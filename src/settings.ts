/**
 * Runtime settings for DSH Rewind.
 * `storageDir` is cordis.yml only and is not hot-swappable.
 * @module dsh-rewind
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import z, { type Schema } from '@deepseek-ai/schemastery'
import { REWIND_DEFAULTS, tunableSettings } from './config.js'
import type { RewindEngine } from './engine.js'
import type { RewindConfig } from './types.js'

/** Settings namespace shared by the host section and the browser card. */
export const REWIND_SETTINGS_NAMESPACE = 'dsh-rewind'

/** Fields the settings card may change without moving the storage root. */
export interface RewindSettings {
  enabled: boolean
  captureSubagents: boolean
  shellPolicy: 'gap' | 'ignore'
  shellTools: string
  extraFileTools: string
  pathFields: string
  excludeGlobs: string
  skipGenerated: boolean
  captureExternal: boolean
  maxSnapshotFiles: number
  maxFileBytes: number
  maxCheckpointsPerSession: number
  retentionDays: number
  maxSessionBytes: number
  maxStorageBytes: number
  maxStoredTurns: number
  conflictPolicy: 'ask' | 'skip' | 'overwrite'
  restoreCreatedFiles: boolean
  blockWhileAgentsRun: boolean
  allowOutsideWorkspace: boolean
  previewTrust: 'content' | 'metadata'
  putPromptInComposer: boolean
  maxPreviewFiles: number
  staleLockMs: number
  originCheck: 'same-origin' | 'off'
  /** Empty uses the default state root. Changing it takes effect on the next launch. */
  storageDir: string
}

/** Older Schemastery releases have no volatile marker. */
function volatileWhenSupported<T>(schema: Schema<T>): Schema<T> {
  const compatible = schema as Schema<T> & { volatile?: () => Schema<T> }
  return typeof compatible.volatile === 'function' ? compatible.volatile() : schema
}

/** Schema projected into DSH 0.1.7 Config and the legacy settings namespace. */
export const RewindSettingsSchema: Schema<RewindSettings> = z.object({
  enabled: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.enabled)),
  captureSubagents: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.captureSubagents)),
  shellPolicy: volatileWhenSupported(z.union(['gap', 'ignore']).default(REWIND_DEFAULTS.shellPolicy)),
  shellTools: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.shellTools)),
  extraFileTools: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.extraFileTools)),
  pathFields: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.pathFields)),
  excludeGlobs: volatileWhenSupported(z.string().default(REWIND_DEFAULTS.excludeGlobs)),
  skipGenerated: volatileWhenSupported(z.boolean().default(REWIND_DEFAULTS.skipGenerated)),
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
  storageDir: z.string().default(''),
})

interface SettingsScopeLike<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void): () => void
}

interface SettingsHooks<T> {
  setSource(current: () => T): void
  onChange(): void
}

interface SettingsProviderLike {
  register?<T>(namespace: string, schema: Schema<T>, options?: { readonly base?: Partial<T> }): SettingsScopeLike<T>
  installSection?<T>(owner: Context, namespace: string, schema: Schema<T>, entry: T, hooks: SettingsHooks<T>): void
}

/**
 * Register the settings namespace and push changes into the running engine.
 * @param ctx - Host context.
 * @param config - Composition config, including the fixed storage root.
 * @param engine - Ledger to update.
 */
export function installRewindSettings(ctx: Context, config: RewindConfig, engine: RewindEngine): void {
  const entry = { ...tunableSettings(engine.config), storageDir: config.storageDir ?? '' }
  let source: () => RewindSettings = () => entry
  const hooks: SettingsHooks<RewindSettings> = {
    setSource: (current) => { source = current },
    onChange: () => {
      try {
        engine.updateConfig({ ...config, ...source(), storageDir: engine.config.storageDir })
        void engine.enforceRetention().catch((retentionError: unknown) => {
          ctx.logger.warn(`[dsh-rewind] could not apply storage limits: ${retentionError instanceof Error ? retentionError.message : String(retentionError)}`)
        })
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] could not apply settings: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
  ctx.inject(['settings'], (scope: Context) => {
    const provider = scope.settings as SettingsProvider & SettingsProviderLike
    if (typeof provider.installSection === 'function') {
      provider.installSection(scope, REWIND_SETTINGS_NAMESPACE, RewindSettingsSchema, entry, hooks)
      return
    }
    if (typeof provider.register !== 'function') return
    const settingsScope = provider.register(REWIND_SETTINGS_NAMESPACE, RewindSettingsSchema, { base: entry }) as SettingsScopeLike<RewindSettings>
    hooks.setSource(() => settingsScope.get())
    scope.effect(() => () => {
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    settingsScope.watch(() => { hooks.onChange() })
  })
}
