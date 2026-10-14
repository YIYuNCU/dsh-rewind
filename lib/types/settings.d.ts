/**
 * Runtime settings for DSH Rewind.
 * `storageDir` is cordis.yml only and is not hot-swappable.
 * @module dsh-rewind
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Schema } from '@deepseek-ai/schemastery';
import type { RewindEngine } from './engine.js';
import type { RewindConfig } from './types.js';
/** Settings namespace shared by the host section and the browser card. */
export declare const REWIND_SETTINGS_NAMESPACE = "dsh-rewind";
/** Fields the settings card may change without moving the storage root. */
export interface RewindSettings {
    enabled: boolean;
    captureSubagents: boolean;
    shellPolicy: 'gap' | 'ignore';
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
    conflictPolicy: 'ask' | 'skip' | 'overwrite';
    restoreCreatedFiles: boolean;
    blockWhileAgentsRun: boolean;
    allowOutsideWorkspace: boolean;
    previewTrust: 'content' | 'metadata';
    putPromptInComposer: boolean;
    maxPreviewFiles: number;
    staleLockMs: number;
    originCheck: 'same-origin' | 'off';
    /** Empty uses the default state root. Changing it takes effect on the next launch. */
    storageDir: string;
}
/** Schema projected into DSH 0.1.7 Config and the legacy settings namespace. */
export declare const RewindSettingsSchema: Schema<RewindSettings>;
/**
 * Register the settings namespace and push changes into the running engine.
 * @param ctx - Host context.
 * @param config - Composition config, including the fixed storage root.
 * @param engine - Ledger to update.
 */
export declare function installRewindSettings(ctx: Context, config: RewindConfig, engine: RewindEngine): void;
