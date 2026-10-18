/**
 * The structural type contracts of this package.
 *
 * Most types live as JSDoc next to the code they describe; the ones collected
 * here are the ones JSDoc expresses poorly — discriminated unions, recursive
 * shapes, and the interfaces shared across modules — and declaring them in a
 * single place lets every module import the same type for the same thing.
 *
 * The file is a declaration module: it holds no runtime code and is imported
 * only for its types, as `import('./contracts.js').X`.
 */

/** One sandbox mode a preset may select, as the sandbox package defines it. */
export type { SandboxMode } from '@deepseek-ai/dsh-sandbox';

/**
 * The sandbox modes that confine. Only these can be widened by extra
 * directories: `danger-full-access` already allows every path, so a preset
 * selecting it has nothing to add.
 */
export type ConfinedMode = Exclude<import('@deepseek-ai/dsh-sandbox').SandboxMode, 'danger-full-access'>;

/** One approval policy a preset may select. */
export type ApprovalPolicy = 'ask' | 'never';

/** The shape the permission service stores for one preset. */
export interface PresetSpec {
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  name?: string;
  description?: string;
}

/** One normalized, usable configured preset. */
export interface PresetEntry {
  readonly name: string;
  readonly sandbox: SandboxMode;
  readonly approval: ApprovalPolicy;
  readonly writableDirs: readonly unknown[];
  /** Optional display label, distinct from the table key. */
  readonly label: string | undefined;
  /** Optional one-line description. */
  readonly description: string | undefined;
}

/** One configured preset that could not be used, with the reason why. */
export interface RejectedPreset {
  readonly name: string;
  readonly reason: string;
}

/** One configured directory that could not be used, with the reason why. */
export interface RejectedEntry {
  readonly entry: unknown;
  readonly reason: string;
}

/** One unusable directory entry, attributed to the preset that configured it. */
export interface UnusablePresetDir extends RejectedEntry {
  readonly name: string;
}

/** The outcome of normalizing the configured preset table. */
export interface NormalizedPresets {
  readonly entries: PresetEntry[];
  readonly rejected: RejectedPreset[];
}

/** The usable directories plus the entries that were rejected. */
export interface ExpandedDirs {
  /** Canonical absolute directories, usable as they are. */
  readonly dirs: string[];
  /** Subpaths of the session workspace, resolvable only per session. */
  readonly workspaceDirs: string[];
  readonly rejected: RejectedEntry[];
}

/** The outcome of expanding every preset's configured directories. */
export interface ExpandedPresetDirs {
  /** Canonical absolute directories per preset name. */
  readonly roots: Map<string, string[]>;
  /**
   * Workspace subpaths per preset name. These name directories inside the
   * session workspace, so they become real paths only against the workspace
   * root of the session making a call.
   */
  readonly workspaceRoots: Map<string, string[]>;
  readonly unusable: UnusablePresetDir[];
}

/**
 * A config field that may be a live volatile reference rather than a value.
 *
 * Cordis' `Volatile` is the real shape; this alias only fixes the payload to
 * `unknown`, because a config field here carries any JSON value.
 */
export type VolatileLike = import('@deepseek-ai/cordis').Volatile<unknown>;

/** The resolved target the stock filesystem fence checks and returns. */
export type { FsTarget as FenceTarget } from '@deepseek-ai/dsh-fs';

/** Reports the extra directories that apply to one call's policy. */
export type ExtraRootsFor = (policy: unknown) => readonly string[];

/** The confined invocation the stock sandbox provider returns. */
export type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox';

/** Reporting hooks the confine wrapper needs from the service. */
export interface ConfineDeps {
  /** Reports the extra directories that apply to one call's policy. */
  extraRootsFor: ExtraRootsFor;
  /** Reports a runner whose profile this plugin cannot extend. */
  reportUnsupported: (runner: string) => void;
}

/** The parts of a session this plugin reads to find its workspace. */
export interface SessionLike {
  readonly id?: unknown;
  readonly header?: { readonly cwd?: unknown };
}

/**
 * The resolved per-call policy fields the enforcement path consults.
 *
 * A partial `SandboxExecutionPolicy`: the service reads whatever the policy
 * service has already resolved, which may leave any field absent for an
 * agentless call.
 */
export type ResolvedPolicy = Partial<import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy>;

/** The validated plugin config this service reads. */
export interface SandboxPresetsConfig {
  readonly presets: unknown;
}

/**
 * The sandbox policy service, read only to recover the workspace root the
 * harness folds for a session. Resolving through the service keeps this
 * plugin's workspace boundary identical to the one the stock policy states.
 */
export interface SandboxPolicyHost {
  resolve?(request: { session?: unknown; mode?: unknown }): { workspaceRoot?: unknown } | undefined;
}

/** The permission service surface this plugin publishes into. */
export interface PermissionTableHost {
  /** The live preset table; `private` in the shipped typings, so declared here. */
  readonly presets: Record<string, PresetSpec>;
  /** Invalidates a client's cached permission catalog. */
  emitCatalogChanged?(): void;
}

/** The prompt registry surface this plugin registers its note with. */
export interface PromptRegistry {
  context(input: {
    name: string;
    order: number;
    text: (context: { agent?: { session?: unknown } }) => string;
  }): unknown;
  getContextOrder(name: string): number;
}

/** One rejection reported to the operator, from either normalization stage. */
export interface ReportableRejection {
  readonly name: string;
  /** Present only for a directory that failed to expand. */
  readonly entry?: unknown;
  readonly reason: string;
}
