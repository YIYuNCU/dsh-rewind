import { retainTurns } from './ledger.js';
import type { FileRestoreResult, ResolvedRewindConfig, RewindConfig, RewindPreview, SessionUsage } from './types.js';
/**
 * File-attribution ledger.
 * It stores the before-image of file tools only, and it never writes into the user's Git repository.
 */
export declare class RewindEngine {
    private current;
    private readonly ledger;
    private readonly open;
    private readonly pending;
    private readonly chains;
    /**
     * @param config - Plugin config. The storage root is fixed after construction.
     */
    constructor(config?: RewindConfig);
    /** Resolved config. Retention and capture fields update in place; the storage root does not. */
    get config(): ResolvedRewindConfig;
    /**
     * Replace runtime settings.
     * @param config - Next config. A different `storageDir` is rejected.
     */
    updateConfig(config: RewindConfig): void;
    /** Apply the global storage and turn caps to every session log. */
    enforceRetention(): Promise<void>;
    /** Create storage and roll back a restore that crashed mid-write. */
    initialize(): Promise<number>;
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
    /**
     * Attach the opening user message to the current turn.
     * @param sessionId - Session that owns the message.
     * @param turn - Turn number.
     * @param userMessageSeq - Event sequence of the direct user message.
     */
    noteUserMessage(sessionId: string, turn: number, userMessageSeq: number): Promise<void>;
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
    private exclusive;
}
export { retainTurns };
