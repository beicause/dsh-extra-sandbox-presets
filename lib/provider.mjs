/**
 * Widening of the live sandbox provider.
 *
 * The stock local provider expresses each confined mode as a bwrap profile that
 * binds only the roots that mode allows (the workspace root and an ephemeral
 * `/tmp` under `workspace-write`; nothing beyond the read-only system binds
 * under `read-only`). This module wraps the live service's own `confine` on the
 * instance, so the stock provider is never replaced or subclassed: nothing is
 * disabled in the composition, and a failure to load this plugin leaves the
 * harness exactly as shipped.
 *
 * The wrapper keeps the stock profile and inserts one `--bind <dir> <dir>` per
 * directory the session's selected preset grants, so confined CLI children can
 * write the same directories the write/edit tools can.
 *
 * Scope is deliberately narrow:
 *   - only for a session that selected a configured preset, as reported by the
 *     plugin service, and never under `danger-full-access` (which does not
 *     confine at all);
 *   - only for the bwrap rung. The Landlock and Seatbelt profiles are built in
 *     modules this package cannot extend, so there the extra directories are
 *     reported once as unsupported rather than silently ignored. Windows is out
 *     of scope for this plugin.
 */

import { withExtraBinds } from './plan.mjs'

/** Own-property key holding the wrapped method, so wrapping stays idempotent. */
const WRAPPED = Symbol.for('dsh-extra-sandbox-presets/wrapped-confine')

/**
 * Wrap one sandbox provider instance so its confinement also binds the extra
 * directories reported for a call.
 *
 * Returns `undefined` without wrapping when the instance does not expose the
 * stock `confine` — an unfamiliar backend, or a version whose seam moved. The
 * caller reports that, so a harness upgrade that moves the seam is visible
 * instead of silently narrowing the preset.
 *
 * @param sandbox - the live sandbox provider service instance.
 * @param deps - reporting hooks: `extraRootsFor` and `reportUnsupported`.
 * @returns a disposer restoring the original method exactly, or `undefined`
 *   when this instance could not be wrapped.
 */
export function applyExtraDirsConfine(sandbox, deps) {
  if (typeof sandbox?.confine !== 'function') return undefined
  if (sandbox[WRAPPED] !== undefined) return () => {}
  // The mount may define `confine` on the instance or inherit it from its
  // prototype; the descriptor records which, so restoring is exact either way.
  const descriptor = Object.getOwnPropertyDescriptor(sandbox, 'confine')
  const original = sandbox.confine

  const wrapped = async function confine(argv, policy, signal) {
    const result = await original.call(this, argv, policy, signal)

    const extra = deps.extraRootsFor(policy)
    if (extra.length === 0) return result

    if (result.argv[0] !== 'bwrap') {
      deps.reportUnsupported(result.argv[0])
      return result
    }

    return { ...result, argv: withExtraBinds(result.argv, extra) }
  }

  Object.defineProperty(sandbox, WRAPPED, {
    value: original,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(sandbox, 'confine', {
    value: wrapped,
    configurable: true,
    writable: true,
  })
  return () => {
    // Only undo our own wrapping; a later wrapper owns its own restore.
    if (sandbox.confine !== wrapped) return
    if (descriptor === undefined) delete sandbox.confine
    else Object.defineProperty(sandbox, 'confine', descriptor)
    delete sandbox[WRAPPED]
  }
}