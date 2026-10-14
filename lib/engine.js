import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalDir, classifyTool, isGeneratedPath, listEligibleFiles, matchesGlob, readCandidate, runPool, scanWorkspace } from './capture.js';
import { RewindError } from './errors.js';
import { Ledger, retainTurns } from './ledger.js';
import { isNodeError, isWithin, pruneEmptyParents, removeFile, replaceRegularFile, resolveContainedPath } from './paths.js';
import { resolveConfig } from './config.js';
/**
 * File-attribution ledger plus a turn-start workspace snapshot.
 * The snapshot is what makes manual edits and script edits between turns restorable.
 * Bytes stay outside the user's Git repository.
 */
export class RewindEngine {
    current;
    ledger;
    open = new Map();
    pending = new Map();
    chains = new Map();
    /** In-flight `beginTurn`, so a tool cannot read a file before its snapshot exists. */
    turnOpenings = new Map();
    /** Serializes before-image reads of one path. The caller may write only after this resolves. */
    pathChains = new Map();
    /**
     * @param config - Plugin config. The storage root is fixed after construction.
     */
    constructor(config = {}) {
        this.current = resolveConfig(config);
        this.ledger = new Ledger(this.current);
    }
    /** Resolved config. Retention and capture fields update in place; the storage root does not. */
    get config() {
        return this.current;
    }
    /**
     * Replace runtime settings.
     * @param config - Next config. A different `storageDir` is rejected.
     */
    updateConfig(config) {
        const resolved = resolveConfig({ ...config, storageDir: config.storageDir ?? this.current.storageDir });
        if (resolved.storageDir !== this.current.storageDir) {
            throw new RewindError('INVALID_CONFIG', 'storageDir cannot change while rewind is running');
        }
        this.current = resolved;
        this.ledger.replaceConfig(resolved);
    }
    /** Apply the global storage and turn caps to every session log. */
    enforceRetention() {
        return this.ledger.enforceGlobalLimits();
    }
    /** Create storage and roll back a restore that crashed mid-write. */
    async initialize() {
        await this.ledger.initialize();
        const workspaces = await this.ledger.journalWorkspaces();
        for (const workspace of workspaces)
            await this.rollbackJournal(workspace);
        await this.ledger.enforceGlobalLimits();
        return workspaces.length;
    }
    /**
     * Remember the workspace turn that is about to run.
     * @param input - Identity of the turn.
     */
    beginTurn(input) {
        const earlier = this.turnOpenings.get(input.sessionId) ?? Promise.resolve();
        const run = earlier.then(() => this.openTurn(input));
        this.turnOpenings.set(input.sessionId, run);
        return run.finally(() => {
            if (this.turnOpenings.get(input.sessionId) === run)
                this.turnOpenings.delete(input.sessionId);
        });
    }
    async openTurn(input) {
        const previous = this.open.get(input.sessionId);
        if (previous !== undefined && previous.turn !== input.turn)
            await this.flush(previous);
        const workspace = await canonicalDir(input.workspace);
        const open = {
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
        };
        if (this.current.enabled && this.current.captureExternal) {
            const scanned = await scanWorkspace(workspace, this.current);
            const baseline = {};
            let complete = scanned.complete;
            await runPool(scanned.files, 8, async (file) => {
                try {
                    await this.storeCaptured(file.captured);
                }
                catch {
                    complete = false;
                    return;
                }
                if (file.captured.hash === null)
                    return;
                baseline[file.relativePath] = { hash: file.captured.hash, mode: file.captured.mode, bytes: file.captured.size };
            });
            open.baseline = baseline;
            open.baselineComplete = complete;
        }
        this.open.set(input.sessionId, open);
    }
    /**
     * Attach the opening user message to the current turn.
     * @param sessionId - Session that owns the message.
     * @param turn - Turn number.
     * @param userMessageSeq - Event sequence of the direct user message.
     */
    async noteUserMessage(sessionId, turn, userMessageSeq) {
        const opening = this.turnOpenings.get(sessionId);
        if (opening !== undefined)
            await opening;
        const current = this.open.get(sessionId);
        if (current === undefined || current.turn !== turn || current.userMessageSeq !== undefined)
            return;
        current.userMessageSeq = userMessageSeq;
        await this.flush(current);
    }
    /**
     * Record a before-image when a file tool is about to run.
     * Failures become gaps. They do not fail the tool.
     * @param input - Tool call identity and arguments.
     */
    async captureBefore(input) {
        const config = this.current;
        if (!config.enabled)
            return;
        const sessionId = this.attributionSession(input.sessionId, input.parentSessionId, input.subagent);
        if (sessionId === undefined)
            return;
        const opening = this.turnOpenings.get(sessionId);
        if (opening !== undefined)
            await opening;
        const open = this.open.get(sessionId);
        if (open === undefined)
            return;
        if (overlapsStorage(open.workspace, config.storageDir)) {
            this.addGap(open, '(storage)', 'capture-failed');
            return;
        }
        const classified = classifyTool(input.toolName, input.args, config);
        if (classified.kind !== 'file')
            return;
        await this.exclusivePath(`${sessionId}\0${classified.path}`, async () => {
            if (open.inflight.has(classified.path)) {
                this.pending.set(pendingKey(sessionId, input.callId), { sessionId, turn: open.turn, path: classified.path, mode: 'update' });
                return;
            }
            open.inflight.add(classified.path);
            let resolved;
            try {
                resolved = await readCandidate(open.workspace, classified.path, config);
            }
            catch {
                open.inflight.delete(classified.path);
                this.addGap(open, classified.path, 'capture-failed');
                return;
            }
            if ('reason' in resolved) {
                open.inflight.delete(classified.path);
                this.addGap(open, resolved.relativePath, resolved.reason);
                await this.flush(open);
                return;
            }
            if ((config.skipGenerated && isGeneratedPath(resolved.relativePath)) || matchesGlob(resolved.relativePath, config.excludeGlobs)) {
                open.inflight.delete(classified.path);
                return;
            }
            const path = resolved.relativePath;
            if (path !== classified.path)
                open.inflight.delete(classified.path);
            if (open.files[path] !== undefined || (path !== classified.path && open.inflight.has(path))) {
                open.inflight.delete(path === classified.path ? path : classified.path);
                this.pending.set(pendingKey(sessionId, input.callId), { sessionId, turn: open.turn, path, mode: 'update' });
                return;
            }
            open.inflight.add(path);
            this.pending.set(pendingKey(sessionId, input.callId), {
                sessionId,
                turn: open.turn,
                path,
                mode: 'create',
                captured: resolved.captured,
            });
        });
    }
    /**
     * Commit or drop the before-image after the tool result.
     * @param input - Call identity and whether the tool succeeded.
     */
    async captureAfter(input) {
        const config = this.current;
        const sessionId = this.attributionSession(input.sessionId, input.parentSessionId, input.subagent) ?? input.sessionId;
        const opening = this.turnOpenings.get(sessionId);
        if (opening !== undefined)
            await opening;
        const open = this.open.get(sessionId);
        const classified = classifyTool(input.toolName, {}, { ...config, extraFileTools: [] });
        if (classified.kind === 'shell') {
            if (open !== undefined && config.shellPolicy === 'gap') {
                open.shellGap = true;
                await this.flush(open);
            }
            return;
        }
        const pending = this.pending.get(pendingKey(sessionId, input.callId));
        this.pending.delete(pendingKey(sessionId, input.callId));
        if (open === undefined || pending === undefined || pending.turn !== open.turn)
            return;
        if (!input.ok) {
            if (pending.mode === 'create')
                open.inflight.delete(pending.path);
            return;
        }
        const read = await readCandidate(open.workspace, pending.path, config).catch(() => undefined);
        const afterBytes = read !== undefined && 'captured' in read ? read.captured : undefined;
        if (pending.mode === 'update') {
            const existing = open.files[pending.path];
            if (existing === undefined) {
                if (afterBytes !== undefined)
                    open.earlyAfter.set(pending.path, afterBytes);
                return;
            }
            if (afterBytes !== undefined) {
                await this.storeCaptured(afterBytes);
                open.files[pending.path] = withAfter(existing, afterBytes);
            }
            await this.flush(open);
            return;
        }
        if (pending.captured === undefined) {
            open.inflight.delete(pending.path);
            return;
        }
        const early = open.earlyAfter.get(pending.path);
        open.earlyAfter.delete(pending.path);
        open.inflight.delete(pending.path);
        const settled = early ?? afterBytes;
        await this.storeCaptured(pending.captured);
        await this.storeCaptured(settled);
        open.files[pending.path] = attribution(pending.captured, settled);
        await this.flush(open);
    }
    /**
     * Compare the attributed paths at and after `turn` with the worktree.
     * @param input - Session, canonical workspace, and turn.
     * @returns A fingerprint of every path, plus the first preview page.
     */
    async preview(input) {
        const config = this.current;
        const workspace = await canonicalDir(input.workspace);
        const turns = await this.turnsFor(input.sessionId, workspace, input.turn);
        const target = turns.find(record => record.turn === input.turn);
        if (target !== undefined && input.userMessageSeq !== undefined && target.userMessageSeq !== input.userMessageSeq) {
            throw new RewindError('STALE', 'the turn no longer matches its opening user message');
        }
        const files = await this.describe(workspace, turns, config);
        const fingerprint = previewFingerprint(turns.some(record => record.shellGap), files);
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
        };
    }
    /**
     * Write attributed paths back to their before-images.
     * The journal stays until {@link RewindEngine.commit} or {@link RewindEngine.rollback}.
     * @param input - Preview fingerprint and conflict selection.
     * @returns Paths written, deleted, already matching, or skipped.
     */
    async apply(input) {
        const config = this.current;
        if (config.blockWhileAgentsRun && input.workspaceBusy === true) {
            throw new RewindError('BUSY', 'an agent is still running in this workspace');
        }
        const workspace = await canonicalDir(input.workspace);
        return this.exclusive(workspace, async () => {
            const turns = await this.turnsFor(input.sessionId, workspace, input.turn);
            const target = turns.find(record => record.turn === input.turn);
            if (target !== undefined && input.userMessageSeq !== undefined && target.userMessageSeq !== input.userMessageSeq) {
                throw new RewindError('STALE', 'the turn no longer matches its opening user message');
            }
            const described = await this.describe(workspace, turns, config);
            if (previewFingerprint(turns.some(record => record.shellGap), described) !== input.fingerprint) {
                throw new RewindError('STALE', 'the worktree changed after the preview; open rewind again');
            }
            const selected = selectFiles(described, config.conflictPolicy, new Set(input.includeConflicts ?? []));
            const steps = [];
            const result = {
                restored: [], deleted: [], unchanged: [...selected.unchanged], skipped: [...selected.skipped],
            };
            try {
                for (const file of selected.write) {
                    const targetPath = await this.restoreTarget(workspace, file.path, config.allowOutsideWorkspace);
                    const redo = await readCandidate(workspace, file.path, { ...config, allowOutsideWorkspace: true }).catch(() => undefined);
                    const captured = redo !== undefined && 'captured' in redo ? redo.captured : undefined;
                    const redoHash = captured?.bytes == null || captured.hash == null ? null : await this.ledger.putBlob(captured.bytes, captured.hash);
                    const redoMode = redo !== undefined && 'captured' in redo ? redo.captured.mode : file.mode;
                    const step = {
                        path: file.path,
                        redo: redoHash,
                        target: file.action === 'delete' ? null : file.before,
                        mode: redoMode || file.mode || 0o644,
                        done: false,
                    };
                    steps.push(step);
                    await this.ledger.writeJournal(workspace, journalOf(input, workspace, steps));
                    if (file.action === 'delete')
                        await removeFile(targetPath);
                    else {
                        if (file.before === null)
                            throw new RewindError('STATE_CORRUPT', `missing before-image for ${file.path}`);
                        const bytes = await this.ledger.readBlob(file.before);
                        await replaceRegularFile(targetPath, bytes, file.mode || 0o644);
                    }
                    if (file.action === 'delete')
                        result.deleted.push(file.path);
                    else
                        result.restored.push(file.path);
                }
            }
            catch (error) {
                await this.rollbackJournal(workspace);
                throw error instanceof RewindError ? error : new RewindError('RESTORE_FAILED', 'rewind could not restore every selected file', { cause: error });
            }
            return result;
        });
    }
    /** Drop the journal after the caller has finished the conversation fork. */
    async commit(workspace) {
        await this.ledger.deleteJournal(await canonicalDir(workspace));
    }
    /** Put a workspace back to the bytes from before an unfinished restore. */
    async rollback(workspace) {
        await this.rollbackJournal(await canonicalDir(workspace));
    }
    /** Session disk use, newest activity first. */
    usage() {
        return this.ledger.usage();
    }
    /**
     * Delete one session ledger, or every ledger when `sessionId` is omitted.
     * @param sessionId - Optional session to drop.
     * @returns The number of session ledgers removed.
     */
    purge(sessionId) {
        return this.ledger.purge(sessionId);
    }
    attributionSession(sessionId, parentSessionId, subagent) {
        if (!subagent)
            return sessionId;
        if (!this.current.captureSubagents)
            return undefined;
        if (parentSessionId !== undefined && this.open.has(parentSessionId))
            return parentSessionId;
        return this.open.has(sessionId) ? sessionId : undefined;
    }
    async turnsFor(sessionId, workspace, turn) {
        return (await this.ledger.readTurns(sessionId)).filter(record => record.turn >= turn && record.workspace === workspace);
    }
    addGap(open, path, reason) {
        if (open.gaps.some(gap => gap.path === path && gap.reason === reason))
            return;
        open.gaps.push({ path, reason });
    }
    async storeCaptured(captured) {
        if (captured?.bytes == null || captured.hash == null)
            return;
        const stored = await this.ledger.putBlob(captured.bytes, captured.hash);
        if (stored !== captured.hash)
            throw new RewindError('STATE_CORRUPT', 'captured bytes do not match their hash');
    }
    async flush(open) {
        if (open.userMessageSeq === undefined)
            return;
        const snapshotted = open.baseline !== undefined;
        if (!snapshotted && Object.keys(open.files).length === 0 && open.gaps.length === 0 && !open.shellGap)
            return;
        const record = {
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
        };
        await this.ledger.appendTurn(record);
    }
    async describe(workspace, turns, config) {
        const reduced = reduceTurns(turns);
        const target = earliestTurn(turns);
        if (target?.baseline !== undefined) {
            for (const [path, entry] of Object.entries(target.baseline)) {
                reduced.set(path, { file: baselineAttribution(entry), checkpoint: true });
            }
            if (target.baselineComplete && config.enabled && config.captureExternal) {
                const live = await listEligibleFiles(workspace, config);
                for (const file of live.files) {
                    if (reduced.has(file.relativePath))
                        continue;
                    reduced.set(file.relativePath, { file: createdAttribution(file.mode), checkpoint: true });
                }
            }
        }
        const files = [];
        for (const [path, entry] of [...reduced.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            const described = await this.describePath(workspace, path, entry, config);
            if (entry.checkpoint === true && described.action === 'unchanged')
                continue;
            files.push(described);
        }
        return files;
    }
    async describePath(workspace, path, entry, config) {
        if (entry.checkpoint === true && entry.file !== undefined) {
            const file = entry.file;
            if (file.before === null && !config.restoreCreatedFiles) {
                return { path, action: 'delete', state: 'gap', reason: 'unsupported', before: null, current: null, bytes: 0, mode: file.mode };
            }
            const current = await this.currentBytes(workspace, path, file, config);
            const action = file.before === null
                ? (current.hash === null ? 'unchanged' : 'delete')
                : (current.hash === file.before ? 'unchanged' : 'restore');
            return { path, action, state: 'clean', before: file.before, current: current.hash, bytes: file.beforeBytes, mode: file.mode };
        }
        if (entry.gap !== undefined && entry.file === undefined) {
            return { path, action: 'unchanged', state: 'gap', reason: entry.gap, before: null, current: null, bytes: 0, mode: 0o644 };
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
            };
        }
        const file = entry.file;
        if (file === undefined) {
            return { path, action: 'unchanged', state: 'gap', before: null, current: null, bytes: 0, mode: 0o644 };
        }
        if (file.before === null && !config.restoreCreatedFiles) {
            return { path, action: 'delete', state: 'gap', reason: 'unsupported', before: null, current: null, bytes: 0, mode: file.mode };
        }
        const current = await this.currentBytes(workspace, path, file, config);
        const action = file.before === null
            ? (current.hash === null ? 'unchanged' : 'delete')
            : (current.hash === file.before ? 'unchanged' : 'restore');
        const matchesAfter = current.hash !== null && (current.hash === file.after || current.metadataMatch);
        const matchesBefore = current.hash === file.before;
        const absentDelete = file.before === null && current.hash === null;
        const state = matchesBefore || absentDelete || matchesAfter || (file.before === null && current.hash === file.after) ? 'clean' : 'conflict';
        return { path, action, state, before: file.before, current: current.hash, bytes: file.beforeBytes, mode: file.mode };
    }
    async currentBytes(workspace, path, file, config) {
        if (config.previewTrust === 'metadata' && file.after !== null) {
            try {
                const target = await this.restoreTarget(workspace, path, true);
                const info = await lstat(target);
                if (info.isFile() && !info.isSymbolicLink() && info.size === file.afterSize && Math.trunc(info.mtimeMs) === Math.trunc(file.afterMtimeMs)) {
                    return { hash: file.after, metadataMatch: true };
                }
            }
            catch (error) {
                if (!isNodeError(error, 'ENOENT'))
                    return { hash: null, metadataMatch: false };
            }
        }
        const read = await readCandidate(workspace, path, { maxFileBytes: config.maxFileBytes, allowOutsideWorkspace: true }).catch(() => undefined);
        if (read === undefined || 'reason' in read)
            return { hash: null, metadataMatch: false };
        return { hash: read.captured.hash, metadataMatch: false };
    }
    async restoreTarget(workspace, path, allowOutside) {
        if (isAbsolute(path)) {
            if (!allowOutside)
                throw new RewindError('UNSAFE_PATH', `refusing to restore an outside path: ${JSON.stringify(path)}`);
            return path;
        }
        return resolveContainedPath(workspace, path);
    }
    async rollbackJournal(workspace) {
        const journal = await this.ledger.readJournal(workspace);
        if (journal === undefined)
            return;
        for (const step of [...journal.steps].reverse()) {
            try {
                const target = await this.restoreTarget(workspace, step.path, true);
                const current = await readCandidate(workspace, step.path, {
                    maxFileBytes: this.current.maxFileBytes,
                    allowOutsideWorkspace: true,
                }).catch(() => undefined);
                const hash = current !== undefined && 'captured' in current ? current.captured.hash : null;
                const applied = step.target === null ? hash === null : hash === step.target;
                if (!applied)
                    continue;
                if (step.redo === null) {
                    await removeFile(target);
                    await pruneEmptyParents(workspace, target);
                }
                else {
                    const bytes = await this.ledger.readBlob(step.redo);
                    await replaceRegularFile(target, bytes, step.mode);
                }
            }
            catch {
                // Keep the journal when a single path cannot be put back.
                return;
            }
        }
        await this.ledger.deleteJournal(workspace);
    }
    async exclusivePath(key, task) {
        const previous = this.pathChains.get(key) ?? Promise.resolve();
        let release = () => { };
        const gate = new Promise(resolveGate => { release = resolveGate; });
        const tail = previous.then(() => gate);
        this.pathChains.set(key, tail);
        await previous.catch(() => undefined);
        try {
            await task();
        }
        finally {
            release();
            if (this.pathChains.get(key) === tail)
                this.pathChains.delete(key);
        }
    }
    async exclusive(workspace, task) {
        const previous = this.chains.get(workspace) ?? Promise.resolve();
        let release = () => { };
        const gate = new Promise(resolveGate => { release = resolveGate; });
        const tail = previous.then(() => gate);
        this.chains.set(workspace, tail);
        await previous.catch(() => undefined);
        const unlock = await this.ledger.acquire(workspace);
        try {
            return await task();
        }
        finally {
            await unlock();
            release();
        }
    }
}
function reduceTurns(turns) {
    const paths = new Map();
    for (const turn of turns) {
        if (turn.workspace !== turns[0]?.workspace)
            continue;
        for (const [path, file] of Object.entries(turn.files)) {
            const existing = paths.get(path) ?? {};
            paths.set(path, {
                file: existing.file === undefined ? file : { ...existing.file, after: file.after ?? existing.file.after, afterSize: file.afterSize, afterMtimeMs: file.afterMtimeMs },
                ...(existing.gap === undefined ? {} : { gap: existing.gap }),
            });
        }
        for (const gap of turn.gaps) {
            const existing = paths.get(gap.path) ?? {};
            paths.set(gap.path, { ...existing, gap: gap.reason });
        }
    }
    return paths;
}
function earliestTurn(turns) {
    return turns.reduce((best, record) => {
        if (best === undefined || record.turn < best.turn)
            return record;
        return best;
    }, undefined);
}
function baselineAttribution(entry) {
    return { before: entry.hash, after: null, mode: entry.mode, beforeBytes: entry.bytes, afterSize: 0, afterMtimeMs: 0 };
}
function createdAttribution(mode) {
    return { before: null, after: null, mode, beforeBytes: 0, afterSize: 0, afterMtimeMs: 0 };
}
function attribution(before, after) {
    return {
        before: before.hash,
        after: after?.hash ?? null,
        mode: before.mode || after?.mode || 0o644,
        beforeBytes: before.size,
        afterSize: after?.size ?? 0,
        afterMtimeMs: after?.mtimeMs ?? 0,
    };
}
function withAfter(file, after) {
    return { ...file, after: after.hash, afterSize: after.size, afterMtimeMs: after.mtimeMs };
}
function previewFingerprint(shellGap, files) {
    const lines = [...files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(file => [file.path, file.action, file.state, file.before ?? '', file.current ?? '', file.reason ?? ''].join('\0'));
    return createHash('sha256').update(`${shellGap ? '1' : '0'}\n${lines.join('\n')}`).digest('hex');
}
function selectFiles(files, policy, include) {
    const write = [];
    const unchanged = [];
    const skipped = [];
    for (const file of files) {
        if (file.state === 'gap') {
            skipped.push(file.path);
            continue;
        }
        if (file.state === 'conflict' && policy !== 'overwrite' && !(policy === 'ask' && include.has(file.path))) {
            skipped.push(file.path);
            continue;
        }
        if (file.action === 'unchanged')
            unchanged.push(file.path);
        else
            write.push(file);
    }
    if (policy === 'ask') {
        for (const path of include) {
            if (!files.some(file => file.path === path && file.state === 'conflict')) {
                throw new RewindError('INVALID_ARGUMENTS', `${JSON.stringify(path)} is not a conflicting path`);
            }
        }
    }
    return { write, unchanged, skipped };
}
function journalOf(input, workspace, steps) {
    return { version: 1, sessionId: input.sessionId, workspace, turn: input.turn, startedAt: Date.now(), steps: steps.map(step => ({ ...step })) };
}
function pendingKey(sessionId, callId) {
    return `${sessionId}\0${callId}`;
}
function overlapsStorage(workspace, storageDir) {
    return isWithin(workspace, storageDir) || isWithin(storageDir, workspace);
}
export { retainTurns };
