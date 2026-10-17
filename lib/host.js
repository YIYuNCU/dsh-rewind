/**
 * DSH adaptation for the file-attribution ledger.
 * The engine stays free of Cordis; this module owns events, HTTP, and conversation forks.
 * @module dsh-rewind
 */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RewindError, errorText } from './errors.js';
import { planFork } from './fork.js';
import { tunableSettings } from './config.js';
/** Preview and restore route. GET never grants apply authority. */
export const REWIND_HTTP_PATH = '/dsh-rewind';
/** Usage and purge route. */
export const REWIND_MANAGE_PATH = '/dsh-rewind/manage';
/**
 * Record file-tool before-images for the open turn.
 * @param ctx - Host context with agents.
 * @param engine - Attribution ledger.
 */
export function installCapture(ctx, engine) {
    const turns = new Map();
    const calls = new Map();
    ctx.on('session/event', (session, event) => {
        if (session?.id === undefined)
            return;
        const cwd = session.header?.cwd;
        if (event.type === 'turn/start' && cwd !== undefined && Number.isSafeInteger(event.data?.turn)) {
            const turn = event.data?.turn;
            turns.set(session.id, turn);
            void engine.beginTurn({
                sessionId: session.id,
                workspace: cwd,
                turn,
                turnStartSeq: event.seq,
            }).catch(error => {
                ctx.logger.warn(`[dsh-rewind] could not open turn ${String(turn)}: ${errorText(error)}`);
            });
            return;
        }
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
            const turn = turns.get(session.id);
            if (turn === undefined)
                return;
            void engine.noteUserMessage(session.id, turn, event.seq).catch(error => {
                ctx.logger.warn(`[dsh-rewind] could not note the user message: ${errorText(error)}`);
            });
            return;
        }
        if (event.type !== 'tool/result')
            return;
        const callId = event.data?.message?.toolCallId;
        if (callId === undefined)
            return;
        const call = calls.get(callId);
        calls.delete(callId);
        if (call === undefined)
            return;
        const subagent = call.subagent;
        void engine.captureAfter({
            sessionId: call.sessionId,
            ...(call.parentSessionId === undefined ? {} : { parentSessionId: call.parentSessionId }),
            subagent,
            callId,
            toolName: call.toolName,
            ok: event.data?.message?.isError !== true,
        }).catch(error => {
            ctx.logger.warn(`[dsh-rewind] could not record ${call.toolName}: ${errorText(error)}`);
        });
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
        const session = exec.agent?.session;
        const header = session?.header;
        if (session !== undefined && header?.cwd !== undefined) {
            const subagent = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
            const parentSessionId = header.parentSession;
            calls.set(exec.callId, {
                sessionId: session.id,
                ...(parentSessionId === undefined ? {} : { parentSessionId }),
                subagent,
                toolName: exec.name,
            });
            try {
                await engine.captureBefore({
                    sessionId: session.id,
                    ...(parentSessionId === undefined ? {} : { parentSessionId }),
                    subagent,
                    callId: exec.callId,
                    toolName: exec.name,
                    args: parseArguments(exec.arguments),
                });
            }
            catch (error) {
                ctx.logger.warn(`[dsh-rewind] capture failed for ${exec.name}: ${errorText(error)}`);
            }
        }
        return next();
    });
}
/**
 * Serve preview, restore, and ledger maintenance.
 * @param ctx - Host context with the web server and session reader.
 * @param engine - Attribution ledger.
 */
export function installRewindHttp(ctx, engine) {
    const restart = ctx;
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: REWIND_HTTP_PATH,
        handler: async (request, response) => {
            await handleRewind(restart, engine, request, response);
        },
    }), 'dsh-rewind.http');
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: REWIND_MANAGE_PATH,
        handler: async (request, response) => {
            await handleManage(engine, request, response);
        },
    }), 'dsh-rewind.manage');
}
async function handleRewind(ctx, engine, request, response) {
    try {
        assertOrigin(request, engine.config.originCheck);
        if (request.method === 'GET') {
            const url = new URL(request.url ?? REWIND_HTTP_PATH, 'http://dsh.local');
            const sessionId = requiredText(url.searchParams.get('sessionId'), 'sessionId');
            const turn = requiredInteger(url.searchParams.get('turn'), 'turn');
            json(response, 200, await previewPayload(ctx, engine, sessionId, turn));
            return;
        }
        if (request.method !== 'POST') {
            json(response, 405, { code: 'INVALID_ARGUMENTS', error: 'method must be GET or POST' });
            return;
        }
        const body = objectBody(await readBody(request));
        const sessionId = requiredText(body.sessionId, 'sessionId');
        const turn = requiredInteger(body.turn, 'turn');
        const mode = requiredMode(body.mode);
        const includeConflicts = stringList(body.includeConflicts);
        const read = await ctx.sessionQuery.readSession(sessionId);
        const plan = planFork(read.events, turn);
        const workspace = requiredText(workspaceOf(ctx, sessionId, read.session), 'workspace');
        let fileResult = { restored: [], deleted: [], unchanged: [], skipped: [] };
        if (mode !== 'messages') {
            const fingerprint = requiredText(body.fingerprint, 'fingerprint');
            fileResult = await engine.apply({
                sessionId,
                workspace,
                turn,
                userMessageSeq: plan.messageSeq,
                fingerprint,
                ...(includeConflicts === undefined ? {} : { includeConflicts }),
                workspaceBusy: await workspaceBusy(ctx, workspace),
            });
        }
        let forkedSessionId;
        try {
            if (mode !== 'code')
                forkedSessionId = await forkConversation(ctx, sessionId, workspace, plan.previousTurnEndSeq);
            await engine.commit(workspace);
        }
        catch (error) {
            if (mode !== 'messages')
                await engine.rollback(workspace);
            throw error instanceof RewindError ? error : new RewindError('FORK_FAILED', errorText(error), { cause: error });
        }
        json(response, 200, {
            sessionId,
            ...(forkedSessionId === undefined ? {} : { forkedSessionId }),
            promptText: plan.promptText,
            putPromptInComposer: engine.config.putPromptInComposer,
            ...fileResult,
        });
    }
    catch (error) {
        fail(response, error);
    }
}
async function handleManage(engine, request, response) {
    try {
        assertOrigin(request, engine.config.originCheck);
        if (request.method === 'GET') {
            json(response, 200, { sessions: await engine.usage(), settings: tunableSettings(engine.config), storageDir: engine.config.storageDir });
            return;
        }
        if (request.method !== 'POST') {
            json(response, 405, { code: 'INVALID_ARGUMENTS', error: 'method must be GET or POST' });
            return;
        }
        const body = objectBody(await readBody(request));
        if (body.action === 'relocate') {
            if (typeof body.storageDir !== 'string')
                throw new RewindError('INVALID_ARGUMENTS', 'storageDir must be a string');
            json(response, 200, await engine.relocateStorage(body.storageDir));
            return;
        }
        if (body.action !== 'purge')
            throw new RewindError('INVALID_ARGUMENTS', 'action must be purge or relocate');
        const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined;
        json(response, 200, { purged: await engine.purge(sessionId) });
    }
    catch (error) {
        fail(response, error);
    }
}
async function previewPayload(ctx, engine, sessionId, turn) {
    const read = await ctx.sessionQuery.readSession(sessionId);
    const plan = planFork(read.events, turn);
    const workspace = requiredText(workspaceOf(ctx, sessionId, read.session), 'workspace');
    const preview = await engine.preview({ sessionId, workspace, turn, userMessageSeq: plan.messageSeq });
    const activeSessionIds = await runningSessions(ctx, workspace);
    return {
        ...preview,
        promptText: plan.promptText,
        activeSessionIds,
        restoreBlocked: engine.config.blockWhileAgentsRun && activeSessionIds.length > 0,
        putPromptInComposer: engine.config.putPromptInComposer,
        conflictPolicy: engine.config.conflictPolicy,
    };
}
async function forkConversation(ctx, sessionId, workspace, previousTurnEndSeq) {
    const controller = ctx.get('sessionController');
    if (controller !== undefined) {
        const registry = ctx.get('workspaceRegistry');
        const membership = registry?.list().find(candidate => candidate.sessionIds.includes(sessionId));
        const created = previousTurnEndSeq === undefined
            ? await controller.create(membership === undefined ? { cwd: workspace } : { workspaceId: membership.id })
            : await controller.fork({ sessionId, atSeq: previousTurnEndSeq });
        return requiredText(created.sessionId, 'sessionId');
    }
    const apiProxy = ctx.get('apiProxy');
    if (apiProxy === undefined) {
        throw new RewindError('FORK_FAILED', 'this DSH host exposes neither sessionController nor apiProxy');
    }
    const response = previousTurnEndSeq === undefined
        ? await apiProxy.sessions.create({ rpcId: randomUUID(), payload: { cwd: workspace } })
        : await apiProxy.sessions.fork({ rpcId: randomUUID(), payload: { sessionId, atSeq: previousTurnEndSeq } });
    if (!response.result.ok)
        throw new RewindError('FORK_FAILED', response.result.error.message);
    return requiredText(response.result.value.sessionId, 'sessionId');
}
async function workspaceBusy(ctx, workspace) {
    return (await runningSessions(ctx, workspace)).length > 0;
}
async function runningSessions(ctx, workspace) {
    const root = await canonical(workspace);
    const shared = [];
    for (const agent of ctx.agents?.list() ?? []) {
        const cwd = agent.session.header?.cwd;
        if (agent.status !== 'running' || cwd === undefined)
            continue;
        if (await canonical(cwd) === root)
            shared.push(agent.session.id);
    }
    return shared.sort();
}
async function canonical(path) {
    try {
        return await realpath(path);
    }
    catch {
        return resolve(path);
    }
}
function assertOrigin(request, check) {
    if (check === 'off')
        return;
    const site = header(request, 'sec-fetch-site');
    if (site === 'cross-site' || site === 'same-site')
        throw new RewindError('ORIGIN_REJECTED', 'cross-site rewind requests are rejected');
    const origin = header(request, 'origin');
    const host = header(request, 'host');
    if (origin === undefined || host === undefined)
        return;
    let parsed;
    try {
        parsed = new URL(origin);
    }
    catch {
        throw new RewindError('ORIGIN_REJECTED', 'origin is not a URL');
    }
    if (parsed.host !== host)
        throw new RewindError('ORIGIN_REJECTED', 'origin does not match the host');
}
function header(request, name) {
    const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' && first !== '' ? first : undefined;
}
function parseArguments(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
/**
 * Working directory for a rewind request.
 * Official `readSession` puts `cwd` on the header object it returns as `session`.
 * @param ctx - Host context, used when the stored header has no cwd.
 * @param sessionId - Session being rewound.
 * @param session - Header returned by `readSession`, or a nested copy.
 * @returns The absolute cwd, or `undefined` when none is known.
 */
export function workspaceOf(ctx, sessionId, session) {
    const stored = textOrUndefined(session.cwd) ?? textOrUndefined(session.header?.cwd);
    if (stored !== undefined)
        return stored;
    const live = ctx.agents?.list().find(agent => agent.session.id === sessionId);
    return textOrUndefined(live?.session.header?.cwd);
}
function textOrUndefined(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function requiredText(value, name) {
    if (typeof value !== 'string' || value.trim() === '')
        throw new RewindError('INVALID_ARGUMENTS', `${name} is required`);
    return value;
}
function requiredInteger(value, name) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new RewindError('INVALID_ARGUMENTS', `${name} must be a non-negative integer`);
    return parsed;
}
function requiredMode(value) {
    if (value === 'both' || value === 'code' || value === 'messages')
        return value;
    throw new RewindError('INVALID_ARGUMENTS', 'mode must be both, code, or messages');
}
function stringList(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
        throw new RewindError('INVALID_ARGUMENTS', 'includeConflicts must be a list of paths');
    }
    return value;
}
function objectBody(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new RewindError('INVALID_ARGUMENTS', 'request body must be an object');
    }
    return value;
}
async function readBody(request) {
    const chunks = [];
    let size = 0;
    await new Promise((resolveRead, reject) => {
        request.on('data', (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 1024 * 1024) {
                reject(new RewindError('INVALID_ARGUMENTS', 'request body exceeds 1 MiB'));
                return;
            }
            chunks.push(bytes);
        });
        request.on('end', () => { resolveRead(); });
        request.on('error', reject);
    });
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '')
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        throw new RewindError('INVALID_ARGUMENTS', 'request body is not JSON');
    }
}
function fail(response, error) {
    const code = error instanceof RewindError ? error.code : 'RESTORE_FAILED';
    const status = code === 'NOT_FOUND' ? 404
        : code === 'STALE' || code === 'BUSY' ? 409
            : code === 'ORIGIN_REJECTED' ? 403
                : code === 'INVALID_ARGUMENTS' || code === 'INVALID_CONFIG' || code === 'UNSAFE_PATH' ? 400
                    : 500;
    json(response, status, { code, error: error instanceof Error ? error.message : errorText(error) });
}
function json(response, status, body) {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
}
