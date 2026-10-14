import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RewindError } from './errors.js';
import { isNodeError } from './paths.js';
import { REWIND_FORMAT_VERSION } from './types.js';
/**
 * Content-addressed blobs and per-session turn logs.
 * Blobs are written once. A later turn line for the same turn replaces earlier lines on read.
 */
export class Ledger {
    config;
    /**
     * @param config - Resolved config. Only `storageDir` and retention fields are read.
     */
    constructor(config) {
        this.config = config;
    }
    /** Use the latest retention settings without moving the storage root. */
    replaceConfig(config) {
        this.config = config;
    }
    /** Create the state root. */
    async initialize() {
        await mkdir(this.sessionsDir(), { recursive: true, mode: 0o700 });
        await mkdir(this.blobRoot(), { recursive: true, mode: 0o700 });
    }
    /** Store bytes and return their SHA-256. Existing contents are verified. */
    async putBlob(bytes) {
        const hash = createHash('sha256').update(bytes).digest('hex');
        const path = this.blobPath(hash);
        await mkdir(join(this.blobRoot(), hash.slice(0, 2)), { recursive: true, mode: 0o700 });
        try {
            const handle = await open(path, 'wx', 0o600);
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (!isNodeError(error, 'EEXIST'))
                throw error;
            const existing = await readFile(path);
            const actual = createHash('sha256').update(existing).digest('hex');
            if (actual !== hash)
                throw new RewindError('STATE_CORRUPT', `blob ${hash} does not match its name`);
        }
        return hash;
    }
    /** Read a blob and reject a hash mismatch. */
    async readBlob(hash) {
        assertHash(hash);
        const bytes = await readFile(this.blobPath(hash));
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== hash)
            throw new RewindError('STATE_CORRUPT', `blob ${hash} does not match its name`);
        return bytes;
    }
    /** Append one full turn snapshot, then apply retention. */
    async appendTurn(record) {
        const directory = this.sessionDir(record.sessionId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, 'session-id'), record.sessionId, { encoding: 'utf8', mode: 0o600 });
        await appendLine(join(directory, 'turns.jsonl'), `${JSON.stringify(record)}\n`);
        const kept = retainTurns(await this.readTurns(record.sessionId), this.config, Date.now());
        if (kept.length !== collapseTurns(await readLines(join(directory, 'turns.jsonl'))).length) {
            await this.rewriteTurns(record.sessionId, kept);
        }
        await this.enforceGlobalLimits();
    }
    /** Collapsed turn records, oldest first. */
    async readTurns(sessionId) {
        const path = join(this.sessionDir(sessionId), 'turns.jsonl');
        return collapseTurns(await readLines(path)).sort((left, right) => left.turn - right.turn);
    }
    /** Replace the session log with `records` and delete blobs nobody references. */
    async rewriteTurns(sessionId, records) {
        await this.writeTurns(sessionId, records);
        await this.collectGarbage();
    }
    /**
     * Drop the oldest checkpoints across sessions until the global caps fit.
     * The newest remaining checkpoint is kept even when it alone exceeds the byte cap.
     */
    async enforceGlobalLimits() {
        const usage = await this.usage();
        const sessions = [];
        for (const entry of usage) {
            sessions.push({ sessionId: entry.sessionId, turns: await this.readTurns(entry.sessionId) });
        }
        const next = retainGlobal(sessions, this.config);
        let changed = false;
        for (const session of next) {
            const before = sessions.find(item => item.sessionId === session.sessionId);
            if (before === undefined || before.turns.length === session.turns.length)
                continue;
            changed = true;
            if (session.turns.length === 0)
                await rm(this.sessionDir(session.sessionId), { recursive: true, force: true });
            else
                await this.writeTurns(session.sessionId, session.turns);
        }
        if (changed)
            await this.collectGarbage();
    }
    async writeTurns(sessionId, records) {
        const directory = this.sessionDir(sessionId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const body = records.map(record => JSON.stringify(record)).join('\n');
        await atomicWrite(join(directory, 'turns.jsonl'), body === '' ? '' : `${body}\n`);
    }
    /** Disk use of every session log. */
    async usage() {
        const result = [];
        let names;
        try {
            names = await readdir(this.sessionsDir());
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                return [];
            throw error;
        }
        for (const name of names) {
            const directory = join(this.sessionsDir(), name);
            let sessionId;
            try {
                sessionId = (await readFile(join(directory, 'session-id'), 'utf8')).trim();
            }
            catch (error) {
                if (isNodeError(error, 'ENOENT'))
                    continue;
                throw error;
            }
            if (sessionId === '')
                continue;
            const turns = await this.readTurns(sessionId);
            const oldest = turns[0];
            const newest = turns[turns.length - 1];
            if (oldest === undefined || newest === undefined)
                continue;
            result.push({
                sessionId,
                workspace: newest.workspace,
                checkpoints: turns.length,
                bytes: await referencedBytes(turns, hash => this.blobSize(hash)),
                oldestAt: oldest.createdAt,
                newestAt: newest.updatedAt,
            });
        }
        return result.sort((left, right) => (right.newestAt ?? 0) - (left.newestAt ?? 0));
    }
    /** Delete one session log, or every session log, then unreferenced blobs. */
    async purge(sessionId) {
        if (sessionId === undefined) {
            const usage = await this.usage();
            for (const entry of usage)
                await rm(this.sessionDir(entry.sessionId), { recursive: true, force: true });
            await this.collectGarbage();
            return usage.length;
        }
        await rm(this.sessionDir(sessionId), { recursive: true, force: true });
        await this.collectGarbage();
        return 1;
    }
    /** Persist a restore journal before the first mutation. */
    async writeJournal(workspace, journal) {
        const directory = this.workspaceDir(workspace);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await atomicWrite(join(directory, 'journal.json'), `${JSON.stringify(journal)}\n`);
    }
    /** Read the journal for one workspace, if a restore was interrupted. */
    async readJournal(workspace) {
        try {
            return parseJournal(JSON.parse(await readFile(join(this.workspaceDir(workspace), 'journal.json'), 'utf8')));
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                return undefined;
            throw error;
        }
    }
    /** Forget a finished journal. */
    async deleteJournal(workspace) {
        await rm(join(this.workspaceDir(workspace), 'journal.json'), { force: true });
    }
    /** Every workspace directory that still has a journal. */
    async journalWorkspaces() {
        const root = join(this.config.storageDir, 'workspaces');
        let names;
        try {
            names = await readdir(root);
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                return [];
            throw error;
        }
        const workspaces = [];
        for (const name of names) {
            try {
                const journal = parseJournal(JSON.parse(await readFile(join(root, name, 'journal.json'), 'utf8')));
                workspaces.push(journal.workspace);
            }
            catch (error) {
                if (isNodeError(error, 'ENOENT'))
                    continue;
                throw error;
            }
        }
        return workspaces;
    }
    /**
     * Hold the exclusive workspace lock.
     * @param workspace - Canonical workspace path.
     * @returns A release function.
     */
    async acquire(workspace) {
        const directory = this.workspaceDir(workspace);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, 'lock.json');
        const nonce = randomBytes(8).toString('hex');
        const deadline = Date.now() + this.config.staleLockMs;
        for (;;) {
            try {
                const handle = await open(path, 'wx', 0o600);
                await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }));
                await handle.close();
                return async () => {
                    await releaseLock(path, nonce);
                };
            }
            catch (error) {
                if (!isNodeError(error, 'EEXIST'))
                    throw error;
                const current = await readLock(path);
                if (current !== undefined && current.pid !== process.pid && !pidAlive(current.pid) && Date.now() - current.createdAt >= this.config.staleLockMs) {
                    await rm(path, { force: true });
                    continue;
                }
                if (Date.now() > deadline)
                    throw new RewindError('BUSY', 'this workspace already has a rewind restore in progress');
                await delay(25);
            }
        }
    }
    sessionsDir() {
        return join(this.config.storageDir, 'sessions');
    }
    sessionDir(sessionId) {
        return join(this.sessionsDir(), createHash('sha256').update(sessionId).digest('hex').slice(0, 32));
    }
    workspaceDir(workspace) {
        return join(this.config.storageDir, 'workspaces', createHash('sha256').update(workspace).digest('hex').slice(0, 32));
    }
    blobRoot() {
        return join(this.config.storageDir, 'blobs');
    }
    blobPath(hash) {
        assertHash(hash);
        return join(this.blobRoot(), hash.slice(0, 2), hash);
    }
    async blobSize(hash) {
        try {
            return (await stat(this.blobPath(hash))).size;
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                return 0;
            throw error;
        }
    }
    async collectGarbage() {
        const referenced = new Set();
        for (const entry of await this.usage()) {
            for (const turn of await this.readTurns(entry.sessionId))
                collectHashes(turn, referenced);
        }
        for (const workspace of await this.journalWorkspaces()) {
            const journal = await this.readJournal(workspace);
            for (const step of journal?.steps ?? []) {
                if (step.redo !== null)
                    referenced.add(step.redo);
                if (step.target !== null)
                    referenced.add(step.target);
            }
        }
        const root = this.blobRoot();
        let prefixes;
        try {
            prefixes = await readdir(root);
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                return;
            throw error;
        }
        for (const prefix of prefixes) {
            const directory = join(root, prefix);
            let names;
            try {
                names = await readdir(directory);
            }
            catch (error) {
                if (isNodeError(error, 'ENOENT'))
                    continue;
                throw error;
            }
            for (const name of names) {
                if (!referenced.has(name))
                    await rm(join(directory, name), { force: true });
            }
        }
    }
}
/** Keep the newest checkpoints that satisfy age, count, and byte limits. */
export function retainTurns(records, config, now) {
    const cutoff = config.retentionDays === 0 ? undefined : now - config.retentionDays * 24 * 60 * 60 * 1_000;
    let kept = records.filter(record => cutoff === undefined || record.createdAt >= cutoff);
    kept = kept.slice(Math.max(0, kept.length - config.maxCheckpointsPerSession));
    while (kept.length > 1 && estimatedBytes(kept) > config.maxSessionBytes)
        kept = kept.slice(1);
    return kept;
}
/** Drop the oldest checkpoints across sessions until both global caps fit. */
export function retainGlobal(sessions, config) {
    const items = sessions.flatMap(session => session.turns.map(turn => ({ sessionId: session.sessionId, turn })));
    items.sort((left, right) => left.turn.createdAt - right.turn.createdAt || left.turn.turn - right.turn.turn || left.sessionId.localeCompare(right.sessionId));
    while (items.length > 1 && (items.length > config.maxStoredTurns || estimatedBytes(items.map(item => item.turn)) > config.maxStorageBytes)) {
        items.shift();
    }
    return sessions.map(session => ({
        sessionId: session.sessionId,
        turns: items.filter(item => item.sessionId === session.sessionId).map(item => item.turn).sort((left, right) => left.turn - right.turn),
    }));
}
function collapseTurns(lines) {
    const byTurn = new Map();
    for (const line of lines) {
        if (line.trim() === '')
            continue;
        const record = parseTurn(JSON.parse(line));
        byTurn.set(record.turn, record);
    }
    return [...byTurn.values()];
}
function parseTurn(value) {
    if (typeof value !== 'object' || value === null)
        throw new RewindError('STATE_CORRUPT', 'turn record is not an object');
    const record = value;
    if (record.version !== REWIND_FORMAT_VERSION)
        throw new RewindError('STATE_CORRUPT', 'turn record version is not supported');
    if (typeof record.sessionId !== 'string' || typeof record.workspace !== 'string') {
        throw new RewindError('STATE_CORRUPT', 'turn record is missing its session identity');
    }
    const turn = integer(record.turn, 'turn');
    const userMessageSeq = integer(record.userMessageSeq, 'user message');
    return {
        version: REWIND_FORMAT_VERSION,
        sessionId: record.sessionId,
        workspace: record.workspace,
        turn,
        turnStartSeq: numeric(record.turnStartSeq),
        userMessageSeq,
        createdAt: numeric(record.createdAt),
        updatedAt: numeric(record.updatedAt),
        shellGap: record.shellGap === true,
        files: parseFiles(record.files),
        gaps: Array.isArray(record.gaps) ? record.gaps.filter(isGap) : [],
    };
}
function parseFiles(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return {};
    const files = {};
    for (const [path, entry] of Object.entries(value)) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const file = entry;
        files[path] = {
            before: file.before ?? null,
            after: file.after ?? null,
            mode: typeof file.mode === 'number' ? file.mode : 0o644,
            beforeBytes: typeof file.beforeBytes === 'number' ? file.beforeBytes : 0,
            afterSize: typeof file.afterSize === 'number' ? file.afterSize : 0,
            afterMtimeMs: typeof file.afterMtimeMs === 'number' ? file.afterMtimeMs : 0,
        };
    }
    return files;
}
function isGap(value) {
    return typeof value === 'object' && value !== null && typeof value.path === 'string';
}
function parseJournal(value) {
    if (typeof value !== 'object' || value === null)
        throw new RewindError('STATE_CORRUPT', 'restore journal is not an object');
    const journal = value;
    if (journal.version !== REWIND_FORMAT_VERSION || typeof journal.workspace !== 'string' || !Array.isArray(journal.steps)) {
        throw new RewindError('STATE_CORRUPT', 'restore journal is malformed');
    }
    return {
        version: REWIND_FORMAT_VERSION,
        sessionId: typeof journal.sessionId === 'string' ? journal.sessionId : '',
        workspace: journal.workspace,
        turn: numeric(journal.turn),
        startedAt: numeric(journal.startedAt),
        steps: journal.steps.filter(isStep),
    };
}
function isStep(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const step = value;
    return typeof step.path === 'string' && typeof step.done === 'boolean' && typeof step.mode === 'number';
}
function collectHashes(record, into) {
    for (const file of Object.values(record.files)) {
        if (file.before !== null)
            into.add(file.before);
        if (file.after !== null)
            into.add(file.after);
    }
}
function estimatedBytes(records) {
    const hashes = new Set();
    let bytes = 0;
    for (const record of records) {
        for (const file of Object.values(record.files)) {
            if (file.before !== null && !hashes.has(file.before)) {
                hashes.add(file.before);
                bytes += file.beforeBytes;
            }
            if (file.after !== null && !hashes.has(file.after)) {
                hashes.add(file.after);
                bytes += file.afterSize;
            }
        }
    }
    return bytes;
}
async function referencedBytes(records, sizeOf) {
    const hashes = new Set();
    for (const record of records)
        collectHashes(record, hashes);
    let total = 0;
    for (const hash of hashes)
        total += await sizeOf(hash);
    return total;
}
async function readLines(path) {
    try {
        return (await readFile(path, 'utf8')).split('\n');
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return [];
        throw error;
    }
}
async function appendLine(path, line) {
    const handle = await open(path, 'a', 0o600);
    try {
        await handle.writeFile(line);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function atomicWrite(path, body) {
    const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
}
async function releaseLock(path, nonce) {
    const current = await readLock(path);
    if (current?.nonce === nonce)
        await unlink(path).catch(() => undefined);
}
async function readLock(path) {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (typeof value.pid !== 'number' || typeof value.nonce !== 'string' || typeof value.createdAt !== 'number')
            return undefined;
        return { pid: value.pid, nonce: value.nonce, createdAt: value.createdAt };
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return undefined;
        return undefined;
    }
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function assertHash(hash) {
    if (!/^[0-9a-f]{64}$/u.test(hash))
        throw new RewindError('STATE_CORRUPT', 'blob name is not a SHA-256');
}
function numeric(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}
function integer(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new RewindError('STATE_CORRUPT', `turn record has an invalid ${label}`);
    }
    return value;
}
function delay(ms) {
    return new Promise(resolveDelay => { setTimeout(resolveDelay, ms); });
}
