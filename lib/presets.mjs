/**
 * Normalization of the configured preset table.
 *
 * The plugin is a registry: every entry of its `presets` config becomes one
 * permission preset that selects a sandbox mode and an approval policy, plus a
 * list of directories writable on top of whatever that mode already allows.
 *
 * Kept free of Cordis and DSH imports (only the pure `./roots.mjs` helpers) so
 * it can be unit-tested directly.
 */

import { expandExtraDirs } from './roots.mjs'

/** Every sandbox mode a preset may select. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/** Every approval policy a preset may select. */
export const APPROVAL_POLICIES = ['ask', 'never']

/** Preset names the permission service owns and refuses to shadow. */
export const RESERVED_PRESET_NAMES = new Set(['custom', 'auto'])

/** The mode an entry selects when it names none. */
export const DEFAULT_SANDBOX = 'workspace-write'

/** The approval policy an entry selects when it names none. */
export const DEFAULT_APPROVAL = 'ask'

/**
 * Read a config field through its reference when it is volatile. A plain value
 * (an unvalidated config in a unit test) is returned as it is.
 *
 * @param raw - the live config field.
 * @returns the current value.
 */
export function readConfigValue(raw) {
  return raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const nonEmptyString = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/**
 * Normalize the configured preset table into the entries the service enforces
 * and publishes. Configuration order is kept, because it is the order the
 * permission picker offers the presets in.
 *
 * An entry that cannot be used is reported instead of being guessed at:
 * publishing a preset whose meaning the caller never named would be the unsafe
 * direction.
 *
 * @param raw - the live `presets` config field (volatile or plain).
 * @returns the usable entries plus the rejected ones.
 */
export function normalizePresets(raw) {
  const table = readConfigValue(raw)
  const entries = []
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

    const sandbox = rawSpec.sandbox ?? DEFAULT_SANDBOX
    if (!SANDBOX_MODES.includes(sandbox)) {
      rejected.push({ name, reason: `unknown sandbox mode ${JSON.stringify(sandbox)}` })
      continue
    }
    const approval = rawSpec.approval ?? DEFAULT_APPROVAL
    if (!APPROVAL_POLICIES.includes(approval)) {
      rejected.push({ name, reason: `unknown approval policy ${JSON.stringify(approval)}` })
      continue
    }

    entries.push({
      name,
      sandbox,
      approval,
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
 * @param entry - one entry from {@link normalizePresets}.
 * @returns the `PresetSpec` the permission service stores.
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
 * Expand every preset's configured directories to the canonical paths the
 * enforcement layers compare.
 *
 * @param entries - normalized presets.
 * @returns a map of preset name to its canonical directories, plus every
 *   unusable entry with the preset that configured it.
 */
export async function expandPresetDirs(entries) {
  const roots = new Map()
  const unusable = []

  for (const entry of entries) {
    const { dirs, rejected } = await expandExtraDirs(entry.writableDirs)
    roots.set(entry.name, dirs)
    for (const rejection of rejected) unusable.push({ name: entry.name, ...rejection })
  }

  return { roots, unusable }
}
