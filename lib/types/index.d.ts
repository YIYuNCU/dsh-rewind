import type { Context } from '@deepseek-ai/cordis';
import { RewindEngine } from './engine.js';
import type { RewindConfig } from './types.js';
export { RewindEngine } from './engine.js';
export { RewindError, REWIND_CODES } from './errors.js';
export { planFork } from './fork.js';
export { REWIND_HTTP_PATH, REWIND_MANAGE_PATH } from './host.js';
export { REWIND_SETTINGS_NAMESPACE, RewindSettingsSchema } from './settings.js';
export type { RewindSettings } from './settings.js';
export type { ConflictPolicy, FileRestoreResult, OriginCheck, PreviewTrust, RewindConfig, RewindMode, RewindPreview, ShellPolicy, } from './types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        dshRewind: RewindService;
    }
}
/** Cordis service exposed as `ctx.dshRewind`. */
export declare class RewindService {
    /** DSH 0.1.7 projects this schema into its settings form. */
    static Config: import("@deepseek-ai/schemastery").Schema<import("./settings.js").RewindSettings>;
    readonly engine: RewindEngine;
    /**
     * @param ctx - Host context.
     * @param config - Composition config. A later `storageDir` change moves existing files.
     */
    constructor(ctx: Context, config?: RewindConfig);
}
export default RewindService;
