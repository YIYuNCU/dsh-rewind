/**
 * DSH adaptation for the file-attribution ledger.
 * The engine stays free of Cordis; this module owns events, HTTP, and conversation forks.
 * @module dsh-rewind
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { RewindError, errorText } from './errors.js'
import type { RewindEngine } from './engine.js'
import { planFork, type ForkEvent } from './fork.js'
import { tunableSettings } from './config.js'
import type { RewindMode } from './types.js'

/** Preview and restore route. GET never grants apply authority. */
export const REWIND_HTTP_PATH = '/dsh-rewind'

/** Usage and purge route. */
export const REWIND_MANAGE_PATH = '/dsh-rewind/manage'

interface SessionLike {
  readonly id: string
  readonly header: {
    readonly cwd?: string
    readonly parentSession?: string
    readonly origin?: string
    readonly delegationDepth?: number
  }
}

interface SessionEventLike extends ForkEvent {
  readonly data?: ForkEvent['data'] & {
    readonly message?: { readonly toolCallId?: string; readonly isError?: boolean }
  }
}

interface AgentLike {
  readonly status: 'idle' | 'running'
  readonly session: SessionLike
}

interface ToolExecutionLike {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: AgentLike
}

interface HttpRequestLike {
  readonly method?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>
  on(event: 'data', listener: (chunk: Buffer | string) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: unknown) => void): void
}

interface HttpResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

interface ReadSessionResult {
  readonly session: { readonly id: string; readonly header: SessionLike['header'] }
  readonly events: readonly SessionEventLike[]
}

interface RestartContext {
  get(name: string): unknown
  readonly agents?: { list(): readonly AgentLike[] }
  readonly sessionQuery: { readSession(id: string): Promise<ReadSessionResult> }
}

/** Remember a tool name until its result event arrives. */
interface OpenCall {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly subagent: boolean
  readonly toolName: string
}

/**
 * Record file-tool before-images for the open turn.
 * @param ctx - Host context with agents.
 * @param engine - Attribution ledger.
 */
export function installCapture(ctx: Context, engine: RewindEngine): void {
  const turns = new Map<string, number>()
  const calls = new Map<string, OpenCall>()
  ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    if (event.type === 'turn/start' && session.header.cwd !== undefined && Number.isSafeInteger(event.data?.turn)) {
      const turn = event.data?.turn as number
      turns.set(session.id, turn)
      void engine.beginTurn({
        sessionId: session.id,
        workspace: session.header.cwd,
        turn,
        turnStartSeq: event.seq,
      }).catch(error => {
        ctx.logger.warn(`[dsh-rewind] could not open turn ${String(turn)}: ${errorText(error)}`)
      })
      return
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const turn = turns.get(session.id)
      if (turn === undefined) return
      void engine.noteUserMessage(session.id, turn, event.seq).catch(error => {
        ctx.logger.warn(`[dsh-rewind] could not note the user message: ${errorText(error)}`)
      })
      return
    }
    if (event.type !== 'tool/result') return
    const callId = event.data?.message?.toolCallId
    if (callId === undefined) return
    const call = calls.get(callId)
    calls.delete(callId)
    if (call === undefined) return
    const subagent = call.subagent
    void engine.captureAfter({
      sessionId: call.sessionId,
      ...(call.parentSessionId === undefined ? {} : { parentSessionId: call.parentSessionId }),
      subagent,
      callId,
      toolName: call.toolName,
      ok: event.data?.message?.isError !== true,
    }).catch(error => {
      ctx.logger.warn(`[dsh-rewind] could not record ${call.toolName}: ${errorText(error)}`)
    })
  })
  ctx.on('tools/pre-execute', async (exec: ToolExecutionLike, next: () => Promise<unknown>) => {
    const session = exec.agent?.session
    if (session?.header.cwd !== undefined) {
      const subagent = session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0
      const parentSessionId = session.header.parentSession
      calls.set(exec.callId, {
        sessionId: session.id,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        subagent,
        toolName: exec.name,
      })
      try {
        await engine.captureBefore({
          sessionId: session.id,
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          subagent,
          callId: exec.callId,
          toolName: exec.name,
          args: parseArguments(exec.arguments),
        })
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] capture failed for ${exec.name}: ${errorText(error)}`)
      }
    }
    return next()
  })
}

/**
 * Serve preview, restore, and ledger maintenance.
 * @param ctx - Host context with the web server and session reader.
 * @param engine - Attribution ledger.
 */
export function installRewindHttp(ctx: Context, engine: RewindEngine): void {
  const restart = ctx as Context & RestartContext
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REWIND_HTTP_PATH,
    handler: async (request, response) => {
      await handleRewind(restart, engine, request as HttpRequestLike, response as HttpResponseLike)
    },
  }), 'dsh-rewind.http')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REWIND_MANAGE_PATH,
    handler: async (request, response) => {
      await handleManage(engine, request as HttpRequestLike, response as HttpResponseLike)
    },
  }), 'dsh-rewind.manage')
}

async function handleRewind(
  ctx: RestartContext,
  engine: RewindEngine,
  request: HttpRequestLike,
  response: HttpResponseLike,
): Promise<void> {
  try {
    assertOrigin(request, engine.config.originCheck)
    if (request.method === 'GET') {
      const url = new URL(request.url ?? REWIND_HTTP_PATH, 'http://dsh.local')
      const sessionId = requiredText(url.searchParams.get('sessionId'), 'sessionId')
      const turn = requiredInteger(url.searchParams.get('turn'), 'turn')
      json(response, 200, await previewPayload(ctx, engine, sessionId, turn))
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { code: 'INVALID_ARGUMENTS', error: 'method must be GET or POST' })
      return
    }
    const body = objectBody(await readBody(request))
    const sessionId = requiredText(body.sessionId, 'sessionId')
    const turn = requiredInteger(body.turn, 'turn')
    const mode = requiredMode(body.mode)
    const includeConflicts = stringList(body.includeConflicts)
    const read = await ctx.sessionQuery.readSession(sessionId)
    const plan = planFork(read.events, turn)
    const workspace = requiredText(read.session.header.cwd, 'workspace')
    let fileResult = { restored: [] as readonly string[], deleted: [] as readonly string[], unchanged: [] as readonly string[], skipped: [] as readonly string[] }
    if (mode !== 'messages') {
      const fingerprint = requiredText(body.fingerprint, 'fingerprint')
      fileResult = await engine.apply({
        sessionId,
        workspace,
        turn,
        userMessageSeq: plan.messageSeq,
        fingerprint,
        ...(includeConflicts === undefined ? {} : { includeConflicts }),
        workspaceBusy: await workspaceBusy(ctx, workspace),
      })
    }
    let forkedSessionId: string | undefined
    try {
      if (mode !== 'code') forkedSessionId = await forkConversation(ctx, sessionId, workspace, plan.previousTurnEndSeq)
      await engine.commit(workspace)
    } catch (error) {
      if (mode !== 'messages') await engine.rollback(workspace)
      throw error instanceof RewindError ? error : new RewindError('FORK_FAILED', errorText(error), { cause: error })
    }
    json(response, 200, {
      sessionId,
      ...(forkedSessionId === undefined ? {} : { forkedSessionId }),
      promptText: plan.promptText,
      putPromptInComposer: engine.config.putPromptInComposer,
      ...fileResult,
    })
  } catch (error) {
    fail(response, error)
  }
}

async function handleManage(
  engine: RewindEngine,
  request: HttpRequestLike,
  response: HttpResponseLike,
): Promise<void> {
  try {
    assertOrigin(request, engine.config.originCheck)
    if (request.method === 'GET') {
      json(response, 200, { sessions: await engine.usage(), settings: tunableSettings(engine.config), storageDir: engine.config.storageDir })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { code: 'INVALID_ARGUMENTS', error: 'method must be GET or POST' })
      return
    }
    const body = objectBody(await readBody(request))
    if (body.action !== 'purge') throw new RewindError('INVALID_ARGUMENTS', 'action must be purge')
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
    json(response, 200, { purged: await engine.purge(sessionId) })
  } catch (error) {
    fail(response, error)
  }
}

async function previewPayload(ctx: RestartContext, engine: RewindEngine, sessionId: string, turn: number): Promise<unknown> {
  const read = await ctx.sessionQuery.readSession(sessionId)
  const plan = planFork(read.events, turn)
  const workspace = requiredText(read.session.header.cwd, 'workspace')
  const preview = await engine.preview({ sessionId, workspace, turn, userMessageSeq: plan.messageSeq })
  const activeSessionIds = await runningSessions(ctx, workspace)
  return {
    ...preview,
    promptText: plan.promptText,
    activeSessionIds,
    restoreBlocked: engine.config.blockWhileAgentsRun && activeSessionIds.length > 0,
    putPromptInComposer: engine.config.putPromptInComposer,
    conflictPolicy: engine.config.conflictPolicy,
  }
}

async function forkConversation(
  ctx: RestartContext,
  sessionId: string,
  workspace: string,
  previousTurnEndSeq: number | undefined,
): Promise<string> {
  const controller = ctx.get('sessionController') as {
    create(input: { readonly cwd?: string; readonly workspaceId?: string }): Promise<{ readonly sessionId?: string }>
    fork(input: { readonly sessionId: string; readonly atSeq: number }): Promise<{ readonly sessionId?: string }>
  } | undefined
  if (controller !== undefined) {
    const registry = ctx.get('workspaceRegistry') as {
      list(): readonly { readonly id: string; readonly sessionIds: readonly string[] }[]
    } | undefined
    const membership = registry?.list().find(candidate => candidate.sessionIds.includes(sessionId))
    const created = previousTurnEndSeq === undefined
      ? await controller.create(membership === undefined ? { cwd: workspace } : { workspaceId: membership.id })
      : await controller.fork({ sessionId, atSeq: previousTurnEndSeq })
    return requiredText(created.sessionId, 'sessionId')
  }
  const apiProxy = ctx.get('apiProxy') as {
    sessions: {
      create(input: { readonly rpcId: string; readonly payload: { readonly cwd: string } }): Promise<RpcSession>
      fork(input: { readonly rpcId: string; readonly payload: { readonly sessionId: string; readonly atSeq: number } }): Promise<RpcSession>
    }
  } | undefined
  if (apiProxy === undefined) {
    throw new RewindError('FORK_FAILED', 'this DSH host exposes neither sessionController nor apiProxy')
  }
  const response = previousTurnEndSeq === undefined
    ? await apiProxy.sessions.create({ rpcId: randomUUID(), payload: { cwd: workspace } })
    : await apiProxy.sessions.fork({ rpcId: randomUUID(), payload: { sessionId, atSeq: previousTurnEndSeq } })
  if (!response.result.ok) throw new RewindError('FORK_FAILED', response.result.error.message)
  return requiredText(response.result.value.sessionId, 'sessionId')
}

interface RpcSession {
  readonly result: { readonly ok: true; readonly value: { readonly sessionId?: string } } | { readonly ok: false; readonly error: { readonly message: string } }
}

async function workspaceBusy(ctx: RestartContext, workspace: string): Promise<boolean> {
  return (await runningSessions(ctx, workspace)).length > 0
}

async function runningSessions(ctx: RestartContext, workspace: string): Promise<readonly string[]> {
  const root = await canonical(workspace)
  const shared: string[] = []
  for (const agent of ctx.agents?.list() ?? []) {
    if (agent.status !== 'running' || agent.session.header.cwd === undefined) continue
    if (await canonical(agent.session.header.cwd) === root) shared.push(agent.session.id)
  }
  return shared.sort()
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

function assertOrigin(request: HttpRequestLike, check: 'same-origin' | 'off'): void {
  if (check === 'off') return
  const site = header(request, 'sec-fetch-site')
  if (site === 'cross-site' || site === 'same-site') throw new RewindError('ORIGIN_REJECTED', 'cross-site rewind requests are rejected')
  const origin = header(request, 'origin')
  const host = header(request, 'host')
  if (origin === undefined || host === undefined) return
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new RewindError('ORIGIN_REJECTED', 'origin is not a URL')
  }
  if (parsed.host !== host) throw new RewindError('ORIGIN_REJECTED', 'origin does not match the host')
}

function header(request: HttpRequestLike, name: string): string | undefined {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first !== '' ? first : undefined
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new RewindError('INVALID_ARGUMENTS', `${name} is required`)
  return value
}

function requiredInteger(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RewindError('INVALID_ARGUMENTS', `${name} must be a non-negative integer`)
  return parsed
}

function requiredMode(value: unknown): RewindMode {
  if (value === 'both' || value === 'code' || value === 'messages') return value
  throw new RewindError('INVALID_ARGUMENTS', 'mode must be both, code, or messages')
}

function stringList(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new RewindError('INVALID_ARGUMENTS', 'includeConflicts must be a list of paths')
  }
  return value
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RewindError('INVALID_ARGUMENTS', 'request body must be an object')
  }
  return value as Record<string, unknown>
}

async function readBody(request: HttpRequestLike): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolveRead, reject) => {
    request.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > 1024 * 1024) {
        reject(new RewindError('INVALID_ARGUMENTS', 'request body exceeds 1 MiB'))
        return
      }
      chunks.push(bytes)
    })
    request.on('end', () => { resolveRead() })
    request.on('error', reject)
  })
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RewindError('INVALID_ARGUMENTS', 'request body is not JSON')
  }
}

function fail(response: HttpResponseLike, error: unknown): void {
  const code = error instanceof RewindError ? error.code : 'RESTORE_FAILED'
  const status = code === 'NOT_FOUND' ? 404
    : code === 'STALE' || code === 'BUSY' ? 409
      : code === 'ORIGIN_REJECTED' ? 403
        : code === 'INVALID_ARGUMENTS' || code === 'INVALID_CONFIG' || code === 'UNSAFE_PATH' ? 400
          : 500
  json(response, status, { code, error: error instanceof Error ? error.message : errorText(error) })
}

function json(response: HttpResponseLike, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}
