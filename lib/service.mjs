/**
 * `ctx.extraWriteDirs` — the owner of the extra writable directories.
 *
 * This service is the single place that knows two things: which canonical
 * directories are configured, and whether the session making a call has the
 * extra preset selected.
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
 * The service also publishes the preset itself. The permission package exposes
 * no contribution API for a preset that is not a composition config entry, and
 * a config entry would be replaced wholesale by any profile that restates
 * `presets` (the shipped Web profile does), so the entry is added to the live
 * table and the client catalog is invalidated.
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyExtraDirsFence } from './fs.mjs'
import { applyExtraDirsConfine } from './provider.mjs'
import { expandExtraDirs } from './roots.mjs'

export const name = 'dsh-workspace-write-extra'

/** Default name of the added preset. */
export const DEFAULT_PRESET_NAME = 'workspace-write-extra'

/** The extra preset reuses the stock workspace-write sandbox mode. */
const PRESET_SANDBOX = 'workspace-write'

/** Matching the stock workspace-write entry keeps approval behaviour unchanged. */
const PRESET_APPROVAL = 'ask'

/** Preset names the permission service owns and refuses to shadow. */
const RESERVED_PRESETS = new Set(['custom', 'auto'])

/** Session projection key owned by `@deepseek-ai/dsh-permission-presets`. */
const PERMISSIONS_KEY = 'permissions'

export class ExtraWritableDirsService extends Service {
  static Config = z.object({
    /**
     * Directories writable in addition to the session workspace, and only
     * while the extra preset is selected. Absolute paths; a leading `~` is
     * expanded. Volatile, so the Settings page edits the list for this whole
     * profile and changes apply live.
     */
    extraWritableDirs: z.array(z.string()).default([]).volatile(),
    /** Name of the added preset in the permission picker. */
    presetName: z.string().default(DEFAULT_PRESET_NAME),
  })

  constructor(ctx, config) {
    super(ctx, 'extraWriteDirs')
    this.config = config
    /** Canonical directories currently in force. */
    this._roots = []
    /** Comparison key of the entry list the current expansion came from. */
    this._key = undefined
    /** Rejections already logged, so the warning is not repeated per refresh. */
    this._reported = undefined
    /** Guards the one-time unsupported-backend warning. */
    this._unsupportedReported = false
    this._refresh()
    this._publishPreset()
    this._publishContext()
    this._installEnforcement()
  }

  /**
   * The extra directories that apply to a call, from the policy the enforcing
   * service received. The policy carries a session id whenever a session made
   * the call; calls without one have no session and therefore selected no
   * preset, so they get none.
   *
   * @param policy - the resolved per-call policy, or `undefined` for a default call.
   * @returns the canonical extra directories that apply.
   */
  extraRootsFor(policy) {
    if (policy?.mode !== 'workspace-write') return []
    return this.rootsForSessionId(policy.sessionId)
  }

  /**
   * Wrap the live enforcement services in place. Both wrappers are additive:
   * the stock method stays authoritative, and each returns a disposer that
   * restores it exactly when this plugin unloads.
   *
   * A service that is not mounted yet is wrapped when it appears, so this does
   * not depend on composition order.
   */
  _installEnforcement() {
    for (const serviceName of ['fs', 'sandbox']) {
      this.ctx.inject([serviceName], (scope) => {
        const service = scope[serviceName]
        scope.effect(() => (serviceName === 'fs'
          ? applyExtraDirsFence(service, (policy) => this.extraRootsFor(policy))
          : applyExtraDirsConfine(service, {
            extraRootsFor: (policy) => this.extraRootsFor(policy),
            reportUnsupported: (runner) => this._reportUnsupported(runner),
          })))
      })
    }
  }

  /**
   * Report once that the selected backend cannot honor the extra directories,
   * so the gap is visible instead of silently narrowing the preset.
   * @param runner - the runner program the stock provider selected.
   */
  _reportUnsupported(runner) {
    if (this._unsupportedReported) return
    this._unsupportedReported = true
    this._warn(
      `the "${runner}" sandbox backend cannot extend its write allow-list from this plugin, `
      + 'so the extra writable directories are not applied to confined commands on this backend '
      + '(prefer bwrap, or use danger-full-access for those commands)',
    )
  }

  /** The configured preset name, falling back to the default when blank. */
  get presetName() {
    const raw = this.config.presetName
    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_PRESET_NAME
  }

  /**
   * The live configured entries. The field is volatile, so it is read through
   * its reference; a plain array (an unvalidated config in a unit test) is
   * accepted too.
   */
  entries() {
    const raw = this.config.extraWritableDirs
    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
    return Array.isArray(value) ? value : []
  }

  /** The canonical directories currently in force. */
  get roots() {
    return this._roots
  }

  /**
   * Re-expand the configured entries when they changed. Expansion is
   * asynchronous (it resolves symlinks), so the previous snapshot keeps
   * serving callers until the refresh settles; a directory therefore becomes
   * writable only after its own successful expansion, never before.
   */
  _refresh() {
    const entries = this.entries()
    const key = JSON.stringify(entries)
    if (key === this._key) return this._pending
    this._key = key
    this._pending = expandExtraDirs(entries).then(({ dirs, rejected }) => {
      // A newer configuration may have arrived while this expansion ran.
      if (this._key !== key) return
      this._roots = dirs
      this._report(rejected)
    }, (error) => {
      this._warn(`expanding extraWritableDirs failed: ${String(error?.message ?? error)}`)
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
    const summary = rejected.map(({ entry, reason }) => `${JSON.stringify(entry)} (${reason})`).join(', ')
    if (summary === this._reported) return
    this._reported = summary
    this._warn(`ignoring unusable extraWritableDirs entries: ${summary}`)
  }

  _warn(message) {
    try {
      this.ctx.logger?.warn?.(`workspace-write-extra: ${message}`)
    } catch {
      // A logger failure must never affect enforcement.
    }
  }

  /**
   * Whether the extra directories are in force for `session`: its last
   * recorded permission preset is this plugin's preset. Without the permission
   * service the preset cannot have been selected, so absence means off.
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns whether the extra directories apply.
   */
  activeFor(session) {
    if (session === undefined || this._roots.length === 0) return false
    const projections = this.ctx.get('sessionProjections')
    const state = projections?.stateOf?.(session, PERMISSIONS_KEY)
    return state?.preset === this.presetName
  }

  /**
   * The canonical extra directories that apply to one call: the configured set
   * while the preset is active for `session`, otherwise none.
   *
   * @param session - the calling session, or `undefined` for agentless calls.
   * @returns the canonical directories the call may additionally write.
   */
  rootsFor(session) {
    this._refresh()
    return this.activeFor(session) ? this._roots : []
  }

  /**
   * The canonical extra directories that apply to a call, identified by the
   * session id a resolved policy carries. Calls without one have no session
   * and therefore selected no preset, so they get none.
   *
   * @param sessionId - the session id from the resolved policy.
   * @returns the canonical directories the call may additionally write.
   */
  rootsForSessionId(sessionId) {
    this._refresh()
    if (sessionId === undefined || this._roots.length === 0) return []
    const session = this.ctx.get('sessions')?.get?.(sessionId)
    return session === undefined ? [] : this.rootsFor(session)
  }

  /**
   * Publish the extra preset in the permission service table and invalidate the
   * client catalog, so the picker offers it and `/permission <name>` accepts it.
   * Runs once the permission service is available; without it the preset cannot
   * be selected and this plugin's enforcement never engages.
   */
  _publishPreset() {
    this.ctx.inject(['permissionPresets'], (scope) => {
      const permissions = scope.permissionPresets
      scope.effect(() => {
        const presetName = this.presetName
        if (RESERVED_PRESETS.has(presetName)) {
          this._warn(`preset name ${JSON.stringify(presetName)} is reserved; the extra preset stays unpublished`)
          return
        }
        const table = permissions.presets
        if (typeof table !== 'object' || table === null) {
          this._warn('the permission service does not expose its preset table; the extra preset stays unpublished')
          return
        }
        const previous = table[presetName]
        // No `name`/`description`: the picker labels the machine value itself,
        // which keeps this entry reading like the built-in ones. Supplying a
        // string here would be rendered verbatim, in English, because the
        // client localizes only its own built-in presets.
        table[presetName] = {
          sandbox: PRESET_SANDBOX,
          approval: PRESET_APPROVAL,
        }
        permissions.emitCatalogChanged?.()
        return () => {
          if (previous === undefined) delete table[presetName]
          else table[presetName] = previous
          permissions.emitCatalogChanged?.()
        }
      })
    })
  }

  /**
   * Contribute a model-facing note naming the extra directories while the
   * preset is active, so the agent knows which out-of-workspace paths it may
   * write. Sits just after the stock sandbox policy section.
   */
  _publishContext() {
    this.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'sandbox:extra-write-dirs',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
        text: (context) => {
          const roots = this.rootsFor(context.agent?.session)
          if (roots.length === 0) return ''
          return 'The current DSH file policy additionally allows writing these configured directories: '
            + `${roots.map((root) => `"${root}"`).join(', ')}. `
            + 'They apply only while the extra-directories permission preset is selected.'
        },
      })
    })
  }
}

export default ExtraWritableDirsService
