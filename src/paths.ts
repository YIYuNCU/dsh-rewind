import { lstat, mkdir, open, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RewindError } from './errors.js'

/** Convert a workspace-relative path to slash form, rejecting escapes. */
export function validateRelativePath(value: string): string {
  if (value === '' || isAbsolute(value) || value.includes('\0')) {
    throw new RewindError('UNSAFE_PATH', 'restore path must be a relative workspace path')
  }
  const parts = value.split(/[/\\]/u)
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new RewindError('UNSAFE_PATH', `restore path escapes the workspace: ${JSON.stringify(value)}`)
  }
  return parts.join('/')
}

/** True when `candidate` is `root` or a descendant. */
export function isWithin(root: string, candidate: string): boolean {
  const from = resolve(root)
  const to = resolve(candidate)
  if (from === to) return true
  const prefix = from.endsWith(sep) ? from : from + sep
  return to.startsWith(prefix)
}

/**
 * Resolve one attributed path and refuse a symlink parent.
 * @param workspace - Canonical workspace root.
 * @param relativePath - Slash-separated ledger path.
 * @returns The absolute target.
 */
export async function resolveContainedPath(workspace: string, relativePath: string): Promise<string> {
  const safe = validateRelativePath(relativePath)
  const target = resolve(workspace, ...safe.split('/'))
  if (!isWithin(workspace, target)) throw new RewindError('UNSAFE_PATH', `restore path is outside the workspace: ${JSON.stringify(relativePath)}`)
  let current = workspace
  for (const segment of safe.split('/').slice(0, -1)) {
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return target
      throw error
    }
    if (info.isSymbolicLink()) throw new RewindError('UNSAFE_PATH', `restore path traverses a symlink: ${JSON.stringify(relativePath)}`)
    if (!info.isDirectory()) throw new RewindError('UNSAFE_PATH', `restore parent is not a directory: ${JSON.stringify(relativePath)}`)
  }
  return target
}

/**
 * True when a parent of `target` inside `root` is a symlink.
 * @param root - Directory that must contain the walk.
 * @param target - Absolute file path.
 * @returns Whether restore must refuse the path.
 */
export async function hasSymlinkParent(root: string, target: string): Promise<boolean> {
  if (!isWithin(root, target)) return false
  const rel = relative(root, target)
  if (rel === '') return false
  let current = root
  for (const segment of rel.split(sep).slice(0, -1)) {
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      throw error
    }
    if (info.isSymbolicLink()) return true
  }
  return false
}

/** Workspace-relative slash path, or undefined when `target` is outside `root`. */
export function relativePosix(root: string, target: string): string | undefined {
  if (!isWithin(root, target)) return undefined
  const value = relative(root, target)
  if (value === '') return undefined
  return value.split(sep).join('/')
}

/** Replace a regular file via a sibling temporary file. */
export async function replaceRegularFile(path: string, content: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${cryptoName()}.dsh-rewind.tmp`)
  const handle = await open(temporary, 'wx', mode & 0o777)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameReplacing(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  await chmodSafe(path, mode & 0o777)
}

/** Remove one regular file or symlink, never a directory tree. */
export async function removeFile(path: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    throw new RewindError('UNSAFE_PATH', `refusing to remove a directory: ${JSON.stringify(path)}`)
  }
  await unlink(path)
}

/** Remove empty parents created for a restore, stopping at `root`. */
export async function pruneEmptyParents(root: string, target: string): Promise<void> {
  let current = dirname(target)
  while (current !== root && isWithin(root, current)) {
    try {
      await rmdir(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

function cryptoName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}

async function renameReplacing(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'EPERM')) throw error
    await rm(to, { force: true })
    await rename(from, to)
  }
}

async function chmodSafe(path: string, mode: number): Promise<void> {
  const { chmod } = await import('node:fs/promises')
  await chmod(path, mode).catch(() => undefined)
}

/** True when `error` is a Node filesystem error with `code`. */
export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
