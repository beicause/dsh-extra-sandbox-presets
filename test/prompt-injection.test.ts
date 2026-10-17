/**
 * Regression tests for the system-prompt injection.
 *
 * These run on a real Cordis application with the real prompt registry, which
 * `integration.test.ts` deliberately does not: its hand-built context inlines
 * every `inject` callback and drops it when a dependency is missing, so it can
 * never show that a registration fails to reach a live context.
 *
 * The distinction that matters here is between an assembled prompt and the one
 * the model receives. The loop re-resolves every runtime context from its
 * provider while preparing each request, so a contribution that exists only in
 * the assembled copy — an amendment of another subsystem's entry, say — is
 * replaced before it is ever rendered. Every case therefore reads the note
 * through the same refresh the loop performs.
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

/** The stock note the plugin's own context is read against. */
const STOCK_NOTE = 'Current DSH file policy: workspace-write. Any available operation may modify files.'

/** The prompt context `dsh-sandbox-policy` registers. */
const POLICY_CONTEXT = 'sandbox:policy'

/** The prompt context this plugin registers. */
const NOTE_CONTEXT = 'sandbox:preset-write-dirs'

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

/** One assembled prompt context. */
interface PromptContext {
  name: string
  text: string
}

/** The part of the prompt registry the cases read. */
interface PromptRegistry {
  context(input: { name: string; order: number; text: (ctx: unknown) => string }): () => void
  getContextOrder(name: string): number
  assemble(context: unknown): Promise<{ contexts: PromptContext[] }>
  refreshContext(assembly: { contexts: PromptContext[] }, context: unknown): { contexts: PromptContext[] }
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
 * Register the stock policy context once. Registration is memoised per host
 * because the registry rejects a duplicate context name.
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

/** The text of one context, or an empty string when it contributes none. */
const textOf = (contexts: PromptContext[], name: string): string =>
  contexts.find((entry) => entry.name === name)?.text ?? ''

/**
 * Read the plugin's note as the model would receive it.
 *
 * The assembled copy is taken first, then the same assembly is refreshed the
 * way the loop does before each request. Both are returned so a case can pin
 * that the note is in the refreshed result rather than only in the assembly.
 *
 * @param host - the mounted host.
 * @param session - the session to assemble for.
 * @returns the note text in each form.
 */
const assembleNote = async (host: Host, session: unknown): Promise<{ assembled: string; refreshed: string }> => {
  registerPolicyContext(host)
  const registry = host.ctx.get('systemPrompt') as PromptRegistry | undefined
  assert.ok(registry !== undefined, 'the prompt registry is reachable')

  const context = { agent: { session } }
  const assembly = await registry.assemble(context)
  const policy = assembly.contexts.find((entry) => entry.name === POLICY_CONTEXT)
  assert.ok(policy !== undefined, 'the stock policy context is in the assembly')
  assert.equal(policy.text, STOCK_NOTE, 'the stock note is left exactly as its owner wrote it')

  return {
    assembled: textOf(assembly.contexts, NOTE_CONTEXT),
    refreshed: textOf(registry.refreshContext(assembly, context).contexts, NOTE_CONTEXT),
  }
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

test('the note reaches the prompt the model receives', { skip }, async () => {
  const writable = await makeWritableDir()
  const { host, session } = await mountService({
    presets: { plus: { writableDirs: [writable] } },
    selected: () => 'plus',
  })
  try {
    const { assembled, refreshed } = await assembleNote(host, session)
    assert.match(assembled, /dsh-extra-sandbox-presets plugin additionally allows writing these configured directories/)
    assert.ok(assembled.includes('"plus" preset'), 'the preset in force is named')
    assert.ok(assembled.includes(`"${writable}"`), 'the granted directory is named in the prompt')
    // This is the assertion the earlier implementation failed: the note only
    // existed in the assembled copy, so the refreshed — and therefore rendered
    // — prompt carried none of it.
    assert.equal(refreshed, assembled, 'the note survives the per-request context refresh')
  } finally {
    await host.disposeAll()
    await rm(writable, { recursive: true, force: true })
  }
})

test('switching the selected preset changes the refreshed note', { skip }, async () => {
  const first = await makeWritableDir()
  const second = await makeWritableDir()
  let selected = 'plus'
  const { host, session } = await mountService({
    presets: {
      plus: { writableDirs: [first] },
      scratch: { sandbox: 'read-only', approval: 'ask', writableDirs: [second] },
    },
    selected: () => selected,
  })
  try {
    const before = await assembleNote(host, session)
    assert.equal(before.refreshed, before.assembled, 'the first selection survives the refresh')
    assert.ok(before.refreshed.includes(`"${first}"`), 'the first preset grants the first directory')
    assert.doesNotMatch(before.refreshed, new RegExp(`"${second}"`), 'and not the other one')

    selected = 'scratch'
    const after = await assembleNote(host, session)
    assert.equal(after.refreshed, after.assembled, 'the new selection survives the refresh too')
    assert.match(after.refreshed, /"scratch" preset/, 'the preset now in force is named')
    assert.ok(after.refreshed.includes(`"${second}"`), 'the newly granted directory is named')
    assert.doesNotMatch(after.refreshed, new RegExp(`"${first}"`), 'the directory it no longer grants is gone')
  } finally {
    await host.disposeAll()
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('an unselected preset contributes no note', { skip }, async () => {
  const { host, session } = await mountService({
    presets: { plus: { writableDirs: [await makeWritableDir()] } },
    // A shipped preset this plugin did not configure.
    selected: () => 'workspace-write',
  })
  try {
    const { assembled, refreshed } = await assembleNote(host, session)
    assert.equal(assembled, '', 'no note for a preset this plugin does not own')
    assert.equal(refreshed, '', 'and none after the refresh either')
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
    const { assembled, refreshed } = await assembleNote(host, session)
    assert.equal(assembled, '', 'a directory that does not resolve is never named')
    assert.equal(refreshed, '', 'nor after the refresh')
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
    const { assembled } = await assembleNote(host, session)
    assert.ok(assembled.includes(`"${writable}"`), 'the granted directory is named')
    assert.ok(assembled.includes('"scratch" preset'), 'the read-only preset is named')
    assert.match(assembled, /even under the read-only policy above/)
  } finally {
    await host.disposeAll()
    await rm(writable, { recursive: true, force: true })
  }
})

test('unloading the plugin removes its note from the prompt', { skip }, async () => {
  const writable = await makeWritableDir()
  const { host, session, mounted } = await mountService({
    presets: { plus: { writableDirs: [writable] } },
    selected: () => 'plus',
  })
  try {
    assert.match((await assembleNote(host, session)).refreshed, /dsh-extra-sandbox-presets plugin additionally allows writing/)

    // The registration has to go with the plugin, or a reload would leave a
    // context behind that keeps naming directories nothing grants. Unloading
    // goes through the handle Cordis returns, which the Loader disposes on
    // reload.
    const handle = mounted as { dispose?: () => void | Promise<void> } | undefined
    assert.ok(handle !== undefined, 'the plugin returns a handle')
    await handle.dispose?.()
    await host.settle(300)

    assert.equal(host.ctx.get('sandboxPresets'), undefined, 'the service is unregistered')
    const { assembled, refreshed } = await assembleNote(host, session)
    assert.equal(assembled, '', 'the context registration is gone with the plugin')
    assert.equal(refreshed, '', 'and so is the note the model would receive')
  } finally {
    await host.disposeAll()
    await rm(writable, { recursive: true, force: true })
  }
})
