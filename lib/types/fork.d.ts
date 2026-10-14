/** One session event the fork planner needs. */
export interface ForkEvent {
    readonly type: string;
    readonly seq: number;
    readonly data?: {
        readonly turn?: number;
        readonly source?: {
            readonly kind?: string;
        } | null;
        readonly content?: readonly {
            readonly type?: string;
            readonly text?: string;
        }[];
    };
}
/** Where a conversation rewind cuts, and the prompt to put back in the composer. */
export interface ForkPlan {
    readonly turn: number;
    readonly messageSeq: number;
    readonly turnStartSeq: number;
    readonly previousTurnEndSeq?: number;
    readonly promptText: string;
}
/**
 * Plan a conversation cut at the user message that opened `turn`.
 * The new session keeps events through the previous `turn/end` only.
 * @param events - Session events in log order.
 * @param turn - Turn number selected in the dialog.
 * @returns The cut and the opening prompt.
 */
export declare function planFork(events: readonly ForkEvent[], turn: number): ForkPlan;
