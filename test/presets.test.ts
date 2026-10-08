/**
 * Unit tests for the preset table normalization.
 *
 * `lib/presets.js` is dependency-free by design (it only reaches the pure
 * `lib/roots.js` helpers), so these run without the DSH packages.
 *
 * Run with `node --test test/presets.test.ts`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { expandPresetDirs, normalizePresets, presetSpecOf } from '../lib/presets.js'

/** A stand-in for the volatile config field, which is read through `.get()`. */
const volatile = (value: unknown) => ({ get: () => value })

test('normalizePresets keeps configuration order and applies the field defaults', () => {
  const { entries, rejected } = normalizePresets({
    rust: { writableDirs: ['/home/me/.cargo'] },
    scratch: { sandbox: 'read-only', approval: 'never', writableDirs: ['/tmp'] },
    wide: { sandbox: 'danger-full-access' },
  })

  assert.deepEqual(rejected, [])
  assert.deepEqual(entries.map((entry) => entry.name), ['rust', 'scratch', 'wide'])
  assert.deepEqual(entries[0], {
    name: 'rust',
    sandbox: 'workspace-write',
    approval: 'ask',
    writableDirs: ['/home/me/.cargo'],
    label: undefined,
    description: undefined,
  })
  assert.equal(entries[1].sandbox, 'read-only')
  assert.equal(entries[1].approval, 'never')
  assert.equal(entries[2].sandbox, 'danger-full-access')
  assert.deepEqual(entries[2].writableDirs, [])
})

test('normalizePresets reads the volatile reference and tolerates an empty table', () => {
  assert.deepEqual(normalizePresets(undefined), { entries: [], rejected: [] })
  assert.deepEqual(normalizePresets(null), { entries: [], rejected: [] })
  assert.deepEqual(normalizePresets(volatile({})), { entries: [], rejected: [] })
  assert.deepEqual(normalizePresets([]).entries, [])
  assert.equal(normalizePresets([]).rejected.length, 1)

  const { entries } = normalizePresets(volatile({ rust: { writableDirs: ['/a'] } }))
  assert.deepEqual(entries.map((entry) => entry.name), ['rust'])
})

test('normalizePresets refuses a preset it cannot honor instead of guessing', () => {
  const { entries, rejected } = normalizePresets({
    auto: { sandbox: 'workspace-write' },
    custom: { sandbox: 'workspace-write' },
    '  ': { sandbox: 'workspace-write' },
    'not an object': 'workspace-write',
    badmode: { sandbox: 'nope' },
    badapproval: { sandbox: 'read-only', approval: 'maybe' },
    '': { sandbox: 'read-only' },
    good: { sandbox: 'read-only' },
  })

  assert.deepEqual(entries.map((entry) => entry.name), ['good'])
  const reasons = rejected.map(({ name, reason }) => `${name}: ${reason}`)
  assert.equal(rejected.length, 7, reasons.join('\n'))
  assert.match(reasons[0], /auto: the permission service reserves this name/)
  assert.match(reasons[1], /custom: the permission service reserves this name/)
  assert.match(reasons[4], /badmode: unknown sandbox mode "nope"/)
  assert.match(reasons[5], /badapproval: unknown approval policy "maybe"/)
  assert.match(reasons[6], /: blank preset name/)
})

test('presetSpecOf carries a label only when the caller configured one', () => {
  const [plain, labelled] = normalizePresets({
    plain: { sandbox: 'read-only' },
    labelled: { sandbox: 'workspace-write', name: 'Rust tools', description: 'Workspace plus the cargo caches' },
  }).entries

  assert.deepEqual(presetSpecOf(plain), { sandbox: 'read-only', approval: 'ask' })
  assert.deepEqual(presetSpecOf(labelled), {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Rust tools',
    description: 'Workspace plus the cargo caches',
  })
})

test('expandPresetDirs keeps each preset separate and reports the unusable entries', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-presets-'))
  try {
    const good = join(base, 'good')
    const also = join(base, 'also')
    const file = join(base, 'file.txt')
    await mkdir(good)
    await mkdir(also)
    await writeFile(file, 'x')

    const { entries } = normalizePresets({
      rust: { writableDirs: [good, file] },
      scratch: { sandbox: 'read-only', writableDirs: [also, join(base, 'missing')] },
    })
    const { roots, unusable } = await expandPresetDirs(entries)

    assert.deepEqual(roots.get('rust'), [good])
    assert.deepEqual(roots.get('scratch'), [also])
    assert.deepEqual(unusable.map(({ name }) => name), ['rust', 'scratch'])
    assert.match(unusable[0].reason, /not a directory/)
    assert.match(unusable[1].reason, /does not exist/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
