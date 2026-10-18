/**
 * Widening of the live filesystem fence.
 *
 * The mounted sandboxed filesystem denies every mutation outside the roots its
 * resolved mode allows. This module wraps the live service's own containment
 * check on the instance, so the stock provider is never replaced or subclassed:
 * nothing is disabled in the composition, and a failure to load this plugin
 * leaves the harness exactly as shipped.
 *
 * The wrapper keeps the stock check authoritative for every stock case and only
 * retries its containment denial against the extra directories the calling
 * session's selected preset grants.
 *
 * The retry covers every confined mode, including `read-only`: the stock fence
 * refuses a read-only mutation before it ever resolves the target, so the
 * wrapper resolves it itself and compares against the preset's directories. A
 * preset that selects `read-only` therefore grants exactly the directories it
 * lists and nothing else. `danger-full-access` never fences at all.
 */

import { isPathUnder } from './roots.js'

/** @typedef {import('./contracts.js').FenceTarget} FenceTarget */
/** @typedef {import('./contracts.js').ExtraRootsFor} ExtraRootsFor */

/** Own-property key holding the wrapped method, so wrapping stays idempotent. */
const WRAPPED = Symbol.for('dsh-extra-sandbox-presets/wrapped-fence')

/** The denial code the stock fence raises for a containment failure. */
const DENIED = 'FS_SANDBOX_DENIED'

/**
 * The slice of the live filesystem service this wrapper extends. Declared
 * locally because the host's own typings are not a dependency of this package.
 *
 * @typedef {object} FenceService
 * @property {(this: FenceService, target: { displayPath: string }, sandboxPolicy?: unknown) => Promise<FenceTarget>} checkedTarget
 *   Accepts a second `sandboxPolicy` argument, which callers may omit.
 * @property {(path: string) => Promise<FenceTarget>} resolve
 */

/**
 * Whether the caught value is the stock fence's containment denial.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
const isDenial = (error) =>
  typeof error === 'object' && error !== null && /** @type {{ code?: unknown }} */ (error).code === DENIED

/**
 * @param {unknown} value
 * @returns {value is FenceService}
 */
const isFenceService = (value) =>
  typeof value === 'object'
  && value !== null
  && typeof /** @type {{ checkedTarget?: unknown }} */ (value).checkedTarget === 'function'

/**
 * Wrap one filesystem service instance so it also accepts the extra directories
 * reported for a call.
 *
 * Returns `undefined` without wrapping when the instance does not expose the
 * stock containment check — an unfamiliar backend, or a version whose
 * `checkedTarget` moved. The caller reports that, so a harness upgrade that
 * moves the seam is visible instead of silently narrowing the preset.
 *
 * @param {unknown} fs - the live filesystem service instance.
 * @param {ExtraRootsFor} extraRootsFor - reports the extra directories that apply to a policy.
 * @returns {(() => void) | undefined} a disposer restoring the original method exactly,
 *   or `undefined` when this instance could not be wrapped.
 */
export function applyExtraDirsFence(fs, extraRootsFor) {
  if (!isFenceService(fs)) return undefined
  const fence = /** @type {FenceService & { [WRAPPED]?: unknown }} */ (fs)
  if (fence[WRAPPED] !== undefined) return () => {}
  // The mount may define the check on the instance or inherit it from its
  // prototype; the descriptor records which, so restoring is exact either way.
  const descriptor = Object.getOwnPropertyDescriptor(fence, 'checkedTarget')
  const original = fence.checkedTarget

  /**
   * @param {FenceTarget} target
   * @param {unknown} [sandboxPolicy]
   * @returns {Promise<FenceTarget>}
   * @this {FenceService}
   */
  const wrapped = async function checkedTarget(target, sandboxPolicy) {
    try {
      return await original.call(this, target, sandboxPolicy)
    } catch (error) {
      if (!isDenial(error)) throw error

      const extra = extraRootsFor(sandboxPolicy)
      if (extra.length === 0) throw error

      // Re-resolve so the identity checked below is the identity written
      // (the stock fence's own anti-TOCTOU rule), then retry containment
      // against the extra directories only.
      const fresh = await this.resolve(target.displayPath)
      for (const root of extra) {
        if (await isPathUnder(fresh.targetKey, root)) return fresh
      }
      throw error
    }
  }

  Object.defineProperty(fence, WRAPPED, {
    value: original,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(fence, 'checkedTarget', {
    value: wrapped,
    configurable: true,
    writable: true,
  })
  return () => {
    // Only undo our own wrapping; a later wrapper owns its own restore.
    if (fence[WRAPPED] !== undefined && fence.checkedTarget !== wrapped) return
    if (descriptor === undefined) delete /** @type {{ checkedTarget?: unknown }} */ (fence).checkedTarget
    else Object.defineProperty(fence, 'checkedTarget', descriptor)
    delete fence[WRAPPED]
  }
}
