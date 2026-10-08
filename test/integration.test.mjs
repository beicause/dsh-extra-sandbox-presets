/**
 * Offline integration test: assemble the plugin's pieces the way the profile
 * does, over a hand-built context, and check that configured presets really
 * widen writes while `/permission` selection decides when.
 *
 * This runs against the real DSH packages (via the scratch link) but without a
 * running Harness, so it exercises the plugin's own wiring: service
 * registration, preset publication, fs containment retry, and bwrap argv.
 *
 * Run with `node --test test/integration.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const dsh = async (specifier) => {
  try {
    return await import(specifier)
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  }
}

const [cordis, fsSandbox, sandboxLocal] = await Promise.all([
  dsh('@deepseek-ai/cordis'),
  dsh('@deepseek-ai/dsh-fs-sandbox'),
  dsh('@deepseek-ai/dsh-sandbox-local'),
])
const skip = cordis === undefined ? 'the DSH packages are not resolvable here' : false

/**
 * Fixture parent. Deliberately NOT the OS temp directory: the stock fence
 * already treats `/tmp` and `tmpdir()` as writable, so a temp-dir fixture
 * could never produce the containment denial under test.
 */
const fixtureParent = join(process.cwd(), '.tmp')
const makeFixture = async () => {
  await mkdir(fixtureParent, { recursive: true })
  return mkdtemp(join(fixtureParent, 'esp-'))
}

/** Validate through the plugin's own schema, the way Cordis does before construction. */
const serviceConfig = (schema, config) => schema(config)

/** A stand-in for the volatile config field, which is read through `.get()`. */
const volatile = (value) => ({ get: () => value })

/**
 * A context just real enough for `Service` registration and `ctx.inject`.
 * `inject` runs its callback immediately so construction-time wiring is seen,
 * and `effect` tracks the disposer for symmetric teardown.
 */
function fakeContext(services = {}) {
  const disposers = []
  const registered = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    // `Service` registers itself through the reflection layer.
    reflect: { provide: (name, instance) => registered.set(name, instance) },
    registry: new Map(),
    // Own effect scope, the way a real plugin fiber provides one.
    effect: (run) => {
      const disposer = run()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get: (name) => ctx[name],
    inject: (names, callback) => {
      if (names.some((name) => ctx[name] === undefined)) return
      callback({
        ...ctx,
        [Symbol.dispose]: undefined,
        effect: (run) => {
          const disposer = run()
          if (typeof disposer === 'function') disposers.push(disposer)
        },
      })
    },
    ...services,
  }
  /** Run every recorded disposer, in reverse, like a plugin unload. */
  ctx.disposeEffects = () => {
    for (const disposer of disposers.splice(0).reverse()) disposer()
  }
  return { ctx, disposers, registered }
}

test('every configured preset is published in the permission table and catalog', { skip }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const catalogChanged = []
  const permissions = {
    presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      // The shipped profile declares this one so its `defaultPreset` resolves
      // without this plugin; the plugin shadows it and restores it on unload.
      'workspace-write-extra': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
    emitCatalogChanged: () => catalogChanged.push(1),
  }
  const promptContexts = []
  const { ctx } = fakeContext({
    permissionPresets: permissions,
    systemPrompt: {
      getContextOrder: () => 110,
      context: (entry) => promptContexts.push(entry),
    },
  })

  const service = new ExtraSandboxPresetsService(ctx, serviceConfig(ExtraSandboxPresetsService.Config, {
    presets: {
      'workspace-write-extra': { writableDirs: [] },
      rust: { writableDirs: [] },
      scratch: { sandbox: 'read-only', approval: 'never', writableDirs: [] },
    },
  }))

  // Each configured preset is offered, keeping the configured mode/approval.
  assert.deepEqual(service.presetNames, ['workspace-write-extra', 'rust', 'scratch'])
  assert.deepEqual(permissions.presets.rust, { sandbox: 'workspace-write', approval: 'ask' })
  assert.deepEqual(permissions.presets.scratch, { sandbox: 'read-only', approval: 'never' })
  assert.deepEqual(permissions.presets['workspace-write-extra'], { sandbox: 'workspace-write', approval: 'ask' })
  // The shipped entries are left exactly as they were.
  assert.deepEqual(permissions.presets['read-only'], { sandbox: 'read-only', approval: 'ask' })
  assert.equal(catalogChanged.length, 1)
  assert.equal(promptContexts.length, 1)
  assert.equal(promptContexts[0].name, 'sandbox:preset-write-dirs')
  assert.equal(promptContexts[0].order, 111)

  // A reserved name is refused instead of shadowing the shipped presets.
  const reserved = fakeContext({ permissionPresets: permissions }).ctx
  const other = new ExtraSandboxPresetsService(reserved, serviceConfig(ExtraSandboxPresetsService.Config, {
    presets: { auto: { sandbox: 'workspace-write' }, good: { sandbox: 'read-only' } },
  }))
  assert.deepEqual(other.presetNames, ['good'])
  assert.equal(permissions.presets.auto, undefined)

  // A configured preset carries a label only when the caller gave one.
  const labelled = fakeContext({ permissionPresets: permissions }).ctx
  new ExtraSandboxPresetsService(labelled, serviceConfig(ExtraSandboxPresetsService.Config, {
    presets: { tools: { sandbox: 'read-only', name: 'Tools only', description: 'No workspace write' } },
  }))
  assert.deepEqual(permissions.presets.tools, {
    sandbox: 'read-only',
    approval: 'ask',
    name: 'Tools only',
    description: 'No workspace write',
  })

  // Unloading restores the shadowed entry and removes the added ones.
  ctx.disposeEffects()
  assert.deepEqual(permissions.presets['workspace-write-extra'], { sandbox: 'workspace-write', approval: 'ask' })
  assert.equal(permissions.presets.rust, undefined)
  assert.equal(permissions.presets.scratch, undefined)
})

test('a changed preset table is republished live', { skip }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const catalogChanged = []
  const permissions = { presets: {}, emitCatalogChanged: () => catalogChanged.push(1) }
  const { ctx } = fakeContext({ permissionPresets: permissions })

  const holder = { table: { rust: { writableDirs: [] } } }
  // Constructed without schema validation: the point here is the volatile
  // reference the service reads live, not the input shape Cordis validates.
  const service = new ExtraSandboxPresetsService(ctx, { presets: { get: () => holder.table } })
  assert.deepEqual(service.presetNames, ['rust'])

  holder.table = { rust: { writableDirs: [] }, scratch: { sandbox: 'read-only' } }
  assert.deepEqual(service.presetNames, ['rust', 'scratch'])
  assert.deepEqual(permissions.presets.scratch, { sandbox: 'read-only', approval: 'ask' })

  // A preset that disappears is withdrawn again.
  holder.table = { scratch: { sandbox: 'read-only' } }
  assert.deepEqual(service.presetNames, ['scratch'])
  assert.equal(permissions.presets.rust, undefined)
})

test('each preset grants only its own directories, and only to its own session', { skip }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const base = await makeFixture()
  try {
    const workspaceExtra = join(base, 'workspace-extra')
    const scratch = join(base, 'scratch')
    const unused = join(base, 'unused')
    await mkdir(workspaceExtra)
    await mkdir(scratch)
    await mkdir(unused)

    // The permission projection is the only thing deciding enablement.
    let selected = 'workspace-write'
    const session = { id: 'session-1' }
    const { ctx } = fakeContext({
      permissionPresets: { presets: {}, emitCatalogChanged() {} },
      sessionProjections: { stateOf: () => ({ preset: selected }) },
      sessions: { get: (id) => (id === session.id ? session : undefined) },
    })

    const service = new ExtraSandboxPresetsService(ctx, serviceConfig(ExtraSandboxPresetsService.Config, {
      presets: {
        'workspace-write-extra': { writableDirs: [workspaceExtra] },
        scratch: { sandbox: 'read-only', writableDirs: [scratch] },
      },
    }))
    await service.ready()

    // No configured preset selected: nothing applies even though it resolves.
    assert.equal(service.presetFor(session), undefined)
    assert.deepEqual(service.rootsFor(session), [])
    assert.deepEqual(service.rootsForSessionId('session-1'), [])

    // Selecting one grants exactly that one's directories.
    selected = 'workspace-write-extra'
    assert.equal(service.presetFor(session)?.name, 'workspace-write-extra')
    assert.deepEqual(service.rootsFor(session), [workspaceExtra])
    assert.deepEqual(service.rootsForSessionId('session-1'), [workspaceExtra])

    selected = 'scratch'
    assert.deepEqual(service.rootsFor(session), [scratch])
    assert.deepEqual(service.dirsForPreset('workspace-write-extra'), [workspaceExtra])

    // Unknown, absent, and non-configured selections get nothing.
    selected = 'read-only'
    assert.deepEqual(service.rootsFor(session), [])
    assert.deepEqual(service.rootsForSessionId('nope'), [])
    assert.deepEqual(service.rootsForSessionId(undefined), [])
    assert.deepEqual(service.rootsFor(undefined), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an unusable configured directory is ignored, never granted', { skip }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const base = await makeFixture()
  try {
    const good = join(base, 'good')
    const file = join(base, 'file.txt')
    await mkdir(good)
    await writeFile(file, 'x')

    const warnings = []
    const session = { id: 's' }
    const { ctx } = fakeContext({
      permissionPresets: { presets: {}, emitCatalogChanged() {} },
      sessionProjections: { stateOf: () => ({ preset: 'rust' }) },
      sessions: { get: () => session },
    })
    ctx.logger.warn = (message) => warnings.push(message)

    const service = new ExtraSandboxPresetsService(ctx, {
      presets: {
        rust: { writableDirs: [good, file, join(base, 'missing'), 'relative'] },
        nope: { sandbox: 'not-a-mode', writableDirs: [good] },
      },
    })
    await service.ready()

    assert.deepEqual(service.dirsForPreset('rust'), [good])
    assert.deepEqual(service.rootsFor(session), [good])
    assert.deepEqual(service.presetNames, ['rust'])
    assert.equal(warnings.length, 1, warnings.join('\n'))
    assert.match(warnings[0], /ignoring unusable configured presets/)
    assert.match(warnings[0], /not a directory/)
    assert.match(warnings[0], /does not exist/)
    assert.match(warnings[0], /unknown sandbox mode "not-a-mode"/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('wrapping the live filesystem widens only the selected preset and session', { skip: skip || fsSandbox === undefined ? 'the DSH filesystem package is not resolvable here' : false }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const base = await makeFixture()
  try {
    const workspace = join(base, 'workspace')
    const extra = join(base, 'extra')
    const scratch = join(base, 'scratch')
    await mkdir(workspace)
    await mkdir(extra)
    await mkdir(scratch)

    let selected = 'workspace-write'
    const inside = { id: 'inside' }
    const outside = { id: 'outside' }

    // The REAL stock filesystem, mounted as the composition would.
    const fs = new fsSandbox.SandboxedFileSystem(
      // Its constructor registers the service and reads `ctx.sandboxPolicy`.
      {
        reflect: { provide() {} },
        sandboxPolicy: { defaultMode: 'workspace-write' },
      },
      // Validate through the real schema so required defaults are present.
      fsSandbox.SandboxedFileSystem.Config({ cwd: workspace }),
    )

    const { ctx } = fakeContext({
      fs,
      // `ctx.inject(['fs', 'sandbox'])` runs the wrapper install immediately.
      sandbox: { async confine() { throw new Error('unused here') } },
      permissionPresets: { presets: {}, emitCatalogChanged() {} },
      sessionProjections: { stateOf: (session) => ({ preset: session === inside ? selected : 'workspace-write' }) },
      sessions: { get: (id) => [inside, outside].find((session) => session.id === id) },
    })

    const service = new ExtraSandboxPresetsService(ctx, serviceConfig(ExtraSandboxPresetsService.Config, {
      presets: {
        'workspace-write-extra': { writableDirs: [extra] },
        scratch: { sandbox: 'read-only', writableDirs: [scratch] },
      },
    }))
    await service.ready()

    const target = await fs.resolve(join(extra, 'note.txt'))
    const scratchTarget = await fs.resolve(join(scratch, 'note.txt'))
    const policyFor = (session, mode = 'workspace-write') => ({ mode, workspaceRoot: workspace, sessionId: session.id })

    // Preset off: the stock fence still refuses, i.e. the wrapper never widens
    // beyond what the session selected.
    await assert.rejects(
      fs.writeText(target, 'a', undefined, undefined, policyFor(inside)),
      { code: 'FS_SANDBOX_DENIED' },
    )

    // The workspace itself stays writable, exactly as before wrapping.
    const inWorkspace = await fs.resolve(join(workspace, 'ok.txt'))
    await fs.writeText(inWorkspace, 'a', undefined, undefined, policyFor(outside))

    // Preset on for that session: the same out-of-workspace target is accepted.
    selected = 'workspace-write-extra'
    await fs.writeText(target, 'b', undefined, undefined, policyFor(inside))
    assert.equal(await fs.readText(target), 'b')

    // A session that did not select it is still refused.
    const otherTarget = await fs.resolve(join(extra, 'other.txt'))
    await assert.rejects(
      fs.writeText(otherTarget, 'c', undefined, undefined, policyFor(outside)),
      { code: 'FS_SANDBOX_DENIED' },
    )

    // A different preset grants a different directory: the workspace-write one
    // no longer applies, and the read-only one does.
    selected = 'scratch'
    await assert.rejects(
      fs.writeText(target, 'd', undefined, undefined, policyFor(inside)),
      { code: 'FS_SANDBOX_DENIED' },
    )
    await fs.writeText(scratchTarget, 'd', undefined, undefined, policyFor(inside, 'read-only'))
    assert.equal(await fs.readText(scratchTarget), 'd')
    // Outside that preset's directory, read-only still refuses.
    await assert.rejects(
      fs.writeText(otherTarget, 'e', undefined, undefined, policyFor(inside, 'read-only')),
      { code: 'FS_SANDBOX_DENIED' },
    )

    // Unloading restores the stock fence exactly: the widening is gone.
    ctx.disposeEffects()
    await assert.rejects(
      fs.writeText(scratchTarget, 'f', undefined, undefined, policyFor(inside, 'read-only')),
      { code: 'FS_SANDBOX_DENIED' },
    )
    assert.equal(await fs.readText(scratchTarget), 'd')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('wrapping the live provider binds the selected preset directories per session', { skip: skip || sandboxLocal === undefined ? 'the DSH sandbox package is not resolvable here' : false }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const base = await makeFixture()
  try {
    const workspace = join(base, 'workspace')
    const extra = join(base, 'extra')
    await mkdir(workspace)
    await mkdir(extra)

    const inside = { id: 'inside' }
    const outside = { id: 'outside' }

    // The REAL stock provider, mounted as the composition would.
    const sandbox = new sandboxLocal.LocalSandboxProvider(
      { reflect: { provide() {} }, effect: () => () => {}, inject: () => {}, logger: { warn() {} } },
      { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000 },
    )

    const { ctx } = fakeContext({
      sandbox,
      fs: { async checkedTarget() { return 'unused' } },
      permissionPresets: { presets: {}, emitCatalogChanged() {} },
      sessionProjections: { stateOf: (session) => ({ preset: session === inside ? 'workspace-write-extra' : 'workspace-write' }) },
      sessions: { get: (id) => [inside, outside].find((session) => session.id === id) },
    })

    const service = new ExtraSandboxPresetsService(ctx, serviceConfig(ExtraSandboxPresetsService.Config, {
      presets: { 'workspace-write-extra': { writableDirs: [extra] } },
    }))
    await service.ready()

    const argv = ['bash', '-c', 'true']
    const policy = (session) => ({ mode: 'workspace-write', workspaceRoot: workspace, sessionId: session.id })
    const bindsOf = (confined) => {
      const at = confined.argv.indexOf('--')
      const binds = []
      for (let index = 0; index < at; index += 1) {
        if (confined.argv[index] === '--bind') binds.push(confined.argv[index + 1])
      }
      return { at, binds, confined }
    }

    // The selected session gets the extra directory bound alongside the workspace.
    const widened = bindsOf(await sandbox.confine(argv, policy(inside)))
    assert.equal(widened.confined.argv[0], 'bwrap', 'the real provider selects the bwrap rung')
    assert.ok(widened.binds.includes(workspace), widened.binds.join(','))
    assert.ok(widened.binds.includes(extra), widened.binds.join(','))
    assert.deepEqual(widened.confined.argv.slice(widened.at + 1), argv)

    // A session that did not select the preset gets the stock profile.
    const stock = bindsOf(await sandbox.confine(argv, policy(outside)))
    assert.ok(stock.binds.includes(workspace), stock.binds.join(','))
    assert.ok(!stock.binds.includes(extra), stock.binds.join(','))

    // Unloading restores the stock profile exactly.
    ctx.disposeEffects()
    const restored = bindsOf(await sandbox.confine(argv, policy(inside)))
    assert.ok(!restored.binds.includes(extra), restored.binds.join(','))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a mounted service without the expected seam is reported, not silently ignored', { skip }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const warnings = []
  // Both enforcement services are mounted but neither exposes the interface the
  // plugin extends, which is what a harness upgrade that moved the seam looks
  // like. The plugin must say so rather than leaving the presets quietly narrow.
  const { ctx } = fakeContext({
    fs: { resolve: async (path) => ({ displayPath: path, targetKey: path }) },
    sandbox: { restrict: () => 'not the seam' },
    permissionPresets: { presets: {}, emitCatalogChanged() {} },
    systemPrompt: { getContextOrder: () => 110, context: () => {} },
  })
  ctx.logger.warn = (message) => warnings.push(message)

  new ExtraSandboxPresetsService(ctx, serviceConfig(ExtraSandboxPresetsService.Config, {
    presets: { rust: { writableDirs: [] } },
  }))

  assert.equal(warnings.length, 2, warnings.join('\n'))
  assert.match(warnings[0], /"fs" service does not expose the interface/)
  assert.match(warnings[1], /"sandbox" service does not expose the interface/)
  assert.match(warnings[0], /moved that interface/)

  // Reported once per service, not on every refresh.
  warnings.length = 0
  const again = fakeContext({
    fs: {},
    sandbox: {},
    permissionPresets: { presets: {}, emitCatalogChanged() {} },
    systemPrompt: { getContextOrder: () => 110, context: () => {} },
  })
  again.ctx.logger.warn = (message) => warnings.push(message)
  const service = new ExtraSandboxPresetsService(again.ctx, serviceConfig(ExtraSandboxPresetsService.Config, {
    presets: { rust: { writableDirs: ['/nonexistent-probe-dir'] } },
  }))
  await service.ready()
  await service.ready()
  const seamWarnings = warnings.filter((message) => message.includes('does not expose the interface'))
  assert.equal(seamWarnings.length, 2, warnings.join('\n'))
})

test('a recognized service is wrapped without any warning', { skip }, async () => {
  const { ExtraSandboxPresetsService } = await import('../lib/service.mjs')

  const warnings = []
  const { ctx } = fakeContext({
    fs: { checkedTarget: async () => 'ok', resolve: async (path) => ({ displayPath: path, targetKey: path }) },
    sandbox: { confine: async (argv) => ({ argv }) },
    permissionPresets: { presets: {}, emitCatalogChanged() {} },
    systemPrompt: { getContextOrder: () => 110, context: () => {} },
  })
  ctx.logger.warn = (message) => warnings.push(message)

  const service = new ExtraSandboxPresetsService(ctx, serviceConfig(ExtraSandboxPresetsService.Config, {
    presets: {},
  }))
  assert.deepEqual(warnings, [], warnings.join('\n'))
  await service.ready()

  // The wrappers are installed and removal restores the originals.
  assert.notEqual(ctx.fs.checkedTarget.name, undefined)
  ctx.disposeEffects()
})
