import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { resolveStorageDir } from './config.js';
import { RewindError } from './errors.js';
import { isNodeError } from './paths.js';
/**
 * Accept an empty string, a `~` path, or an absolute path.
 * @param value - Raw storage directory from settings.
 * @returns Trimmed input, or `undefined` when the default root should be used.
 */
export function normalizeStorageRequest(value) {
    const trimmed = value.trim();
    if (trimmed === '')
        return undefined;
    if (trimmed.includes('\0'))
        throw new RewindError('INVALID_CONFIG', 'storageDir must not contain a null character');
    if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\') || isAbsolute(trimmed))
        return trimmed;
    throw new RewindError('INVALID_CONFIG', 'storageDir must be an absolute path');
}
/** Absolute file that records the directory holding rewind data. */
export function resolveLocationFile(explicit) {
    if (explicit !== undefined && explicit.trim() !== '')
        return resolve(explicit.trim());
    return join(dirname(resolveStorageDir(undefined)), '.dsh-rewind-location.json');
}
/** True when two paths name the same directory. Windows compares case-insensitively. */
export function sameStoragePath(left, right) {
    return storageKey(left) === storageKey(right);
}
/** True when `candidate` is `root` or a path inside it. */
export function storageContains(root, candidate) {
    const from = storageKey(root);
    const to = storageKey(candidate);
    if (from === to)
        return true;
    const prefix = from.endsWith(sep) ? from : from + sep;
    return to.startsWith(prefix);
}
/** Read the last directory known to hold rewind data. A missing or unreadable file returns `undefined`. */
export async function readStorageLocation(file) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object')
            return undefined;
        const storageDir = parsed.storageDir;
        if (typeof storageDir !== 'string' || storageDir.trim() === '')
            return undefined;
        return resolve(storageDir);
    }
    catch {
        return undefined;
    }
}
/** Remember the directory that now holds rewind data. */
export async function writeStorageLocation(file, storageDir) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ version: 1, storageDir: resolve(storageDir) })}\n`, { mode: 0o600 });
    await rename(temporary, file);
}
/** True when the directory exists and contains at least one entry. */
export async function directoryHasEntries(dir) {
    try {
        const names = await readdir(dir);
        return names.length > 0;
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR'))
            return false;
        throw error;
    }
}
/**
 * Move a rewind storage directory.
 * A missing source only creates the destination. An existing destination must be an empty real directory.
 * @returns Whether the source directory existed and was moved.
 */
export async function transferStorage(from, to) {
    if (sameStoragePath(from, to))
        return false;
    if (storageContains(from, to) || storageContains(to, from)) {
        throw new RewindError('INVALID_CONFIG', 'storageDir must not contain the current storage directory');
    }
    const source = await statIfExists(from);
    if (source === undefined) {
        await mkdir(to, { recursive: true, mode: 0o700 });
        return false;
    }
    if (source.isSymbolicLink() || !source.isDirectory()) {
        throw new RewindError('INVALID_CONFIG', 'current storage directory is not a real directory');
    }
    const destination = await statIfExists(to);
    if (destination?.isSymbolicLink() === true)
        throw new RewindError('INVALID_CONFIG', 'storageDir must not be a symbolic link');
    if (destination !== undefined && !destination.isDirectory()) {
        throw new RewindError('INVALID_CONFIG', 'storageDir exists and is not a directory');
    }
    if (destination !== undefined) {
        const names = await readdir(to);
        if (names.length > 0)
            throw new RewindError('INVALID_CONFIG', 'storageDir is not empty');
        await moveChildren(from, to);
        await rm(from, { recursive: true, force: true });
        return true;
    }
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    try {
        await rename(from, to);
        return true;
    }
    catch (error) {
        if (!isNodeError(error, 'EXDEV'))
            throw new RewindError('RELOCATE_FAILED', 'could not move the storage directory', { cause: error });
    }
    const temporary = join(dirname(to), `.${basename(to)}.${randomBytes(4).toString('hex')}.dsh-rewind-moving`);
    try {
        await cp(from, temporary, { recursive: true, verbatimSymlinks: true });
        await rename(temporary, to);
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw new RewindError('RELOCATE_FAILED', 'could not copy the storage directory', { cause: error });
    }
    await rm(from, { recursive: true, force: true }).catch(() => undefined);
    return true;
}
function storageKey(value) {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
async function statIfExists(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
async function moveChildren(from, to) {
    const names = await readdir(from);
    const moved = [];
    try {
        for (const name of names) {
            await moveEntry(join(from, name), join(to, name));
            moved.push(name);
        }
    }
    catch (error) {
        for (const name of moved.reverse())
            await moveEntry(join(to, name), join(from, name)).catch(() => undefined);
        throw error instanceof RewindError ? error : new RewindError('RELOCATE_FAILED', 'could not move the storage directory', { cause: error });
    }
}
async function moveEntry(from, to) {
    try {
        await rename(from, to);
        return;
    }
    catch (error) {
        if (!isNodeError(error, 'EXDEV'))
            throw error;
    }
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
}
