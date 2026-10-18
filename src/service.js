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

import { Service } from '@deepseek-ai/cordis'
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
} from './presets.js'

/** @typedef {import('./contracts.js').PresetEntry} PresetEntry */
/** @typedef {import('./contracts.js').PresetSpec} PresetSpec */
/** @typedef {import('./contracts.js').SessionLike} SessionLike */
/** @typedef {import('./contracts.js').ResolvedPolicy} ResolvedPolicy */
/** @typedef {import('./contracts.js').SandboxPolicyHost} SandboxPolicyHost */
/** @typedef {import('./contracts.js').PermissionTableHost} PermissionTableHost */
/** @typedef {import('./contracts.js').PromptRegistry} PromptRegistry */
/** @typedef {import('./contracts.js').ReportableRejection} ReportableRejection */
/** @typedef {import('./contracts.js').SandboxPresetsConfig} SandboxPresetsConfig */

export const name = 'dsh-extra-sandbox-presets'

/** Session projection key owned by `@deepseek-ai/dsh-permission-presets`. */
const PERMISSIONS_KEY = 'permissions'

/** The one sandbox mode that never confines, so extra directories are moot. */
const UNCONFINED_MODE = 'danger-full-access'

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

/**
 * Read a service by name from the composition context. `Context.get` is not
 * declared on the slice of the typings this package sees, so the call goes
 * through one checked cast here instead of at every use.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the composition context.
 * @param {string} serviceName - the service name to read.
 * @returns {unknown} the mounted service, or `undefined` when there is none.
 */
const serviceOf = (ctx, serviceName) =>
  /** @type {{ get?: (name: string) => unknown }} */ (ctx).get?.(serviceName)

/**
 * @param {unknown} value
 * @returns {value is PermissionTableHost}
 */
const isPermissionTableHost = (value) =>
  typeof value === 'object' && value !== null && typeof /** @type {PermissionTableHost} */ (value).presets === 'object'

/**
 * The workspace root one resolved policy carries. The enforcing services
 * receive the resolved policy, so its own root is preferred over re-resolving;
 * the session's cwd is the fallback for a partial policy.
 *
 * @param {ResolvedPolicy} policy - the resolved per-call policy.
 * @param {SessionLike | undefined} session - the session the call belongs to, when one was found.
 * @returns {string | undefined} the absolute workspace root, or `undefined` when neither carries one.
 */
const workspaceRootOf = (policy, session) => {
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

  /**
   * The validated plugin config this instance serves.
   *
   * @param {import('@deepseek-ai/cordis').Context} ctx - the composition context.
   * @param {SandboxPresetsConfig} config - the validated plugin config.
   */
  constructor(ctx, config) {
    super(ctx, 'sandboxPresets')
    /** The validated plugin config this instance serves. @type {SandboxPresetsConfig} */
    this.config = config
    /** Normalized configured presets, in configuration order. @type {PresetEntry[]} */
    this._presets = []
    /** Canonical directories per preset name. @type {Map<string, string[]>} */
    this._dirs = new Map()
    /** Workspace subpaths per preset name. @type {Map<string, string[]>} */
    this._workspace = new Map()
    /** Comparison key of the table the current snapshot came from. @type {string | undefined} */
    this._key = undefined
    /** Rejections already logged, so the warning is not repeated per refresh. @type {string | undefined} */
    this._reported = undefined
    /** Guards the one-time unsupported-backend warning. @type {boolean} */
    this._unsupportedReported = false
    /** Enforcement services already reported as missing the expected seam. @type {Set<string>} */
    this._unrecognizedReported = new Set()
    /** Republish hook, installed once the permission service is available. @type {(() => void) | undefined} */
    this._publish = undefined
    /** The in-flight directory expansion, so callers can settle it. @type {Promise<void> | undefined} */
    this._pending = undefined
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
   * @param {unknown} [policy] - the resolved per-call policy, or `undefined` for a default call.
   * @returns {readonly string[]} the canonical directories the call may additionally write.
   */
  extraRootsFor(policy = undefined) {
    const resolved = /** @type {ResolvedPolicy | undefined} */ (policy)
    if (resolved === undefined || resolved === null) return []
    if (resolved.mode === UNCONFINED_MODE) return []
    this._refresh()
    const sessionId = resolved.sessionId
    if (sessionId === undefined || sessionId === null) return []
    const session = /** @type {SessionLike | undefined} */ (
      /** @type {{ get?: (id: unknown) => unknown } | undefined} */ (serviceOf(this.ctx, 'sessions'))?.get?.(sessionId)
    )
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
  _installEnforcement() {
    for (const serviceName of /** @type {const} */ (['fs', 'sandbox'])) {
      this.ctx.inject([serviceName], (scope) => {
        const service = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (scope))[serviceName]
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
   * @param {string} serviceName - the service that could not be wrapped.
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
   * @param {string} runner - the runner program the stock provider selected.
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
   * @returns {readonly PresetEntry[]} the current entries.
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
   * @param {unknown} [session] - the calling session, or `undefined` for agentless calls.
   * @returns {PresetEntry | undefined} the selected configured preset, or `undefined`.
   */
  presetFor(session = undefined) {
    this._refresh()
    if (session === undefined || session === null) return undefined
    const state = /** @type {{ stateOf?: (session: unknown, key: string) => { preset?: unknown } | undefined }} */ (
      serviceOf(this.ctx, 'sessionProjections')
    )?.stateOf?.(session, PERMISSIONS_KEY)
    const selected = state?.preset
    if (typeof selected !== 'string') return undefined
    return this._presets.find((entry) => entry.name === selected)
  }

  /**
   * The canonical directories one configured preset grants.
   *
   * @param {string} presetName - one configured preset name.
   * @returns {readonly string[]} the canonical directories of that preset.
   */
  dirsForPreset(presetName) {
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
   * @param {string} presetName - one configured preset name.
   * @param {string | undefined} workspaceRoot - the workspace root of the calling session.
   * @returns {readonly string[]} the canonical directories plus the resolved workspace entries.
   */
  resolvedDirsFor(presetName, workspaceRoot) {
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
   * @param {unknown} [session] - the calling session, or `undefined` for agentless calls.
   * @returns {readonly string[]} the canonical directories the call may additionally write.
   */
  rootsFor(session = undefined) {
    this._refresh()
    const entry = this.presetFor(session)
    if (entry === undefined) return []
    return this.resolvedDirsFor(entry.name, this.workspaceRootFor(/** @type {SessionLike | undefined} */ (session)))
  }

  /**
   * The workspace root a session writes within, as the harness folds it.
   *
   * Read through the sandbox policy service so this plugin's boundary is the
   * same one the stock `sandbox:policy` note names; a session's own `cwd` is
   * the direct fallback when that service is unavailable.
   *
   * @param {SessionLike | undefined} session - the calling session, or `undefined` for agentless calls.
   * @returns {string | undefined} the absolute workspace root, or `undefined` when none can be found.
   */
  workspaceRootFor(session) {
    if (session === undefined || session === null) return undefined
    const policy = /** @type {SandboxPolicyHost | undefined} */ (serviceOf(this.ctx, 'sandboxPolicy'))
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
   * @param {unknown} [sessionId] - the session id from the resolved policy.
   * @returns {readonly string[]} the canonical directories the call may additionally write.
   */
  rootsForSessionId(sessionId = undefined) {
    this._refresh()
    if (sessionId === undefined || sessionId === null) return []
    const session = /** @type {{ get?: (id: unknown) => unknown } | undefined} */ (
      serviceOf(this.ctx, 'sessions')
    )?.get?.(sessionId)
    return session === undefined ? [] : this.rootsFor(session)
  }

  /**
   * Re-read and re-expand the configured table when it changed. Expansion is
   * asynchronous (it resolves symlinks), so the previous snapshot keeps serving
   * callers until the refresh settles; a directory therefore becomes writable
   * only after its own successful expansion, never before.
   *
   * @returns {Promise<void> | undefined} the in-flight expansion, if any.
   */
  _refresh() {
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
    }, (error) => {
      this._warn(`expanding the configured writable directories failed: ${detailOf(error)}`)
    })
    return this._pending
  }

  /**
   * Settle the current expansion. Callers that need the configured directories
   * to be in force already (startup, tests) await this; the enforcement path
   * deliberately does not, it serves the last settled snapshot.
   * @returns {Promise<void>} a promise resolved once the current expansion has settled.
   */
  async ready() {
    await this._refresh()
  }

  /** @param {readonly ReportableRejection[]} rejected */
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

  /** @param {string} message */
  _warn(message) {
    try {
      /** @type {{ logger?: { warn?: (message: string) => void } }} */ (/** @type {unknown} */ (this.ctx)).logger?.warn?.(`extra-sandbox-presets: ${message}`)
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
      const permissions = /** @type {{ permissionPresets?: unknown }} */ (scope).permissionPresets
      scope.effect(() => {
        /** Names this plugin wrote, mapped to the value it replaced. */
        /** @type {Map<string, PresetSpec | undefined>} */
        const applied = new Map()

        const sync = () => {
          if (!isPermissionTableHost(permissions)) {
            this._warn('the permission service does not expose its preset table; the configured presets stay unpublished')
            return
          }
          const table = permissions.presets
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
  _publishContext() {
    this.ctx.inject(['systemPrompt'], (scope) => {
      const registry = /** @type {{ systemPrompt?: PromptRegistry }} */ (scope).systemPrompt
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
   * @param {unknown} [session] - the calling session, or `undefined` for agentless calls.
   * @returns {string} the note, or an empty string when no directory applies.
   */
  noteFor(session = undefined) {
    this._refresh()
    const entry = this.presetFor(session)
    if (entry === undefined || entry.sandbox === UNCONFINED_MODE) return ''
    // Workspace entries are named by the real path they resolve to for this
    // session, so the model is told where the directories actually are.
    const roots = this.resolvedDirsFor(entry.name, this.workspaceRootFor(/** @type {SessionLike | undefined} */ (session)))
    if (roots.length === 0) return ''
    return `The ${name} plugin additionally allows writing these configured directories`
      + ` while the "${entry.name}" preset is selected`
      + exceptionClauseFor(entry.sandbox)
      + ': '
      + `${roots.map((root) => `"${root}"`).join(', ')}. `
      + 'They apply only while that preset remains selected.'
  }
}

/**
 * The message of an unknown failure, reproducing `String(error?.message ?? error)`.
 *
 * @param {unknown} error
 * @returns {string}
 */
function detailOf(error) {
  const message = /** @type {{ message?: unknown } | undefined} */ (error)?.message
  return String(message ?? error)
}

export default ExtraSandboxPresetsService
