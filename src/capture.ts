import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { ResolvedRewindConfig } from './types.js'
import type { GapReason } from './types.js'
import { hasSymlinkParent, isNodeError, relativePosix } from './paths.js'

/** Bytes of one path before a tool runs. */
export interface CapturedBytes {
  readonly hash: string | null
  readonly bytes: Buffer | null
  readonly mode: number
  readonly size: number
  readonly mtimeMs: number
}

/** A file tool path, a shell gap, or a tool the ledger ignores. */
export type ToolClass = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'shell' } | { readonly kind: 'ignore' }

/**
 * Classify one tool call.
 * Built-in file tools are `write`, `edit`, and mutating `str_replace_editor`.
 * @param name - Wire tool name.
 * @param args - Parsed arguments.
 * @param config - Tool-name settings.
 * @returns The class used by the capture hook.
 */
export function classifyTool(name: string, args: unknown, config: Pick<ResolvedRewindConfig, 'shellTools' | 'extraFileTools' | 'pathFields'>): ToolClass {
  if (config.shellTools.includes(name)) return { kind: 'shell' }
  const builtin = builtinPath(name, args)
  if (builtin !== undefined) return { kind: 'file', path: builtin }
  if (!config.extraFileTools.includes(name)) return { kind: 'ignore' }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { kind: 'ignore' }
  const record = args as Record<string, unknown>
  for (const field of config.pathFields) {
    const value = text(record[field])
    if (value !== undefined) return { kind: 'file', path: value }
  }
  return { kind: 'ignore' }
}

const GENERATED_DIRECTORIES = ['node_modules', '.git', 'dist', 'coverage', '.dsh'] as const

/** True when a relative slash path matches one configured glob. */
export function matchesGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => globToRegExp(pattern).test(path))
}

/**
 * True when any path segment is a generated directory.
 * Matching is by segment, so `distribute` is not `dist`.
 * @param path - Workspace-relative or absolute path.
 */
export function isGeneratedPath(path: string): boolean {
  return path.split(/[/\\]/u).some(part => (GENERATED_DIRECTORIES as readonly string[]).includes(part))
}

/**
 * Read a regular file without following a final symlink.
 * @param workspace - Canonical workspace root.
 * @param requested - Tool argument path.
 * @param config - Size and outside-workspace policy.
 * @returns Captured bytes, or a gap reason.
 */
export async function readCandidate(
  workspace: string,
  requested: string,
  config: Pick<ResolvedRewindConfig, 'maxFileBytes' | 'allowOutsideWorkspace'>,
): Promise<{ readonly relativePath: string; readonly captured: CapturedBytes } | { readonly relativePath: string; readonly reason: GapReason }> {
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested)
  if (await hasSymlinkParent(workspace, absolute)) {
    return { relativePath: relativePosix(workspace, absolute) ?? absolute, reason: 'symlink' }
  }
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) return { relativePath: displayPath(workspace, absolute), reason: 'capture-failed' }
    const relativePath = outsideOrRelative(workspace, absolute, config.allowOutsideWorkspace)
    if (relativePath === undefined) return { relativePath: displayPath(workspace, absolute), reason: 'outside' }
    return {
      relativePath,
      captured: { hash: null, bytes: null, mode: 0o644, size: 0, mtimeMs: 0 },
    }
  }
  const relativePath = outsideOrRelative(workspace, absolute, config.allowOutsideWorkspace)
  if (relativePath === undefined) return { relativePath: displayPath(workspace, absolute), reason: 'outside' }
  if (info.isSymbolicLink()) return { relativePath, reason: 'symlink' }
  if (!info.isFile()) return { relativePath, reason: 'unsupported' }
  if (info.nlink > 1) return { relativePath, reason: 'hardlink' }
  if (info.size > config.maxFileBytes) return { relativePath, reason: 'too-large' }
  const handle = await open(absolute, 'r')
  try {
    const again = await handle.stat()
    if (!again.isFile() || again.size > config.maxFileBytes) return { relativePath, reason: 'too-large' }
    const bytes = await handle.readFile()
    return {
      relativePath,
      captured: {
        hash: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        mode: again.mode & 0o777,
        size: bytes.length,
        mtimeMs: again.mtimeMs,
      },
    }
  } finally {
    await handle.close()
  }
}

/** Canonicalize a directory, or return it unchanged when it does not exist yet. */
export async function canonicalDir(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return resolve(path)
    throw error
  }
}

function builtinPath(name: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  if (name === 'write') return typeof record.content === 'string' ? text(record.file_path) : undefined
  if (name === 'edit') {
    return typeof record.old_string === 'string' && typeof record.new_string === 'string' ? text(record.file_path) : undefined
  }
  if (name === 'str_replace_editor') {
    const command = record.command
    if (command !== 'create' && command !== 'str_replace' && command !== 'insert') return undefined
    return text(record.path)
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function outsideOrRelative(workspace: string, absolute: string, allowOutside: boolean): string | undefined {
  const relativePath = relativePosix(workspace, absolute)
  if (relativePath !== undefined) return relativePath
  if (!allowOutside) return undefined
  return absolute
}

function displayPath(workspace: string, absolute: string): string {
  return relativePosix(workspace, absolute) ?? absolute
}

function globToRegExp(pattern: string): RegExp {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const next = pattern[index + 1]
    if (char === '*' && next === '*') {
      expression += '.*'
      index += 1
      if (pattern[index + 1] === '/') index += 1
      continue
    }
    if (char === '*') {
      expression += '[^/]*'
      continue
    }
    if (char === '?') {
      expression += '[^/]'
      continue
    }
    if (char !== undefined && '.*+?^${}()|[]\\'.includes(char)) expression += `\\${char}`
    else expression += char ?? ''
  }
  expression += '$'
  return new RegExp(expression, 'u')
}
