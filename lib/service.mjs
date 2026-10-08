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
 * mounted filesystem's containment check (`./fs.mjs`) and the sandbox
 * provider's `confine` (`./provider.mjs`). Neither stock service is disabled,
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

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyExtraDirsFence } from './fs.mjs'
import { applyExtraDirsConfine } from './provider.mjs'
import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
  SANDBOX_MODES,
  expandPresetDirs,
  normalizePresets,
  presetSpecOf,
} from './presets.mjs'

export const name = 'dsh-extra-sandbox-presets'

/** Session projection key owned by `@deepseek-ai/dsh-permission-presets`. */
const PERMISSIONS_KEY = 'permissions'

/** The one sandbox mode that never confines, so extra directories are moot. */
const UNCONFINED_MODE = 'danger-full-access'

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

  constructor(ctx, config) {
    super(ctx, 'sandboxPresets')
    this.config = config
    /** Normalized configured presets, in configuration order. */
    this._presets = []
    /** Canonical directories per preset name. */
    this._dirs = new Map()
    /** Comparison key of the table the current snapshot came from. */
    this._key = undefined
    /** Rejections already logged, so the warning is not repeated per refresh. */
    this._reported = undefined
    /** Guards the one-time unsupported-backend warning. */
    this._unsupportedReported = false
    /** Enforcement services already reported as missing the expected seam. */
    this._unrecognizedReported = new Set()
    /** Republish hook, installed once the permission service is available. */
    this._publish = undefined
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
  extraRootsFor(policy) {
    if (policy === undefined || policy.mode === UNCONFINED_MODE) return []
    return this.rootsForSessionId(policy.sessionId)
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
  _installEnforcement() {
    for (const serviceName of ['fs', 'sandbox']) {
      this.ctx.inject([serviceName], (scope) => {
        const service = scope[serviceName]
        scope.effect(() => {
          const disposer = serviceName === 'fs'
            ? applyExtraDirsFence(service, (policy) => this.extraRootsFor(policy))
            : applyExtraDirsConfine(service, {
              extraRootsFor: (policy) => this.extraRootsFor(policy),
              reportUnsupported: (runner) => this._reportUnsupported(runner),
            })
          if (disposer === undefined) this._reportUnrecognized(serviceName)
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
  _reportUnrecognized(serviceName) {
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
  _reportUnsupported(runner) {
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
  presets() {
    this._refresh()
    return this._presets
  }

  /** The configured preset names, in the order the picker offers them. */
  get presetNames() {
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
  presetFor(session) {
    this._refresh()
    if (session === undefined) return undefined
    const state = this.ctx.get('sessionProjections')?.stateOf?.(session, PERMISSIONS_KEY)
    const selected = state?.preset
    if (typeof selected !== 'string') return undefined
    return this._presets.find((entry) => entry.name === selected)
  }

  /** The canonical directories one configured preset grants. */
  dirsForPreset(presetName) {
    return this._dirs.get(presetName) ?? []
  }

  /**
   * The canonical directories that apply to one call: the selected preset's
   * directories while a configured preset is selected, otherwise none.
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns the canonical directories the call may additionally write.
   */
  rootsFor(session) {
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
  rootsForSessionId(sessionId) {
    this._refresh()
    if (sessionId === undefined) return []
    const session = this.ctx.get('sessions')?.get?.(sessionId)
    return session === undefined ? [] : this.rootsFor(session)
  }

  /**
   * Re-read and re-expand the configured table when it changed. Expansion is
   * asynchronous (it resolves symlinks), so the previous snapshot keeps serving
   * callers until the refresh settles; a directory therefore becomes writable
   * only after its own successful expansion, never before.
   */
  _refresh() {
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
    }, (error) => {
      this._warn(`expanding the configured writable directories failed: ${String(error?.message ?? error)}`)
    })
    return this._pending
  }

  /**
   * Settle the current expansion. Callers that need the configured directories
   * to be in force already (startup, tests) await this; the enforcement path
   * deliberately does not, it serves the last settled snapshot.
   * @returns a promise resolved once the current expansion has settled.
   */
  async ready() {
    await this._refresh()
  }

  _report(rejected) {
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

  _warn(message) {
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
  _publishPresets() {
    this.ctx.inject(['permissionPresets'], (scope) => {
      const permissions = scope.permissionPresets
      scope.effect(() => {
        /** Names this plugin wrote, mapped to the value it replaced. */
        const applied = new Map()

        const sync = () => {
          const table = permissions.presets
          if (typeof table !== 'object' || table === null) {
            this._warn('the permission service does not expose its preset table; the configured presets stay unpublished')
            return
          }
          const wanted = new Map(this._presets.map((entry) => [entry.name, presetSpecOf(entry)]))
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
          const table = permissions.presets
          if (typeof table === 'object' && table !== null) {
            for (const [presetName, previous] of applied) {
              if (previous === undefined) delete table[presetName]
              else table[presetName] = previous
            }
          }
          permissions.emitCatalogChanged?.()
        }
      })
    })
  }

  /**
   * Contribute a model-facing note naming the directories the session's
   * selected preset adds, so the agent knows which out-of-workspace paths it
   * may write. Sits just after the stock sandbox policy section.
   */
  _publishContext() {
    this.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'sandbox:preset-write-dirs',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
        text: (context) => {
          const roots = this.rootsFor(context.agent?.session)
          if (roots.length === 0) return ''
          return 'The current DSH file policy additionally allows writing these configured directories: '
            + `${roots.map((root) => `"${root}"`).join(', ')}. `
            + 'They apply only while the permission preset that configures them is selected.'
        },
      })
    })
  }
}

export default ExtraSandboxPresetsService
