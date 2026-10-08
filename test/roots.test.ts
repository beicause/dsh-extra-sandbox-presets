/**
 * Unit tests for the pure path logic behind the extra writable directories.
 *
 * Run with `node test/roots.test.ts` from the package directory. Uses only
 * Node built-ins so it can run without the DSH dependency tree.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { absoluteEntry, expandExtraDirs, isPathUnder, isUnderAny } from '../lib/roots.js'

const withTempTree = async (run: (base: string) => Promise<unknown>) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-extra-dirs-'))
  try {
    return await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('absoluteEntry expands ~ and requires an absolute path', () => {
  assert.equal(absoluteEntry('/a/b'), '/a/b')
  assert.equal(absoluteEntry('  /a/b  '), '/a/b')
  assert.equal(absoluteEntry(''), undefined)
  assert.equal(absoluteEntry('   '), undefined)
  assert.equal(absoluteEntry('relative/dir'), undefined)
  assert.equal(absoluteEntry(undefined), undefined)
  assert.equal(absoluteEntry(42), undefined)
  const expanded = absoluteEntry('~/x')
  assert.ok(expanded !== undefined)
  assert.match(expanded, /\/x$/)
})

test('expandExtraDirs keeps directories, dedupes, and reports the rest', async () => {
  await withTempTree(async (base) => {
    const dir = join(base, 'dir')
    const file = join(base, 'file.txt')
    await mkdir(dir)
    await writeFile(file, 'x')

    const { dirs, rejected } = await expandExtraDirs([
      dir,
      dir,
      file,
      join(base, 'missing'),
      'relative',
      '',
    ])

    assert.deepEqual(dirs, [dir])
    const reasons = rejected.map(({ reason }) => reason)
    assert.ok(reasons.includes('not a directory'), reasons.join(' | '))
    assert.ok(reasons.includes('does not exist'), reasons.join(' | '))
    assert.ok(reasons.some((reason) => reason.startsWith('not an absolute path')), reasons.join(' | '))
    // The blank entry is rejected with its own reason.
    assert.ok(reasons.includes('blank entry'), reasons.join(' | '))
    assert.equal(rejected.length, 4)
  })
})

test('expandExtraDirs resolves a symlinked directory to its target', async () => {
  await withTempTree(async (base) => {
    const real = join(base, 'real')
    const link = join(base, 'link')
    await mkdir(real)
    await symlink(real, link)

    const { dirs } = await expandExtraDirs([link])
    assert.equal(dirs.length, 1)
    assert.ok(!dirs[0]!.endsWith('/link'), dirs[0])
  })
})

test('isPathUnder accepts the root itself, descendants, and rejects siblings', async () => {
  await withTempTree(async (base) => {
    const root = join(base, 'root')
    const nested = join(root, 'a', 'b')
    await mkdir(nested, { recursive: true })
    await writeFile(join(base, 'sibling'), 'x')

    assert.equal(await isPathUnder(root, root), true)
    assert.equal(await isPathUnder(nested, root), true)
    assert.equal(await isPathUnder(join(root, 'a'), root), true)
    assert.equal(await isPathUnder(join(base, 'sibling'), root), false)
    assert.equal(await isPathUnder(base, root), false)
    // A not-yet-existing path below the root is still contained lexically.
    assert.equal(await isPathUnder(join(root, 'a', 'new.txt'), root), true)
  })
})

test('isPathUnder does not treat a name prefix as containment', async () => {
  await withTempTree(async (base) => {
    const root = join(base, 'root')
    const sibling = join(base, 'root-other')
    await mkdir(root)
    await mkdir(sibling)
    assert.equal(await isPathUnder(sibling, root), false)
  })
})

test('isUnderAny matches any configured root', async () => {
  await withTempTree(async (base) => {
    const one = join(base, 'one')
    const two = join(base, 'two')
    await mkdir(one)
    await mkdir(two)

    assert.equal(await isUnderAny(join(two, 'f'), [one, two]), true)
    assert.equal(await isUnderAny(join(one, 'f'), [one, two]), true)
    assert.equal(await isUnderAny(join(base, 'elsewhere'), [one, two]), false)
    assert.equal(await isUnderAny(join(one, 'f'), []), false)
  })
})
