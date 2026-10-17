import { retainTurns } from './ledger.js';
import type { FileRestoreResult, ResolvedRewindConfig, RewindConfig, RewindPreview, SessionUsage } from './types.js';
/**
 * File-attribution ledger plus a turn-start workspace snapshot.
 * The snapshot is what makes manual edits and script edits between turns restorable.
 * Bytes stay outside the user's Git repository.
 */
export declare class RewindEngine {
    private current;
    private readonly ledger;
    private readonly open;
    private readonly pending;
    private readonly chains;
    /** In-flight `beginTurn`, so a tool cannot read a file before its snapshot exists. */
    private readonly turnOpenings;
    /** Serializes before-image reads of one path. The caller may write only after this resolves. */
    private readonly pathChains;
    /** Last settings, so a storage move keeps every other field. */
    private base;
    /** Stable file that records which directory holds the bytes. */
    private readonly locationFile;
    /** Startup work. Storage moves wait for it. */
    private boot?;
    /** In-flight captures and restores. A move waits until this is zero. */
    private storageUsers;
    /** True until startup finishes, and again while files are moving. */
    private storageMoving;
    private readonly storageIdle;
    private readonly storageMoveDone;
    private relocateChain;
    /**
     * @param config - Plugin config. Change the storage root with {@link RewindEngine.relocateStorage}.
     */
    constructor(config?: RewindConfig);
    /** Resolved config. Retention and capture fields update in place. */
    get config(): ResolvedRewindConfig;
    /**
     * Replace runtime settings other than the storage root.
     * @param config - Next config. A different `storageDir` is rejected; use {@link RewindEngine.relocateStorage}.
     */
    updateConfig(config: RewindConfig): void;
    /**
     * Move existing rewind files to `storageDir` and use that directory.
     * An empty string selects the default root. The current directory is a no-op.
     * @param storageDir - Absolute path, `~` path, or empty for the default.
     * @returns The resolved directory and whether a directory was moved.
     */
    relocateStorage(storageDir: string): Promise<{
        storageDir: string;
        moved: boolean;
    }>;
    /** Apply the global storage and turn caps to every session log. */
    enforceRetention(): Promise<void>;
    /** Create storage, finish an interrupted move, and roll back a restore that crashed mid-write. */
    initialize(): Promise<number>;
    private initializeExclusive;
    /**
     * Remember the workspace turn that is about to run.
     * @param input - Identity of the turn.
     */
    beginTurn(input: {
        readonly sessionId: string;
        readonly workspace: string;
        readonly turn: number;
        readonly turnStartSeq: number;
    }): Promise<void>;
    private openTurn;
    private openTurnBody;
    /**
     * Attach the opening user message to the current turn.
     * @param sessionId - Session that owns the message.
     * @param turn - Turn number.
     * @param userMessageSeq - Event sequence of the direct user message.
     */
    noteUserMessage(sessionId: string, turn: number, userMessageSeq: number): Promise<void>;
    private noteUserMessageBody;
    /**
     * Record a before-image when a file tool is about to run.
     * Failures become gaps. They do not fail the tool.
     * @param input - Tool call identity and arguments.
     */
    captureBefore(input: {
        readonly sessionId: string;
        readonly parentSessionId?: string;
        readonly subagent: boolean;
        readonly callId: string;
        readonly toolName: string;
        readonly args: unknown;
    }): Promise<void>;
    private captureBeforeBody;
    /**
     * Commit or drop the before-image after the tool result.
     * @param input - Call identity and whether the tool succeeded.
     */
    captureAfter(input: {
        readonly sessionId: string;
        readonly parentSessionId?: string;
        readonly subagent: boolean;
        readonly callId: string;
        readonly toolName: string;
        readonly ok: boolean;
    }): Promise<void>;
    private captureAfterBody;
    /**
     * Compare the attributed paths at and after `turn` with the worktree.
     * @param input - Session, canonical workspace, and turn.
     * @returns A fingerprint of every path, plus the first preview page.
     */
    preview(input: {
        readonly sessionId: string;
        readonly workspace: string;
        readonly turn: number;
        readonly userMessageSeq?: number;
    }): Promise<RewindPreview>;
    private previewBody;
    /**
     * Write attributed paths back to their before-images.
     * The journal stays until {@link RewindEngine.commit} or {@link RewindEngine.rollback}.
     * @param input - Preview fingerprint and conflict selection.
     * @returns Paths written, deleted, already matching, or skipped.
     */
    apply(input: {
        readonly sessionId: string;
        readonly workspace: string;
        readonly turn: number;
        readonly userMessageSeq?: number;
        readonly fingerprint: string;
        readonly includeConflicts?: readonly string[];
        readonly workspaceBusy?: boolean;
    }): Promise<FileRestoreResult>;
    private applyBody;
    /** Drop the journal after the caller has finished the conversation fork. */
    commit(workspace: string): Promise<void>;
    /** Put a workspace back to the bytes from before an unfinished restore. */
    rollback(workspace: string): Promise<void>;
    /** Session disk use, newest activity first. */
    usage(): Promise<SessionUsage[]>;
    /**
     * Delete one session ledger, or every ledger when `sessionId` is omitted.
     * @param sessionId - Optional session to drop.
     * @returns The number of session ledgers removed.
     */
    purge(sessionId?: string): Promise<number>;
    private relocateExclusive;
    /** Move files, then point the ledger at the new root. A failed location write moves the files back. */
    private transferTo;
    /** Finish a move whose saved directory is empty and whose recorded directory still has files. */
    private finishPendingTransfer;
    private useStorage;
    private enterStorage;
    private leaveStorage;
    private releaseMove;
    private attributionSession;
    private turnsFor;
    private addGap;
    private storeCaptured;
    private flush;
    private describe;
    private describePath;
    private currentBytes;
    private restoreTarget;
    private rollbackJournal;
    private exclusivePath;
    private exclusive;
}
export { retainTurns };
