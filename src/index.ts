/**
 * DSH Rewind records the bytes a file tool replaced and can put them back.
 * Conversation rewind forks a new session; it does not truncate the original.
 * @module dsh-rewind
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { RewindEngine } from './engine.js'
import { installCapture, installRewindHttp } from './host.js'
import { RewindSettingsSchema, installRewindSettings } from './settings.js'
import type { RewindConfig } from './types.js'

export { RewindEngine } from './engine.js'
export { RewindError, REWIND_CODES } from './errors.js'
export { planFork } from './fork.js'
export { REWIND_HTTP_PATH, REWIND_MANAGE_PATH } from './host.js'
export { REWIND_SETTINGS_NAMESPACE, RewindSettingsSchema } from './settings.js'
export type { RewindSettings } from './settings.js'
export type {
  ConflictPolicy,
  FileRestoreResult,
  OriginCheck,
  PreviewTrust,
  RewindConfig,
  RewindMode,
  RewindPreview,
  ShellPolicy,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshRewind: RewindService
  }
}

/** Cordis service exposed as `ctx.dshRewind`. */
export class RewindService {
  /** DSH 0.1.7 projects this schema into its settings form. */
  static Config = RewindSettingsSchema
  readonly engine: RewindEngine

  /**
   * @param ctx - Host context.
   * @param config - Composition config. `storageDir` is fixed after this returns.
   */
  constructor(ctx: Context, config: RewindConfig = {}) {
    const normalized = unwrapVolatileConfig(config)
    this.engine = new RewindEngine(normalized)
    ctx.provide('dshRewind', this)
    ctx.logger.info(`[dsh-rewind] v${pluginVersion()} active`)
    ctx.inject(['agents'], (scope: Context) => { installCapture(scope, this.engine) })
    ctx.inject(['webServer', 'sessions', 'sessionQuery', 'agents'], (scope: Context) => {
      installRewindHttp(scope, this.engine)
    })
    installRewindSettings(ctx, normalized, this.engine)
    void this.engine.initialize().then(recovered => {
      if (recovered > 0) ctx.logger.warn(`[dsh-rewind] rolled back ${String(recovered)} interrupted restore(s)`)
      else ctx.logger.info(`[dsh-rewind] ready; state=${this.engine.config.storageDir}`)
    }).catch((error: unknown) => {
      ctx.logger.error(`[dsh-rewind] startup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

export default RewindService

function pluginVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Volatile config values are wrappers in DSH 0.1.7 and plain values on older hosts. */
function unwrapVolatileConfig(config: RewindConfig): RewindConfig {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    result[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get(): unknown }).get()
      : value
  }
  return result as RewindConfig
}
