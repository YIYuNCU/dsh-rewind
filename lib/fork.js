import { RewindError } from './errors.js';
/**
 * Plan a conversation cut at the user message that opened `turn`.
 * The new session keeps events through the previous `turn/end` only.
 * @param events - Session events in log order.
 * @param turn - Turn number selected in the dialog.
 * @returns The cut and the opening prompt.
 */
export function planFork(events, turn) {
    if (!Number.isSafeInteger(turn) || turn < 0)
        throw new RewindError('INVALID_ARGUMENTS', 'turn must be a non-negative integer');
    const start = events.find(event => event.type === 'turn/start' && event.data?.turn === turn);
    if (start === undefined)
        throw new RewindError('NOT_FOUND', `turn ${String(turn)} has no turn/start`);
    const end = events.find(event => event.type === 'turn/end' && event.seq > start.seq && event.data?.turn === turn);
    const message = events.find(event => (event.type === 'user/message'
        && event.seq > start.seq
        && (end === undefined || event.seq < end.seq)
        && isDirectUser(event)));
    if (message === undefined)
        throw new RewindError('NOT_FOUND', `turn ${String(turn)} has no opening user message`);
    const previous = [...events].reverse().find(event => event.type === 'turn/end' && event.seq < start.seq);
    return {
        turn,
        messageSeq: message.seq,
        turnStartSeq: start.seq,
        ...(previous === undefined ? {} : { previousTurnEndSeq: previous.seq }),
        promptText: promptOf(message),
    };
}
function isDirectUser(event) {
    return event.data?.source?.kind === 'user';
}
function promptOf(event) {
    return (event.data?.content ?? [])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text ?? '')
        .join('\n');
}
