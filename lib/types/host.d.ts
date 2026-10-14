import type { Context } from '@deepseek-ai/cordis';
import type { RewindEngine } from './engine.js';
/** Preview and restore route. GET never grants apply authority. */
export declare const REWIND_HTTP_PATH = "/dsh-rewind";
/** Usage and purge route. */
export declare const REWIND_MANAGE_PATH = "/dsh-rewind/manage";
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
