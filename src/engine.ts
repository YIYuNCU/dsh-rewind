import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { canonicalDir, classifyTool, isGeneratedPath, listEligibleFiles, matchesGlob, readCandidate, runPool, scanWorkspace, type CapturedBytes } from './capture.js'
import { RewindError } from './errors.js'
import { Ledger, retainTurns, type JournalStep, type RestoreJournal } from './ledger.js'
import { isNodeError, isWithin, pruneEmptyParents, removeFile, replaceRegularFile, resolveContainedPath } from './paths.js'
import { resolveConfig, resolveStorageDir } from './config.js'
import { directoryHasEntries, normalizeStorageRequest, readStorageLocation, resolveLocationFile, sameStoragePath, storageContains, transferStorage, writeStorageLocation } from './relocate.js'
import type {
  BaselineEntry,
  CaptureGap,
  FileAttribution,
  FileRestoreResult,
  PreviewFile,
  ResolvedRewindConfig,
  RestoreAction,
  RewindConfig,
  RewindPreview,
  SessionUsage,
  TurnRecord,
} from './types.js'

interface OpenTurn {
  sessionId: string
  workspace: string
  turn: number
  turnStartSeq: number
  userMessageSeq?: number
  createdAt: number
  shellGap: boolean
  files: Record<string, FileAttribution>
  gaps: CaptureGap[]
  inflight: Set<string>
  earlyAfter: Map<string, CapturedBytes>
  /** Undefined when external capture is off. An empty map is a real snapshot of an empty tree. */
  baseline?: Record<string, BaselineEntry>
  baselineComplete: boolean
}

interface PendingCapture {
  sessionId: string
  turn: number
  path: string
  mode: 'create' | 'update'
  captured?: CapturedBytes
}

/**
 * File-attribution ledger plus a turn-start workspace snapshot.
 * The snapshot is what makes manual edits and script edits between turns restorable.
 * Bytes stay outside the user's Git repository.
 */
export class RewindEngine {
  private current: ResolvedRewindConfig
  private readonly ledger: Ledger
  private readonly open = new Map<string, OpenTurn>()
  private readonly pending = new Map<string, PendingCapture>()
  private readonly chains = new Map<string, Promise<unknown>>()
  /** In-flight `beginTurn`, so a tool cannot read a file before its snapshot exists. */
  private readonly turnOpenings = new Map<string, Promise<void>>()
  /** Serializes before-image reads of one path. The caller may write only after this resolves. */
  private readonly pathChains = new Map<string, Promise<unknown>>()
  /** Last settings, so a storage move keeps every other field. */
  private base: RewindConfig
  /** Stable file that records which directory holds the bytes. */
  private readonly locationFile: string
  /** Startup work. Storage moves wait for it. */
  private boot?: Promise<number>
  /** In-flight captures and restores. A move waits until this is zero. */
  private storageUsers = 0
  /** True until startup finishes, and again while files are moving. */
  private storageMoving = true
  private readonly storageIdle: Array<() => void> = []
  private readonly storageMoveDone: Array<() => void> = []
  private relocateChain: Promise<void> = Promise.resolve()

  /**
   * @param config - Plugin config. Change the storage root with {@link RewindEngine.relocateStorage}.
   */
  constructor(config: RewindConfig = {}) {
    this.base = { ...config }
    this.locationFile = resolveLocationFile(config.locationFile)
    this.current = resolveConfig(config)
    this.ledger = new Ledger(this.current)
  }

  /** Resolved config. Retention and capture fields update in place. */
  get config(): ResolvedRewindConfig {
    return this.current
  }

  /**
   * Replace runtime settings other than the storage root.
   * @param config - Next config. A different `storageDir` is rejected; use {@link RewindEngine.relocateStorage}.
   */
  updateConfig(config: RewindConfig): void {
    if (config.storageDir !== undefined && config.storageDir.trim() !== '') {
      const requested = resolveStorageDir(config.storageDir)
      if (!sameStoragePath(requested, this.current.storageDir)) {
        throw new RewindError('INVALID_CONFIG', 'storageDir cannot change while rewind is running')
      }
    }
    const resolved = resolveConfig(configWithStorage(config, this.current.storageDir))
    const next = { ...resolved, storageDir: this.current.storageDir }
    this.base = configWithStorage(configWithLocation(config, this.base.locationFile), this.base.storageDir)
    this.current = next
    this.ledger.replaceConfig(next)
  }

  /**
   * Move existing rewind files to `storageDir` and use that directory.
   * An empty string selects the default root. The current directory is a no-op.
   * @param storageDir - Absolute path, `~` path, or empty for the default.
   * @returns The resolved directory and whether a directory was moved.
   */
  relocateStorage(storageDir: string): Promise<{ storageDir: string; moved: boolean }> {
    const run = this.relocateChain.then(() => this.relocateExclusive(storageDir))
    this.relocateChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Apply the global storage and turn caps to every session log. */
  enforceRetention(): Promise<void> {
    return this.useStorage(() => this.ledger.enforceGlobalLimits())
  }

  /** Create storage, finish an interrupted move, and roll back a restore that crashed mid-write. */
  initialize(): Promise<number> {
    this.boot ??= this.initializeExclusive()
    return this.boot
  }

  private async initializeExclusive(): Promise<number> {
    try {
      await this.finishPendingTransfer()
      await this.ledger.initialize()
      const workspaces = await this.ledger.journalWorkspaces()
      for (const workspace of workspaces) await this.rollbackJournal(workspace)
      await this.ledger.enforceGlobalLimits()
      await writeStorageLocation(this.locationFile, this.current.storageDir)
      return workspaces.length
    } finally {
      this.releaseMove()
    }
  }

  /**
   * Remember the workspace turn that is about to run.
   * @param input - Identity of the turn.
   */
  beginTurn(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly turn: number
    readonly turnStartSeq: number
  }): Promise<void> {
    const earlier = this.turnOpenings.get(input.sessionId) ?? Promise.resolve()
    const run = earlier.then(() => this.openTurn(input))
    this.turnOpenings.set(input.sessionId, run)
    return run.finally(() => {
      if (this.turnOpenings.get(input.sessionId) === run) this.turnOpenings.delete(input.sessionId)
    })
  }

  private openTurn(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly turn: number
    readonly turnStartSeq: number
  }): Promise<void> {
    return this.useStorage(() => this.openTurnBody(input))
  }

  private async openTurnBody(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly turn: number
    readonly turnStartSeq: number
  }): Promise<void> {
    const previous = this.open.get(input.sessionId)
    if (previous !== undefined && previous.turn !== input.turn) await this.flush(previous)
    const workspace = await canonicalDir(input.workspace)
    const open: OpenTurn = {
      sessionId: input.sessionId,
      workspace,
      turn: input.turn,
      turnStartSeq: input.turnStartSeq,
      createdAt: Date.now(),
      shellGap: false,
      files: {},
      gaps: [],
      inflight: new Set(),
      earlyAfter: new Map(),
      baselineComplete: false,
    }
    if (this.current.enabled && this.current.captureExternal) {
      const scanned = await scanWorkspace(workspace, this.current)
      const baseline: Record<string, BaselineEntry> = {}
      let complete = scanned.complete
      await runPool(scanned.files, 8, async file => {
        try {
          await this.storeCaptured(file.captured)
        } catch {
          complete = false
          return
        }
        if (file.captured.hash === null) return
        baseline[file.relativePath] = { hash: file.captured.hash, mode: file.captured.mode, bytes: file.captured.size }
      })
      open.baseline = baseline
      open.baselineComplete = complete
    }
    this.open.set(input.sessionId, open)
  }

  /**
   * Attach the opening user message to the current turn.
   * @param sessionId - Session that owns the message.
   * @param turn - Turn number.
   * @param userMessageSeq - Event sequence of the direct user message.
   */
  async noteUserMessage(sessionId: string, turn: number, userMessageSeq: number): Promise<void> {
    const opening = this.turnOpenings.get(sessionId)
    if (opening !== undefined) await opening
    return this.useStorage(() => this.noteUserMessageBody(sessionId, turn, userMessageSeq))
  }

  private async noteUserMessageBody(sessionId: string, turn: number, userMessageSeq: number): Promise<void> {
    const current = this.open.get(sessionId)
    if (current === undefined || current.turn !== turn || current.userMessageSeq !== undefined) return
    current.userMessageSeq = userMessageSeq
    await this.flush(current)
  }

  /**
   * Record a before-image when a file tool is about to run.
   * Failures become gaps. They do not fail the tool.
   * @param input - Tool call identity and arguments.
   */
  async captureBefore(input: {
    readonly sessionId: string
    readonly parentSessionId?: string
    readonly subagent: boolean
    readonly callId: string
    readonly toolName: string
    readonly args: unknown
  }): Promise<void> {
    const sessionId = this.attributionSession(input.sessionId, input.parentSessionId, input.subagent)
    const opening = sessionId === undefined ? undefined : this.turnOpenings.get(sessionId)
    if (opening !== undefined) await opening
    return this.useStorage(() => this.captureBeforeBody(input))
  }

  private async captureBeforeBody(input: {
    readonly sessionId: string
    readonly parentSessionId?: string
    readonly subagent: boolean
    readonly callId: string
    readonly toolName: string
    readonly args: unknown
  }): Promise<void> {
    const config = this.current
    if (!config.enabled) return
    const sessionId = this.attributionSession(input.sessionId, input.parentSessionId, input.subagent)
    if (sessionId === undefined) return
    const open = this.open.get(sessionId)
    if (open === undefined) return
    if (overlapsStorage(open.workspace, config.storageDir)) {
      this.addGap(open, '(storage)', 'capture-failed')
      return
    }
    const classified = classifyTool(input.toolName, input.args, config)
    if (classified.kind !== 'file') return
    await this.exclusivePath(`${sessionId}\0${classified.path}`, async () => {
      if (open.inflight.has(classified.path)) {
        this.pending.set(pendingKey(sessionId, input.callId), { sessionId, turn: open.turn, path: classified.path, mode: 'update' })
        return
      }
      open.inflight.add(classified.path)
      let resolved: Awaited<ReturnType<typeof readCandidate>>
      try {
        resolved = await readCandidate(open.workspace, classified.path, config)
      } catch {
        open.inflight.delete(classified.path)
        this.addGap(open, classified.path, 'capture-failed')
        return
      }
      if ('reason' in resolved) {
        open.inflight.delete(classified.path)
        this.addGap(open, resolved.relativePath, resolved.reason)
        await this.flush(open)
        return
      }
      if ((config.skipGenerated && isGeneratedPath(resolved.relativePath, config.generatedDirectories)) || matchesGlob(resolved.relativePath, config.excludeGlobs)) {
        open.inflight.delete(classified.path)
        return
      }
      const path = resolved.relativePath
      if (path !== classified.path) open.inflight.delete(classified.path)
      if (open.files[path] !== undefined || (path !== classified.path && open.inflight.has(path))) {
        open.inflight.delete(path === classified.path ? path : classified.path)
        this.pending.set(pendingKey(sessionId, input.callId), { sessionId, turn: open.turn, path, mode: 'update' })
        return
      }
      open.inflight.add(path)
      this.pending.set(pendingKey(sessionId, input.callId), {
        sessionId,
        turn: open.turn,
        path,
        mode: 'create',
        captured: resolved.captured,
      })
    })
  }

  /**
   * Commit or drop the before-image after the tool result.
   * @param input - Call identity and whether the tool succeeded.
   */
  async captureAfter(input: {
    readonly sessionId: string
    readonly parentSessionId?: string
    readonly subagent: boolean
    readonly callId: string
    readonly toolName: string
    readonly ok: boolean
  }): Promise<void> {
    const sessionId = this.attributionSession(input.sessionId, input.parentSessionId, input.subagent) ?? input.sessionId
    const opening = this.turnOpenings.get(sessionId)
    if (opening !== undefined) await opening
    return this.useStorage(() => this.captureAfterBody(input))
  }

  private async captureAfterBody(input: {
    readonly sessionId: string
    readonly parentSessionId?: string
    readonly subagent: boolean
    readonly callId: string
    readonly toolName: string
    readonly ok: boolean
  }): Promise<void> {
    const config = this.current
    const sessionId = this.attributionSession(input.sessionId, input.parentSessionId, input.subagent) ?? input.sessionId
    const open = this.open.get(sessionId)
    const classified = classifyTool(input.toolName, {}, { ...config, extraFileTools: [] })
    if (classified.kind === 'shell') {
      if (open !== undefined && config.shellPolicy === 'gap') {
        open.shellGap = true
        await this.flush(open)
      }
      return
    }
    const pending = this.pending.get(pendingKey(sessionId, input.callId))
    this.pending.delete(pendingKey(sessionId, input.callId))
    if (open === undefined || pending === undefined || pending.turn !== open.turn) return
    if (!input.ok) {
      if (pending.mode === 'create') open.inflight.delete(pending.path)
      return
    }
    const read = await readCandidate(open.workspace, pending.path, config).catch(() => undefined)
    const afterBytes = read !== undefined && 'captured' in read ? read.captured : undefined
    if (pending.mode === 'update') {
      const existing = open.files[pending.path]
      if (existing === undefined) {
        if (afterBytes !== undefined) open.earlyAfter.set(pending.path, afterBytes)
        return
      }
      if (afterBytes !== undefined) {
        await this.storeCaptured(afterBytes)
        open.files[pending.path] = withAfter(existing, afterBytes)
      }
      await this.flush(open)
      return
    }
    if (pending.captured === undefined) {
      open.inflight.delete(pending.path)
      return
    }
    const early = open.earlyAfter.get(pending.path)
    open.earlyAfter.delete(pending.path)
    open.inflight.delete(pending.path)
    const settled = early ?? afterBytes
    await this.storeCaptured(pending.captured)
    await this.storeCaptured(settled)
    open.files[pending.path] = attribution(pending.captured, settled)
    await this.flush(open)
  }

  /**
   * Compare the attributed paths at and after `turn` with the worktree.
   * @param input - Session, canonical workspace, and turn.
   * @returns A fingerprint of every path, plus the first preview page.
   */
  preview(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly turn: number
    readonly userMessageSeq?: number
  }): Promise<RewindPreview> {
    return this.useStorage(() => this.previewBody(input))
  }

  private async previewBody(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly turn: number
    readonly userMessageSeq?: number
  }): Promise<RewindPreview> {
    const config = this.current
    const workspace = await canonicalDir(input.workspace)
    const turns = await this.turnsFor(input.sessionId, workspace, input.turn)
    const target = turns.find(record => record.turn === input.turn)
    if (target !== undefined && input.userMessageSeq !== undefined && target.userMessageSeq !== input.userMessageSeq) {
      throw new RewindError('STALE', 'the turn no longer matches its opening user message')
    }
    const files = await this.describe(workspace, turns, config)
    const fingerprint = previewFingerprint(turns.some(record => record.shellGap), files)
    return {
      sessionId: input.sessionId,
      workspace,
      turn: input.turn,
      ...(target?.userMessageSeq === undefined ? {} : { userMessageSeq: target.userMessageSeq }),
      fingerprint,
      shellGap: turns.some(record => record.shellGap),
      files: files.slice(0, config.maxPreviewFiles),
      hiddenCount: Math.max(0, files.length - config.maxPreviewFiles),
      totalFiles: files.length,
    }
  }

  /**
   * Write attributed paths back to their before-images.
   * The journal stays until {@link RewindEngine.commit} or {@link RewindEngine.rollback}.
   * @param input - Preview fingerprint and conflict selection.
   * @returns Paths written, deleted, already matching, or skipped.
   */
  apply(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly turn: number
    readonly userMessageSeq?: number
    readonly fingerprint: string
    readonly includeConflicts?: readonly string[]
    readonly workspaceBusy?: boolean
  }): Promise<FileRestoreResult> {
    return this.useStorage(() => this.applyBody(input))
  }

  private async applyBody(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly turn: number
    readonly userMessageSeq?: number
    readonly fingerprint: string
    readonly includeConflicts?: readonly string[]
    readonly workspaceBusy?: boolean
  }): Promise<FileRestoreResult> {
    const config = this.current
    if (config.blockWhileAgentsRun && input.workspaceBusy === true) {
      throw new RewindError('BUSY', 'an agent is still running in this workspace')
    }
    const workspace = await canonicalDir(input.workspace)
    return this.exclusive(workspace, async () => {
      const turns = await this.turnsFor(input.sessionId, workspace, input.turn)
      const target = turns.find(record => record.turn === input.turn)
      if (target !== undefined && input.userMessageSeq !== undefined && target.userMessageSeq !== input.userMessageSeq) {
        throw new RewindError('STALE', 'the turn no longer matches its opening user message')
      }
      const described = await this.describe(workspace, turns, config)
      if (previewFingerprint(turns.some(record => record.shellGap), described) !== input.fingerprint) {
        throw new RewindError('STALE', 'the worktree changed after the preview; open rewind again')
      }
      const selected = selectFiles(described, config.conflictPolicy, new Set(input.includeConflicts ?? []))
      const steps: JournalStep[] = []
      const result: { restored: string[]; deleted: string[]; unchanged: string[]; skipped: string[] } = {
        restored: [], deleted: [], unchanged: [...selected.unchanged], skipped: [...selected.skipped],
      }
      try {
        for (const file of selected.write) {
          const targetPath = await this.restoreTarget(workspace, file.path, config.allowOutsideWorkspace)
          const redo = await readCandidate(workspace, file.path, { ...config, allowOutsideWorkspace: true }).catch(() => undefined)
          const captured = redo !== undefined && 'captured' in redo ? redo.captured : undefined
          const redoHash = captured?.bytes == null || captured.hash == null ? null : await this.ledger.putBlob(captured.bytes, captured.hash)
          const redoMode = redo !== undefined && 'captured' in redo ? redo.captured.mode : file.mode
          const step: JournalStep = {
            path: file.path,
            redo: redoHash,
            target: file.action === 'delete' ? null : file.before,
            mode: redoMode || file.mode || 0o644,
            done: false,
          }
          steps.push(step)
          await this.ledger.writeJournal(workspace, journalOf(input, workspace, steps))
          if (file.action === 'delete') await removeFile(targetPath)
          else {
            if (file.before === null) throw new RewindError('STATE_CORRUPT', `missing before-image for ${file.path}`)
            const bytes = await this.ledger.readBlob(file.before)
            await replaceRegularFile(targetPath, bytes, file.mode || 0o644)
          }
          if (file.action === 'delete') result.deleted.push(file.path)
          else result.restored.push(file.path)
        }
      } catch (error) {
        await this.rollbackJournal(workspace)
        throw error instanceof RewindError ? error : new RewindError('RESTORE_FAILED', 'rewind could not restore every selected file', { cause: error })
      }
      return result
    })
  }

  /** Drop the journal after the caller has finished the conversation fork. */
  commit(workspace: string): Promise<void> {
    return this.useStorage(async () => {
      await this.ledger.deleteJournal(await canonicalDir(workspace))
    })
  }

  /** Put a workspace back to the bytes from before an unfinished restore. */
  rollback(workspace: string): Promise<void> {
    return this.useStorage(async () => {
      await this.rollbackJournal(await canonicalDir(workspace))
    })
  }

  /** Session disk use, newest activity first. */
  usage(): Promise<SessionUsage[]> {
    return this.useStorage(() => this.ledger.usage())
  }

  /**
   * Delete one session ledger, or every ledger when `sessionId` is omitted.
   * @param sessionId - Optional session to drop.
   * @returns The number of session ledgers removed.
   */
  purge(sessionId?: string): Promise<number> {
    return this.useStorage(() => this.ledger.purge(sessionId))
  }

  private async relocateExclusive(storageDir: string): Promise<{ storageDir: string; moved: boolean }> {
    if (this.boot === undefined) throw new RewindError('BUSY', 'rewind is still starting')
    await this.boot
    const requested = normalizeStorageRequest(storageDir)
    const nextDir = resolveStorageDir(requested)
    if (sameStoragePath(nextDir, this.current.storageDir)) return { storageDir: this.current.storageDir, moved: false }
    this.storageMoving = true
    try {
      while (this.storageUsers > 0) {
        await new Promise<void>(resolve => { this.storageIdle.push(resolve) })
      }
      const moved = await this.transferTo(nextDir, requested ?? '')
      return { storageDir: this.current.storageDir, moved }
    } finally {
      this.releaseMove()
    }
  }

  /** Move files, then point the ledger at the new root. A failed location write moves the files back. */
  private async transferTo(nextDir: string, raw: string): Promise<boolean> {
    const previous = this.current.storageDir
    const previousRaw = this.base.storageDir
    if (storageContains(previous, this.locationFile) || storageContains(nextDir, this.locationFile)) {
      throw new RewindError('INVALID_CONFIG', 'storageDir must not contain the storage location record')
    }
    if (storageContains(previous, nextDir) || storageContains(nextDir, previous)) {
      throw new RewindError('INVALID_CONFIG', 'storageDir must not contain the current storage directory')
    }
    const workspaces = new Set<string>()
    for (const open of this.open.values()) workspaces.add(open.workspace)
    for (const row of await this.ledger.usage()) workspaces.add(row.workspace)
    for (const workspace of workspaces) {
      if (storageContains(workspace, nextDir) || storageContains(nextDir, workspace)) {
        throw new RewindError('UNSAFE_PATH', 'storageDir must not overlap a workspace')
      }
    }
    const moved = await transferStorage(previous, nextDir)
    try {
      const next = resolveConfig(configWithStorage(this.base, raw === '' ? undefined : raw))
      this.base = configWithStorage(this.base, raw)
      this.current = { ...next, storageDir: nextDir }
      this.ledger.rebind(this.current)
      await writeStorageLocation(this.locationFile, nextDir)
    } catch (error) {
      await transferStorage(nextDir, previous).catch(() => false)
      const restored = resolveConfig(configWithStorage(this.base, previous))
      this.base = configWithStorage(this.base, previousRaw)
      this.current = { ...restored, storageDir: previous }
      this.ledger.rebind(this.current)
      throw error instanceof RewindError ? error : new RewindError('RELOCATE_FAILED', 'could not record the storage directory', { cause: error })
    }
    return moved
  }

  /** Finish a move whose saved directory is empty and whose recorded directory still has files. */
  private async finishPendingTransfer(): Promise<void> {
    const recorded = await readStorageLocation(this.locationFile)
    if (recorded === undefined || sameStoragePath(recorded, this.current.storageDir)) return
    if (storageContains(recorded, this.current.storageDir) || storageContains(this.current.storageDir, recorded)) return
    if (storageContains(recorded, this.locationFile) || storageContains(this.current.storageDir, this.locationFile)) return
    if (await directoryHasEntries(this.current.storageDir)) return
    if (!await directoryHasEntries(recorded)) return
    await transferStorage(recorded, this.current.storageDir)
  }

  private async useStorage<T>(task: () => Promise<T>): Promise<T> {
    await this.enterStorage()
    try {
      return await task()
    } finally {
      this.leaveStorage()
    }
  }

  private async enterStorage(): Promise<void> {
    for (;;) {
      if (!this.storageMoving) {
        this.storageUsers += 1
        return
      }
      await new Promise<void>(resolve => { this.storageMoveDone.push(resolve) })
    }
  }

  private leaveStorage(): void {
    this.storageUsers -= 1
    if (this.storageUsers <= 0) {
      this.storageUsers = 0
      const pending = this.storageIdle.splice(0)
      for (const resolve of pending) resolve()
    }
  }

  private releaseMove(): void {
    this.storageMoving = false
    const pending = this.storageMoveDone.splice(0)
    for (const resolve of pending) resolve()
  }

  private attributionSession(sessionId: string, parentSessionId: string | undefined, subagent: boolean): string | undefined {
    if (!subagent) return sessionId
    if (!this.current.captureSubagents) return undefined
    if (parentSessionId !== undefined && this.open.has(parentSessionId)) return parentSessionId
    return this.open.has(sessionId) ? sessionId : undefined
  }

  private async turnsFor(sessionId: string, workspace: string, turn: number): Promise<TurnRecord[]> {
    return (await this.ledger.readTurns(sessionId)).filter(record => record.turn >= turn && record.workspace === workspace)
  }

  private addGap(open: OpenTurn, path: string, reason: CaptureGap['reason']): void {
    if (open.gaps.some(gap => gap.path === path && gap.reason === reason)) return
    open.gaps.push({ path, reason })
  }

  private async storeCaptured(captured: CapturedBytes | undefined): Promise<void> {
    if (captured?.bytes == null || captured.hash == null) return
    const stored = await this.ledger.putBlob(captured.bytes, captured.hash)
    if (stored !== captured.hash) throw new RewindError('STATE_CORRUPT', 'captured bytes do not match their hash')
  }

  private async flush(open: OpenTurn): Promise<void> {
    if (open.userMessageSeq === undefined) return
    const snapshotted = open.baseline !== undefined
    if (!snapshotted && Object.keys(open.files).length === 0 && open.gaps.length === 0 && !open.shellGap) return
    const record: TurnRecord = {
      version: 1,
      sessionId: open.sessionId,
      workspace: open.workspace,
      turn: open.turn,
      turnStartSeq: open.turnStartSeq,
      userMessageSeq: open.userMessageSeq,
      createdAt: open.createdAt,
      updatedAt: Date.now(),
      shellGap: open.shellGap,
      files: open.files,
      gaps: open.gaps,
      ...(open.baseline === undefined ? {} : { baseline: open.baseline, baselineComplete: open.baselineComplete }),
    }
    await this.ledger.appendTurn(record)
  }

  private async describe(workspace: string, turns: readonly TurnRecord[], config: ResolvedRewindConfig): Promise<PreviewFile[]> {
    const reduced = reduceTurns(turns)
    const target = earliestTurn(turns)
    if (target?.baseline !== undefined) {
      for (const [path, entry] of Object.entries(target.baseline)) {
        reduced.set(path, { file: baselineAttribution(entry), checkpoint: true })
      }
      if (target.baselineComplete && config.enabled && config.captureExternal) {
        const live = await listEligibleFiles(workspace, config)
        for (const file of live.files) {
          if (reduced.has(file.relativePath)) continue
          reduced.set(file.relativePath, { file: createdAttribution(file.mode), checkpoint: true })
        }
      }
    }
    const files: PreviewFile[] = []
    for (const [path, entry] of [...reduced.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const described = await this.describePath(workspace, path, entry, config)
      if (entry.checkpoint === true && described.action === 'unchanged') continue
      files.push(described)
    }
    return files
  }

  private async describePath(
    workspace: string,
    path: string,
    entry: ReducedPath,
    config: ResolvedRewindConfig,
  ): Promise<PreviewFile> {
    if (entry.checkpoint === true && entry.file !== undefined) {
      const file = entry.file
      if (file.before === null && !config.restoreCreatedFiles) {
        return { path, action: 'delete', state: 'gap', reason: 'unsupported', before: null, current: null, bytes: 0, mode: file.mode }
      }
      const current = await this.currentBytes(workspace, path, file, config)
      const action: RestoreAction = file.before === null
        ? (current.hash === null ? 'unchanged' : 'delete')
        : (current.hash === file.before ? 'unchanged' : 'restore')
      return { path, action, state: 'clean', before: file.before, current: current.hash, bytes: file.beforeBytes, mode: file.mode }
    }
    if (entry.gap !== undefined && entry.file === undefined) {
      return { path, action: 'unchanged', state: 'gap', reason: entry.gap, before: null, current: null, bytes: 0, mode: 0o644 }
    }
    if (entry.gap !== undefined) {
      return {
        path,
        action: entry.file?.before === null ? 'delete' : 'restore',
        state: 'gap',
        reason: entry.gap,
        before: entry.file?.before ?? null,
        current: null,
        bytes: entry.file?.beforeBytes ?? 0,
        mode: entry.file?.mode ?? 0o644,
      }
    }
    const file = entry.file
    if (file === undefined) {
      return { path, action: 'unchanged', state: 'gap', before: null, current: null, bytes: 0, mode: 0o644 }
    }
    if (file.before === null && !config.restoreCreatedFiles) {
      return { path, action: 'delete', state: 'gap', reason: 'unsupported', before: null, current: null, bytes: 0, mode: file.mode }
    }
    const current = await this.currentBytes(workspace, path, file, config)
    const action: RestoreAction = file.before === null
      ? (current.hash === null ? 'unchanged' : 'delete')
      : (current.hash === file.before ? 'unchanged' : 'restore')
    const matchesAfter = current.hash !== null && (current.hash === file.after || current.metadataMatch)
    const matchesBefore = current.hash === file.before
    const absentDelete = file.before === null && current.hash === null
    const state = matchesBefore || absentDelete || matchesAfter || (file.before === null && current.hash === file.after) ? 'clean' : 'conflict'
    return { path, action, state, before: file.before, current: current.hash, bytes: file.beforeBytes, mode: file.mode }
  }

  private async currentBytes(
    workspace: string,
    path: string,
    file: FileAttribution,
    config: ResolvedRewindConfig,
  ): Promise<{ readonly hash: string | null; readonly metadataMatch: boolean }> {
    if (config.previewTrust === 'metadata' && file.after !== null) {
      try {
        const target = await this.restoreTarget(workspace, path, true)
        const info = await lstat(target)
        if (info.isFile() && !info.isSymbolicLink() && info.size === file.afterSize && Math.trunc(info.mtimeMs) === Math.trunc(file.afterMtimeMs)) {
          return { hash: file.after, metadataMatch: true }
        }
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) return { hash: null, metadataMatch: false }
      }
    }
    const read = await readCandidate(workspace, path, { maxFileBytes: config.maxFileBytes, allowOutsideWorkspace: true }).catch(() => undefined)
    if (read === undefined || 'reason' in read) return { hash: null, metadataMatch: false }
    return { hash: read.captured.hash, metadataMatch: false }
  }

  private async restoreTarget(workspace: string, path: string, allowOutside: boolean): Promise<string> {
    if (isAbsolute(path)) {
      if (!allowOutside) throw new RewindError('UNSAFE_PATH', `refusing to restore an outside path: ${JSON.stringify(path)}`)
      return path
    }
    return resolveContainedPath(workspace, path)
  }

  private async rollbackJournal(workspace: string): Promise<void> {
    const journal = await this.ledger.readJournal(workspace)
    if (journal === undefined) return
    for (const step of [...journal.steps].reverse()) {
      try {
        const target = await this.restoreTarget(workspace, step.path, true)
        const current = await readCandidate(workspace, step.path, {
          maxFileBytes: this.current.maxFileBytes,
          allowOutsideWorkspace: true,
        }).catch(() => undefined)
        const hash = current !== undefined && 'captured' in current ? current.captured.hash : null
        const applied = step.target === null ? hash === null : hash === step.target
        if (!applied) continue
        if (step.redo === null) {
          await removeFile(target)
          await pruneEmptyParents(workspace, target)
        } else {
          const bytes = await this.ledger.readBlob(step.redo)
          await replaceRegularFile(target, bytes, step.mode)
        }
      } catch {
        // Keep the journal when a single path cannot be put back.
        return
      }
    }
    await this.ledger.deleteJournal(workspace)
  }

  private async exclusivePath(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.pathChains.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const tail = previous.then(() => gate)
    this.pathChains.set(key, tail)
    await previous.catch(() => undefined)
    try {
      await task()
    } finally {
      release()
      if (this.pathChains.get(key) === tail) this.pathChains.delete(key)
    }
  }

  private async exclusive<T>(workspace: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(workspace) ?? Promise.resolve()
    let release = (): void => {}
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const tail = previous.then(() => gate)
    this.chains.set(workspace, tail)
    await previous.catch(() => undefined)
    const unlock = await this.ledger.acquire(workspace)
    try {
      return await task()
    } finally {
      await unlock()
      release()
    }
  }
}

interface ReducedPath {
  readonly file?: FileAttribution
  readonly gap?: CaptureGap['reason']
  /** Turn-start snapshot, not a file-tool conflict. */
  checkpoint?: boolean
}

function reduceTurns(turns: readonly TurnRecord[]): Map<string, ReducedPath> {
  const paths = new Map<string, { file?: FileAttribution; gap?: CaptureGap['reason'] }>()
  for (const turn of turns) {
    if (turn.workspace !== turns[0]?.workspace) continue
    for (const [path, file] of Object.entries(turn.files)) {
      const existing = paths.get(path) ?? {}
      paths.set(path, {
        file: existing.file === undefined ? file : { ...existing.file, after: file.after ?? existing.file.after, afterSize: file.afterSize, afterMtimeMs: file.afterMtimeMs },
        ...(existing.gap === undefined ? {} : { gap: existing.gap }),
      })
    }
    for (const gap of turn.gaps) {
      const existing = paths.get(gap.path) ?? {}
      paths.set(gap.path, { ...existing, gap: gap.reason })
    }
  }
  return paths
}

function earliestTurn(turns: readonly TurnRecord[]): TurnRecord | undefined {
  return turns.reduce<TurnRecord | undefined>((best, record) => {
    if (best === undefined || record.turn < best.turn) return record
    return best
  }, undefined)
}

function baselineAttribution(entry: BaselineEntry): FileAttribution {
  return { before: entry.hash, after: null, mode: entry.mode, beforeBytes: entry.bytes, afterSize: 0, afterMtimeMs: 0 }
}

function createdAttribution(mode: number): FileAttribution {
  return { before: null, after: null, mode, beforeBytes: 0, afterSize: 0, afterMtimeMs: 0 }
}

function attribution(before: CapturedBytes, after: CapturedBytes | undefined): FileAttribution {
  return {
    before: before.hash,
    after: after?.hash ?? null,
    mode: before.mode || after?.mode || 0o644,
    beforeBytes: before.size,
    afterSize: after?.size ?? 0,
    afterMtimeMs: after?.mtimeMs ?? 0,
  }
}

function withAfter(file: FileAttribution, after: CapturedBytes): FileAttribution {
  return { ...file, after: after.hash, afterSize: after.size, afterMtimeMs: after.mtimeMs }
}

function previewFingerprint(shellGap: boolean, files: readonly PreviewFile[]): string {
  const lines = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => [file.path, file.action, file.state, file.before ?? '', file.current ?? '', file.reason ?? ''].join('\0'))
  return createHash('sha256').update(`${shellGap ? '1' : '0'}\n${lines.join('\n')}`).digest('hex')
}

function selectFiles(
  files: readonly PreviewFile[],
  policy: ResolvedRewindConfig['conflictPolicy'],
  include: ReadonlySet<string>,
): { readonly write: PreviewFile[]; readonly unchanged: string[]; readonly skipped: string[] } {
  const write: PreviewFile[] = []
  const unchanged: string[] = []
  const skipped: string[] = []
  for (const file of files) {
    if (file.state === 'gap') {
      skipped.push(file.path)
      continue
    }
    if (file.state === 'conflict' && policy !== 'overwrite' && !(policy === 'ask' && include.has(file.path))) {
      skipped.push(file.path)
      continue
    }
    if (file.action === 'unchanged') unchanged.push(file.path)
    else write.push(file)
  }
  if (policy === 'ask') {
    for (const path of include) {
      if (!files.some(file => file.path === path && file.state === 'conflict')) {
        throw new RewindError('INVALID_ARGUMENTS', `${JSON.stringify(path)} is not a conflicting path`)
      }
    }
  }
  return { write, unchanged, skipped }
}

function journalOf(input: { readonly sessionId: string; readonly turn: number }, workspace: string, steps: readonly JournalStep[]): RestoreJournal {
  return { version: 1, sessionId: input.sessionId, workspace, turn: input.turn, startedAt: Date.now(), steps: steps.map(step => ({ ...step })) }
}

function pendingKey(sessionId: string, callId: string): string {
  return `${sessionId}\0${callId}`
}

function configWithStorage(config: RewindConfig, storageDir: string | undefined): RewindConfig {
  const { storageDir: _storage, ...rest } = config
  if (storageDir === undefined || storageDir === '') return rest
  return { ...rest, storageDir }
}

function configWithLocation(config: RewindConfig, locationFile: string | undefined): RewindConfig {
  const { locationFile: _location, ...rest } = config
  if (locationFile === undefined || locationFile === '') return rest
  return { ...rest, locationFile }
}

function overlapsStorage(workspace: string, storageDir: string): boolean {
  return isWithin(workspace, storageDir) || isWithin(storageDir, workspace)
}

export { retainTurns }
