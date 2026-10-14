import { REWIND_FORMAT_VERSION, type ResolvedRewindConfig, type SessionUsage, type TurnRecord } from './types.js';
/** One in-flight file restore, durable across a crash. */
export interface RestoreJournal {
    readonly version: typeof REWIND_FORMAT_VERSION;
    readonly sessionId: string;
    readonly workspace: string;
    readonly turn: number;
    readonly startedAt: number;
    readonly steps: readonly JournalStep[];
}
/** One path the restore intended to change. */
export interface JournalStep {
    readonly path: string;
    readonly redo: string | null;
    readonly target: string | null;
    readonly mode: number;
    readonly done: boolean;
}
/**
 * Content-addressed blobs and per-session turn logs.
 * Blobs are written once. A later turn line for the same turn replaces earlier lines on read.
 */
export declare class Ledger {
    private config;
    /**
     * @param config - Resolved config. Only `storageDir` and retention fields are read.
     */
    constructor(config: ResolvedRewindConfig);
    /** Use the latest retention settings without moving the storage root. */
    replaceConfig(config: ResolvedRewindConfig): void;
    /** Create the state root. */
    initialize(): Promise<void>;
    /** Store bytes and return their SHA-256. Existing contents are verified. */
    putBlob(bytes: Buffer): Promise<string>;
    /** Read a blob and reject a hash mismatch. */
    readBlob(hash: string): Promise<Buffer>;
    /** Append one full turn snapshot, then apply retention. */
    appendTurn(record: TurnRecord): Promise<void>;
    /** Collapsed turn records, oldest first. */
    readTurns(sessionId: string): Promise<TurnRecord[]>;
    /** Replace the session log with `records` and delete blobs nobody references. */
    rewriteTurns(sessionId: string, records: readonly TurnRecord[]): Promise<void>;
    /**
     * Drop the oldest checkpoints across sessions until the global caps fit.
     * The newest remaining checkpoint is kept even when it alone exceeds the byte cap.
     */
    enforceGlobalLimits(): Promise<void>;
    private writeTurns;
    /** Disk use of every session log. */
    usage(): Promise<SessionUsage[]>;
    /** Delete one session log, or every session log, then unreferenced blobs. */
    purge(sessionId?: string): Promise<number>;
    /** Persist a restore journal before the first mutation. */
    writeJournal(workspace: string, journal: RestoreJournal): Promise<void>;
    /** Read the journal for one workspace, if a restore was interrupted. */
    readJournal(workspace: string): Promise<RestoreJournal | undefined>;
    /** Forget a finished journal. */
    deleteJournal(workspace: string): Promise<void>;
    /** Every workspace directory that still has a journal. */
    journalWorkspaces(): Promise<readonly string[]>;
    /**
     * Hold the exclusive workspace lock.
     * @param workspace - Canonical workspace path.
     * @returns A release function.
     */
    acquire(workspace: string): Promise<() => Promise<void>>;
    private sessionsDir;
    private sessionDir;
    private workspaceDir;
    private blobRoot;
    private blobPath;
    private blobSize;
    private collectGarbage;
}
interface SessionTurns {
    readonly sessionId: string;
    readonly turns: readonly TurnRecord[];
}
/** Keep the newest checkpoints that satisfy age, count, and byte limits. */
export declare function retainTurns(records: readonly TurnRecord[], config: Pick<ResolvedRewindConfig, 'retentionDays' | 'maxCheckpointsPerSession' | 'maxSessionBytes'>, now: number): TurnRecord[];
/** Drop the oldest checkpoints across sessions until both global caps fit. */
export declare function retainGlobal(sessions: readonly SessionTurns[], config: Pick<ResolvedRewindConfig, 'maxStoredTurns' | 'maxStorageBytes'>): SessionTurns[];
export {};
