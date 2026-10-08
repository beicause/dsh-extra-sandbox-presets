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
import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
  SANDBOX_MODES,
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
}

/** The permission service surface this plugin publishes into. */
interface PermissionTableHost {
  /** The live preset table; `private` in the shipped typings, so declared here. */
  readonly presets: Record<string, PresetSpec>
  /** Invalidates a client's cached permission catalog. */
  emitCatalogChanged?(): void
}

/**
 * The stock sandbox policy note this plugin restates. It is owned by
 * `@deepseek-ai/dsh-sandbox-policy`, which registers it at
 * `CONTEXT_ORDERS.SANDBOX_POLICY` and does not export its renderer, so the
 * note is corrected in place rather than replaced by a second context.
 */
const POLICY_CONTEXT = 'sandbox:policy'

/** The part of an assembled prompt this plugin rewrites. */
interface PromptAssembly {
  contexts: Array<{ name: string; text: string }>
}

/**
 * The system-prompt waterfall this plugin listens on. The event belongs to
 * `@deepseek-ai/dsh-system-prompt`, which is not a dependency here, so only
 * the shape this plugin touches is declared.
 */
interface AssembleHost {
  on(
    name: 'system-prompt/assemble',
    listener: (
      assembly: PromptAssembly,
      context: { agent?: { session?: unknown } },
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>,
    options?: { prepend?: boolean },
  ): unknown
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
    return this.rootsForSessionId(resolved.sessionId)
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
   * The canonical directories that apply to one call: the selected preset's
   * directories while a configured preset is selected, otherwise none.
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns the canonical directories the call may additionally write.
   */
  rootsFor(session: unknown): readonly string[] {
    this._refresh()
    const entry = this.presetFor(session)
    return entry === undefined ? [] : this.dirsForPreset(entry.name)
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
    this._pending = expandPresetDirs(entries).then(({ roots, unusable }) => {
      // A newer configuration may have arrived while this expansion ran.
      if (this._key !== key) return
      this._dirs = roots
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
   * Correct the stock sandbox policy note so it accounts for the directories
   * the session's selected preset adds. The stock note is written from the
   * sandbox mode alone, so it reads as a closed boundary in both confined
   * modes: under `read-only` it claims nothing is writable at all, and under
   * `workspace-write` it names the session workspace as the writable area.
   * The note is amended in place — a second context would contradict it.
   */
  private _publishContext(): void {
    this.ctx.inject(['systemPrompt'], (scope) => {
      const assemble = scope as unknown as AssembleHost
      if (typeof assemble.on !== 'function') return
      assemble.on('system-prompt/assemble', async (assembly, context, next) => {
        const assembled = await next()
        const entry = this.presetFor(context.agent?.session)
        if (entry === undefined || entry.sandbox === UNCONFINED_MODE) return assembled
        const roots = this.dirsForPreset(entry.name)
        if (roots.length === 0) return assembled
        // The stock note reads as a closed boundary in both confined modes:
        // under `read-only` it is a flat prohibition, and under
        // `workspace-write` it names the session workspace as the writable
        // area. The exception is stated outright in each case instead of
        // relying on "additionally" to be read as an override of the sentence
        // before it.
        const exception = entry.sandbox === 'read-only'
          ? ', even under the read-only policy above'
          : ', whether or not they are inside the session workspace'
        const note = 'The current DSH file policy additionally allows writing these configured directories'
          + exception
          + ': '
          + `${roots.map((root) => `"${root}"`).join(', ')}. `
          + 'They apply only while the permission preset that configures them is selected.'
        return {
          ...assembled,
          contexts: assembled.contexts.map((entry) =>
            entry.name === POLICY_CONTEXT && entry.text.length > 0
              ? { ...entry, text: `${entry.text} ${note}` }
              : entry),
        }
      })
    })
  }
}

/** The message of an unknown failure, reproducing `String(error?.message ?? error)`. */
function detailOf(error: unknown): string {
  const message = (error as { message?: unknown } | undefined)?.message
  return String(message ?? error)
}

export default ExtraSandboxPresetsService
