import type { ResolvedRewindConfig } from './types.js';
import type { GapReason } from './types.js';
/** Bytes of one path before a tool runs. */
export interface CapturedBytes {
    readonly hash: string | null;
    readonly bytes: Buffer | null;
    readonly mode: number;
    readonly size: number;
    readonly mtimeMs: number;
}
/** A file tool path, a shell gap, or a tool the ledger ignores. */
export type ToolClass = {
    readonly kind: 'file';
    readonly path: string;
} | {
    readonly kind: 'shell';
} | {
    readonly kind: 'ignore';
};
/**
 * Classify one tool call.
 * Built-in file tools are `write`, `edit`, and mutating `str_replace_editor`.
 * @param name - Wire tool name.
 * @param args - Parsed arguments.
 * @param config - Tool-name settings.
 * @returns The class used by the capture hook.
 */
export declare function classifyTool(name: string, args: unknown, config: Pick<ResolvedRewindConfig, 'shellTools' | 'extraFileTools' | 'pathFields'>): ToolClass;
/** True when a relative slash path matches one configured glob. */
export declare function matchesGlob(path: string, patterns: readonly string[]): boolean;
/**
 * True when any path segment is a generated directory.
 * Matching is by segment, so `distribute` is not `dist`.
 * @param path - Workspace-relative or absolute path.
 */
export declare function isGeneratedPath(path: string): boolean;
/**
 * Read a regular file without following a final symlink.
 * @param workspace - Canonical workspace root.
 * @param requested - Tool argument path.
 * @param config - Size and outside-workspace policy.
 * @returns Captured bytes, or a gap reason.
 */
export declare function readCandidate(workspace: string, requested: string, config: Pick<ResolvedRewindConfig, 'maxFileBytes' | 'allowOutsideWorkspace'>): Promise<{
    readonly relativePath: string;
    readonly captured: CapturedBytes;
} | {
    readonly relativePath: string;
    readonly reason: GapReason;
}>;
/** Canonicalize a directory, or return it unchanged when it does not exist yet. */
export declare function canonicalDir(path: string): Promise<string>;
