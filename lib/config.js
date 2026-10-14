import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RewindError } from './errors.js';
const DEFAULT_SHELL_TOOLS = ['bash', 'shell', 'run_code', 'terminal'];
const DEFAULT_PATH_FIELDS = ['file_path', 'path'];
/** Built-in defaults. Numeric settings are bytes, days, or milliseconds as named. */
export const REWIND_DEFAULTS = {
    enabled: true,
    captureSubagents: true,
    shellPolicy: 'gap',
    shellTools: DEFAULT_SHELL_TOOLS.join(','),
    extraFileTools: '',
    pathFields: DEFAULT_PATH_FIELDS.join(','),
    excludeGlobs: '',
    skipGenerated: true,
    maxFileBytes: 8 * 1024 * 1024,
    maxCheckpointsPerSession: 100,
    retentionDays: 30,
    maxSessionBytes: 512 * 1024 * 1024,
    maxStorageBytes: 2 * 1024 * 1024 * 1024,
    maxStoredTurns: 1_000,
    conflictPolicy: 'ask',
    restoreCreatedFiles: true,
    blockWhileAgentsRun: true,
    allowOutsideWorkspace: false,
    previewTrust: 'content',
    putPromptInComposer: true,
    maxPreviewFiles: 200,
    staleLockMs: 30_000,
    originCheck: 'same-origin',
};
/**
 * Resolve and validate config.
 * An empty `storageDir` becomes `$DSH_HOME/rewind/v1` or `~/.dsh/rewind/v1`.
 * @param config - Partial plugin config.
 * @returns A complete config.
 */
export function resolveConfig(config = {}) {
    return {
        storageDir: resolveStorageDir(config.storageDir),
        enabled: bool(config.enabled, REWIND_DEFAULTS.enabled, 'enabled'),
        captureSubagents: bool(config.captureSubagents, REWIND_DEFAULTS.captureSubagents, 'captureSubagents'),
        shellPolicy: keyword(config.shellPolicy, ['gap', 'ignore'], REWIND_DEFAULTS.shellPolicy, 'shellPolicy'),
        shellTools: csv(config.shellTools ?? REWIND_DEFAULTS.shellTools),
        extraFileTools: csv(config.extraFileTools ?? REWIND_DEFAULTS.extraFileTools),
        pathFields: csv(config.pathFields ?? REWIND_DEFAULTS.pathFields),
        excludeGlobs: splitList(config.excludeGlobs ?? REWIND_DEFAULTS.excludeGlobs, '\n'),
        skipGenerated: bool(config.skipGenerated, REWIND_DEFAULTS.skipGenerated, 'skipGenerated'),
        maxFileBytes: positive(config.maxFileBytes, REWIND_DEFAULTS.maxFileBytes, 'maxFileBytes'),
        maxCheckpointsPerSession: positive(config.maxCheckpointsPerSession, REWIND_DEFAULTS.maxCheckpointsPerSession, 'maxCheckpointsPerSession'),
        retentionDays: nonNegative(config.retentionDays, REWIND_DEFAULTS.retentionDays, 'retentionDays'),
        maxSessionBytes: positive(config.maxSessionBytes, REWIND_DEFAULTS.maxSessionBytes, 'maxSessionBytes'),
        maxStorageBytes: positive(config.maxStorageBytes, REWIND_DEFAULTS.maxStorageBytes, 'maxStorageBytes'),
        maxStoredTurns: positive(config.maxStoredTurns, REWIND_DEFAULTS.maxStoredTurns, 'maxStoredTurns'),
        conflictPolicy: keyword(config.conflictPolicy, ['ask', 'skip', 'overwrite'], REWIND_DEFAULTS.conflictPolicy, 'conflictPolicy'),
        restoreCreatedFiles: bool(config.restoreCreatedFiles, REWIND_DEFAULTS.restoreCreatedFiles, 'restoreCreatedFiles'),
        blockWhileAgentsRun: bool(config.blockWhileAgentsRun, REWIND_DEFAULTS.blockWhileAgentsRun, 'blockWhileAgentsRun'),
        allowOutsideWorkspace: bool(config.allowOutsideWorkspace, REWIND_DEFAULTS.allowOutsideWorkspace, 'allowOutsideWorkspace'),
        previewTrust: keyword(config.previewTrust, ['content', 'metadata'], REWIND_DEFAULTS.previewTrust, 'previewTrust'),
        putPromptInComposer: bool(config.putPromptInComposer, REWIND_DEFAULTS.putPromptInComposer, 'putPromptInComposer'),
        maxPreviewFiles: bounded(config.maxPreviewFiles, REWIND_DEFAULTS.maxPreviewFiles, 1, 1_000, 'maxPreviewFiles'),
        staleLockMs: bounded(config.staleLockMs, REWIND_DEFAULTS.staleLockMs, 1_000, 24 * 60 * 60 * 1_000, 'staleLockMs'),
        originCheck: keyword(config.originCheck, ['same-origin', 'off'], REWIND_DEFAULTS.originCheck, 'originCheck'),
    };
}
/** Settings-card fields. `storageDir` stays on the cordis config layer. */
export function tunableSettings(config) {
    return {
        enabled: config.enabled,
        captureSubagents: config.captureSubagents,
        shellPolicy: config.shellPolicy,
        shellTools: config.shellTools.join(','),
        extraFileTools: config.extraFileTools.join(','),
        pathFields: config.pathFields.join(','),
        excludeGlobs: config.excludeGlobs.join('\n'),
        skipGenerated: config.skipGenerated,
        maxFileBytes: config.maxFileBytes,
        maxCheckpointsPerSession: config.maxCheckpointsPerSession,
        retentionDays: config.retentionDays,
        maxSessionBytes: config.maxSessionBytes,
        maxStorageBytes: config.maxStorageBytes,
        maxStoredTurns: config.maxStoredTurns,
        conflictPolicy: config.conflictPolicy,
        restoreCreatedFiles: config.restoreCreatedFiles,
        blockWhileAgentsRun: config.blockWhileAgentsRun,
        allowOutsideWorkspace: config.allowOutsideWorkspace,
        previewTrust: config.previewTrust,
        putPromptInComposer: config.putPromptInComposer,
        maxPreviewFiles: config.maxPreviewFiles,
        staleLockMs: config.staleLockMs,
        originCheck: config.originCheck,
    };
}
function resolveStorageDir(value) {
    if (value !== undefined && value.trim() !== '')
        return resolve(expandHome(value.trim()));
    const home = process.env.DSH_HOME;
    const root = home !== undefined && home.trim() !== '' ? resolve(expandHome(home.trim())) : join(homedir(), '.dsh');
    return join(root, 'rewind', 'v1');
}
function expandHome(value) {
    if (value === '~')
        return homedir();
    if (value.startsWith('~/') || value.startsWith('~\\'))
        return join(homedir(), value.slice(2));
    return value;
}
function bool(value, fallback, name) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        throw new RewindError('INVALID_CONFIG', `${name} must be a boolean`);
    return value;
}
function keyword(value, allowed, fallback, name) {
    if (value === undefined)
        return fallback;
    if (!allowed.includes(value))
        throw new RewindError('INVALID_CONFIG', `${name} must be ${allowed.join(' or ')}`);
    return value;
}
function positive(value, fallback, name) {
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || value < 1)
        throw new RewindError('INVALID_CONFIG', `${name} must be a positive integer`);
    return value;
}
function nonNegative(value, fallback, name) {
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RewindError('INVALID_CONFIG', `${name} must be a non-negative integer`);
    return value;
}
function bounded(value, fallback, min, max, name) {
    const resolved = positive(value, fallback, name);
    if (resolved < min || resolved > max)
        throw new RewindError('INVALID_CONFIG', `${name} must be between ${String(min)} and ${String(max)}`);
    return resolved;
}
function csv(value) {
    return splitList(value, ',');
}
function splitList(value, separator) {
    if (value.length > 8_000)
        throw new RewindError('INVALID_CONFIG', 'list settings must be at most 8000 characters');
    const items = [];
    for (const part of value.split(separator)) {
        const trimmed = part.trim();
        if (trimmed !== '' && !items.includes(trimmed))
            items.push(trimmed);
    }
    return items;
}
