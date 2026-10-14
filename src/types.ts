/** Durable ledger version. Readers reject every other version. */
export const REWIND_FORMAT_VERSION = 1 as const

/** How a shell or code-execution tool is recorded. */
export type ShellPolicy = 'gap' | 'ignore'

/** What to do with a path whose bytes no longer match the recorded after-image. */
export type ConflictPolicy = 'ask' | 'skip' | 'overwrite'

/** How preview decides that the worktree still matches the recorded after-image. */
export type PreviewTrust = 'content' | 'metadata'

/** Cross-site request handling for the restore route. */
export type OriginCheck = 'same-origin' | 'off'

/** File, conversation, or both. */
export type RewindMode = 'both' | 'code' | 'messages'

/** Why an eligible path was not given a restorable before-image. */
export type GapReason = 'too-large' | 'symlink' | 'hardlink' | 'unsupported' | 'outside' | 'shell' | 'capture-failed'

/** Plugin config accepted from cordis.yml and the settings card. */
export interface RewindConfig {
  /** State root. Empty uses `$DSH_HOME/rewind/v1` or `~/.dsh/rewind/v1`. Not hot-swappable. */
  readonly storageDir?: string
  /** Master switch for new captures. Existing records stay restorable. */
  readonly enabled?: boolean
  /** Attribute a subagent file-tool edit to the parent session's open turn. */
  readonly captureSubagents?: boolean
  /** `gap` shows that a shell ran; `ignore` pretends it did not. Neither snapshots shell output. */
  readonly shellPolicy?: ShellPolicy
  /** Comma-separated tool names treated as shell gaps. */
  readonly shellTools?: string
  /** Comma-separated extra tool names whose arguments contain a path. */
  readonly extraFileTools?: string
  /** Comma-separated argument keys read for {@link RewindConfig.extraFileTools}. */
  readonly pathFields?: string
  /** Newline-separated globs. A match is recorded as neither a file nor a deletion. */
  readonly excludeGlobs?: string
  /** Also skip `node_modules`, `.git`, `dist`, `coverage`, and `.dsh`. */
  readonly skipGenerated?: boolean
  /** Largest regular file whose bytes are stored. */
  readonly maxFileBytes?: number
  /** Newest checkpoints kept for one session after the age sweep. */
  readonly maxCheckpointsPerSession?: number
  /** Drop checkpoints older than this many days. Zero disables the age sweep. */
  readonly retentionDays?: number
  /** Drop oldest checkpoints until the session's referenced blobs fit. */
  readonly maxSessionBytes?: number
  /** Drop the oldest checkpoints across every session until referenced blobs fit. */
  readonly maxStorageBytes?: number
  /** Newest checkpoints kept across every session. */
  readonly maxStoredTurns?: number
  /** Default treatment of paths changed outside the recorded after-image. */
  readonly conflictPolicy?: ConflictPolicy
  /** Delete a file whose before-image is "absent" when restoring. */
  readonly restoreCreatedFiles?: boolean
  /** Refuse file restore while any Agent is running in the same workspace. */
  readonly blockWhileAgentsRun?: boolean
  /** Store and restore an edit whose path resolves outside the session workspace. */
  readonly allowOutsideWorkspace?: boolean
  /** `content` hashes the file; `metadata` trusts size and mtime when they still match. */
  readonly previewTrust?: PreviewTrust
  /** After a conversation fork, put the selected prompt back into the composer. */
  readonly putPromptInComposer?: boolean
  /** File rows returned to the dialog. The fingerprint still covers every path. */
  readonly maxPreviewFiles?: number
  /** Age after which a lock whose owner process is gone may be taken. */
  readonly staleLockMs?: number
  /** Reject a cross-site POST. `off` is only for a trusted private listener. */
  readonly originCheck?: OriginCheck
}

/** Config after defaults and validation. */
export interface ResolvedRewindConfig {
  readonly storageDir: string
  readonly enabled: boolean
  readonly captureSubagents: boolean
  readonly shellPolicy: ShellPolicy
  readonly shellTools: readonly string[]
  readonly extraFileTools: readonly string[]
  readonly pathFields: readonly string[]
  readonly excludeGlobs: readonly string[]
  readonly skipGenerated: boolean
  readonly maxFileBytes: number
  readonly maxCheckpointsPerSession: number
  readonly retentionDays: number
  readonly maxSessionBytes: number
  readonly maxStorageBytes: number
  readonly maxStoredTurns: number
  readonly conflictPolicy: ConflictPolicy
  readonly restoreCreatedFiles: boolean
  readonly blockWhileAgentsRun: boolean
  readonly allowOutsideWorkspace: boolean
  readonly previewTrust: PreviewTrust
  readonly putPromptInComposer: boolean
  readonly maxPreviewFiles: number
  readonly staleLockMs: number
  readonly originCheck: OriginCheck
}

/** One path the ledger can write back. */
export interface FileAttribution {
  /** Blob of the bytes before this turn first changed the path. Null means the file was created. */
  readonly before: string | null
  /** Blob of the bytes after the latest successful file tool in this turn. */
  readonly after: string | null
  readonly mode: number
  readonly beforeBytes: number
  readonly afterSize: number
  readonly afterMtimeMs: number
}

/** One path observed but not restorable. */
export interface CaptureGap {
  readonly path: string
  readonly reason: GapReason
}

/** Durable per-turn attribution. A later line for the same turn replaces the earlier one. */
export interface TurnRecord {
  readonly version: typeof REWIND_FORMAT_VERSION
  readonly sessionId: string
  readonly workspace: string
  readonly turn: number
  readonly turnStartSeq: number
  readonly userMessageSeq: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly shellGap: boolean
  readonly files: Readonly<Record<string, FileAttribution>>
  readonly gaps: readonly CaptureGap[]
}

/** Write or delete when the recorded before-image is applied. */
export type RestoreAction = 'restore' | 'delete' | 'unchanged'

/** Comparison of one attributed path with the current worktree. */
export type RestoreState = 'clean' | 'conflict' | 'gap'

/** One row of a restore preview. */
export interface PreviewFile {
  readonly path: string
  readonly action: RestoreAction
  readonly state: RestoreState
  readonly reason?: GapReason
  readonly before: string | null
  readonly current: string | null
  readonly bytes: number
  /** Mode of the before-image. Not part of the preview fingerprint. */
  readonly mode: number
}

/** Read-only description of restoring one turn and everything after it. */
export interface RewindPreview {
  readonly sessionId: string
  readonly workspace: string
  readonly turn: number
  readonly userMessageSeq?: number
  readonly fingerprint: string
  readonly shellGap: boolean
  readonly files: readonly PreviewFile[]
  readonly hiddenCount: number
  readonly totalFiles: number
}

/** Paths a file restore changed. */
export interface FileRestoreResult {
  readonly restored: readonly string[]
  readonly deleted: readonly string[]
  readonly unchanged: readonly string[]
  readonly skipped: readonly string[]
}

/** Aggregate disk use of one session ledger. */
export interface SessionUsage {
  readonly sessionId: string
  readonly workspace: string
  readonly checkpoints: number
  readonly bytes: number
  readonly oldestAt?: number
  readonly newestAt?: number
}
