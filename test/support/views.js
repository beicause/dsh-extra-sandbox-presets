/**
 * Structural views of the stock classes the contract tests drive.
 *
 * The published typings declare `checkedTarget` private and do not declare the
 * file methods `LocalFileSystem` mixes in, so those members cannot be read
 * through the class type. These views name exactly the surface the tests use:
 * a renamed or removed member fails typecheck here, which is what a contract
 * test is for. The constructors take the minimal context a double provides,
 * because the real one demands a fully buffered logger a stand-in cannot fake.
 */

/** @typedef {import('../../src/contracts.js').FenceTarget} FenceTarget */

/**
 * The filesystem seam `src/fs.js` wraps.
 *
 * @typedef {object} FsSeam
 * @property {(target: FenceTarget, sandboxPolicy?: unknown) => Promise<FenceTarget>} checkedTarget - the fence seam.
 * @property {(path: string) => Promise<FenceTarget>} resolve - target resolution.
 * @property {(target: FenceTarget, content: string, expected?: unknown, signal?: unknown, policy?: unknown) => Promise<unknown>} writeText - mutation entry.
 * @property {(target: FenceTarget) => Promise<string>} readText - read back what was written.
 */

/**
 * The sandbox seam `src/provider.js` wraps.
 *
 * @typedef {object} SandboxSeam
 * @property {(argv: readonly string[], policy: unknown, signal?: unknown) => Promise<{ argv: string[], enforcement?: unknown }>} confine - the confinement seam.
 */

/**
 * The stock filesystem class as the tests instantiate it.
 *
 * @typedef {new (ctx: unknown, config: unknown) => FsSeam} FsConstructor
 */

/**
 * The stock sandbox provider class as the tests instantiate it.
 *
 * @typedef {new (ctx: unknown, config: unknown) => SandboxSeam} SandboxConstructor
 */

/**
 * Read the stock filesystem class through its seam view.
 *
 * The intermediate `unknown` is the point: the published class type omits the
 * mixed-in file methods, so the cast states which surface the test relies on
 * instead of silencing the mismatch at each call.
 *
 * @param {unknown} value - the imported class.
 * @returns {FsConstructor & { prototype: FsSeam, Config: (input: Record<string, unknown>) => unknown }} the class, as the tests drive it.
 */
export const asFsClass = (value) =>
  /** @type {FsConstructor & { prototype: FsSeam, Config: (input: Record<string, unknown>) => unknown }} */ (
    /** @type {unknown} */ (value)
  )

/**
 * Read the stock sandbox provider class through its seam view.
 *
 * @param {unknown} value - the imported class.
 * @returns {SandboxConstructor & { prototype: SandboxSeam, Config: (input: Record<string, unknown>) => unknown }} the class, as the tests drive it.
 */
export const asSandboxClass = (value) =>
  /** @type {SandboxConstructor & { prototype: SandboxSeam, Config: (input: Record<string, unknown>) => unknown }} */ (
    /** @type {unknown} */ (value)
  )
