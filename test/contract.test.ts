/**
 * Contract tests for the stock seams this plugin extends.
 *
 * The plugin does not depend on a dsh version range; it depends on the exact
 * shape of two mounted services. These tests pin that shape against the REAL
 * classes, so a harness upgrade that moves a method, changes its arity, renames
 * a policy field, or turns a return value into something else fails here
 * instead of degrading the preset in production.
 *
 * Every case skips when the DSH packages are not resolvable, which is the case
 * outside an installed profile; run it from a profile to exercise the real
 * classes.
 *
 * Run with `node --test test/contract.test.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { applyExtraDirsConfine } from '../lib/provider.js'
import { applyExtraDirsFence } from '../lib/fs.js'

const dsh = async (specifier: string): Promise<unknown> => {
  try {
    return await import(specifier)
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  }
}

/** One resolved filesystem target, as the fence wrapper reads it. */
interface FenceTargetShape {
  readonly displayPath: string
  readonly targetKey: string
}

/** The part of the stock sandboxed filesystem this contract pins. */
interface SandboxedFileSystemInstance {
  checkedTarget(target: FenceTargetShape, policy?: unknown): Promise<FenceTargetShape>
  resolve(path: string): Promise<FenceTargetShape>
  writeText(target: FenceTargetShape, data: string, ...rest: unknown[]): Promise<unknown>
}

interface SandboxedFileSystemClass {
  new (ctx: unknown, config: unknown): SandboxedFileSystemInstance
  readonly prototype: SandboxedFileSystemInstance
  Config(config: { cwd: string }): unknown
}

/** The part of the stock local sandbox provider this contract pins. */
interface SandboxProviderInstance {
  confine(argv: readonly string[], policy?: unknown, signal?: unknown): Promise<{
    argv: string[]
    enforcement: unknown
  }>
}

interface SandboxProviderClass {
  new (ctx: unknown, config: unknown): SandboxProviderInstance
  readonly prototype: SandboxProviderInstance
  Config(config: Record<string, unknown>): unknown
}

const [fsSandbox, sandboxLocal] = (await Promise.all([
  dsh('@deepseek-ai/dsh-fs-sandbox'),
  dsh('@deepseek-ai/dsh-sandbox-local'),
])) as [
  { SandboxedFileSystem: SandboxedFileSystemClass } | undefined,
  { LocalSandboxProvider: SandboxProviderClass } | undefined,
]

/** The seam `lib/fs.js` wraps, and the policy fields `lib/service.js` reads. */
test('the stock filesystem still offers the seam the fence wrapper needs', {
  skip: fsSandbox === undefined ? 'the DSH filesystem package is not resolvable here' : false,
}, async () => {
  if (fsSandbox === undefined) return
  const proto = fsSandbox.SandboxedFileSystem.prototype

  // `applyExtraDirsFence` calls these two, and requires the first to reject
  // containment with this exact code before it retries against extra roots.
  assert.equal(typeof proto.checkedTarget, 'function', 'checkedTarget is the seam the fence wraps')
  assert.equal(typeof proto.resolve, 'function', 'the wrapper re-resolves through this')

  const instance = new fsSandbox.SandboxedFileSystem(
    { reflect: { provide() {} }, sandboxPolicy: { defaultMode: 'workspace-write' } },
    fsSandbox.SandboxedFileSystem.Config({ cwd: process.cwd() }),
  )
  // Inherited, not own: the wrapper records the descriptor so restore is exact.
  assert.equal(Object.hasOwn(instance, 'checkedTarget'), false, 'the seam is inherited, as the wrapper assumes')

  // The wrapper must recognize this instance, i.e. it must be wrappable.
  const dispose = applyExtraDirsFence(instance, () => [])
  assert.equal(typeof dispose, 'function', 'the real filesystem instance is recognized and wrapped')
  dispose?.()
  assert.equal(instance.checkedTarget, proto.checkedTarget, 'restoring returns the inherited method')

  // A denial carries the code the wrapper keys on. Proven through the real
  // fence rather than a stand-in, so a code rename fails here.
  const outside = await instance.resolve('/')
  await assert.rejects(
    instance.writeText(outside, 'x', undefined, undefined, { mode: 'read-only', workspaceRoot: process.cwd() }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'FS_SANDBOX_DENIED', 'the fence denial code the wrapper matches on')
      return true
    },
  )
})

/** The seam `lib/provider.js` wraps, and the result fields it reads. */
test('the stock sandbox provider still offers the seam the confine wrapper needs', {
  skip: sandboxLocal === undefined ? 'the DSH sandbox package is not resolvable here' : false,
}, async () => {
  if (sandboxLocal === undefined) return
  const proto = sandboxLocal.LocalSandboxProvider.prototype
  const base = Object.getPrototypeOf(sandboxLocal.LocalSandboxProvider)

  assert.equal(typeof proto.confine, 'function', 'confine is the seam the provider wrapper wraps')
  // The wrapper awaits the stock call, which is why a sync-to-async change is
  // safe for it, but the result must still be an object carrying `argv`.
  assert.equal(proto.confine.constructor.name, 'AsyncFunction', 'the wrapper awaits this call')

  const instance = new sandboxLocal.LocalSandboxProvider(
    { reflect: { provide() {} }, effect: () => () => {}, inject: () => {}, logger: { warn() {} } },
    // Validate through the real schema so required defaults are present.
    sandboxLocal.LocalSandboxProvider.Config({
      runnerCommand: [],
      runnerFailureSignatures: [],
      probeTimeoutMs: 5_000,
    }),
  )
  assert.equal(Object.hasOwn(instance, 'confine'), false, 'the seam is inherited, as the wrapper assumes')

  const deps = { extraRootsFor: () => [], reportUnsupported: () => {} }
  const dispose = applyExtraDirsConfine(instance, deps)
  assert.equal(typeof dispose, 'function', 'the real provider instance is recognized and wrapped')
  dispose?.()
  assert.equal(instance.confine, proto.confine, 'restoring returns the inherited method')

  // On Linux the real provider selects the bwrap rung, and `confine` resolves
  // to an object whose `argv` the wrapper edits. Every field it touches is
  // pinned here, so a return-shape change fails this contract.
  if (process.platform === 'linux') {
    const result = await instance.confine(['true'], { mode: 'workspace-write', workspaceRoot: process.cwd() })
    assert.ok(Array.isArray(result.argv), 'the wrapper inserts into result.argv')
    assert.equal(result.argv[0], 'bwrap', 'the rung the wrapper extends')
    assert.equal(typeof result.enforcement, 'string', 'the result shape the wrapper spreads unchanged')
    assert.notEqual(result.argv.indexOf('--'), -1, 'the separator the wrapper inserts before')
  }

  // The base class is where the service name comes from, which is why a
  // subclass cannot coexist with the stock row.
  assert.equal(base.name, 'SandboxProvider', 'the base registers the fixed "sandbox" service name')
})