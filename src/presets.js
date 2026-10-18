/**
 * Normalization of the configured preset table.
 *
 * The plugin is a registry: every entry of its `presets` config becomes one
 * permission preset that selects a sandbox mode and an approval policy, plus a
 * list of directories writable on top of whatever that mode already allows.
 *
 * Kept free of Cordis and DSH imports (only the pure `./roots.js` helpers) so
 * it can be unit-tested directly.
 */

import { expandExtraDirs } from './roots.js'

/** @typedef {import('./contracts.js').SandboxMode} SandboxMode */
/** @typedef {import('./contracts.js').ConfinedMode} ConfinedMode */
/** @typedef {import('./contracts.js').ApprovalPolicy} ApprovalPolicy */
/** @typedef {import('./contracts.js').PresetSpec} PresetSpec */
/** @typedef {import('./contracts.js').PresetEntry} PresetEntry */
/** @typedef {import('./contracts.js').RejectedPreset} RejectedPreset */
/** @typedef {import('./contracts.js').NormalizedPresets} NormalizedPresets */
/** @typedef {import('./contracts.js').UnusablePresetDir} UnusablePresetDir */
/** @typedef {import('./contracts.js').VolatileLike} VolatileLike */
/** @typedef {import('./contracts.js').ExpandedPresetDirs} ExpandedPresetDirs */

/** Every sandbox mode a preset may select, in declaration order. */
export const SANDBOX_MODES = /** @type {const} */ (['read-only', 'workspace-write', 'danger-full-access'])

/** Every approval policy a preset may select, in declaration order. */
export const APPROVAL_POLICIES = /** @type {const} */ (['ask', 'never'])

/** Preset names the permission service owns and refuses to shadow. */
export const RESERVED_PRESET_NAMES = /** @type {ReadonlySet<string>} */ (new Set(['custom', 'auto']))

/** The mode an entry selects when it names none. @type {SandboxMode} */
export const DEFAULT_SANDBOX = 'workspace-write'

/** The approval policy an entry selects when it names none. @type {ApprovalPolicy} */
export const DEFAULT_APPROVAL = 'ask'

/**
 * Read a config field through its reference when it is volatile. A plain value
 * (an unvalidated config in a unit test) is returned as it is.
 *
 * @param {unknown} raw - the live config field.
 * @returns {unknown} the current value.
 */
export function readConfigValue(raw) {
  return raw !== null && typeof raw === 'object' && typeof /** @type {VolatileLike} */ (raw).get === 'function'
    ? /** @type {VolatileLike} */ (raw).get()
    : raw
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** @param {unknown} value */
const nonEmptyString = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * Normalize the configured preset table into the entries the service enforces
 * and publishes. Configuration order is kept, because it is the order the
 * permission picker offers the presets in.
 *
 * An entry that cannot be used is reported instead of being guessed at:
 * publishing a preset whose meaning the caller never named would be the unsafe
 * direction.
 *
 * @param {unknown} raw - the live `presets` config field (volatile or plain).
 * @returns {NormalizedPresets} the usable entries plus the rejected ones.
 */
export function normalizePresets(raw) {
  const table = readConfigValue(raw)
  /** @type {PresetEntry[]} */
  const entries = []
  /** @type {RejectedPreset[]} */
  const rejected = []

  if (table === undefined || table === null) return { entries, rejected }
  if (!isPlainObject(table)) {
    rejected.push({ name: '', reason: 'the preset table must be a mapping of preset name to preset' })
    return { entries, rejected }
  }

  for (const [rawName, rawSpec] of Object.entries(table)) {
    const name = nonEmptyString(rawName)
    if (name === undefined) {
      rejected.push({ name: rawName, reason: 'blank preset name' })
      continue
    }
    if (RESERVED_PRESET_NAMES.has(name)) {
      rejected.push({ name, reason: 'the permission service reserves this name' })
      continue
    }
    if (!isPlainObject(rawSpec)) {
      rejected.push({ name, reason: 'the preset must be a mapping of its fields' })
      continue
    }

    const sandbox = /** @type {unknown} */ (rawSpec.sandbox ?? DEFAULT_SANDBOX)
    if (!(/** @type {readonly unknown[]} */ (SANDBOX_MODES)).includes(sandbox)) {
      rejected.push({ name, reason: `unknown sandbox mode ${JSON.stringify(sandbox)}` })
      continue
    }
    const approval = /** @type {unknown} */ (rawSpec.approval ?? DEFAULT_APPROVAL)
    if (!(/** @type {readonly unknown[]} */ (APPROVAL_POLICIES)).includes(approval)) {
      rejected.push({ name, reason: `unknown approval policy ${JSON.stringify(approval)}` })
      continue
    }

    entries.push({
      name,
      sandbox: /** @type {SandboxMode} */ (sandbox),
      approval: /** @type {ApprovalPolicy} */ (approval),
      writableDirs: Array.isArray(rawSpec.writableDirs) ? rawSpec.writableDirs : [],
      // The display label, distinct from the table key. Left undefined when the
      // caller configured none, so the client renders the key itself instead of
      // a verbatim string it would not localize.
      label: nonEmptyString(rawSpec.name),
      description: nonEmptyString(rawSpec.description),
    })
  }

  return { entries, rejected }
}

/**
 * The permission-table entry one normalized preset publishes. Carries no
 * `name`/`description` unless the caller configured them: the client localizes
 * only its own built-in presets, so an invented label would render verbatim, in
 * English.
 *
 * @param {PresetEntry} entry - one entry from {@link normalizePresets}.
 * @returns {PresetSpec} the `PresetSpec` the permission service stores.
 */
export function presetSpecOf(entry) {
  return {
    sandbox: entry.sandbox,
    approval: entry.approval,
    ...(entry.label === undefined ? {} : { name: entry.label }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  }
}

/**
 * The clause that answers the closed boundary the stock sandbox note draws for
 * one confined mode.
 *
 * The stock note is written from the sandbox mode alone. Under `read-only` it
 * is a flat prohibition, so the exception has to be stated as one. Under
 * `workspace-write` it names the session workspace as the writable area, so the
 * exception has to say the directories count regardless of that boundary.
 *
 * `danger-full-access` is deliberately absent: it confines nothing, so this
 * plugin never amends its note and there is no clause to write. The parameter
 * type excludes it, so passing an unconfined mode is a type error rather than a
 * silently meaningless sentence.
 *
 * @param {ConfinedMode} mode - the confined sandbox mode the selected preset uses.
 * @returns {string} the clause to follow "these configured directories".
 */
export function exceptionClauseFor(mode) {
  switch (mode) {
    case 'read-only':
      return ', even under the read-only policy above'
    case 'workspace-write':
      return ', whether or not they are inside the session workspace'
  }
}

/**
 * Expand every preset's configured directories to the canonical paths the
 * enforcement layers compare.
 *
 * @param {readonly PresetEntry[]} entries - normalized presets.
 * @returns {Promise<ExpandedPresetDirs>} a map of preset name to its canonical
 *   directories, plus every unusable entry with the preset that configured it.
 */
export async function expandPresetDirs(entries) {
  /** @type {Map<string, string[]>} */
  const roots = new Map()
  /** @type {Map<string, string[]>} */
  const workspaceRoots = new Map()
  /** @type {UnusablePresetDir[]} */
  const unusable = []

  for (const entry of entries) {
    const { dirs, workspaceDirs, rejected } = await expandExtraDirs(entry.writableDirs)
    roots.set(entry.name, dirs)
    workspaceRoots.set(entry.name, workspaceDirs)
    for (const rejection of rejected) unusable.push({ name: entry.name, ...rejection })
  }

  return { roots, workspaceRoots, unusable }
}
