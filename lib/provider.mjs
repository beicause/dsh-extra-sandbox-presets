/**
 * Widening of the live sandbox provider.
 *
 * The stock local provider expresses `workspace-write` as a bwrap profile that
 * binds only the workspace root (plus an ephemeral `/tmp`). This module wraps
 * the live service's own `confine` on the instance, so the stock provider is
 * never replaced or subclassed: nothing is disabled in the composition, and a
 * failure to load this plugin leaves the harness exactly as shipped.
 *
 * The wrapper keeps the stock profile and inserts one `--bind <dir> <dir>` per
 * extra directory that applies to the calling session, so confined CLI children
 * can write the same directories the write/edit tools can.
 *
 * Scope is deliberately narrow:
 *   - only under `workspace-write` and only for a session that selected the
 *     extra preset, as reported by the plugin service;
 *   - only for the bwrap rung. The Landlock and Seatbelt profiles are built in
 *     modules this package cannot extend, so there the extra directories are
 *     reported once as unsupported rather than silently ignored. Windows is out
 *     of scope for this plugin.
 */

import { withExtraBinds } from './plan.mjs'

/** Own-property key holding the wrapped method, so wrapping stays idempotent. */
const WRAPPED = Symbol.for('dsh-workspace-write-extra/wrapped-confine')

/**
 * Wrap one sandbox provider instance so its confinement also binds the extra
 * directories reported for a call.
 *
 * Does nothing when the instance does not expose the stock `confine` (an
 * unfamiliar backend, or an instance that is already wrapped), so the plugin
 * stays inert rather than breaking a composition it does not recognize.
 *
 * @param sandbox - the live sandbox provider service instance.
 * @param deps - reporting hooks: `extraRootsFor` and `reportUnsupported`.
 * @returns a disposer restoring the original method exactly.
 */
export function applyExtraDirsConfine(sandbox, deps) {
  if (typeof sandbox?.confine !== 'function' || sandbox[WRAPPED] !== undefined) return () => {}
  // The mount may define `confine` on the instance or inherit it from its
  // prototype; the descriptor records which, so restoring is exact either way.
  const descriptor = Object.getOwnPropertyDescriptor(sandbox, 'confine')
  const original = sandbox.confine

  const wrapped = async function confine(argv, policy, signal) {
    const result = await original.call(this, argv, policy, signal)

    if (policy?.mode !== 'workspace-write') return result
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