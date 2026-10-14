/**
 * Browser half of DSH Rewind.
 * The turn-tail slot is the supported mount. A future user-message slot is registered the same way.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

type Lang = 'zh' | 'en'
type Mode = 'both' | 'code' | 'messages'
type FieldKind = 'bool' | 'text' | 'number' | 'select'

interface SettingsValue {
  enabled: boolean
  captureSubagents: boolean
  shellPolicy: 'gap' | 'ignore'
  shellTools: string
  extraFileTools: string
  pathFields: string
  excludeGlobs: string
  skipGenerated: boolean
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
  readonly turn?: number
  readonly sessionId?: string
  readonly openRestoredSession?: (sessionId: string, prompt: string) => Promise<void>
}

interface SettingsProps {
  readonly scope?: SettingsScope
}

const UNAVAILABLE: SettingsSnapshot = { status: 'unavailable' }
const FIELD_DEFS: readonly { readonly key: keyof SettingsValue; readonly kind: FieldKind; readonly options?: readonly string[] }[] = [
  { key: 'enabled', kind: 'bool' },
  { key: 'captureSubagents', kind: 'bool' },
  { key: 'shellPolicy', kind: 'select', options: ['gap', 'ignore'] },
  { key: 'shellTools', kind: 'text' },
  { key: 'extraFileTools', kind: 'text' },
  { key: 'pathFields', kind: 'text' },
  { key: 'excludeGlobs', kind: 'text' },
  { key: 'skipGenerated', kind: 'bool' },
  { key: 'maxFileBytes', kind: 'number' },
  { key: 'maxCheckpointsPerSession', kind: 'number' },
  { key: 'retentionDays', kind: 'number' },
  { key: 'maxSessionBytes', kind: 'number' },
  { key: 'maxStorageBytes', kind: 'number' },
  { key: 'maxStoredTurns', kind: 'number' },
  { key: 'conflictPolicy', kind: 'select', options: ['ask', 'skip', 'overwrite'] },
  { key: 'restoreCreatedFiles', kind: 'bool' },
  { key: 'blockWhileAgentsRun', kind: 'bool' },
  { key: 'allowOutsideWorkspace', kind: 'bool' },
  { key: 'previewTrust', kind: 'select', options: ['content', 'metadata'] },
  { key: 'putPromptInComposer', kind: 'bool' },
  { key: 'maxPreviewFiles', kind: 'number' },
  { key: 'staleLockMs', kind: 'number' },
  { key: 'originCheck', kind: 'select', options: ['same-origin', 'off'] },
]

const copy = {
  zh: {
    title: '回退',
    button: '回退这一轮',
    buttonTip: '把这一轮开始前的文件改回去，并另开会话。不会改掉原来的记录。',
    close: '关闭',
    warning: '手改过的文件，以及 shell、run_code 改过的内容，不会自动撤掉。',
    shell: '这一轮运行过命令。命令造成的改动不在回退范围内。',
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
    settingsTitle: '回退',
    settingsMissing: '设置服务还没就绪。',
    storage: '存储目录（改完要重启）',
    purge: '清除这个会话的回退记录',
    purgeAll: '清除全部回退记录',
    usage: '已保存的回退',
    none: '还没有回退记录。',
    bytes: '字节',
    checkpoints: '个检查点',
    actions: { restore: '恢复修改前', delete: '删除新建文件', unchanged: '已经是修改前' },
    states: { clean: '可回退', conflict: '有冲突', gap: '跳过' },
    fields: {
      enabled: ['启用捕获', '关闭后不再记录新的修改，已有记录仍可回退。'],
      captureSubagents: ['记录子代理的文件工具', '子代理改的文件算到父会话当前这一轮。'],
      shellPolicy: ['命令工具', 'gap 会标明跑过命令；ignore 则不标明。都不会给命令做快照。'],
      shellTools: ['命令工具名', '逗号分隔。这些工具只记一笔缺口。'],
      extraFileTools: ['额外文件工具名', '逗号分隔。配合下面的参数名读取路径。'],
      pathFields: ['路径参数名', '逗号分隔，例如 file_path,path。'],
      excludeGlobs: ['排除路径', '每行一个 glob。匹配到的文件不记录。'],
      skipGenerated: ['跳过生成目录', '另外不记录 node_modules、.git、dist、coverage 和 .dsh。你自己的排除列表仍然有效。'],
      maxFileBytes: ['单文件上限', '超过这个字节数的文件只记缺口，不存内容。'],
      maxCheckpointsPerSession: ['每会话保留条数', '超出后丢掉最旧的记录。'],
      retentionDays: ['保留天数', '0 表示不按天数删除。'],
      maxSessionBytes: ['每会话容量', '超出后从最旧的记录开始丢。'],
      maxStorageBytes: ['最大存储空间', '全部会话加在一起的字节上限。超出后丢掉最旧的一轮，至少保留一轮。'],
      maxStoredTurns: ['最大存储轮数', '全部会话加在一起最多保留这么多轮。超出后丢掉最旧的一轮。'],
      conflictPolicy: ['冲突策略', 'ask 要你勾选；skip 跳过；overwrite 直接覆盖。'],
      restoreCreatedFiles: ['删除本轮新建的文件', '关闭后，代理新建的文件会留在原地。'],
      blockWhileAgentsRun: ['运行中禁止改文件', '同一工作区还有代理在跑时，不允许回退代码。'],
      allowOutsideWorkspace: ['允许工作区外的路径', '默认拒绝。打开后才会记录并回退工作区外面的文件。'],
      previewTrust: ['预览校验', 'content 重新计算哈希；metadata 在大小和时间没变时少读一次。'],
      putPromptInComposer: ['把原话放回输入框', '回退对话后，把当时的用户消息放进新会话的输入框。'],
      maxPreviewFiles: ['预览最多显示', '对话框里最多列这么多行。指纹仍覆盖全部路径。'],
      staleLockMs: ['过期锁毫秒', '持有者进程已经不在、并且超过这个时间后，才允许抢走锁。'],
      originCheck: ['来源检查', 'same-origin 拒绝跨站请求。off 只适合可信的本机端口。'],
    } as Record<string, readonly [string, string]>,
  },
  en: {
    title: 'Rewind',
    button: 'Rewind this turn',
    buttonTip: 'Restore files from before this turn and open a forked session. The original session stays intact.',
    close: 'Close',
    warning: 'Manual edits, and anything a shell or run_code changed, are not undone.',
    shell: 'A command ran during this turn. Its effects are outside the rewind.',
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
    settingsTitle: 'Rewind',
    settingsMissing: 'Settings are not available yet.',
    storage: 'Storage directory (restart to change)',
    purge: 'Delete rewind data for this session',
    purgeAll: 'Delete all rewind data',
    usage: 'Saved rewinds',
    none: 'No rewind data yet.',
    bytes: 'bytes',
    checkpoints: 'checkpoints',
    actions: { restore: 'Restore previous bytes', delete: 'Delete created file', unchanged: 'Already at previous bytes' },
    states: { clean: 'Ready', conflict: 'Conflict', gap: 'Skip' },
    fields: {
      enabled: ['Capture edits', 'When off, new edits are not recorded. Existing records can still be restored.'],
      captureSubagents: ['Capture subagent file tools', 'Attribute a subagent edit to the parent session’s open turn.'],
      shellPolicy: ['Command tools', 'gap marks that a command ran. ignore does not. Neither snapshots the command.'],
      shellTools: ['Command tool names', 'Comma-separated. These tools only leave a gap.'],
      extraFileTools: ['Extra file tool names', 'Comma-separated. Their path is read from the fields below.'],
      pathFields: ['Path argument names', 'Comma-separated, for example file_path,path.'],
      excludeGlobs: ['Exclude globs', 'One glob per line. Matches are not recorded.'],
      skipGenerated: ['Skip generated directories', 'Also skip node_modules, .git, dist, coverage, and .dsh. Your own exclude list still applies.'],
      maxFileBytes: ['Per-file byte limit', 'A larger file is a gap, not a stored before-image.'],
      maxCheckpointsPerSession: ['Checkpoints per session', 'Older checkpoints are dropped past this count.'],
      retentionDays: ['Retention days', 'Zero disables the age sweep.'],
      maxSessionBytes: ['Bytes per session', 'Oldest checkpoints are dropped until the session fits.'],
      maxStorageBytes: ['Maximum storage', 'Byte cap across every session. The oldest turn is dropped until it fits, and at least one turn is kept.'],
      maxStoredTurns: ['Maximum stored turns', 'How many turns are kept across every session. The oldest turn is dropped past this count.'],
      conflictPolicy: ['Conflicts', 'ask requires a check. skip leaves them. overwrite replaces them.'],
      restoreCreatedFiles: ['Delete files created this turn', 'When off, files the agent created are left in place.'],
      blockWhileAgentsRun: ['Block while agents run', 'Refuse a file rewind while any agent is running in the workspace.'],
      allowOutsideWorkspace: ['Allow paths outside the workspace', 'Off by default. On records and restores those paths too.'],
      previewTrust: ['Preview check', 'content hashes the file. metadata skips the read when size and mtime still match.'],
      putPromptInComposer: ['Return the prompt to the composer', 'After a conversation rewind, put that user message in the new draft.'],
      maxPreviewFiles: ['Preview row limit', 'The dialog lists at most this many files. The fingerprint still covers every path.'],
      staleLockMs: ['Stale lock milliseconds', 'A lock can be taken only after its owner process is gone and this age has passed.'],
      originCheck: ['Origin check', 'same-origin rejects cross-site requests. off is only for a trusted local listener.'],
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
 * Register the turn-tail action and the settings card.
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
  ctx.slots.inject('conversation.chat.user-actions', () => {
    ctx.slots.register({
      name: 'conversation.chat.user-actions',
      id: 'dsh-rewind',
      order: 20,
      inject: (sessionId: string) => ({ sessionId, openRestoredSession }),
    }, RewindTurnButton as (props: Record<string, unknown>) => ReactNode)
  })
  const settings = () => ({ scope: settingsScope(ctx) })
  ctx.slots.inject('settings.plugin.item', () => {
    ctx.slots.register({ name: 'settings.plugin.item', key: 'dsh-rewind', inject: settings }, RewindSettingsCard as (props: Record<string, unknown>) => ReactNode)
  })
  ctx.slots.inject('settings.plugins.tab', () => {
    ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'dsh-rewind',
      order: 80,
      label: () => copy[lang].settingsTitle,
      inject: settings,
    }, RewindSettingsCard as (props: Record<string, unknown>) => ReactNode)
  })
}

function RewindTurnButton(props: TurnProps): ReactNode {
  const text = copy[useLang()]
  const [open, setOpen] = useState(false)
  if (!Number.isSafeInteger(props.turn) || props.sessionId === undefined || props.sessionId === '') return null
  const turn = props.turn as number
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
        <p>{text.warning}</p>
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

function RewindSettingsCard({ scope }: SettingsProps): ReactNode {
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
    void requestJson<{ readonly sessions?: readonly UsageRow[]; readonly storageDir?: string }>('/dsh-rewind/manage')
      .then((body) => {
        setUsage(body.sessions ?? [])
        setStorageDir(body.storageDir ?? '')
      })
      .catch((caught: unknown) => { setError(messageOf(caught)) })
  }, [])
  const refresh = (): void => {
    void requestJson<{ readonly sessions?: readonly UsageRow[]; readonly storageDir?: string }>('/dsh-rewind/manage')
      .then((body) => {
        setUsage(body.sessions ?? [])
        setStorageDir(body.storageDir ?? value?.storageDir ?? '')
      })
      .catch((caught: unknown) => { setError(messageOf(caught)) })
  }
  return (
    <section data-dsh-rewind="settings">
      <h3>{text.settingsTitle}</h3>
      {value === undefined ? <p>{text.settingsMissing}</p> : null}
      {value !== undefined ? FIELD_DEFS.map(field => {
        const labels = text.fields[field.key]
        const current = value[field.key]
        return (
          <label key={field.key}>
            <span>{labels?.[0] ?? field.key}</span>
            {field.kind === 'bool' ? (
              <input
                type="checkbox"
                checked={current === true}
                disabled={snapshot.writable === false}
                onChange={(event) => { void scope?.set(field.key, event.target.checked).catch((caught: unknown) => { setError(messageOf(caught)) }) }}
              />
            ) : null}
            {field.kind === 'text' ? (
              <textarea
                value={typeof current === 'string' ? current : ''}
                disabled={snapshot.writable === false}
                onChange={(event) => { void scope?.set(field.key, event.target.value).catch((caught: unknown) => { setError(messageOf(caught)) }) }}
              />
            ) : null}
            {field.kind === 'number' ? (
              <input
                type="number"
                value={typeof current === 'number' ? current : 0}
                disabled={snapshot.writable === false}
                onChange={(event) => {
                  const parsed = Number(event.target.value)
                  if (!Number.isSafeInteger(parsed)) return
                  void scope?.set(field.key, parsed).catch((caught: unknown) => { setError(messageOf(caught)) })
                }}
              />
            ) : null}
            {field.kind === 'select' ? (
              <select
                value={typeof current === 'string' ? current : field.options?.[0]}
                disabled={snapshot.writable === false}
                onChange={(event) => { void scope?.set(field.key, event.target.value).catch((caught: unknown) => { setError(messageOf(caught)) }) }}
              >
                {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : null}
            <small>{labels?.[1]}</small>
          </label>
        )
      }) : null}
      <p>{text.storage}</p>
      <code>{storageDir}</code>
      <div>
        <Button type="button" variant="ghost" onClick={refresh}>{text.usage}</Button>
        <Button type="button" variant="outline" onClick={() => { void purge(undefined).then(refresh).catch((caught: unknown) => { setError(messageOf(caught)) }) }}>{text.purgeAll}</Button>
      </div>
      {usage.length === 0 ? <p>{text.none}</p> : (
        <ul>
          {usage.map(row => (
            <li key={row.sessionId}>
              <code>{row.sessionId}</code>
              <span>{String(row.checkpoints)} {text.checkpoints} · {String(row.bytes)} {text.bytes}</span>
              <Button type="button" variant="ghost" onClick={() => { void purge(row.sessionId).then(refresh).catch((caught: unknown) => { setError(messageOf(caught)) }) }}>{text.purge}</Button>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined ? <p role="alert">{error}</p> : null}
    </section>
  )
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
    '[data-dsh-rewind="dialog"] li, [data-dsh-rewind="settings"] label, [data-dsh-rewind="settings"] li { display: flex; gap: 8px; align-items: center; margin: 6px 0; }',
    '[data-dsh-rewind="settings"] textarea { min-height: 64px; width: 100%; }',
    '[data-dsh-rewind="actions"] { display: flex; gap: 8px; flex-wrap: wrap; }',
  ].join('\n')
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
