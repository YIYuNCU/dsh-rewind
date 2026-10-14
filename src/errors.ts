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
  'FORK_FAILED',
  'ORIGIN_REJECTED',
] as const

/** One {@link REWIND_CODES} value. */
export type RewindCode = typeof REWIND_CODES[number]

/** Stable failure from the rewind ledger or its host adapter. */
export class RewindError extends Error {
  override readonly name = 'RewindError'

  /**
   * @param code - Machine-readable category.
   * @param message - Human-readable diagnostic.
   * @param cause - Optional lower-level failure.
   */
  constructor(
    readonly code: RewindCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`[${code}] ${message}`, options)
  }
}

/** One bounded diagnostic line. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2_000)
  return String(error).slice(0, 2_000)
}
