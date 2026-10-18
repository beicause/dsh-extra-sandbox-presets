/**
 * A view of the sandbox backend that exposes its private fence seam.
 *
 * `checkedTarget` is the member this plugin wraps, and the published typings
 * declare it private, so a contract test cannot read it through the class
 * type. Everything else — `resolve`, `readText`, `writeText` — is public and
 * comes straight from the package, so this adds that one member and nothing
 * else.
 *
 * The base is `Omit`ted rather than intersected: intersecting a class with a
 * redeclared private member reduces the whole type to `never`.
 */

/**
 * @typedef {Omit<import('@deepseek-ai/dsh-fs-sandbox').SandboxedFileSystem, 'checkedTarget'> & {
 *   checkedTarget(target: import('@deepseek-ai/dsh-fs').FsTarget, sandboxPolicy?: unknown): Promise<import('@deepseek-ai/dsh-fs').FsTarget>
 * }} FsSeam
 */

/**
 * Read the stock filesystem instance through its fence seam.
 *
 * @param {import('@deepseek-ai/dsh-fs-sandbox').SandboxedFileSystem} fs - the instance the wrapper installs on.
 * @returns {FsSeam} the same instance, with the private seam visible.
 */
export const asFsSeam = (fs) => /** @type {FsSeam} */ (/** @type {unknown} */ (fs))
