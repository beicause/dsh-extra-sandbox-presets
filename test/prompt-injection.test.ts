/**
 * Regression tests for the system-prompt injection.
 *
 * These run on a real Cordis application with the real prompt registry, which
 * `integration.test.ts` deliberately does not: its hand-built context inlines
 * every `inject` callback and drops it when a dependency is missing, so it can
 * never show that the waterfall listener fails to register on a live context.
 * That is exactly the failure this suite exists to catch — the plugin stays
 * mounted, its presets keep widening writes, and only the model-facing note
 * silently goes missing.
 *
 * Every case skips when the DSH packages are not resolvable, which is the case
 * outside an installed profile.
 *
 * Run with `node --test test/prompt-injection.test.ts`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createHost, optionalImport, type Host } from './support/host.ts'

const cordis = await optionalImport('@deepseek-ai/cordis')
const skip = cordis === undefined ? 'the DSH packages are not resolvable here' : false

/** The stock note the plugin amends in place. */
const STOCK_NOTE = 'Current DSH file policy: workspace-write. Any available operation may modify files.'

/** The prompt context `dsh-sandbox-policy` registers. */
const POLICY_CONTEXT = 'sandbox:policy'

/** Hosts whose stock policy context has been registered already. */
const registeredHosts = new WeakSet<Host>()

/**
 * A directory that really exists. The plugin expands every configured path and
 * drops the ones it cannot resolve, so a made-up path would widen nothing and
 * the note would correctly stay absent.
 */
const makeWritableDir = async (): Promise<string> => {
  const parent = join(process.cwd(), '.tmp')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'esp-prompt-'))
}

/** The part of the prompt registry the cases read. */
interface PromptRegistry {
  context(input: { name: string; order: number; text: (ctx: unknown) => string }): () => void
  getContextOrder(name: string): number
  assemble(context: unknown): Promise<{ contexts: Array<{ name: string; text: string }> }>
}

/**
 * Mount the plugin on a real host with the services it injects stubbed, and
 * return the pieces the cases assert against.
 */
const mountService = async (options: {
  presets: Record<string, { sandbox?: string; approval?: string; writableDirs: string[] }>
  selected: () => string
}): Promise<{ host: Host; session: { id: string }; presets: Record<string, unknown>; mounted: unknown }> => {
  const host = await createHost()
  assert.ok(host !== undefined, 'a real Cordis host is available')

  const presets: Record<string, unknown> = {}
  const session = { id: 'session-under-test' }

  assert.ok(await host.mountSystemPrompt(), 'the stock prompt registry is mounted')
  await host.provideDependencies({
    permissionPresets: { presets, emitCatalogChanged() {} },
    // The projection the plugin reads the session's selection from.
    sessionProjections: {
      stateOf: (_session: unknown, key: string) => (key === 'permissions' ? { preset: options.selected() } : undefined),
    },
    sessions: { get: (id: string) => (id === session.id ? session : undefined) },
    fs: {},
    sandbox: {},
  })

  const { ExtraSandboxPresetsService } = await import('../lib/service.js')
  const mounted = host.ctx.plugin(ExtraSandboxPresetsService, { presets: options.presets })
  await host.settle(400)

  return { host, session, presets, mounted }
}

/**
 * Register the stock policy context once, then read back the assembled text.
 * Registration is memoised per host because the registry rejects a duplicate
 * context name, and the cases assemble more than once.
 */
const registerPolicyContext = (host: Host): void => {
  if (registeredHosts.has(host)) return
  const registry = host.ctx.get('systemPrompt') as PromptRegistry | undefined
  assert.ok(registry !== undefined, 'the prompt registry is reachable')
  registry.context({
    name: POLICY_CONTEXT,
    order: registry.getContextOrder('SANDBOX_POLICY'),
    text: () => STOCK_NOTE,
  })
  registeredHosts.add(host)
}

/** Read the assembled policy text for one session. */
const assemblePolicy = async (host: Host, session: unknown): Promise<string> => {
  registerPolicyContext(host)
  const registry = host.ctx.get('systemPrompt') as PromptRegistry | undefined
  assert.ok(registry !== undefined, 'the prompt registry is reachable')

  const assembly = await registry.assemble({ agent: { session } })
  const policy = assembly.contexts.find((entry) => entry.name === POLICY_CONTEXT)
  assert.ok(policy !== undefined, 'the stock policy context is in the assembly')
  return policy.text
}

test('the plugin registers its service on a real context', { skip }, async () => {
  const { host } = await mountService({ presets: { plus: { writableDirs: [] } }, selected: () => 'plus' })
  try {
    const service = host.ctx.get('sandboxPresets') as { presetNames: readonly string[] } | undefined
    assert.ok(service !== undefined, 'the plugin registers its service on a live context')
    assert.deepEqual(service.presetNames, ['plus'])
  } finally {
    await host.disposeAll()
  }
})

test('the note reaches the assembled prompt on a real context', { skip }, async () => {
  const writable = await makeWritableDir()
  const { host, session } = await mountService({
    presets: { plus: { writableDirs: [writable] } },
    selected: () => 'plus',
  })
  try {
    const text = await assemblePolicy(host, session)
    assert.ok(text.startsWith(STOCK_NOTE), 'the stock wording is kept')
    assert.match(text, /dsh-extra-sandbox-presets plugin additionally allows writing these configured directories/)
    assert.ok(text.includes('"plus" preset'), 'the preset in force is named')
    assert.ok(text.includes(`"${writable}"`), 'the granted directory is named in the prompt')
  } finally {
    await host.disposeAll()
    await rm(writable, { recursive: true, force: true })
  }
})

test('an unselected preset leaves the assembled prompt untouched', { skip }, async () => {
  const { host, session } = await mountService({
    presets: { plus: { writableDirs: [await makeWritableDir()] } },
    // A shipped preset this plugin did not configure.
    selected: () => 'workspace-write',
  })
  try {
    const text = await assemblePolicy(host, session)
    assert.equal(text, STOCK_NOTE, 'no note is appended for a preset this plugin does not own')
  } finally {
    await host.disposeAll()
  }
})

test('an unusable directory is never named in the prompt', { skip }, async () => {
  // `expandExtraDirs` reports a missing directory instead of granting it, so a
  // note claiming it would promise a path the fence refuses.
  const { host, session } = await mountService({
    presets: { plus: { writableDirs: ['/definitely/not/a/real/directory'] } },
    selected: () => 'plus',
  })
  try {
    const text = await assemblePolicy(host, session)
    assert.equal(text, STOCK_NOTE, 'a directory that does not resolve is never named')
  } finally {
    await host.disposeAll()
  }
})

test('the configured presets are published into the live permission table', { skip }, async () => {
  const { host, presets } = await mountService({
    presets: {
      'workspace-write-extra': { writableDirs: [] },
      scratch: { sandbox: 'read-only', approval: 'never', writableDirs: [] },
    },
    selected: () => 'workspace-write-extra',
  })
  try {
    assert.deepEqual(presets['workspace-write-extra'], { sandbox: 'workspace-write', approval: 'ask' })
    assert.deepEqual(presets.scratch, { sandbox: 'read-only', approval: 'never' })
  } finally {
    await host.disposeAll()
  }
})

test('a read-only preset states its exception against the read-only boundary', { skip }, async () => {
  const writable = await makeWritableDir()
  const { host, session } = await mountService({
    presets: { scratch: { sandbox: 'read-only', approval: 'ask', writableDirs: [writable] } },
    selected: () => 'scratch',
  })
  try {
    const text = await assemblePolicy(host, session)
    assert.ok(text.includes(`"${writable}"`), 'the granted directory is named')
    assert.ok(text.includes('"scratch" preset'), 'the read-only preset is named')
    assert.match(text, /even under the read-only policy above/)
  } finally {
    await host.disposeAll()
    await rm(writable, { recursive: true, force: true })
  }
})

test('unloading the plugin drops its listener from the live waterfall', { skip }, async () => {
  const writable = await makeWritableDir()
  const { host, session, mounted } = await mountService({
    presets: { plus: { writableDirs: [writable] } },
    selected: () => 'plus',
  })
  try {
    assert.match(await assemblePolicy(host, session), /dsh-extra-sandbox-presets plugin additionally allows writing/)

    // The handler must be torn down with the plugin, or a reload would append
    // the note once per remaining listener. Unloading goes through the plugin
    // handle Cordis returns, which is what the Loader disposes on reload.
    const handle = mounted as { dispose?: () => void | Promise<void> } | undefined
    assert.ok(handle !== undefined, 'the plugin returns a handle')
    await handle.dispose?.()
    await host.settle(300)

    assert.equal(host.ctx.get('sandboxPresets'), undefined, 'the service is unregistered')
    assert.equal(await assemblePolicy(host, session), STOCK_NOTE, 'the waterfall listener is gone with it')
  } finally {
    await host.disposeAll()
    await rm(writable, { recursive: true, force: true })
  }
})
