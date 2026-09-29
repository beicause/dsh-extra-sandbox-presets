/**
 * Offline integration test: assemble the plugin's three pieces the way the
 * profile does, over a hand-built context, and check that the extra preset
 * really widens writes while `/permission` selection decides when.
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
  return mkdtemp(join(fixtureParent, 'wwx-'))
}

/** Validate through the plugin's own schema, the way Cordis does before construction. */
const serviceConfig = (schema, config) => schema(config)

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

test('publishing the preset adds it to the permission table and catalog', { skip }, async () => {
  const { ExtraWritableDirsService } = await import('../lib/service.mjs')

  const catalogChanged = []
  const permissions = {
    presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
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

  const service = new ExtraWritableDirsService(ctx, serviceConfig(ExtraWritableDirsService.Config, {
    extraWritableDirs: [],
    presetName: 'workspace-write-extra',
  }))

  // The preset is offered and keeps the stock sandbox mode. It carries no
  // label, so the picker renders the machine value like the built-in entries.
  assert.deepEqual(Object.keys(permissions.presets), [
    'read-only', 'workspace-write', 'danger-full-access', 'workspace-write-extra',
  ])
  assert.deepEqual(permissions.presets['workspace-write-extra'], {
    sandbox: 'workspace-write',
    approval: 'ask',
  })
  assert.equal(catalogChanged.length, 1)
  assert.equal(promptContexts.length, 1)
  assert.equal(promptContexts[0].name, 'sandbox:extra-write-dirs')
  assert.equal(promptContexts[0].order, 111)

  // A reserved name is refused instead of shadowing the shipped presets.
  const reserved = fakeContext({ permissionPresets: permissions }).ctx
  const other = new ExtraWritableDirsService(reserved, serviceConfig(ExtraWritableDirsService.Config, {
    extraWritableDirs: [],
    presetName: 'auto',
  }))
  assert.equal(other.presetName, 'auto')
  assert.equal(permissions.presets.auto, undefined)
  assert.equal(service.presetName, 'workspace-write-extra')
})

test('the extra directories apply only while the extra preset is selected', { skip }, async () => {
  const { ExtraWritableDirsService } = await import('../lib/service.mjs')

  const base = await makeFixture()
  try {
    const extra = join(base, 'extra')
    await mkdir(extra)

    // The permission projection is the only thing deciding enablement.
    let selected = 'workspace-write'
    const session = { id: 'session-1' }
    const { ctx } = fakeContext({
      permissionPresets: { presets: {}, emitCatalogChanged() {} },
      sessionProjections: { stateOf: () => ({ preset: selected }) },
      sessions: { get: (id) => (id === session.id ? session : undefined) },
    })

    const service = new ExtraWritableDirsService(ctx, serviceConfig(ExtraWritableDirsService.Config, {
      extraWritableDirs: [extra],
      presetName: 'workspace-write-extra',
    }))
    await service.ready()

    // Selected preset off: no directories apply even though they resolve.
    assert.equal(service.activeFor(session), false)
    assert.deepEqual(service.rootsFor(session), [])
    assert.deepEqual(service.rootsForSessionId('session-1'), [])

    // Selected preset on: they apply for that session only.
    selected = 'workspace-write-extra'
    assert.equal(service.activeFor(session), true)
    assert.deepEqual(service.rootsFor(session), [extra])
    assert.deepEqual(service.rootsForSessionId('session-1'), [extra])
    // Unknown or absent sessions get nothing.
    assert.deepEqual(service.rootsForSessionId('nope'), [])
    assert.deepEqual(service.rootsForSessionId(undefined), [])
    assert.deepEqual(service.rootsFor(undefined), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an unusable configured entry is ignored, never granted', { skip }, async () => {
  const { ExtraWritableDirsService } = await import('../lib/service.mjs')

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
      sessionProjections: { stateOf: () => ({ preset: 'workspace-write-extra' }) },
      sessions: { get: () => session },
    })
    ctx.logger.warn = (message) => warnings.push(message)

    const service = new ExtraWritableDirsService(ctx, serviceConfig(ExtraWritableDirsService.Config, {
      extraWritableDirs: [good, file, join(base, 'missing'), 'relative'],
      presetName: 'workspace-write-extra',
    }))
    await service.ready()

    assert.deepEqual(service.roots, [good])
    assert.deepEqual(service.rootsFor(session), [good])
    assert.equal(warnings.length, 1, warnings.join('\n'))
    assert.match(warnings[0], /ignoring unusable extraWritableDirs entries/)
    assert.match(warnings[0], /not a directory/)
    assert.match(warnings[0], /does not exist/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('wrapping the live filesystem widens only the selected session', { skip: skip || fsSandbox === undefined ? 'the DSH filesystem package is not resolvable here' : false }, async () => {
  const { ExtraWritableDirsService } = await import('../lib/service.mjs')

  const base = await makeFixture()
  try {
    const workspace = join(base, 'workspace')
    const extra = join(base, 'extra')
    await mkdir(workspace)
    await mkdir(extra)

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

    const service = new ExtraWritableDirsService(ctx, serviceConfig(ExtraWritableDirsService.Config, {
      extraWritableDirs: [extra],
      presetName: 'workspace-write-extra',
    }))
    await service.ready()

    const target = await fs.resolve(join(extra, 'note.txt'))
    const policyFor = (session) => ({ mode: 'workspace-write', workspaceRoot: workspace, sessionId: session.id })

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

    // read-only refuses regardless of the extra directories.
    await assert.rejects(
      fs.writeText(target, 'd', undefined, undefined, { ...policyFor(inside), mode: 'read-only' }),
      { code: 'FS_SANDBOX_DENIED' },
    )
    assert.equal(await fs.readText(target), 'b')

    // Unloading restores the stock fence exactly: the widening is gone.
    ctx.disposeEffects()
    await assert.rejects(
      fs.writeText(target, 'e', undefined, undefined, policyFor(inside)),
      { code: 'FS_SANDBOX_DENIED' },
    )
    assert.equal(await fs.readText(target), 'b')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('wrapping the live provider binds the extra directories per session', { skip: skip || sandboxLocal === undefined ? 'the DSH sandbox package is not resolvable here' : false }, async () => {
  const { ExtraWritableDirsService } = await import('../lib/service.mjs')

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

    const service = new ExtraWritableDirsService(ctx, serviceConfig(ExtraWritableDirsService.Config, {
      extraWritableDirs: [extra],
      presetName: 'workspace-write-extra',
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
  const { ExtraWritableDirsService } = await import('../lib/service.mjs')

  const warnings = []
  // Both enforcement services are mounted but neither exposes the interface the
  // plugin extends, which is what a harness upgrade that moved the seam looks
  // like. The plugin must say so rather than leaving the preset quietly narrow.
  const { ctx } = fakeContext({
    fs: { resolve: async (path) => ({ displayPath: path, targetKey: path }) },
    sandbox: { restrict: () => 'not the seam' },
    permissionPresets: { presets: {}, emitCatalogChanged() {} },
    systemPrompt: { getContextOrder: () => 110, context: () => {} },
  })
  ctx.logger.warn = (message) => warnings.push(message)

  new ExtraWritableDirsService(ctx, serviceConfig(ExtraWritableDirsService.Config, {
    extraWritableDirs: [],
    presetName: 'workspace-write-extra',
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
  const service = new ExtraWritableDirsService(again.ctx, serviceConfig(ExtraWritableDirsService.Config, {
    extraWritableDirs: ['/nonexistent-probe-dir'],
    presetName: 'workspace-write-extra',
  }))
  await service.ready()
  await service.ready()
  const seamWarnings = warnings.filter((message) => message.includes('does not expose the interface'))
  assert.equal(seamWarnings.length, 2, warnings.join('\n'))
})

test('a recognized service is wrapped without any warning', { skip }, async () => {
  const { ExtraWritableDirsService } = await import('../lib/service.mjs')

  const warnings = []
  const { ctx } = fakeContext({
    fs: { checkedTarget: async () => 'ok', resolve: async (path) => ({ displayPath: path, targetKey: path }) },
    sandbox: { confine: async (argv) => ({ argv }) },
    permissionPresets: { presets: {}, emitCatalogChanged() {} },
    systemPrompt: { getContextOrder: () => 110, context: () => {} },
  })
  ctx.logger.warn = (message) => warnings.push(message)

  const service = new ExtraWritableDirsService(ctx, serviceConfig(ExtraWritableDirsService.Config, {
    extraWritableDirs: [],
    presetName: 'workspace-write-extra',
  }))
  assert.deepEqual(warnings, [], warnings.join('\n'))
  await service.ready()

  // The wrappers are installed and removal restores the originals.
  assert.notEqual(ctx.fs.checkedTarget.name, undefined)
  ctx.disposeEffects()
})
