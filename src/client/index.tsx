/**
 * Browser half of DSH Rewind.
 * The completed-turn tail is the chat mount. Settings live on the Plugins tab.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

type Lang = 'zh' | 'en'
type Mode = 'both' | 'code' | 'messages'
interface SettingsValue {
  enabled: boolean
  captureSubagents: boolean
  shellPolicy: 'gap' | 'ignore'
  shellTools: string
  extraFileTools: string
  pathFields: string
  excludeGlobs: string
  skipGenerated: boolean
  captureExternal: boolean
  maxFileBytes: number
  maxCheckpointsPerSession: number
  retentionDays: number
  maxSessionBytes: number
  maxStorageBytes: number
  maxStoredTurns: number
  conflictPolicy: 'ask' | 'skip' | 'overwrite'
  restoreCreatedFiles: boolean
  blockWhileAgentsRun: boolean
  allowOutsideWorkspace: boolean
  previewTrust: 'content' | 'metadata'
  putPromptInComposer: boolean
  maxPreviewFiles: number
  staleLockMs: number
  originCheck: 'same-origin' | 'off'
  storageDir: string
}

interface SettingsSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value?: SettingsValue
  readonly writable?: boolean
}

interface SettingsScope {
  getSnapshot(): SettingsSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

interface PreviewFile {
  readonly path: string
  readonly action: 'restore' | 'delete' | 'unchanged'
  readonly state: 'clean' | 'conflict' | 'gap'
  readonly reason?: string
  readonly bytes: number
}

interface Preview {
  readonly fingerprint: string
  readonly shellGap: boolean
  readonly files: readonly PreviewFile[]
  readonly hiddenCount: number
  readonly totalFiles: number
  readonly promptText: string
  readonly activeSessionIds: readonly string[]
  readonly restoreBlocked: boolean
  readonly putPromptInComposer: boolean
  readonly conflictPolicy: 'ask' | 'skip' | 'overwrite'
}

interface UsageRow {
  readonly sessionId: string
  readonly workspace: string
  readonly checkpoints: number
  readonly bytes: number
}

interface ClientContext {
  effect(setup: () => void | (() => void), label?: string): void
  on?(name: string, listener: (snapshot: { readonly active?: string }) => void): unknown
  get?(name: string): unknown
  slots: {
    inject(name: string, install: () => void): void
    register(entry: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactNode): void
  }
  sessions: {
    open?(id: string): void
    scope(id: string): unknown
  }
  conversation: { input: { for(scope: unknown): { setDraft(text: string): void } } }
}

interface TurnProps {
  /** 0.2.0-rc.2 passes a turn location; a bare number is accepted too. */
  readonly turn?: number | { readonly turn?: number }
  readonly sessionId?: string
  readonly openRestoredSession?: (sessionId: string, prompt: string) => Promise<void>
}

interface SettingsProps {
  readonly view?: string
  readonly scope?: SettingsScope
}

type SettingsGroup = 'capture' | 'restore' | 'storage'

const UNAVAILABLE: SettingsSnapshot = { status: 'unavailable' }
const MIB = 1024 * 1024
const VISIBLE_FIELDS: readonly {
  readonly key: keyof SettingsValue
  readonly kind: 'bool' | 'number' | 'select' | 'mib'
  readonly group: SettingsGroup
  readonly options?: readonly string[]
}[] = [
  { key: 'skipGenerated', kind: 'bool', group: 'capture' },
  { key: 'captureExternal', kind: 'bool', group: 'capture' },
  { key: 'captureSubagents', kind: 'bool', group: 'capture' },
  { key: 'shellPolicy', kind: 'select', group: 'capture', options: ['gap', 'ignore'] },
  { key: 'conflictPolicy', kind: 'select', group: 'restore', options: ['ask', 'skip', 'overwrite'] },
  { key: 'restoreCreatedFiles', kind: 'bool', group: 'restore' },
  { key: 'putPromptInComposer', kind: 'bool', group: 'restore' },
  { key: 'blockWhileAgentsRun', kind: 'bool', group: 'restore' },
  { key: 'retentionDays', kind: 'number', group: 'storage' },
  { key: 'maxStorageBytes', kind: 'mib', group: 'storage' },
  { key: 'maxStoredTurns', kind: 'number', group: 'storage' },
]

const copy = {
  zh: {
    title: '回退',
    button: '回退这一轮',
    buttonTip: '把这一轮开始前的文件改回去，并另开会话。不会改掉原来的记录。',
    close: '关闭',
    warning: '生成目录、符号链接、硬链接，以及超过大小或数量上限的文件，不会自动撤掉。',
    shell: '这一轮运行过命令。命令改过的合格文件会回到这一轮开始时的内容。',
    blocked: '这个工作区还有正在运行的会话，暂时不能改文件。',
    hidden: (count: number) => `还有 ${String(count)} 个文件没列在这里，但回退会一起处理。`,
    empty: '这一轮没有可回退的文件改动。仍可以只回退对话。',
    conflict: '这个文件现在的内容和记录不一致。勾选后才会覆盖它。',
    gap: '这个路径没有可用的修改前内容。',
    both: '回退代码和对话',
    code: '只回退代码',
    messages: '只回退对话',
    working: '正在回退…',
    failed: '回退没有完成。',
    settingsTitle: '设置',
    settingsMissing: '设置服务还没就绪。',
    storage: '存储目录',
    purge: '清除',
    purgeAll: '清除全部',
    usage: '已保存',
    none: '还没有回退记录。',
    bytes: '字节',
    checkpoints: '个检查点',
    mib: 'MiB',
    groups: { capture: '记录', restore: '回退', storage: '存储' },
    options: {
      shellPolicy: { gap: '标明跑过命令', ignore: '不标明' },
      conflictPolicy: { ask: '询问', skip: '跳过', overwrite: '覆盖' },
    },
    actions: { restore: '恢复修改前', delete: '删除新建文件', unchanged: '已经是修改前' },
    states: { clean: '可回退', conflict: '有冲突', gap: '跳过' },
    fields: {
      captureSubagents: ['记录子代理', '子代理改的文件算到父会话当前这一轮。'],
      shellPolicy: ['命令工具', '只标明这一轮跑过命令，不会给命令做快照。'],
      skipGenerated: ['跳过生成目录', '不记录 node_modules、.git、dist、coverage 和 .dsh。'],
      captureExternal: ['记录回合之间的改动', '每轮开始时记下工作区。之后的手改和脚本改动，回退到这一轮时会撤掉。'],
      retentionDays: ['保留天数', '0 表示不按天数删除。'],
      maxStorageBytes: ['最大存储空间', '全部会话加在一起的上限。超出后丢掉最旧的一轮，至少保留一轮。'],
      maxStoredTurns: ['最大存储轮数', '全部会话加在一起最多保留这么多轮。'],
      conflictPolicy: ['文件冲突', '文件已经和记录不一致时怎么处理。'],
      restoreCreatedFiles: ['删除本轮新建的文件', '关闭后，这一轮新建的文件会留在原地。'],
      blockWhileAgentsRun: ['运行中禁止改文件', '同一工作区还有代理在跑时，不允许回退代码。'],
      putPromptInComposer: ['把原话放回输入框', '回退对话后，把当时的用户消息放进新会话的输入框。'],
    } as Record<string, readonly [string, string]>,
  },
  en: {
    title: 'Rewind',
    button: 'Rewind this turn',
    buttonTip: 'Restore files from before this turn and open a forked session. The original session stays intact.',
    close: 'Close',
    warning: 'Generated directories, symlinks, hard links, and files past the size or count limit are not undone.',
    shell: 'A command ran during this turn. Eligible files it changed go back to the start of the turn.',
    blocked: 'An agent is still running in this workspace, so files cannot be changed.',
    hidden: (count: number) => `${String(count)} more files are hidden here but are still included.`,
    empty: 'This turn has no restorable file edits. You can still rewind the conversation.',
    conflict: 'This file no longer matches the recorded bytes. It is overwritten only if you check it.',
    gap: 'No usable before-image for this path.',
    both: 'Rewind code and conversation',
    code: 'Rewind code only',
    messages: 'Rewind conversation only',
    working: 'Rewinding…',
    failed: 'Rewind did not finish.',
    settingsTitle: 'Settings',
    settingsMissing: 'Settings are not available yet.',
    storage: 'Storage directory',
    purge: 'Delete',
    purgeAll: 'Delete all',
    usage: 'Saved',
    none: 'No rewind data yet.',
    bytes: 'bytes',
    checkpoints: 'checkpoints',
    mib: 'MiB',
    groups: { capture: 'Capture', restore: 'Rewind', storage: 'Storage' },
    options: {
      shellPolicy: { gap: 'Mark that a command ran', ignore: 'Do not mark it' },
      conflictPolicy: { ask: 'Ask', skip: 'Skip', overwrite: 'Overwrite' },
    },
    actions: { restore: 'Restore previous bytes', delete: 'Delete created file', unchanged: 'Already at previous bytes' },
    states: { clean: 'Ready', conflict: 'Conflict', gap: 'Skip' },
    fields: {
      captureSubagents: ['Capture subagents', 'Attribute a subagent edit to the parent session’s open turn.'],
      shellPolicy: ['Command tools', 'Only marks that a command ran. The command itself is not snapshotted.'],
      skipGenerated: ['Skip generated directories', 'Do not record node_modules, .git, dist, coverage, or .dsh.'],
      captureExternal: ['Record edits between turns', 'Snapshot the workspace when a turn starts. Later manual and script edits are undone when you rewind to that turn.'],
      retentionDays: ['Retention days', 'Zero disables the age sweep.'],
      maxStorageBytes: ['Maximum storage', 'Cap across every session. The oldest turn is dropped until it fits, and at least one turn is kept.'],
      maxStoredTurns: ['Maximum stored turns', 'How many turns are kept across every session.'],
      conflictPolicy: ['File conflicts', 'What to do when a file no longer matches the recorded bytes.'],
      restoreCreatedFiles: ['Delete files created this turn', 'When off, files created during the turn stay in place.'],
      blockWhileAgentsRun: ['Block while agents run', 'Refuse a file rewind while any agent is running in the workspace.'],
      putPromptInComposer: ['Return the prompt to the composer', 'After a conversation rewind, put that user message in the new draft.'],
    } as Record<string, readonly [string, string]>,
  },
} as const

const listeners = new Set<() => void>()
let lang: Lang = 'zh'

function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, () => lang, () => lang)
}

function subscribeLang(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function adopt(next: string | undefined): void {
  const resolved: Lang = next?.toLowerCase().startsWith('en') ? 'en' : 'zh'
  if (resolved === lang) return
  lang = resolved
  for (const listener of listeners) listener()
}

function followHostLocale(ctx: ClientContext): () => void {
  const read = (): string | undefined => {
    try {
      const active = (ctx.get?.('locale') as { getSnapshot(): { active?: string } } | undefined)?.getSnapshot().active
      return typeof active === 'string' ? active : undefined
    } catch {
      return undefined
    }
  }
  adopt(read() ?? (typeof navigator === 'undefined' ? undefined : navigator.language))
  const timer = setTimeout(() => { adopt(read() ?? lang) }, 0)
  let off: unknown
  try {
    off = ctx.on?.('locale/change', (snapshot) => { adopt(snapshot.active) })
  } catch {
    off = undefined
  }
  return () => {
    clearTimeout(timer)
    if (typeof off === 'function') off()
  }
}

/** Services this browser plugin reads. */
export const inject = ['slots', 'sessions', 'conversation']

/**
 * Register the turn-tail action and the plugin-page settings.
 * @param ctx - Client context. This plugin does not start a server.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => followHostLocale(ctx), 'dsh-rewind.locale')
  ctx.effect(() => mountStyles(), 'dsh-rewind.styles')
  const openRestoredSession = async (sessionId: string, prompt: string): Promise<void> => {
    await openSessionWithDraft(ctx, sessionId, prompt)
  }
  ctx.slots.inject('conversation.chat.turnTail', () => {
    ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: 'dsh-rewind',
      order: 20,
      inject: (sessionId: string) => ({ sessionId, openRestoredSession }),
    }, RewindTurnButton as (props: Record<string, unknown>) => ReactNode)
  })
  ctx.slots.inject('plugins.bundle.config', () => {
    ctx.slots.register({
      name: 'plugins.bundle.config',
      key: 'dsh-rewind',
      inject: () => ({ scope: settingsScope(ctx) }),
    }, RewindSettingsCard as (props: Record<string, unknown>) => ReactNode)
  })
}

function turnOf(value: TurnProps['turn']): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'object' && value !== null && typeof value.turn === 'number' && Number.isSafeInteger(value.turn)) return value.turn
  return undefined
}

function RewindTurnButton(props: TurnProps): ReactNode {
  const text = copy[useLang()]
  const [open, setOpen] = useState(false)
  const turn = turnOf(props.turn)
  if (turn === undefined || props.sessionId === undefined || props.sessionId === '') return null
  const sessionId = props.sessionId
  return (
    <span data-dsh-rewind="turn">
      <Tooltip label={text.buttonTip}>
        <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(true) }}>{text.button}</Button>
      </Tooltip>
      {open ? (
        <RewindDialog
          sessionId={sessionId}
          turn={turn}
          title={text.title}
          closeLabel={text.close}
          onClose={() => { setOpen(false) }}
          {...(props.openRestoredSession === undefined ? {} : { openRestoredSession: props.openRestoredSession })}
        />
      ) : null}
    </span>
  )
}

function RewindDialog(props: {
  readonly sessionId: string
  readonly turn: number
  readonly title: string
  readonly closeLabel: string
  readonly onClose: () => void
  readonly openRestoredSession?: (sessionId: string, prompt: string) => Promise<void>
}): ReactNode {
  const text = copy[useLang()]
  const [preview, setPreview] = useState<Preview | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState<readonly string[]>([])
  useEffect(() => {
    let active = true
    void requestJson<Preview>(`/dsh-rewind?sessionId=${encodeURIComponent(props.sessionId)}&turn=${String(props.turn)}`)
      .then((value) => { if (active) setPreview(value) })
      .catch((caught: unknown) => { if (active) setError(messageOf(caught)) })
    return () => { active = false }
  }, [props.sessionId, props.turn])
  const run = (mode: Mode): void => {
    if (preview === undefined) return
    setBusy(true)
    setError(undefined)
    void requestJson<{ readonly forkedSessionId?: string; readonly promptText?: string; readonly putPromptInComposer?: boolean }>('/dsh-rewind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: props.sessionId,
        turn: props.turn,
        mode,
        fingerprint: preview.fingerprint,
        includeConflicts: checked,
      }),
    }).then(async (result) => {
      if (result.forkedSessionId !== undefined && result.putPromptInComposer !== false) {
        await props.openRestoredSession?.(result.forkedSessionId, result.promptText ?? '')
      }
      props.onClose()
    }).catch((caught: unknown) => {
      setError(messageOf(caught) || text.failed)
      setBusy(false)
    })
  }
  const codeDisabled = busy || preview === undefined || preview.restoreBlocked
  return (
    <Modal open title={props.title} closeLabel={props.closeLabel} onClose={props.onClose} description={text.warning}>
      <div data-dsh-rewind="dialog">
        {preview?.shellGap === true ? <p>{text.shell}</p> : null}
        {preview?.restoreBlocked === true ? <p>{text.blocked} {preview.activeSessionIds.join(', ')}</p> : null}
        {preview !== undefined && preview.totalFiles === 0 ? <p>{text.empty}</p> : null}
        {preview !== undefined && preview.hiddenCount > 0 ? <p>{text.hidden(preview.hiddenCount)}</p> : null}
        <ul>
          {(preview?.files ?? []).map(file => (
            <li key={file.path}>
              {preview?.conflictPolicy === 'ask' && file.state === 'conflict' ? (
                <input
                  type="checkbox"
                  checked={checked.includes(file.path)}
                  onChange={() => {
                    setChecked(current => current.includes(file.path) ? current.filter(path => path !== file.path) : [...current, file.path])
                  }}
                />
              ) : null}
              <code>{file.path}</code>
              <span>{text.actions[file.action]} · {text.states[file.state]}</span>
              {file.state === 'conflict' ? <small>{text.conflict}</small> : null}
              {file.state === 'gap' ? <small>{text.gap}</small> : null}
            </li>
          ))}
        </ul>
        {error !== undefined ? <p role="alert">{error}</p> : null}
        <div data-dsh-rewind="actions">
          <Button type="button" variant="primary" disabled={codeDisabled || busy} onClick={() => { run('both') }}>{busy ? text.working : text.both}</Button>
          <Button type="button" variant="outline" disabled={codeDisabled} onClick={() => { run('code') }}>{text.code}</Button>
          <Button type="button" variant="ghost" disabled={busy || preview === undefined} onClick={() => { run('messages') }}>{text.messages}</Button>
        </div>
      </div>
    </Modal>
  )
}

function RewindSettingsCard({ view, scope }: SettingsProps): ReactNode {
  const text = copy[useLang()]
  const snapshot = useSyncExternalStore(
    (listener) => scope?.subscribe(listener) ?? (() => {}),
    () => scope?.getSnapshot() ?? UNAVAILABLE,
    () => UNAVAILABLE,
  )
  const [usage, setUsage] = useState<readonly UsageRow[]>([])
  const [storageDir, setStorageDir] = useState('')
  const [error, setError] = useState<string | undefined>()
  const value = snapshot.value
  useEffect(() => {
    if (view !== undefined && view !== 'page') return undefined
    let active = true
    void requestJson<{ readonly sessions?: readonly UsageRow[]; readonly storageDir?: string }>('/dsh-rewind/manage')
      .then((body) => {
        if (!active) return
        setUsage(body.sessions ?? [])
        setStorageDir(body.storageDir ?? '')
      })
      .catch((caught: unknown) => { if (active) setError(messageOf(caught)) })
    return () => { active = false }
  }, [view])
  if (view !== undefined && view !== 'page') return null
  const refresh = (): void => {
    void requestJson<{ readonly sessions?: readonly UsageRow[]; readonly storageDir?: string }>('/dsh-rewind/manage')
      .then((body) => {
        setUsage(body.sessions ?? [])
        setStorageDir(body.storageDir ?? '')
      })
      .catch((caught: unknown) => { setError(messageOf(caught)) })
  }
  const write = (key: string, next: boolean | number | string): void => {
    void scope?.set(key, next).catch((caught: unknown) => { setError(messageOf(caught)) })
  }
  const groups: readonly SettingsGroup[] = ['capture', 'restore', 'storage']
  return (
    <div data-dsh-rewind="settings">
      <h3>{text.settingsTitle}</h3>
      {value === undefined ? <p>{text.settingsMissing}</p> : groups.map(group => (
        <section key={group} data-dsh-rewind="group">
          <h4>{text.groups[group]}</h4>
          {VISIBLE_FIELDS.filter(field => field.group === group).map(field => {
            const labels = text.fields[field.key]
            const current = value[field.key]
            const disabled = snapshot.writable === false
            return (
              <div key={field.key} data-dsh-rewind="row">
                <div data-dsh-rewind="copy">
                  <strong>{labels?.[0] ?? field.key}</strong>
                  <span>{labels?.[1]}</span>
                </div>
                <div data-dsh-rewind="control">
                  {field.kind === 'bool' ? (
                    <Switch
                      checked={current === true}
                      disabled={disabled}
                      label={labels?.[0] ?? field.key}
                      onChange={(next) => { write(field.key, next) }}
                    />
                  ) : null}
                  {field.kind === 'select' ? (
                    <select
                      aria-label={labels?.[0] ?? field.key}
                      value={typeof current === 'string' ? current : field.options?.[0]}
                      disabled={disabled}
                      onChange={(event) => { write(field.key, event.target.value) }}
                    >
                      {(field.options ?? []).map(option => (
                        <option key={option} value={option}>{optionLabel(text, field.key, option)}</option>
                      ))}
                    </select>
                  ) : null}
                  {field.kind === 'number' || field.kind === 'mib' ? (
                    <label>
                      <input
                        aria-label={labels?.[0] ?? field.key}
                        type="number"
                        min={field.key === 'retentionDays' ? 0 : 1}
                        step={1}
                        value={shownNumber(field.kind, current)}
                        disabled={disabled}
                        onChange={(event) => {
                          const parsed = Number(event.target.value)
                          if (!Number.isSafeInteger(parsed) || parsed < (field.key === 'retentionDays' ? 0 : 1)) return
                          write(field.key, field.kind === 'mib' ? parsed * MIB : parsed)
                        }}
                      />
                      {field.kind === 'mib' ? <span data-dsh-rewind="unit">{text.mib}</span> : null}
                    </label>
                  ) : null}
                </div>
              </div>
            )
          })}
        </section>
      ))}
      <section data-dsh-rewind="group">
        <div data-dsh-rewind="usage-head">
          <h4>{text.usage}</h4>
          <Button type="button" variant="outline" size="sm" onClick={() => { void purge(undefined).then(refresh).catch((caught: unknown) => { setError(messageOf(caught)) }) }}>{text.purgeAll}</Button>
        </div>
        {storageDir !== '' ? <p data-dsh-rewind="path"><span>{text.storage}</span> <code>{storageDir}</code></p> : null}
        {usage.length === 0 ? <p data-dsh-rewind="empty">{text.none}</p> : (
          <ul>
            {usage.map(row => (
              <li key={row.sessionId} data-dsh-rewind="row">
                <div data-dsh-rewind="copy">
                  <code>{row.sessionId}</code>
                  <span>{String(row.checkpoints)} {text.checkpoints} · {String(row.bytes)} {text.bytes}</span>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => { void purge(row.sessionId).then(refresh).catch((caught: unknown) => { setError(messageOf(caught)) }) }}>{text.purge}</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error !== undefined ? <p role="alert">{error}</p> : null}
    </div>
  )
}

function optionLabel(text: (typeof copy)[Lang], field: string, option: string): string {
  const table: Record<string, string> | undefined = field === 'shellPolicy' || field === 'conflictPolicy'
    ? text.options[field]
    : undefined
  return table?.[option] ?? option
}

function shownNumber(kind: 'number' | 'mib', current: SettingsValue[keyof SettingsValue] | undefined): number {
  if (typeof current !== 'number' || !Number.isFinite(current)) return 0
  return kind === 'mib' ? Math.max(1, Math.round(current / MIB)) : current
}

function settingsScope(ctx: ClientContext): SettingsScope | undefined {
  const forms = ctx.get?.('configForms') as { get<T>(entryId: string): SettingsScope & { getSnapshot(): SettingsSnapshot & { value?: T } } } | undefined
  if (forms !== undefined) return forms.get<SettingsValue>('dsh-rewind')
  const legacy = ctx.get?.('settingsScope') as { bind(spec: { readonly namespace: string }): SettingsScope } | undefined
  return legacy?.bind({ namespace: 'dsh-rewind' })
}

async function openSessionWithDraft(ctx: ClientContext, sessionId: string, prompt: string): Promise<void> {
  if (typeof ctx.sessions.open === 'function') ctx.sessions.open(sessionId)
  else {
    const navigation = ctx.get?.('uiWorkspace') as { openSession(id: string): void } | undefined
    navigation?.openSession(sessionId)
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const scope = ctx.sessions.scope(sessionId)
    if (scope !== undefined) {
      ctx.conversation.input.for(scope).setDraft(prompt)
      return
    }
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
  }
}

async function purge(sessionId: string | undefined): Promise<void> {
  await requestJson('/dsh-rewind/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'purge', ...(sessionId === undefined ? {} : { sessionId }) }),
  })
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? {} : JSON.parse(text) as unknown
  } catch {
    throw new Error(response.ok ? 'invalid response' : `request failed (${String(response.status)})`)
  }
  if (!response.ok) {
    const record = body !== null && typeof body === 'object' ? body as { error?: unknown } : {}
    throw new Error(typeof record.error === 'string' ? record.error : `request failed (${String(response.status)})`)
  }
  return body as T
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mountStyles(): () => void {
  if (document.querySelector('style[data-dsh-rewind-style]') !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.dshRewindStyle = 'true'
  tag.textContent = [
    '[data-dsh-rewind="dialog"] ul { max-height: 240px; overflow: auto; padding: 0; list-style: none; }',
    '[data-dsh-rewind="dialog"] li { display: flex; gap: 8px; align-items: center; margin: 6px 0; }',
    '[data-dsh-rewind="actions"] { display: flex; gap: 8px; flex-wrap: wrap; }',
    '[data-dsh-rewind="settings"] { display: flex; flex-direction: column; gap: 28px; }',
    '[data-dsh-rewind="settings"] h3, [data-dsh-rewind="settings"] h4 { margin: 0; font-weight: 500; }',
    '[data-dsh-rewind="settings"] h3 { font-size: 14px; line-height: 20px; }',
    '[data-dsh-rewind="settings"] h4 { margin-bottom: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
    '[data-dsh-rewind="row"] { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 52px; padding: 10px 2px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }',
    '[data-dsh-rewind="copy"] { display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
    '[data-dsh-rewind="copy"] strong { font-size: 13px; font-weight: 500; line-height: 20px; }',
    '[data-dsh-rewind="copy"] span, [data-dsh-rewind="empty"], [data-dsh-rewind="path"] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
    '[data-dsh-rewind="control"] select, [data-dsh-rewind="control"] input { height: 32px; min-width: 148px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 13px; }',
    '[data-dsh-rewind="control"] label { display: flex; align-items: center; gap: 8px; }',
    '[data-dsh-rewind="unit"] { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
    '[data-dsh-rewind="usage-head"] { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
    '[data-dsh-rewind="settings"] ul { margin: 0; padding: 0; list-style: none; }',
    '[data-dsh-rewind="path"] { margin: 8px 2px 0; }',
    '[data-dsh-rewind="path"] code, [data-dsh-rewind="copy"] code { font-size: 12px; overflow-wrap: anywhere; }',
    '[data-dsh-rewind="empty"] { margin: 8px 2px 0; }',
  ].join('\n')
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
