import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { RewindError } from './errors.js'
import type { ConflictPolicy, OriginCheck, PreviewTrust, ResolvedRewindConfig, RewindConfig, ShellPolicy } from './types.js'

const DEFAULT_SHELL_TOOLS = ['bash', 'shell', 'run_code', 'terminal'] as const
const DEFAULT_PATH_FIELDS = ['file_path', 'path'] as const
/**
 * Generated and temporary directory names for common languages and tools.
 * A name matches one path segment. `*.suffix` matches a segment that ends with `.suffix`.
 * Source names such as `src` and `lib` are omitted on purpose.
 */
const DEFAULT_GENERATED_DIRECTORIES = [
  'node_modules', 'bower_components', 'dist', 'build', 'out', 'coverage', '.nyc_output', 'htmlcov',
  '.next', '.nuxt', '.output', '.svelte-kit', '.astro', '.angular', '.turbo', '.parcel-cache',
  '.cache', '.vite', '.docusaurus', '.vuepress', 'storybook-static', '.nx',
  '.git', '.dsh', 'tmp', 'temp', 'Temp', '.tmp', '.temp', 'cache',
  '__pycache__', '.venv', 'venv', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.hypothesis', '.pytype', '.pyre', '.eggs', 'site-packages', '.ipynb_checkpoints', '*.egg-info',
  'target', '.gradle', 'bin', 'obj', 'Obj', 'TestResults', '.vs', 'ipch', 'Debug', 'Release',
  'x64', 'x86', 'ARM', 'ARM64', 'CMakeFiles', 'cmake-build-debug', 'cmake-build-release',
  'cmake-build-relwithdebinfo', 'cmake-build-minsizerel',
  'vendor', '.bundle', '.yardoc', '_build', 'deps', '.elixir_ls', 'dist-newstyle', '.stack-work', '_opam',
  '.build', 'DerivedData', '.swiftpm', 'Pods', 'xcuserdata', '.dart_tool', 'zig-out', 'zig-cache',
  '.zig-cache', 'nimcache', 'blib', 'lua_modules', '.dub',
  'bazel-bin', 'bazel-out', 'bazel-testlogs', 'bazel-genfiles', 'buck-out', '.terraform', '.terragrunt-cache', '.direnv',
  '.externalNativeBuild', '.cxx',
  'Library', 'Logs', 'MemoryCaptures', 'Binaries', 'DerivedDataCache', 'Intermediate', 'Saved',
  '.godot', '.import', '_site', '.jekyll-cache', '.sass-cache', '.Rproj.user',
  'test-results', 'playwright-report', 'blob-report',
] as const

/** Built-in defaults. Numeric settings are bytes, days, or milliseconds as named. */
export const REWIND_DEFAULTS = {
  enabled: true,
  captureSubagents: true,
  shellPolicy: 'gap' as const,
  shellTools: DEFAULT_SHELL_TOOLS.join(','),
  extraFileTools: '',
  pathFields: DEFAULT_PATH_FIELDS.join(','),
  excludeGlobs: '',
  skipGenerated: true,
  generatedDirectories: DEFAULT_GENERATED_DIRECTORIES.join(','),
  captureExternal: true,
  maxSnapshotFiles: 2_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxCheckpointsPerSession: 100,
  retentionDays: 30,
  maxSessionBytes: 512 * 1024 * 1024,
  maxStorageBytes: 2 * 1024 * 1024 * 1024,
  maxStoredTurns: 1_000,
  conflictPolicy: 'ask' as const,
  restoreCreatedFiles: true,
  blockWhileAgentsRun: true,
  allowOutsideWorkspace: false,
  previewTrust: 'content' as const,
  putPromptInComposer: true,
  maxPreviewFiles: 200,
  staleLockMs: 30_000,
  originCheck: 'same-origin' as const,
}

/**
 * Resolve and validate config.
 * An empty `storageDir` becomes `$DSH_HOME/rewind/v1` or `~/.dsh/rewind/v1`.
 * @param config - Partial plugin config.
 * @returns A complete config.
 */
export function resolveConfig(config: RewindConfig = {}): ResolvedRewindConfig {
  return {
    storageDir: resolveStorageDir(config.storageDir),
    enabled: bool(config.enabled, REWIND_DEFAULTS.enabled, 'enabled'),
    captureSubagents: bool(config.captureSubagents, REWIND_DEFAULTS.captureSubagents, 'captureSubagents'),
    shellPolicy: keyword(config.shellPolicy, ['gap', 'ignore'], REWIND_DEFAULTS.shellPolicy, 'shellPolicy'),
    shellTools: csv(config.shellTools ?? REWIND_DEFAULTS.shellTools),
    extraFileTools: csv(config.extraFileTools ?? REWIND_DEFAULTS.extraFileTools),
    pathFields: csv(config.pathFields ?? REWIND_DEFAULTS.pathFields),
    excludeGlobs: splitList(config.excludeGlobs ?? REWIND_DEFAULTS.excludeGlobs, '\n'),
    skipGenerated: bool(config.skipGenerated, REWIND_DEFAULTS.skipGenerated, 'skipGenerated'),
    generatedDirectories: directoryNames(config.generatedDirectories ?? REWIND_DEFAULTS.generatedDirectories),
    captureExternal: bool(config.captureExternal, REWIND_DEFAULTS.captureExternal, 'captureExternal'),
    maxSnapshotFiles: bounded(config.maxSnapshotFiles, REWIND_DEFAULTS.maxSnapshotFiles, 1, 100_000, 'maxSnapshotFiles'),
    maxFileBytes: positive(config.maxFileBytes, REWIND_DEFAULTS.maxFileBytes, 'maxFileBytes'),
    maxCheckpointsPerSession: positive(
      config.maxCheckpointsPerSession,
      REWIND_DEFAULTS.maxCheckpointsPerSession,
      'maxCheckpointsPerSession',
    ),
    retentionDays: nonNegative(config.retentionDays, REWIND_DEFAULTS.retentionDays, 'retentionDays'),
    maxSessionBytes: positive(config.maxSessionBytes, REWIND_DEFAULTS.maxSessionBytes, 'maxSessionBytes'),
    maxStorageBytes: positive(config.maxStorageBytes, REWIND_DEFAULTS.maxStorageBytes, 'maxStorageBytes'),
    maxStoredTurns: positive(config.maxStoredTurns, REWIND_DEFAULTS.maxStoredTurns, 'maxStoredTurns'),
    conflictPolicy: keyword(config.conflictPolicy, ['ask', 'skip', 'overwrite'], REWIND_DEFAULTS.conflictPolicy, 'conflictPolicy'),
    restoreCreatedFiles: bool(config.restoreCreatedFiles, REWIND_DEFAULTS.restoreCreatedFiles, 'restoreCreatedFiles'),
    blockWhileAgentsRun: bool(config.blockWhileAgentsRun, REWIND_DEFAULTS.blockWhileAgentsRun, 'blockWhileAgentsRun'),
    allowOutsideWorkspace: bool(config.allowOutsideWorkspace, REWIND_DEFAULTS.allowOutsideWorkspace, 'allowOutsideWorkspace'),
    previewTrust: keyword(config.previewTrust, ['content', 'metadata'], REWIND_DEFAULTS.previewTrust, 'previewTrust'),
    putPromptInComposer: bool(config.putPromptInComposer, REWIND_DEFAULTS.putPromptInComposer, 'putPromptInComposer'),
    maxPreviewFiles: bounded(config.maxPreviewFiles, REWIND_DEFAULTS.maxPreviewFiles, 1, 1_000, 'maxPreviewFiles'),
    staleLockMs: bounded(config.staleLockMs, REWIND_DEFAULTS.staleLockMs, 1_000, 24 * 60 * 60 * 1_000, 'staleLockMs'),
    originCheck: keyword(config.originCheck, ['same-origin', 'off'], REWIND_DEFAULTS.originCheck, 'originCheck'),
  }
}

/** Settings-card fields. `storageDir` stays on the cordis config layer. */
export function tunableSettings(config: ResolvedRewindConfig): Omit<ResolvedRewindConfig, 'storageDir' | 'shellTools' | 'extraFileTools' | 'pathFields' | 'excludeGlobs' | 'generatedDirectories'> & {
  shellTools: string
  extraFileTools: string
  pathFields: string
  excludeGlobs: string
  generatedDirectories: string
} {
  return {
    enabled: config.enabled,
    captureSubagents: config.captureSubagents,
    shellPolicy: config.shellPolicy,
    shellTools: config.shellTools.join(','),
    extraFileTools: config.extraFileTools.join(','),
    pathFields: config.pathFields.join(','),
    excludeGlobs: config.excludeGlobs.join('\n'),
    skipGenerated: config.skipGenerated,
    generatedDirectories: config.generatedDirectories.join(','),
    captureExternal: config.captureExternal,
    maxSnapshotFiles: config.maxSnapshotFiles,
    maxFileBytes: config.maxFileBytes,
    maxCheckpointsPerSession: config.maxCheckpointsPerSession,
    retentionDays: config.retentionDays,
    maxSessionBytes: config.maxSessionBytes,
    maxStorageBytes: config.maxStorageBytes,
    maxStoredTurns: config.maxStoredTurns,
    conflictPolicy: config.conflictPolicy,
    restoreCreatedFiles: config.restoreCreatedFiles,
    blockWhileAgentsRun: config.blockWhileAgentsRun,
    allowOutsideWorkspace: config.allowOutsideWorkspace,
    previewTrust: config.previewTrust,
    putPromptInComposer: config.putPromptInComposer,
    maxPreviewFiles: config.maxPreviewFiles,
    staleLockMs: config.staleLockMs,
    originCheck: config.originCheck,
  }
}

function resolveStorageDir(value: string | undefined): string {
  if (value !== undefined && value.trim() !== '') return resolve(expandHome(value.trim()))
  const home = process.env.DSH_HOME
  const root = home !== undefined && home.trim() !== '' ? resolve(expandHome(home.trim())) : join(homedir(), '.dsh')
  return join(root, 'rewind', 'v1')
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function bool(value: boolean | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new RewindError('INVALID_CONFIG', `${name} must be a boolean`)
  return value
}

function keyword<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) throw new RewindError('INVALID_CONFIG', `${name} must be ${allowed.join(' or ')}`)
  return value
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new RewindError('INVALID_CONFIG', `${name} must be a positive integer`)
  return value
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new RewindError('INVALID_CONFIG', `${name} must be a non-negative integer`)
  return value
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = positive(value, fallback, name)
  if (resolved < min || resolved > max) throw new RewindError('INVALID_CONFIG', `${name} must be between ${String(min)} and ${String(max)}`)
  return resolved
}

function csv(value: string): readonly string[] {
  return splitList(value, ',')
}

/** A directory name, or `*.suffix` for a segment that ends with that suffix. */
function directoryNames(value: string): readonly string[] {
  const names = csv(value)
  for (const name of names) {
    if (!validDirectoryName(name)) {
      throw new RewindError('INVALID_CONFIG', 'generatedDirectories entries must be one directory name, or *.suffix')
    }
  }
  return names
}

function validDirectoryName(name: string): boolean {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return false
  if (!name.includes('*')) return true
  return name.startsWith('*.') && name.length > 2 && !name.includes('*', 1)
}

function splitList(value: string, separator: string): readonly string[] {
  if (value.length > 8_000) throw new RewindError('INVALID_CONFIG', 'list settings must be at most 8000 characters')
  const items: string[] = []
  for (const part of value.split(separator)) {
    const trimmed = part.trim()
    if (trimmed !== '' && !items.includes(trimmed)) items.push(trimmed)
  }
  return items
}

export type { ConflictPolicy, OriginCheck, PreviewTrust, ShellPolicy }
