window.__ModuleLoader__.load({ id: "dsh-rewind", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Browser half of DSH Rewind.
 * The completed-turn tail is the chat mount. Settings live on the Plugins tab.
 */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const UNAVAILABLE = { status: 'unavailable' };
const MIB = 1024 * 1024;
const VISIBLE_FIELDS = [
    { key: 'skipGenerated', kind: 'bool', group: 'capture' },
    { key: 'generatedDirectories', kind: 'text', group: 'capture' },
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
];
const copy = {
    zh: {
        title: '回退',
        button: '回退这一轮',
        buttonTip: '把这一轮开始前的文件改回去，并另开会话。不会改掉原来的记录。',
        close: '关闭',
        warning: '生成目录、符号链接、硬链接，以及超过大小或数量上限的文件，不会自动撤掉。',
        shell: '这一轮运行过命令。命令改过的合格文件会回到这一轮开始时的内容。',
        blocked: '这个工作区还有正在运行的会话，暂时不能改文件。',
        hidden: (count) => `还有 ${String(count)} 个文件没列在这里，但回退会一起处理。`,
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
            skipGenerated: ['跳过生成目录', '打开后，不记录下面列出的目录，回退时也不会删它们。'],
            generatedDirectories: ['生成目录', '目录名用逗号分开，按路径里的一整段匹配。默认已包含常见语言的生成目录、依赖目录、缓存和临时目录。*.egg-info 匹配以 .egg-info 结尾的目录。改这里会替换整份名单。'],
            captureExternal: ['记录回合之间的改动', '每轮开始时记下工作区。之后的手改和脚本改动，回退到这一轮时会撤掉。'],
            retentionDays: ['保留天数', '0 表示不按天数删除。'],
            maxStorageBytes: ['最大存储空间', '全部会话加在一起的上限。超出后丢掉最旧的一轮，至少保留一轮。'],
            maxStoredTurns: ['最大存储轮数', '全部会话加在一起最多保留这么多轮。'],
            conflictPolicy: ['文件冲突', '文件已经和记录不一致时怎么处理。'],
            restoreCreatedFiles: ['删除本轮新建的文件', '关闭后，这一轮新建的文件会留在原地。'],
            blockWhileAgentsRun: ['运行中禁止改文件', '同一工作区还有代理在跑时，不允许回退代码。'],
            putPromptInComposer: ['把原话放回输入框', '回退对话后，把当时的用户消息放进新会话的输入框。'],
        },
    },
    en: {
        title: 'Rewind',
        button: 'Rewind this turn',
        buttonTip: 'Restore files from before this turn and open a forked session. The original session stays intact.',
        close: 'Close',
        warning: 'Generated directories, symlinks, hard links, and files past the size or count limit are not undone.',
        shell: 'A command ran during this turn. Eligible files it changed go back to the start of the turn.',
        blocked: 'An agent is still running in this workspace, so files cannot be changed.',
        hidden: (count) => `${String(count)} more files are hidden here but are still included.`,
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
            skipGenerated: ['Skip generated directories', 'When on, the directories below are not recorded and are not deleted on rewind.'],
            generatedDirectories: ['Generated directories', 'Comma-separated names, matched as a whole path segment. The default already covers common languages’ build, dependency, cache, and temporary directories. *.egg-info matches a name ending in .egg-info. Editing this replaces the whole list.'],
            captureExternal: ['Record edits between turns', 'Snapshot the workspace when a turn starts. Later manual and script edits are undone when you rewind to that turn.'],
            retentionDays: ['Retention days', 'Zero disables the age sweep.'],
            maxStorageBytes: ['Maximum storage', 'Cap across every session. The oldest turn is dropped until it fits, and at least one turn is kept.'],
            maxStoredTurns: ['Maximum stored turns', 'How many turns are kept across every session.'],
            conflictPolicy: ['File conflicts', 'What to do when a file no longer matches the recorded bytes.'],
            restoreCreatedFiles: ['Delete files created this turn', 'When off, files created during the turn stay in place.'],
            blockWhileAgentsRun: ['Block while agents run', 'Refuse a file rewind while any agent is running in the workspace.'],
            putPromptInComposer: ['Return the prompt to the composer', 'After a conversation rewind, put that user message in the new draft.'],
        },
    },
};
const listeners = new Set();
let lang = 'zh';
function useLang() {
    return (0, react_1.useSyncExternalStore)(subscribeLang, () => lang, () => lang);
}
function subscribeLang(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function adopt(next) {
    const resolved = next?.toLowerCase().startsWith('en') ? 'en' : 'zh';
    if (resolved === lang)
        return;
    lang = resolved;
    for (const listener of listeners)
        listener();
}
function followHostLocale(ctx) {
    const read = () => {
        try {
            const active = ctx.get?.('locale')?.getSnapshot().active;
            return typeof active === 'string' ? active : undefined;
        }
        catch {
            return undefined;
        }
    };
    adopt(read() ?? (typeof navigator === 'undefined' ? undefined : navigator.language));
    const timer = setTimeout(() => { adopt(read() ?? lang); }, 0);
    let off;
    try {
        off = ctx.on?.('locale/change', (snapshot) => { adopt(snapshot.active); });
    }
    catch {
        off = undefined;
    }
    return () => {
        clearTimeout(timer);
        if (typeof off === 'function')
            off();
    };
}
/** Services this browser plugin reads. */
exports.inject = ['slots', 'sessions', 'conversation'];
/**
 * Register the turn-tail action and the plugin-page settings.
 * @param ctx - Client context. This plugin does not start a server.
 */
function apply(ctx) {
    ctx.effect(() => followHostLocale(ctx), 'dsh-rewind.locale');
    ctx.effect(() => mountStyles(), 'dsh-rewind.styles');
    const openRestoredSession = async (sessionId, prompt) => {
        await openSessionWithDraft(ctx, sessionId, prompt);
    };
    ctx.slots.inject('conversation.chat.turnTail', () => {
        ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'dsh-rewind',
            order: 20,
            inject: (sessionId) => ({ sessionId, openRestoredSession }),
        }, RewindTurnButton);
    });
    ctx.slots.inject('plugins.bundle.config', () => {
        ctx.slots.register({
            name: 'plugins.bundle.config',
            key: 'dsh-rewind',
            inject: () => ({ scope: settingsScope(ctx) }),
        }, RewindSettingsCard);
    });
}
function turnOf(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return value;
    if (typeof value === 'object' && value !== null && typeof value.turn === 'number' && Number.isSafeInteger(value.turn))
        return value.turn;
    return undefined;
}
function RewindTurnButton(props) {
    const text = copy[useLang()];
    const [open, setOpen] = (0, react_1.useState)(false);
    const turn = turnOf(props.turn);
    if (turn === undefined || props.sessionId === undefined || props.sessionId === '')
        return null;
    const sessionId = props.sessionId;
    return ((0, jsx_runtime_1.jsxs)("span", { "data-dsh-rewind": "turn", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: text.buttonTip, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { type: "button", variant: "ghost", size: "sm", onClick: () => { setOpen(true); }, children: text.button }) }), open ? ((0, jsx_runtime_1.jsx)(RewindDialog, { sessionId: sessionId, turn: turn, title: text.title, closeLabel: text.close, onClose: () => { setOpen(false); }, ...(props.openRestoredSession === undefined ? {} : { openRestoredSession: props.openRestoredSession }) })) : null] }));
}
function RewindDialog(props) {
    const text = copy[useLang()];
    const [preview, setPreview] = (0, react_1.useState)();
    const [error, setError] = (0, react_1.useState)();
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [checked, setChecked] = (0, react_1.useState)([]);
    (0, react_1.useEffect)(() => {
        let active = true;
        void requestJson(`/dsh-rewind?sessionId=${encodeURIComponent(props.sessionId)}&turn=${String(props.turn)}`)
            .then((value) => { if (active)
            setPreview(value); })
            .catch((caught) => { if (active)
            setError(messageOf(caught)); });
        return () => { active = false; };
    }, [props.sessionId, props.turn]);
    const run = (mode) => {
        if (preview === undefined)
            return;
        setBusy(true);
        setError(undefined);
        void requestJson('/dsh-rewind', {
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
                await props.openRestoredSession?.(result.forkedSessionId, result.promptText ?? '');
            }
            props.onClose();
        }).catch((caught) => {
            setError(messageOf(caught) || text.failed);
            setBusy(false);
        });
    };
    const codeDisabled = busy || preview === undefined || preview.restoreBlocked;
    return ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Modal, { open: true, title: props.title, closeLabel: props.closeLabel, onClose: props.onClose, description: text.warning, children: (0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "dialog", children: [preview?.shellGap === true ? (0, jsx_runtime_1.jsx)("p", { children: text.shell }) : null, preview?.restoreBlocked === true ? (0, jsx_runtime_1.jsxs)("p", { children: [text.blocked, " ", preview.activeSessionIds.join(', ')] }) : null, preview !== undefined && preview.totalFiles === 0 ? (0, jsx_runtime_1.jsx)("p", { children: text.empty }) : null, preview !== undefined && preview.hiddenCount > 0 ? (0, jsx_runtime_1.jsx)("p", { children: text.hidden(preview.hiddenCount) }) : null, (0, jsx_runtime_1.jsx)("ul", { children: (preview?.files ?? []).map(file => ((0, jsx_runtime_1.jsxs)("li", { children: [preview?.conflictPolicy === 'ask' && file.state === 'conflict' ? ((0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: checked.includes(file.path), onChange: () => {
                                    setChecked(current => current.includes(file.path) ? current.filter(path => path !== file.path) : [...current, file.path]);
                                } })) : null, (0, jsx_runtime_1.jsx)("code", { children: file.path }), (0, jsx_runtime_1.jsxs)("span", { children: [text.actions[file.action], " \u00B7 ", text.states[file.state]] }), file.state === 'conflict' ? (0, jsx_runtime_1.jsx)("small", { children: text.conflict }) : null, file.state === 'gap' ? (0, jsx_runtime_1.jsx)("small", { children: text.gap }) : null] }, file.path))) }), error !== undefined ? (0, jsx_runtime_1.jsx)("p", { role: "alert", children: error }) : null, (0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "actions", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { type: "button", variant: "primary", disabled: codeDisabled || busy, onClick: () => { run('both'); }, children: busy ? text.working : text.both }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { type: "button", variant: "outline", disabled: codeDisabled, onClick: () => { run('code'); }, children: text.code }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { type: "button", variant: "ghost", disabled: busy || preview === undefined, onClick: () => { run('messages'); }, children: text.messages })] })] }) }));
}
function RewindSettingsCard({ view, scope }) {
    const text = copy[useLang()];
    const snapshot = (0, react_1.useSyncExternalStore)((listener) => scope?.subscribe(listener) ?? (() => { }), () => scope?.getSnapshot() ?? UNAVAILABLE, () => UNAVAILABLE);
    const [usage, setUsage] = (0, react_1.useState)([]);
    const [storageDir, setStorageDir] = (0, react_1.useState)('');
    const [error, setError] = (0, react_1.useState)();
    const value = snapshot.value;
    (0, react_1.useEffect)(() => {
        if (view !== undefined && view !== 'page')
            return undefined;
        let active = true;
        void requestJson('/dsh-rewind/manage')
            .then((body) => {
            if (!active)
                return;
            setUsage(body.sessions ?? []);
            setStorageDir(body.storageDir ?? '');
        })
            .catch((caught) => { if (active)
            setError(messageOf(caught)); });
        return () => { active = false; };
    }, [view]);
    if (view !== undefined && view !== 'page')
        return null;
    const refresh = () => {
        void requestJson('/dsh-rewind/manage')
            .then((body) => {
            setUsage(body.sessions ?? []);
            setStorageDir(body.storageDir ?? '');
        })
            .catch((caught) => { setError(messageOf(caught)); });
    };
    const write = (key, next) => {
        void scope?.set(key, next).catch((caught) => { setError(messageOf(caught)); });
    };
    const groups = ['capture', 'restore', 'storage'];
    return ((0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "settings", children: [(0, jsx_runtime_1.jsx)("h3", { children: text.settingsTitle }), value === undefined ? (0, jsx_runtime_1.jsx)("p", { children: text.settingsMissing }) : groups.map(group => ((0, jsx_runtime_1.jsxs)("section", { "data-dsh-rewind": "group", children: [(0, jsx_runtime_1.jsx)("h4", { children: text.groups[group] }), VISIBLE_FIELDS.filter(field => field.group === group).map(field => {
                        const labels = text.fields[field.key];
                        const current = value[field.key];
                        const disabled = snapshot.writable === false;
                        return ((0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "row", children: [(0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "copy", children: [(0, jsx_runtime_1.jsx)("strong", { children: labels?.[0] ?? field.key }), (0, jsx_runtime_1.jsx)("span", { children: labels?.[1] })] }), (0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "control", children: [field.kind === 'bool' ? ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Switch, { checked: current === true, disabled: disabled, label: labels?.[0] ?? field.key, onChange: (next) => { write(field.key, next); } })) : null, field.kind === 'select' ? ((0, jsx_runtime_1.jsx)("select", { "aria-label": labels?.[0] ?? field.key, value: typeof current === 'string' ? current : field.options?.[0], disabled: disabled, onChange: (event) => { write(field.key, event.target.value); }, children: (field.options ?? []).map(option => ((0, jsx_runtime_1.jsx)("option", { value: option, children: optionLabel(text, field.key, option) }, option))) })) : null, field.kind === 'text' ? ((0, jsx_runtime_1.jsx)("textarea", { "aria-label": labels?.[0] ?? field.key, spellCheck: false, rows: 6, value: typeof current === 'string' ? current : '', disabled: disabled, onChange: (event) => { write(field.key, event.target.value); } })) : null, field.kind === 'number' || field.kind === 'mib' ? ((0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { "aria-label": labels?.[0] ?? field.key, type: "number", min: field.key === 'retentionDays' ? 0 : 1, step: 1, value: shownNumber(field.kind, current), disabled: disabled, onChange: (event) => {
                                                        const parsed = Number(event.target.value);
                                                        if (!Number.isSafeInteger(parsed) || parsed < (field.key === 'retentionDays' ? 0 : 1))
                                                            return;
                                                        write(field.key, field.kind === 'mib' ? parsed * MIB : parsed);
                                                    } }), field.kind === 'mib' ? (0, jsx_runtime_1.jsx)("span", { "data-dsh-rewind": "unit", children: text.mib }) : null] })) : null] })] }, field.key));
                    })] }, group))), (0, jsx_runtime_1.jsxs)("section", { "data-dsh-rewind": "group", children: [(0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "usage-head", children: [(0, jsx_runtime_1.jsx)("h4", { children: text.usage }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { type: "button", variant: "outline", size: "sm", onClick: () => { void purge(undefined).then(refresh).catch((caught) => { setError(messageOf(caught)); }); }, children: text.purgeAll })] }), storageDir !== '' ? (0, jsx_runtime_1.jsxs)("p", { "data-dsh-rewind": "path", children: [(0, jsx_runtime_1.jsx)("span", { children: text.storage }), " ", (0, jsx_runtime_1.jsx)("code", { children: storageDir })] }) : null, usage.length === 0 ? (0, jsx_runtime_1.jsx)("p", { "data-dsh-rewind": "empty", children: text.none }) : ((0, jsx_runtime_1.jsx)("ul", { children: usage.map(row => ((0, jsx_runtime_1.jsxs)("li", { "data-dsh-rewind": "row", children: [(0, jsx_runtime_1.jsxs)("div", { "data-dsh-rewind": "copy", children: [(0, jsx_runtime_1.jsx)("code", { children: row.sessionId }), (0, jsx_runtime_1.jsxs)("span", { children: [String(row.checkpoints), " ", text.checkpoints, " \u00B7 ", String(row.bytes), " ", text.bytes] })] }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { type: "button", variant: "ghost", size: "sm", onClick: () => { void purge(row.sessionId).then(refresh).catch((caught) => { setError(messageOf(caught)); }); }, children: text.purge })] }, row.sessionId))) }))] }), error !== undefined ? (0, jsx_runtime_1.jsx)("p", { role: "alert", children: error }) : null] }));
}
function optionLabel(text, field, option) {
    const table = field === 'shellPolicy' || field === 'conflictPolicy'
        ? text.options[field]
        : undefined;
    return table?.[option] ?? option;
}
function shownNumber(kind, current) {
    if (typeof current !== 'number' || !Number.isFinite(current))
        return 0;
    return kind === 'mib' ? Math.max(1, Math.round(current / MIB)) : current;
}
function settingsScope(ctx) {
    const forms = ctx.get?.('configForms');
    if (forms !== undefined)
        return forms.get('dsh-rewind');
    const legacy = ctx.get?.('settingsScope');
    return legacy?.bind({ namespace: 'dsh-rewind' });
}
async function openSessionWithDraft(ctx, sessionId, prompt) {
    if (typeof ctx.sessions.open === 'function')
        ctx.sessions.open(sessionId);
    else {
        const navigation = ctx.get?.('uiWorkspace');
        navigation?.openSession(sessionId);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const scope = ctx.sessions.scope(sessionId);
        if (scope !== undefined) {
            ctx.conversation.input.for(scope).setDraft(prompt);
            return;
        }
        await new Promise(resolve => { setTimeout(resolve, 50); });
    }
}
async function purge(sessionId) {
    await requestJson('/dsh-rewind/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'purge', ...(sessionId === undefined ? {} : { sessionId }) }),
    });
}
async function requestJson(url, init) {
    const response = await fetch(url, init);
    const text = await response.text();
    let body;
    try {
        body = text === '' ? {} : JSON.parse(text);
    }
    catch {
        throw new Error(response.ok ? 'invalid response' : `request failed (${String(response.status)})`);
    }
    if (!response.ok) {
        const record = body !== null && typeof body === 'object' ? body : {};
        throw new Error(typeof record.error === 'string' ? record.error : `request failed (${String(response.status)})`);
    }
    return body;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function mountStyles() {
    if (document.querySelector('style[data-dsh-rewind-style]') !== null)
        return () => { };
    const tag = document.createElement('style');
    tag.dataset.dshRewindStyle = 'true';
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
        '[data-dsh-rewind="control"] textarea { width: 320px; min-height: 96px; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; line-height: 18px; resize: vertical; }',
        '[data-dsh-rewind="row"]:has(textarea) { align-items: flex-start; }',
        '[data-dsh-rewind="control"] label { display: flex; align-items: center; gap: 8px; }',
        '[data-dsh-rewind="unit"] { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
        '[data-dsh-rewind="usage-head"] { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
        '[data-dsh-rewind="settings"] ul { margin: 0; padding: 0; list-style: none; }',
        '[data-dsh-rewind="path"] { margin: 8px 2px 0; }',
        '[data-dsh-rewind="path"] code, [data-dsh-rewind="copy"] code { font-size: 12px; overflow-wrap: anywhere; }',
        '[data-dsh-rewind="empty"] { margin: 8px 2px 0; }',
    ].join('\n');
    document.head.appendChild(tag);
    return () => { tag.remove(); };
}

return module.exports; } });
//# sourceMappingURL=client.js.map
