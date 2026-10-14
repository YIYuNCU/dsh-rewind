import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { hasSymlinkParent, isNodeError, relativePosix } from './paths.js';
/**
 * Classify one tool call.
 * Built-in file tools are `write`, `edit`, and mutating `str_replace_editor`.
 * @param name - Wire tool name.
 * @param args - Parsed arguments.
 * @param config - Tool-name settings.
 * @returns The class used by the capture hook.
 */
export function classifyTool(name, args, config) {
    if (config.shellTools.includes(name))
        return { kind: 'shell' };
    const builtin = builtinPath(name, args);
    if (builtin !== undefined)
        return { kind: 'file', path: builtin };
    if (!config.extraFileTools.includes(name))
        return { kind: 'ignore' };
    if (typeof args !== 'object' || args === null || Array.isArray(args))
        return { kind: 'ignore' };
    const record = args;
    for (const field of config.pathFields) {
        const value = text(record[field]);
        if (value !== undefined)
            return { kind: 'file', path: value };
    }
    return { kind: 'ignore' };
}
const GENERATED_DIRECTORIES = ['node_modules', '.git', 'dist', 'coverage', '.dsh'];
/** True when a relative slash path matches one configured glob. */
export function matchesGlob(path, patterns) {
    return patterns.some(pattern => globToRegExp(pattern).test(path));
}
/**
 * True when any path segment is a generated directory.
 * Matching is by segment, so `distribute` is not `dist`.
 * @param path - Workspace-relative or absolute path.
 */
export function isGeneratedPath(path) {
    return path.split(/[/\\]/u).some(part => GENERATED_DIRECTORIES.includes(part));
}
/**
 * Read a regular file without following a final symlink.
 * @param workspace - Canonical workspace root.
 * @param requested - Tool argument path.
 * @param config - Size and outside-workspace policy.
 * @returns Captured bytes, or a gap reason.
 */
export async function readCandidate(workspace, requested, config) {
    const absolute = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
    if (await hasSymlinkParent(workspace, absolute)) {
        return { relativePath: relativePosix(workspace, absolute) ?? absolute, reason: 'symlink' };
    }
    let info;
    try {
        info = await lstat(absolute);
    }
    catch (error) {
        if (!isNodeError(error, 'ENOENT'))
            return { relativePath: displayPath(workspace, absolute), reason: 'capture-failed' };
        const relativePath = outsideOrRelative(workspace, absolute, config.allowOutsideWorkspace);
        if (relativePath === undefined)
            return { relativePath: displayPath(workspace, absolute), reason: 'outside' };
        return {
            relativePath,
            captured: { hash: null, bytes: null, mode: 0o644, size: 0, mtimeMs: 0 },
        };
    }
    const relativePath = outsideOrRelative(workspace, absolute, config.allowOutsideWorkspace);
    if (relativePath === undefined)
        return { relativePath: displayPath(workspace, absolute), reason: 'outside' };
    if (info.isSymbolicLink())
        return { relativePath, reason: 'symlink' };
    if (!info.isFile())
        return { relativePath, reason: 'unsupported' };
    if (info.nlink > 1)
        return { relativePath, reason: 'hardlink' };
    if (info.size > config.maxFileBytes)
        return { relativePath, reason: 'too-large' };
    const handle = await open(absolute, 'r');
    try {
        const again = await handle.stat();
        if (!again.isFile() || again.size > config.maxFileBytes)
            return { relativePath, reason: 'too-large' };
        const bytes = await handle.readFile();
        return {
            relativePath,
            captured: {
                hash: createHash('sha256').update(bytes).digest('hex'),
                bytes,
                mode: again.mode & 0o777,
                size: bytes.length,
                mtimeMs: again.mtimeMs,
            },
        };
    }
    finally {
        await handle.close();
    }
}
/**
 * List regular files without reading them.
 * Generated directories, excluded globs, symlinks, hard links, and oversized files are skipped.
 * A skipped path is not a deletion candidate.
 * @param workspace - Canonical workspace root.
 * @param config - Size and exclusion rules.
 * @param limit - Stop after this many files and mark the walk incomplete.
 */
export async function listEligibleFiles(workspace, config, limit) {
    const files = [];
    let complete = true;
    const walk = async (directory) => {
        if (!complete)
            return;
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            complete = false;
            return;
        }
        const pending = [];
        for (const entry of entries) {
            if (!complete)
                return;
            const absolute = join(directory, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                if (config.skipGenerated && isGeneratedPath(entry.name))
                    continue;
                await walk(absolute);
                continue;
            }
            if (!entry.isFile())
                continue;
            const relativePath = relativePosix(workspace, absolute);
            if (relativePath === undefined)
                continue;
            if ((config.skipGenerated && isGeneratedPath(relativePath)) || matchesGlob(relativePath, config.excludeGlobs))
                continue;
            pending.push({ absolute, relativePath });
        }
        const stats = await runPool(pending, 16, async (item) => {
            try {
                return { ...item, info: await lstat(item.absolute) };
            }
            catch {
                return undefined;
            }
        });
        for (const item of stats) {
            if (!complete)
                return;
            if (item === undefined) {
                complete = false;
                continue;
            }
            const info = item.info;
            if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > config.maxFileBytes)
                continue;
            if (limit !== undefined && files.length >= limit) {
                complete = false;
                return;
            }
            files.push({ relativePath: item.relativePath, mode: info.mode & 0o777, size: info.size });
        }
    };
    await walk(workspace);
    return { files, complete };
}
/**
 * Read regular files inside a workspace for a turn-start snapshot.
 * The walk already skipped symlink parents, so each file is hashed without another parent walk.
 * @param workspace - Canonical workspace root.
 * @param config - Size, exclusion, and snapshot limits.
 * @returns Captured files and whether every eligible file fit in the cap.
 */
export async function scanWorkspace(workspace, config) {
    const listed = await listEligibleFiles(workspace, config, config.maxSnapshotFiles);
    let dropped = false;
    const reads = await runPool(listed.files, 8, async (file) => {
        const absolute = resolve(workspace, ...file.relativePath.split('/'));
        try {
            const captured = await readRegular(absolute, config.maxFileBytes);
            return captured === undefined ? undefined : { relativePath: file.relativePath, captured };
        }
        catch {
            return undefined;
        }
    });
    const files = [];
    for (const item of reads) {
        if (item === undefined) {
            dropped = true;
            continue;
        }
        files.push(item);
    }
    return { files, complete: listed.complete && !dropped };
}
/** Run `task` over `items` with a fixed number of workers. */
export async function runPool(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length)
                return;
            const item = items[index];
            if (item === undefined)
                return;
            results[index] = await task(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}
async function readRegular(absolute, maxFileBytes) {
    const handle = await open(absolute, 'r');
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > maxFileBytes)
            return undefined;
        const bytes = await handle.readFile();
        return {
            hash: createHash('sha256').update(bytes).digest('hex'),
            bytes,
            mode: info.mode & 0o777,
            size: bytes.length,
            mtimeMs: info.mtimeMs,
        };
    }
    finally {
        await handle.close();
    }
}
/** Canonicalize a directory, or return it unchanged when it does not exist yet. */
export async function canonicalDir(path) {
    try {
        return await realpath(path);
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return resolve(path);
        throw error;
    }
}
function builtinPath(name, args) {
    if (typeof args !== 'object' || args === null || Array.isArray(args))
        return undefined;
    const record = args;
    if (name === 'write')
        return typeof record.content === 'string' ? text(record.file_path) : undefined;
    if (name === 'edit') {
        return typeof record.old_string === 'string' && typeof record.new_string === 'string' ? text(record.file_path) : undefined;
    }
    if (name === 'str_replace_editor') {
        const command = record.command;
        if (command !== 'create' && command !== 'str_replace' && command !== 'insert')
            return undefined;
        return text(record.path);
    }
    return undefined;
}
function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function outsideOrRelative(workspace, absolute, allowOutside) {
    const relativePath = relativePosix(workspace, absolute);
    if (relativePath !== undefined)
        return relativePath;
    if (!allowOutside)
        return undefined;
    return absolute;
}
function displayPath(workspace, absolute) {
    return relativePosix(workspace, absolute) ?? absolute;
}
function globToRegExp(pattern) {
    let expression = '^';
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];
        const next = pattern[index + 1];
        if (char === '*' && next === '*') {
            expression += '.*';
            index += 1;
            if (pattern[index + 1] === '/')
                index += 1;
            continue;
        }
        if (char === '*') {
            expression += '[^/]*';
            continue;
        }
        if (char === '?') {
            expression += '[^/]';
            continue;
        }
        if (char !== undefined && '.*+?^${}()|[]\\'.includes(char))
            expression += `\\${char}`;
        else
            expression += char ?? '';
    }
    expression += '$';
    return new RegExp(expression, 'u');
}
