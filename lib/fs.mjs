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

import { isPathUnder } from './roots.mjs'

/** Own-property key holding the wrapped method, so wrapping stays idempotent. */
const WRAPPED = Symbol.for('dsh-extra-sandbox-presets/wrapped-fence')

/** The denial code the stock fence raises for a containment failure. */
const DENIED = 'FS_SANDBOX_DENIED'

/**
 * Wrap one filesystem service instance so it also accepts the extra directories
 * reported for a call.
 *
 * Returns `undefined` without wrapping when the instance does not expose the
 * stock containment check — an unfamiliar backend, or a version whose
 * `checkedTarget` moved. The caller reports that, so a harness upgrade that
 * moves the seam is visible instead of silently narrowing the preset.
 *
 * @param fs - the live filesystem service instance.
 * @param extraRootsFor - reports the extra directories that apply to a policy.
 * @returns a disposer restoring the original method exactly, or `undefined`
 *   when this instance could not be wrapped.
 */
export function applyExtraDirsFence(fs, extraRootsFor) {
  if (typeof fs?.checkedTarget !== 'function') return undefined
  if (fs[WRAPPED] !== undefined) return () => {}
  // The mount may define the check on the instance or inherit it from its
  // prototype; the descriptor records which, so restoring is exact either way.
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'checkedTarget')
  const original = fs.checkedTarget

  const wrapped = async function checkedTarget(target, sandboxPolicy) {
    try {
      return await original.call(this, target, sandboxPolicy)
    } catch (error) {
      if (error?.code !== DENIED) throw error

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

  Object.defineProperty(fs, WRAPPED, {
    value: original,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(fs, 'checkedTarget', {
    value: wrapped,
    configurable: true,
    writable: true,
  })
  return () => {
    // Only undo our own wrapping; a later wrapper owns its own restore.
    if (fs[WRAPPED] !== undefined && fs.checkedTarget !== wrapped) return
    if (descriptor === undefined) delete fs.checkedTarget
    else Object.defineProperty(fs, 'checkedTarget', descriptor)
    delete fs[WRAPPED]
  }
}