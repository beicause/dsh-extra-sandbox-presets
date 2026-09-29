/**
 * Behavioural tests for the two wrapping helpers.
 *
 * Both modules are dependency-free by design: they wrap whatever enforcement
 * service the composition mounted, so a plain stand-in is enough to check the
 * exact widening rule and the exact restore behaviour.
 *
 * Run with `node test/enforcement.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { applyExtraDirsFence } from '../lib/fs.mjs'
import { withExtraBinds } from '../lib/plan.mjs'
import { applyExtraDirsConfine } from '../lib/provider.mjs'

/** A stand-in filesystem whose stock check throws `thrown`. */
const fakeFs = (thrown) => ({
  async checkedTarget() { throw thrown },
  async resolve(path) { return { displayPath: path, targetKey: path } },
})

/** A stand-in provider returning a bwrap profile. */
const fakeSandbox = (argv) => ({
  async confine() {
    return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  },
})

test('withExtraBinds inserts the binds with the profile, before --', () => {
  const argv = ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work', '--', 'bash', '-c', 'echo -- hi']
  assert.deepEqual(withExtraBinds(argv, ['/extra/a', '/extra/b']), [
    'bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work',
    '--bind', '/extra/a', '/extra/a', '--bind', '/extra/b', '/extra/b',
    '--', 'bash', '-c', 'echo -- hi',
  ])
  // No separator: append at the end rather than corrupting the command.
  assert.deepEqual(withExtraBinds(['bwrap', '--ro-bind', '/', '/'], ['/x']), [
    'bwrap', '--ro-bind', '/', '/', '--bind', '/x', '/x',
  ])
  // The input is never mutated.
  const original = ['bwrap', '--', 'bash']
  withExtraBinds(original, ['/x'])
  assert.deepEqual(original, ['bwrap', '--', 'bash'])
})

test('the fence wrapper widens only a workspace-write containment denial', async () => {
  const denial = () => Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' })
  // The target below resolves to `/outside/file.txt`, so this root contains it.
  const extra = ['/outside']
  // The real service answers this; the stub mirrors its mode rule.
  const rootsFor = (policy) => (policy?.mode === 'workspace-write' ? extra : [])

  // Denied, but the extra directories contain the target: allowed, and the
  // FRESH resolution is returned so the identity checked is the one written.
  const fs = fakeFs(denial())
  const restore = applyExtraDirsFence(fs, rootsFor)
  assert.deepEqual(
    await fs.checkedTarget({ displayPath: '/outside/file.txt' }, { mode: 'workspace-write' }),
    { displayPath: '/outside/file.txt', targetKey: '/outside/file.txt' },
  )

  // read-only is never widened, even though the target lies in an extra root.
  await assert.rejects(
    fs.checkedTarget({ displayPath: '/outside/file.txt' }, { mode: 'read-only' }),
    { code: 'FS_SANDBOX_DENIED' },
  )

  // No extra directories apply: the stock denial stands.
  const noRoots = fakeFs(denial())
  applyExtraDirsFence(noRoots, () => [])
  await assert.rejects(
    noRoots.checkedTarget({ displayPath: '/outside/file.txt' }, { mode: 'workspace-write' }),
    { code: 'FS_SANDBOX_DENIED' },
  )

  // A target outside every extra root is still denied.
  const outside = { ...fakeFs(denial()), async resolve(path) { return { displayPath: path, targetKey: '/other' } } }
  applyExtraDirsFence(outside, rootsFor)
  await assert.rejects(
    outside.checkedTarget({ displayPath: '/other/file.txt' }, { mode: 'workspace-write' }),
    { code: 'FS_SANDBOX_DENIED' },
  )

  // Unrelated errors pass through untouched.
  const unrelated = new Error('boom')
  const brokenFs = fakeFs(unrelated)
  applyExtraDirsFence(brokenFs, rootsFor)
  await assert.rejects(brokenFs.checkedTarget({ displayPath: '/x' }), (error) => error === unrelated)

  // The original check stays authoritative for stock-allowed targets.
  const allowedFs = { async checkedTarget() { return 'stock-ok' } }
  applyExtraDirsFence(allowedFs, rootsFor)
  assert.equal(await allowedFs.checkedTarget({ displayPath: '/work/f' }), 'stock-ok')

  // Restoring returns the instance to exactly its previous shape, whether the
  // method was inherited or an own property.
  const inherited = Object.create({ async checkedTarget() { throw denial() } })
  const inheritedBefore = Object.getOwnPropertyDescriptor(inherited, 'checkedTarget')
  applyExtraDirsFence(inherited, rootsFor)()
  assert.deepEqual(Object.getOwnPropertyDescriptor(inherited, 'checkedTarget'), inheritedBefore)

  const own = fakeFs(denial())
  const ownBefore = own.checkedTarget
  const undo = applyExtraDirsFence(own, rootsFor)
  assert.notEqual(own.checkedTarget, ownBefore)
  undo()
  assert.equal(own.checkedTarget, ownBefore)

  // A wrapped instance is never wrapped twice, and an instance without the
  // expected seam is left untouched and reported as unwrapped (`undefined`),
  // so the caller can warn instead of degrading in silence.
  const twice = fakeFs(denial())
  const first = applyExtraDirsFence(twice, rootsFor)
  const wrappedOnce = twice.checkedTarget
  assert.equal(typeof applyExtraDirsFence(twice, rootsFor), 'function')
  assert.equal(twice.checkedTarget, wrappedOnce)
  first()
  assert.equal(applyExtraDirsFence({}, rootsFor), undefined)
  assert.equal(applyExtraDirsFence(undefined, rootsFor), undefined)
  assert.equal(applyExtraDirsFence({ checkedTarget: 'not-a-function' }, rootsFor), undefined)
  restore()
})

test('the confine wrapper binds only for workspace-write and reports other backends', async () => {
  const argv = ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work', '--', 'bash', '-c', 'true']

  const unsupported = []
  const sandbox = fakeSandbox(argv)
  const restore = applyExtraDirsConfine(sandbox, {
    extraRootsFor: (policy) => (policy.extra ?? []),
    reportUnsupported: (runner) => unsupported.push(runner),
  })

  // The extra directories join the profile, before the command separator.
  const widened = await sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', extra: ['/extra/a'] })
  assert.deepEqual(widened.argv, [
    'bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work',
    '--bind', '/extra/a', '/extra/a', '--', 'bash', '-c', 'true',
  ])
  assert.deepEqual(unsupported, [])

  // No extra directories: the stock argv is returned untouched.
  assert.deepEqual((await sandbox.confine([], { mode: 'workspace-write' })).argv, argv)

  // A non-workspace-write policy is never widened, even with the field set.
  assert.deepEqual((await sandbox.confine([], { mode: 'read-only', extra: ['/x'] })).argv, argv)
  assert.deepEqual((await sandbox.confine([], { mode: 'danger-full-access', extra: ['/x'] })).argv, argv)

  // A non-bwrap rung warns once instead of pretending to widen.
  const other = fakeSandbox(['landlock', '--', 'bash'])
  let reportCount = 0
  applyExtraDirsConfine(other, {
    extraRootsFor: () => ['/extra/a'],
    reportUnsupported: () => { reportCount += 1 },
  })
  assert.deepEqual((await other.confine([], { mode: 'workspace-write' })).argv, ['landlock', '--', 'bash'])
  await other.confine([], { mode: 'workspace-write' })
  assert.equal(reportCount, 2, 'the wrapper reports per call; the service dedupes')

  // Restoring returns the instance to exactly its previous shape.
  const plain = fakeSandbox(argv)
  const before = plain.confine
  const undo = applyExtraDirsConfine(plain, { extraRootsFor: () => ['/x'], reportUnsupported: () => {} })
  undo()
  assert.equal(plain.confine, before)

  // An instance without the expected seam is reported as unwrapped instead of
  // being passed over in silence.
  const deps = { extraRootsFor: () => ['/x'], reportUnsupported: () => {} }
  assert.equal(applyExtraDirsConfine({}, deps), undefined)
  assert.equal(applyExtraDirsConfine(undefined, deps), undefined)
  assert.equal(applyExtraDirsConfine({ confine: 'not-a-function' }, deps), undefined)
  restore()
})