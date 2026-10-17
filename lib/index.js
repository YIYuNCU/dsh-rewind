/**
 * DSH Rewind records the bytes a file tool replaced and can put them back.
 * Conversation rewind forks a new session; it does not truncate the original.
 * @module dsh-rewind
 */
import { readFileSync } from 'node:fs';
import { RewindEngine } from './engine.js';
import { installCapture, installRewindHttp } from './host.js';
import { RewindSettingsSchema, applyRewindSettings, installRewindSettings } from './settings.js';
export { RewindEngine } from './engine.js';
export { RewindError, REWIND_CODES } from './errors.js';
export { planFork } from './fork.js';
export { REWIND_HTTP_PATH, REWIND_MANAGE_PATH } from './host.js';
export { REWIND_SETTINGS_NAMESPACE, RewindSettingsSchema } from './settings.js';
/** Cordis service exposed as `ctx.dshRewind`. */
export class RewindService {
    /** DSH 0.1.7 projects this schema into its settings form. */
    static Config = RewindSettingsSchema;
    engine;
    /**
     * @param ctx - Host context.
     * @param config - Composition config. A later `storageDir` change moves existing files.
     */
    constructor(ctx, config = {}) {
        const normalized = unwrapVolatileConfig(config);
        this.engine = new RewindEngine(normalized);
        ctx.provide('dshRewind', this);
        ctx.logger.info(`[dsh-rewind] v${pluginVersion()} active`);
        ctx.inject(['agents'], (scope) => { installCapture(scope, this.engine); });
        ctx.inject(['webServer', 'sessions', 'sessionQuery', 'agents'], (scope) => {
            installRewindHttp(scope, this.engine);
        });
        const starting = this.engine.initialize();
        installRewindSettings(ctx, normalized, this.engine);
        ctx.on('loader/volatile-update', () => {
            applyRewindSettings(ctx, this.engine, unwrapVolatileConfig(config));
        });
        void starting.then(recovered => {
            if (recovered > 0)
                ctx.logger.warn(`[dsh-rewind] rolled back ${String(recovered)} interrupted restore(s)`);
            else
                ctx.logger.info(`[dsh-rewind] ready; state=${this.engine.config.storageDir}`);
        }).catch((error) => {
            ctx.logger.error(`[dsh-rewind] startup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
}
export default RewindService;
function pluginVersion() {
    try {
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof manifest.version === 'string' ? manifest.version : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/** Volatile config values are wrappers in DSH 0.1.7 and plain values on older hosts. */
function unwrapVolatileConfig(config) {
    const result = {};
    for (const [key, value] of Object.entries(config)) {
        result[key] = value !== null && typeof value === 'object' && typeof value.get === 'function'
            ? value.get()
            : value;
    }
    return result;
}
