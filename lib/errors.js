/** Closed set of restore failures a caller can branch on. */
export const REWIND_CODES = [
    'INVALID_CONFIG',
    'INVALID_ARGUMENTS',
    'STATE_CORRUPT',
    'NOT_FOUND',
    'STALE',
    'BUSY',
    'UNSAFE_PATH',
    'RESTORE_FAILED',
    'RELOCATE_FAILED',
    'FORK_FAILED',
    'ORIGIN_REJECTED',
];
/** Stable failure from the rewind ledger or its host adapter. */
export class RewindError extends Error {
    code;
    name = 'RewindError';
    /**
     * @param code - Machine-readable category.
     * @param message - Human-readable diagnostic.
     * @param cause - Optional lower-level failure.
     */
    constructor(code, message, options) {
        super(`[${code}] ${message}`, options);
        this.code = code;
    }
}
/** One bounded diagnostic line. */
export function errorText(error) {
    if (error instanceof Error)
        return error.message.slice(0, 2_000);
    return String(error).slice(0, 2_000);
}
