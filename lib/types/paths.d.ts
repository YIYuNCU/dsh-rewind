/** Convert a workspace-relative path to slash form, rejecting escapes. */
export declare function validateRelativePath(value: string): string;
/** True when `candidate` is `root` or a descendant. */
export declare function isWithin(root: string, candidate: string): boolean;
/**
 * Resolve one attributed path and refuse a symlink parent.
 * @param workspace - Canonical workspace root.
 * @param relativePath - Slash-separated ledger path.
 * @returns The absolute target.
 */
export declare function resolveContainedPath(workspace: string, relativePath: string): Promise<string>;
/**
 * True when a parent of `target` inside `root` is a symlink.
 * @param root - Directory that must contain the walk.
 * @param target - Absolute file path.
 * @returns Whether restore must refuse the path.
 */
export declare function hasSymlinkParent(root: string, target: string): Promise<boolean>;
/** Workspace-relative slash path, or undefined when `target` is outside `root`. */
export declare function relativePosix(root: string, target: string): string | undefined;
/** Replace a regular file via a sibling temporary file. */
export declare function replaceRegularFile(path: string, content: Buffer, mode: number): Promise<void>;
/** Remove one regular file or symlink, never a directory tree. */
export declare function removeFile(path: string): Promise<void>;
/** Remove empty parents created for a restore, stopping at `root`. */
export declare function pruneEmptyParents(root: string, target: string): Promise<void>;
/** True when `error` is a Node filesystem error with `code`. */
export declare function isNodeError(error: unknown, code: string): boolean;
