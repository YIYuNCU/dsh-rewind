import type { Context } from '@deepseek-ai/cordis';
import type { RewindEngine } from './engine.js';
import { type ForkEvent } from './fork.js';
/** Preview and restore route. GET never grants apply authority. */
export declare const REWIND_HTTP_PATH = "/dsh-rewind";
/** Usage and purge route. */
export declare const REWIND_MANAGE_PATH = "/dsh-rewind/manage";
interface SessionLike {
    readonly id: string;
    readonly header?: {
        readonly cwd?: string;
        readonly parentSession?: string;
        readonly origin?: string;
        readonly delegationDepth?: number;
    };
}
interface SessionEventLike extends ForkEvent {
    readonly data?: ForkEvent['data'] & {
        readonly message?: {
            readonly toolCallId?: string;
            readonly isError?: boolean;
        };
    };
}
interface AgentLike {
    readonly status: 'idle' | 'running';
    readonly session: SessionLike;
}
interface ReadSessionResult {
    /** `readSession` returns the header itself. `header` is only a fallback for a nested copy. */
    readonly session: {
        readonly id: string;
        readonly cwd?: string;
        readonly header?: SessionLike['header'];
    };
    readonly events: readonly SessionEventLike[];
}
interface RestartContext {
    get(name: string): unknown;
    readonly agents?: {
        list(): readonly AgentLike[];
    };
    readonly sessionQuery: {
        readSession(id: string): Promise<ReadSessionResult>;
    };
}
/**
 * Record file-tool before-images for the open turn.
 * @param ctx - Host context with agents.
 * @param engine - Attribution ledger.
 */
export declare function installCapture(ctx: Context, engine: RewindEngine): void;
/**
 * Serve preview, restore, and ledger maintenance.
 * @param ctx - Host context with the web server and session reader.
 * @param engine - Attribution ledger.
 */
export declare function installRewindHttp(ctx: Context, engine: RewindEngine): void;
/**
 * Working directory for a rewind request.
 * Official `readSession` puts `cwd` on the header object it returns as `session`.
 * @param ctx - Host context, used when the stored header has no cwd.
 * @param sessionId - Session being rewound.
 * @param session - Header returned by `readSession`, or a nested copy.
 * @returns The absolute cwd, or `undefined` when none is known.
 */
export declare function workspaceOf(ctx: RestartContext, sessionId: string, session: {
    readonly cwd?: string;
    readonly header?: {
        readonly cwd?: string;
    } | undefined;
}): string | undefined;
export {};
