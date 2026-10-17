import z, {} from '@deepseek-ai/schemastery';
import { REWIND_DEFAULTS, tunableSettings } from './config.js';
/** Settings namespace shared by the host section and the browser card. */
export const REWIND_SETTINGS_NAMESPACE = 'dsh-rewind';
/** Older Schemastery releases have no volatile marker. */
function volatileWhenSupported(schema) {
    const compatible = schema;
    return typeof compatible.volatile === 'function' ? compatible.volatile() : schema;
}
/** Schema projected into DSH 0.1.7 Config and the legacy settings namespace. */
export const RewindSettingsSchema = z.object({
    enabled: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.enabled)),
    captureSubagents: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.captureSubagents)),
    shellPolicy: volatileWhenSupported(z.union(['gap', 'ignore']).default(REWIND_DEFAULTS.shellPolicy)),
    shellTools: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.shellTools)),
    extraFileTools: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.extraFileTools)),
    pathFields: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.pathFields)),
    excludeGlobs: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.excludeGlobs)),
    skipGenerated: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.skipGenerated)),
    generatedDirectories: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.generatedDirectories)),
    captureExternal: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.captureExternal)),
    maxSnapshotFiles: volatileWhenSupported(z.number().step(1).min(1).max(100_000).default(REWIND_DEFAULTS.maxSnapshotFiles)),
    maxFileBytes: volatileWhenSupported(z.number().step(1).min(1).default(REWIND_DEFAULTS.maxFileBytes)),
    maxCheckpointsPerSession: volatileWhenSupported(z.number().step(1).min(1).default(REWIND_DEFAULTS.maxCheckpointsPerSession)),
    retentionDays: volatileWhenSupported(z.number().step(1).min(0).default(REWIND_DEFAULTS.retentionDays)),
    maxSessionBytes: volatileWhenSupported(z.number().step(1).min(1).default(REWIND_DEFAULTS.maxSessionBytes)),
    maxStorageBytes: volatileWhenSupported(z.number().step(1).min(1).default(REWIND_DEFAULTS.maxStorageBytes)),
    maxStoredTurns: volatileWhenSupported(z.number().step(1).min(1).default(REWIND_DEFAULTS.maxStoredTurns)),
    conflictPolicy: volatileWhenSupported(z.union(['ask', 'skip', 'overwrite']).default(REWIND_DEFAULTS.conflictPolicy)),
    restoreCreatedFiles: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.restoreCreatedFiles)),
    blockWhileAgentsRun: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.blockWhileAgentsRun)),
    allowOutsideWorkspace: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.allowOutsideWorkspace)),
    previewTrust: volatileWhenSupported(z.union(['content', 'metadata']).default(REWIND_DEFAULTS.previewTrust)),
    putPromptInComposer: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.putPromptInComposer)),
    maxPreviewFiles: volatileWhenSupported(z.number().step(1).min(1).max(1_000).default(REWIND_DEFAULTS.maxPreviewFiles)),
    staleLockMs: volatileWhenSupported(z.number().step(1).min(1_000).default(REWIND_DEFAULTS.staleLockMs)),
    originCheck: volatileWhenSupported(z.union(['same-origin', 'off']).default(REWIND_DEFAULTS.originCheck)),
    storageDir: volatileWhenSupported(z.string().default('')),
});
/**
 * Apply one settings snapshot. A different storage directory moves existing files.
 * @param ctx - Host context. Failures are logged, not thrown.
 * @param engine - Ledger to update.
 * @param next - Settings to apply, including the raw storage directory.
 */
export function applyRewindSettings(ctx, engine, next) {
    try {
        engine.updateConfig({ ...next, storageDir: engine.config.storageDir });
    }
    catch (error) {
        ctx.logger.warn(`[dsh-rewind] could not apply settings: ${error instanceof Error ? error.message : String(error)}`);
    }
    const storageDir = typeof next.storageDir === 'string' ? next.storageDir : '';
    void engine.relocateStorage(storageDir).then(() => engine.enforceRetention()).catch((error) => {
        ctx.logger.warn(`[dsh-rewind] could not apply storage settings: ${error instanceof Error ? error.message : String(error)}`);
    });
}
/**
 * Register the settings namespace and push changes into the running engine.
 * @param ctx - Host context.
 * @param config - Composition config, including the storage root.
 * @param engine - Ledger to update.
 */
export function installRewindSettings(ctx, config, engine) {
    const entry = { ...tunableSettings(engine.config), storageDir: config.storageDir ?? '' };
    let source = () => entry;
    const hooks = {
        setSource: (current) => { source = current; },
        onChange: () => { applyRewindSettings(ctx, engine, { ...config, ...source() }); },
    };
    ctx.inject(['settings'], (scope) => {
        const provider = scope.settings;
        if (typeof provider.installSection === 'function') {
            provider.installSection(scope, REWIND_SETTINGS_NAMESPACE, RewindSettingsSchema, entry, hooks);
            return;
        }
        if (typeof provider.register !== 'function')
            return;
        const settingsScope = provider.register(REWIND_SETTINGS_NAMESPACE, RewindSettingsSchema, { base: entry });
        hooks.setSource(() => settingsScope.get());
        scope.effect(() => () => {
            hooks.setSource(() => entry);
            hooks.onChange();
        });
        hooks.onChange();
        settingsScope.watch(() => { hooks.onChange(); });
    });
}
