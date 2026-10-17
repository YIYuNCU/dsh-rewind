/**
 * Accept an empty string, a `~` path, or an absolute path.
 * @param value - Raw storage directory from settings.
 * @returns Trimmed input, or `undefined` when the default root should be used.
 */
export declare function normalizeStorageRequest(value: string): string | undefined;
/** Absolute file that records the directory holding rewind data. */
export declare function resolveLocationFile(explicit: string | undefined): string;
/** True when two paths name the same directory. Windows compares case-insensitively. */
export declare function sameStoragePath(left: string, right: string): boolean;
/** True when `candidate` is `root` or a path inside it. */
export declare function storageContains(root: string, candidate: string): boolean;
/** Read the last directory known to hold rewind data. A missing or unreadable file returns `undefined`. */
export declare function readStorageLocation(file: string): Promise<string | undefined>;
/** Remember the directory that now holds rewind data. */
export declare function writeStorageLocation(file: string, storageDir: string): Promise<void>;
/** True when the directory exists and contains at least one entry. */
export declare function directoryHasEntries(dir: string): Promise<boolean>;
/**
 * Move a rewind storage directory.
 * A missing source only creates the destination. An existing destination must be an empty real directory.
 * @returns Whether the source directory existed and was moved.
 */
export declare function transferStorage(from: string, to: string): Promise<boolean>;
