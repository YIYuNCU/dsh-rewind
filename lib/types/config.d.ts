import type { ConflictPolicy, OriginCheck, PreviewTrust, ResolvedRewindConfig, RewindConfig, ShellPolicy } from './types.js';
/** Built-in defaults. Numeric settings are bytes, days, or milliseconds as named. */
export declare const REWIND_DEFAULTS: {
    enabled: boolean;
    captureSubagents: boolean;
    shellPolicy: "gap";
    shellTools: string;
    extraFileTools: string;
    pathFields: string;
    excludeGlobs: string;
    skipGenerated: boolean;
    captureExternal: boolean;
    maxSnapshotFiles: number;
    maxFileBytes: number;
    maxCheckpointsPerSession: number;
    retentionDays: number;
    maxSessionBytes: number;
    maxStorageBytes: number;
    maxStoredTurns: number;
    conflictPolicy: "ask";
    restoreCreatedFiles: boolean;
    blockWhileAgentsRun: boolean;
    allowOutsideWorkspace: boolean;
    previewTrust: "content";
    putPromptInComposer: boolean;
    maxPreviewFiles: number;
    staleLockMs: number;
    originCheck: "same-origin";
};
/**
 * Resolve and validate config.
 * An empty `storageDir` becomes `$DSH_HOME/rewind/v1` or `~/.dsh/rewind/v1`.
 * @param config - Partial plugin config.
 * @returns A complete config.
 */
export declare function resolveConfig(config?: RewindConfig): ResolvedRewindConfig;
/** Settings-card fields. `storageDir` stays on the cordis config layer. */
export declare function tunableSettings(config: ResolvedRewindConfig): Omit<ResolvedRewindConfig, 'storageDir' | 'shellTools' | 'extraFileTools' | 'pathFields' | 'excludeGlobs'> & {
    shellTools: string;
    extraFileTools: string;
    pathFields: string;
    excludeGlobs: string;
};
export type { ConflictPolicy, OriginCheck, PreviewTrust, ShellPolicy };
