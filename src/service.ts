/**
 * `ctx.sandboxPresets` — a registry of configured permission presets.
 *
 * Each entry of the `presets` config becomes one permission preset: a sandbox
 * mode, an approval policy, and a list of directories writable on top of
 * whatever that mode already allows. That covers both shapes the harness can
 * express — a `workspace-write` preset that adds directories beside the session
 * workspace, and a `read-only` preset that opens exactly the directories it
 * lists — and any number of each.
 *
 * The service is the single place that knows which directories a preset grants,
 * and whether the session making a call has that preset selected.
 *
 * It enforces them by wrapping the two live enforcement services in place — the
 * mounted filesystem's containment check (`./fs.js`) and the sandbox
 * provider's `confine` (`./provider.js`). Neither stock service is disabled,
 * replaced, or subclassed, so a failure to load this plugin leaves the harness
 * exactly as shipped instead of stripping it of its filesystem or sandbox.
 *
 * Enablement is per session and read from the permission service's projection
 * (the last recorded permission preset), so it survives restart by session-log
 * replay and never leaks between sessions.
 *
 * The service also publishes the presets themselves. The permission package
 * exposes no contribution API for a preset that is not a composition config
 * entry, and a config entry would be replaced wholesale by any profile that
 * restates `presets` (the shipped Web profile does), so the entries are added
 * to the live table and the client catalog is invalidated.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyExtraDirsFence } from './fs.js'
import { applyExtraDirsConfine } from './provider.js'
import { isAbsolute } from 'node:path'
import { workspaceEntryPath } from './roots.js'
import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
  SANDBOX_MODES,
  exceptionClauseFor,
  expandPresetDirs,
  normalizePresets,
  presetSpecOf,
  type PresetEntry,
  type PresetSpec,
} from './presets.js'

export const name = 'dsh-extra-sandbox-presets'

/** Session projection key owned by `@deepseek-ai/dsh-permission-presets`. */
const PERMISSIONS_KEY = 'permissions'

/** The one sandbox mode that never confines, so extra directories are moot. */
const UNCONFINED_MODE = 'danger-full-access'

/**
 * The validated plugin config this service reads.
 *
 * `presets` is volatile, so it is a live reference rather than a value; the
 * concrete type is left open because the service normalizes it itself and a
 * unit test may hand it a plain table.
 */
export interface SandboxPresetsConfig {
  readonly presets: unknown
}

/** The resolved per-call policy fields the enforcement path consults. */
interface ResolvedPolicy {
  readonly mode?: unknown
  readonly sessionId?: unknown
  readonly workspaceRoot?: unknown
}

/** The parts of a session this plugin reads to find its workspace. */
interface SessionLike {
  readonly id?: unknown
  readonly header?: { readonly cwd?: unknown }
}

/**
 * The sandbox policy service, read only to recover the workspace root the
 * harness folds for a session. Resolving through the service keeps this
 * plugin's workspace boundary identical to the one the stock policy states.
 */
interface SandboxPolicyHost {
  resolve?(request: { session?: unknown; mode?: unknown }): { workspaceRoot?: unknown } | undefined
}

/** The permission service surface this plugin publishes into. */
interface PermissionTableHost {
  /** The live preset table; `private` in the shipped typings, so declared here. */
  readonly presets: Record<string, PresetSpec>
  /** Invalidates a client's cached permission catalog. */
  emitCatalogChanged?(): void
}

/**
 * This plugin's own runtime-context entry, placed directly after the stock
 * sandbox policy note.
 *
 * It is a context of its own rather than an amendment of that note. The loop
 * re-resolves every context from its provider while preparing each request, so
 * a copy of another subsystem's entry that this plugin rewrote in the assembly
 * waterfall is replaced by the provider's own text before the snapshot reaches
 * the model: the note would be present in a direct `assemble()` and absent
 * from every real step. A provider of this plugin's own is re-resolved from the
 * live selection instead, so switching presets shows up in the next snapshot.
 */
const NOTE_CONTEXT = 'sandbox:preset-write-dirs'

/** The registry placement name of the stock sandbox policy note. */
const POLICY_PLACEMENT = 'SANDBOX_POLICY'

/** The prompt registry this plugin registers its note with. */
interface PromptRegistry {
  context(input: {
    name: string
    order: number
    text: (context: { agent?: { session?: unknown } }) => string
  }): unknown
  getContextOrder(name: string): number
}
/** One rejection reported to the operator, from either normalization stage. */
interface ReportableRejection {
  readonly name: string
  /** Present only for a directory that failed to expand. */
  readonly entry?: unknown
  readonly reason: string
}

const isPermissionTableHost = (value: unknown): value is PermissionTableHost =>
  typeof value === 'object' && value !== null && typeof (value as PermissionTableHost).presets === 'object'

/**
 * The workspace root one resolved policy carries. The enforcing services
 * receive the resolved policy, so its own root is preferred over re-resolving;
 * the session's cwd is the fallback for a partial policy.
 *
 * @param policy - the resolved per-call policy.
 * @param session - the session the call belongs to, when one was found.
 * @returns the absolute workspace root, or `undefined` when neither carries one.
 */
const workspaceRootOf = (policy: ResolvedPolicy, session: SessionLike | undefined): string | undefined => {
  const own = policy.workspaceRoot
  if (typeof own === 'string' && isAbsolute(own)) return own
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined
}

export class ExtraSandboxPresetsService extends Service {
  static Config = z.object({
    /**
     * The permission presets to register, keyed by preset name. Each value
     * names the sandbox mode and approval policy the preset selects, plus the
     * directories it makes writable on top of that mode. Absolute paths; a
     * leading `~` is expanded. Volatile, so the Settings page edits the whole
     * table for this profile and changes apply live.
     */
    presets: z.dict(z.object({
      sandbox: z.union(SANDBOX_MODES).default(DEFAULT_SANDBOX),
      approval: z.union(APPROVAL_POLICIES).default(DEFAULT_APPROVAL),
      writableDirs: z.array(z.string()).default([]),
      /** Optional display label for clients that show one. */
      name: z.string(),
      /** Optional one-line description for clients that show one. */
      description: z.string(),
    })).default({}).volatile(),
  })

  /** The validated plugin config this instance serves. */
  readonly config: SandboxPresetsConfig

  /** Normalized configured presets, in configuration order. */
  private _presets: PresetEntry[] = []

  /** Canonical directories per preset name. */
  private _dirs = new Map<string, string[]>()

  /** Workspace subpaths per preset name, resolved against a session's workspace. */
  private _workspace = new Map<string, string[]>()

  /** Comparison key of the table the current snapshot came from. */
  private _key: string | undefined = undefined

  /** Rejections already logged, so the warning is not repeated per refresh. */
  private _reported: string | undefined = undefined

  /** Guards the one-time unsupported-backend warning. */
  private _unsupportedReported = false

  /** Enforcement services already reported as missing the expected seam. */
  private readonly _unrecognizedReported = new Set<string>()

  /** Republish hook, installed once the permission service is available. */
  private _publish: (() => void) | undefined = undefined

  /** The in-flight directory expansion, so callers can settle it. */
  private _pending: Promise<void> | undefined = undefined

  constructor(ctx: Context, config: SandboxPresetsConfig) {
    super(ctx, 'sandboxPresets')
    this.config = config
    this._refresh()
    this._publishPresets()
    this._publishContext()
    this._installEnforcement()
  }

  /**
   * The directories that apply to a call, from the policy the enforcing service
   * received. The policy carries a session id whenever a session made the call;
   * calls without one have no session and therefore selected no preset, so they
   * get none.
   *
   * @param policy - the resolved per-call policy, or `undefined` for a default call.
   * @returns the canonical directories the call may additionally write.
   */
  extraRootsFor(policy: unknown): readonly string[] {
    const resolved = policy as ResolvedPolicy | undefined
    if (resolved === undefined || resolved === null) return []
    if (resolved.mode === UNCONFINED_MODE) return []
    this._refresh()
    const sessionId = resolved.sessionId
    if (sessionId === undefined || sessionId === null) return []
    const session = this.ctx.get('sessions')?.get?.(sessionId) as SessionLike | undefined
    const entry = session === undefined ? undefined : this.presetFor(session)
    if (entry === undefined) return []
    return this.resolvedDirsFor(entry.name, workspaceRootOf(resolved, session))
  }

  /**
   * Wrap the live enforcement services in place. Both wrappers are additive:
   * the stock method stays authoritative, and each returns a disposer that
   * restores it exactly when this plugin unloads.
   *
   * A service that is not mounted yet is wrapped when it appears, so this does
   * not depend on composition order. A service whose seam is not where this
   * plugin expects it is reported rather than passed over in silence, so a
   * harness upgrade that moves the seam is visible.
   */
  private _installEnforcement(): void {
    for (const serviceName of ['fs', 'sandbox'] as const) {
      this.ctx.inject([serviceName], (scope) => {
        const service = (scope as unknown as Record<string, unknown>)[serviceName]
        scope.effect(() => {
          const disposer = serviceName === 'fs'
            ? applyExtraDirsFence(service, (policy) => this.extraRootsFor(policy))
            : applyExtraDirsConfine(service, {
              extraRootsFor: (policy) => this.extraRootsFor(policy),
              reportUnsupported: (runner) => this._reportUnsupported(runner),
            })
          if (disposer === undefined) {
            this._reportUnrecognized(serviceName)
            return () => {}
          }
          return disposer
        })
      })
    }
  }

  /**
   * Report once that a mounted enforcement service does not expose the seam
   * this plugin extends, so an upgraded harness that moved it is visible
   * instead of leaving the presets quietly narrower than they claim.
   * @param serviceName - the service that could not be wrapped.
   */
  private _reportUnrecognized(serviceName: string): void {
    const key = `unrecognized:${serviceName}`
    if (this._unrecognizedReported.has(key)) return
    this._unrecognizedReported.add(key)
    this._warn(
      `the mounted "${serviceName}" service does not expose the interface this plugin extends, `
      + 'so the configured writable directories are not enforced through it; this usually means the '
      + 'installed dsh version moved that interface, and this plugin needs updating for it',
    )
  }

  /**
   * Report once that the selected backend cannot honor the configured
   * directories, so the gap is visible instead of silently narrowing a preset.
   * @param runner - the runner program the stock provider selected.
   */
  private _reportUnsupported(runner: string): void {
    if (this._unsupportedReported) return
    this._unsupportedReported = true
    this._warn(
      `the "${runner}" sandbox backend cannot extend its write allow-list from this plugin, `
      + 'so the configured writable directories are not applied to confined commands on this backend '
      + '(prefer bwrap, or use a danger-full-access preset for those commands)',
    )
  }

  /**
   * The configured presets, normalized and in configuration order. The field is
   * volatile, so it is read through its reference; a plain table (an
   * unvalidated config in a unit test) is accepted too.
   * @returns the current entries.
   */
  presets(): readonly PresetEntry[] {
    this._refresh()
    return this._presets
  }

  /** The configured preset names, in the order the picker offers them. */
  get presetNames(): readonly string[] {
    this._refresh()
    return this._presets.map((entry) => entry.name)
  }

  /**
   * The configured preset a session has selected, if any. Read from the
   * permission service's projection (the last recorded permission preset).
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns the selected configured preset, or `undefined`.
   */
  presetFor(session: unknown): PresetEntry | undefined {
    this._refresh()
    if (session === undefined || session === null) return undefined
    const state = this.ctx.get('sessionProjections')?.stateOf?.(session, PERMISSIONS_KEY)
    const selected: unknown = state?.preset
    if (typeof selected !== 'string') return undefined
    return this._presets.find((entry) => entry.name === selected)
  }

  /** The canonical directories one configured preset grants. */
  dirsForPreset(presetName: string): readonly string[] {
    return this._dirs.get(presetName) ?? []
  }

  /**
   * Every directory one configured preset grants, with its workspace-relative
   * entries resolved against a workspace root.
   *
   * A workspace subpath is joined onto the root the caller supplies, which is
   * the root the harness folded for that session — so a preset granting
   * `workspace:notes/` means the same thing for every session, wherever its
   * workspace is, instead of being pinned to whatever the process default was
   * when the plugin loaded.
   *
   * @param presetName - one configured preset name.
   * @param workspaceRoot - the workspace root of the calling session.
   * @returns the canonical directories plus the resolved workspace entries.
   */
  resolvedDirsFor(presetName: string, workspaceRoot: string | undefined): readonly string[] {
    const fixed = this.dirsForPreset(presetName)
    const subpaths = this._workspace.get(presetName) ?? []
    if (subpaths.length === 0 || workspaceRoot === undefined) return fixed
    const resolved = subpaths.map((subpath) => workspaceEntryPath(subpath, workspaceRoot))
    return [...fixed, ...resolved.filter((path) => !fixed.includes(path))]
  }

  /**
   * The canonical directories that apply to one call: the selected preset's
   * directories while a configured preset is selected, otherwise none.
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns the canonical directories the call may additionally write.
   */
  rootsFor(session: unknown): readonly string[] {
    this._refresh()
    const entry = this.presetFor(session)
    if (entry === undefined) return []
    return this.resolvedDirsFor(entry.name, this.workspaceRootFor(session as SessionLike | undefined))
  }

  /**
   * The workspace root a session writes within, as the harness folds it.
   *
   * Read through the sandbox policy service so this plugin's boundary is the
   * same one the stock `sandbox:policy` note names; a session's own `cwd` is
   * the direct fallback when that service is unavailable.
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns the absolute workspace root, or `undefined` when none can be found.
   */
  private workspaceRootFor(session: SessionLike | undefined): string | undefined {
    if (session === undefined || session === null) return undefined
    const policy = this.ctx.get('sandboxPolicy') as SandboxPolicyHost | undefined
    const resolved = policy?.resolve?.({ session })?.workspaceRoot
    if (typeof resolved === 'string' && isAbsolute(resolved)) return resolved
    const own = session.header?.cwd
    return typeof own === 'string' && isAbsolute(own) ? own : undefined
  }

  /**
   * The canonical directories that apply to a call, identified by the session
   * id a resolved policy carries. Calls without one have no session and
   * therefore selected no preset, so they get none.
   *
   * @param sessionId - the session id from the resolved policy.
   * @returns the canonical directories the call may additionally write.
   */
  rootsForSessionId(sessionId: unknown): readonly string[] {
    this._refresh()
    if (sessionId === undefined || sessionId === null) return []
    const session = this.ctx.get('sessions')?.get?.(sessionId)
    return session === undefined ? [] : this.rootsFor(session)
  }

  /**
   * Re-read and re-expand the configured table when it changed. Expansion is
   * asynchronous (it resolves symlinks), so the previous snapshot keeps serving
   * callers until the refresh settles; a directory therefore becomes writable
   * only after its own successful expansion, never before.
   */
  private _refresh(): Promise<void> | undefined {
    const { entries, rejected } = normalizePresets(this.config.presets)
    const key = JSON.stringify(entries)
    if (key === this._key) return this._pending
    this._key = key
    this._presets = entries
    this._publish?.()
    this._pending = expandPresetDirs(entries).then(({ roots, workspaceRoots, unusable }) => {
      // A newer configuration may have arrived while this expansion ran.
      if (this._key !== key) return
      this._dirs = roots
      this._workspace = workspaceRoots
      this._report([...rejected, ...unusable])
    }, (error: unknown) => {
      this._warn(`expanding the configured writable directories failed: ${detailOf(error)}`)
    })
    return this._pending
  }

  /**
   * Settle the current expansion. Callers that need the configured directories
   * to be in force already (startup, tests) await this; the enforcement path
   * deliberately does not, it serves the last settled snapshot.
   * @returns a promise resolved once the current expansion has settled.
   */
  async ready(): Promise<void> {
    await this._refresh()
  }

  private _report(rejected: readonly ReportableRejection[]): void {
    if (rejected.length === 0) {
      this._reported = undefined
      return
    }
    const summary = rejected
      .map(({ name, entry, reason }) => `${JSON.stringify(name)}: ${JSON.stringify(entry)} (${reason})`)
      .join(', ')
    if (summary === this._reported) return
    this._reported = summary
    this._warn(`ignoring unusable configured presets: ${summary}`)
  }

  private _warn(message: string): void {
    try {
      this.ctx.logger?.warn?.(`extra-sandbox-presets: ${message}`)
    } catch {
      // A logger failure must never affect enforcement.
    }
  }

  /**
   * Publish every configured preset in the permission service table and
   * invalidate the client catalog, so the picker offers them and
   * `/permission <name>` accepts them. Runs once the permission service is
   * available; without it no configured preset can be selected and this
   * plugin's enforcement never engages.
   *
   * A name that is already in the table (the shipped profile declares one of
   * them so its `defaultPreset` resolves without this plugin) is shadowed while
   * this plugin is loaded and restored exactly when it unloads.
   */
  private _publishPresets(): void {
    this.ctx.inject(['permissionPresets'], (scope) => {
      const permissions = (scope as unknown as { permissionPresets?: unknown }).permissionPresets
      scope.effect(() => {
        /** Names this plugin wrote, mapped to the value it replaced. */
        const applied = new Map<string, PresetSpec | undefined>()

        const sync = (): void => {
          if (!isPermissionTableHost(permissions)) {
            this._warn('the permission service does not expose its preset table; the configured presets stay unpublished')
            return
          }
          const table = permissions.presets
          const wanted = new Map(this._presets.map((entry) => [entry.name, presetSpecOf(entry)] as const))
          for (const [presetName, previous] of applied) {
            if (wanted.has(presetName)) continue
            if (previous === undefined) delete table[presetName]
            else table[presetName] = previous
            applied.delete(presetName)
          }
          for (const [presetName, spec] of wanted) {
            if (!applied.has(presetName)) applied.set(presetName, table[presetName])
            table[presetName] = spec
          }
          permissions.emitCatalogChanged?.()
        }

        this._publish = sync
        sync()
        return () => {
          this._publish = undefined
          if (isPermissionTableHost(permissions)) {
            const table = permissions.presets
            for (const [presetName, previous] of applied) {
              if (previous === undefined) delete table[presetName]
              else table[presetName] = previous
            }
          }
          if (isPermissionTableHost(permissions)) permissions.emitCatalogChanged?.()
        }
      })
    })
  }

  /**
   * Register this plugin's own runtime-context entry, naming the directories
   * the session's selected preset adds.
   *
   * The entry is rendered from the live selection on every assembly, so it
   * follows a preset switch and survives the per-request context refresh that
   * an amended copy of the stock note would not. It renders to an empty string
   * unless a configured, confined preset is selected with at least one usable
   * directory, and empty contexts are dropped from the snapshot, so no note
   * appears where this plugin grants nothing.
   */
  private _publishContext(): void {
    this.ctx.inject(['systemPrompt'], (scope) => {
      const registry = (scope as unknown as { systemPrompt?: PromptRegistry }).systemPrompt
      if (typeof registry?.context !== 'function') return
      // Directly after the stock note, which states the boundary the exception
      // is read against. Both orders come from the registry so a harness that
      // moves the note keeps this entry beside it.
      registry.context({
        name: NOTE_CONTEXT,
        order: registry.getContextOrder(POLICY_PLACEMENT) + 1,
        text: (context) => this.noteFor(context?.agent?.session),
      })
    })
  }

  /**
   * The model-facing note for one session, or an empty string when it grants
   * nothing beyond what the stock policy note already describes.
   *
   * The stock note is written from the sandbox mode alone, so it reads as a
   * closed boundary in both confined modes: under `read-only` it is a flat
   * prohibition, and under `workspace-write` it names the session workspace as
   * the writable area. The exception is therefore stated outright in each case
   * rather than left to "additionally" to be read as an override of the
   * sentence before it. `danger-full-access` never confines, so it is excluded
   * and only confined modes reach the clause.
   *
   * The preset name is named because a configured preset is what grants the
   * directories: when several are configured, the model has to know which one is
   * in force to answer whether a path is writable. The injector is named so the
   * note can be traced back to its source.
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns the note, or an empty string when no directory applies.
   */
  private noteFor(session: unknown): string {
    this._refresh()
    const entry = this.presetFor(session)
    if (entry === undefined || entry.sandbox === UNCONFINED_MODE) return ''
    // Workspace entries are named by the real path they resolve to for this
    // session, so the model is told where the directories actually are.
    const roots = this.resolvedDirsFor(entry.name, this.workspaceRootFor(session as SessionLike | undefined))
    if (roots.length === 0) return ''
    return `The ${name} plugin additionally allows writing these configured directories`
      + ` while the "${entry.name}" preset is selected`
      + exceptionClauseFor(entry.sandbox)
      + ': '
      + `${roots.map((root) => `"${root}"`).join(', ')}. `
      + 'They apply only while that preset remains selected.'
  }
}

/** The message of an unknown failure, reproducing `String(error?.message ?? error)`. */
function detailOf(error: unknown): string {
  const message = (error as { message?: unknown } | undefined)?.message
  return String(message ?? error)
}

export default ExtraSandboxPresetsService
