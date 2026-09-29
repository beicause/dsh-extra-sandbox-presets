/**
 * Pure transformation for the bwrap enforcement half.
 *
 * Kept free of DSH imports so it can be tested directly; the subclass module
 * stays a thin override around it.
 */

/**
 * Insert one `--bind <dir> <dir>` pair per extra directory into a bwrap
 * invocation, placing them with the profile (before the `--` separator) so the
 * confined children see the directories writable exactly like the write/edit
 * tools do.
 *
 * @param argv - the bwrap invocation produced by the stock provider.
 * @param extra - the canonical extra directories to bind.
 * @returns a new argv; the input is left untouched.
 */
export function withExtraBinds(argv, extra) {
  const separator = argv.indexOf('--')
  const at = separator === -1 ? argv.length : separator
  const binds = []
  for (const dir of extra) binds.push('--bind', dir, dir)
  return [...argv.slice(0, at), ...binds, ...argv.slice(at)]
}
