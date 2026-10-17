/** Closed set of restore failures a caller can branch on. */
export declare const REWIND_CODES: readonly ["INVALID_CONFIG", "INVALID_ARGUMENTS", "STATE_CORRUPT", "NOT_FOUND", "STALE", "BUSY", "UNSAFE_PATH", "RESTORE_FAILED", "RELOCATE_FAILED", "FORK_FAILED", "ORIGIN_REJECTED"];
/** One {@link REWIND_CODES} value. */
export type RewindCode = typeof REWIND_CODES[number];
/** Stable failure from the rewind ledger or its host adapter. */
export declare class RewindError extends Error {
    readonly code: RewindCode;
    readonly name = "RewindError";
    /**
     * @param code - Machine-readable category.
     * @param message - Human-readable diagnostic.
     * @param cause - Optional lower-level failure.
     */
    constructor(code: RewindCode, message: string, options?: {
        readonly cause?: unknown;
    });
}
/** One bounded diagnostic line. */
export declare function errorText(error: unknown): string;
