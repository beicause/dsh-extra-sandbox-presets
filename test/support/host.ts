/**
 * A real Cordis application and real DSH packages for the tests that must not
 * trust a hand-built context.
 *
 * `integration.test.ts` drives a stand-in context whose `inject` inlines every
 * callback and drops it when a dependency is missing. Real Cordis does neither:
 * an injected callback is deferred until the dependency is provided, re-run
 * when it is replaced, and handed a live child context whose `on` is the event
 * bus. A case that has to observe a listener failing to register, or a
 * disposer leaving one behind, therefore needs the real machinery.
 *
 * Resolution goes through the pnpm store when a bare specifier fails, because
 * this package is not a dependency of the DSH packages it pins; a profile
 * install makes them bare-resolvable and the store fallback is then unused.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolve the packages the running `dsh` is installed with, without assuming a
 * package manager's directory layout.
 *
 * A hardcoded installation root only runs on the machine it was written on,
 * and `.pnpm` is pnpm-specific: npm and yarn lay the same packages out
 * differently. So nothing here inspects a store. Instead the `dsh` executable
 * is located on `PATH`, the absolute entry its shim points at is read out (a
 * shim of every manager names its target), and Node's own resolution runs from
 * that entry with `createRequire`. Whatever layout installed `dsh` is then
 * handled by Node itself.
 *
 * @returns a resolver rooted at the running `dsh`, or `undefined` when it
 *   cannot be located.
 */
const dshResolver = (): NodeJS.Require | undefined => {
  let shim: string
  try {
    shim = execSync('command -v dsh', { encoding: 'utf8', shell: '/bin/bash' }).trim()
  } catch {
    return undefined
  }
  if (shim === '') return undefined

  // Read the entry out of the shim generically: whichever manager wrote it,
  // the file it launches is an absolute path ending in `.js`.
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  const entry = (text.match(/\/[^\s"'`)]*\.js/g) ?? []).find((candidate) => existsSync(candidate))
  if (entry === undefined) return undefined

  try {
    return createRequire(realpathSync(entry))
  } catch {
    return undefined
  }
}

/** Node's resolver rooted at the running `dsh`, when it can be found. */
const resolver = dshResolver()

/**
 * Resolve one package directory, by asking Node to resolve the package itself.
 * @param specifier - the package name.
 * @returns its directory, or `undefined` when it is not installed.
 */
export const storeResolve = (specifier: string): string | undefined => {
  if (resolver === undefined) return undefined
  try {
    // Let Node pick the package's entry, then walk up to its directory so the
    // caller does not have to know which file the manifest names.
    let directory = dirname(resolver.resolve(specifier))
    for (let hops = 0; hops < 8; hops += 1) {
      if (existsSync(join(directory, 'package.json'))) return directory
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Import a package, by bare specifier when this module can see it and through
 * the running `dsh`'s resolution otherwise.
 * @param specifier - the package name.
 * @returns the module namespace, or `undefined` when it is not available.
 */
export const optionalImport = async (specifier: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return await import(specifier) as Record<string, unknown>
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  if (resolver === undefined) return undefined
  // Resolve the package's own entry, so a manifest with `exports` or a
  // non-`lib/index.js` layout is handled by Node rather than guessed at.
  let entry: string
  try {
    entry = resolver.resolve(specifier)
  } catch {
    return undefined
  }
  return await import(pathToFileURL(entry).href) as Record<string, unknown>
}

/** The Cordis surface this fixture drives. */
export interface HostContext {
  plugin(plugin: unknown, config?: unknown): unknown
  get(name: string): unknown
  provide?(name: string, value: unknown): unknown
  [name: string]: unknown
}

/** A real Cordis application plus what the cases need to drive it. */
export interface Host {
  readonly ctx: HostContext
  settle(milliseconds?: number): Promise<void>
  /** Mount the stock prompt registry; false when it is unavailable. */
  mountSystemPrompt(): Promise<boolean>
  /** Provide the services a plugin under test injects. */
  provideDependencies(dependencies: Record<string, unknown>): Promise<void>
  disposeAll(): Promise<void>
}

/**
 * Create a real Cordis application.
 * @returns the host, or `undefined` when Cordis is not available.
 */
export const createHost = async (): Promise<Host | undefined> => {
  const cordis = await optionalImport('@deepseek-ai/cordis')
  const Context = cordis?.Context as (new () => HostContext) | undefined
  if (typeof Context !== 'function') return undefined

  const ctx = new Context()
  const settle = async (milliseconds = 200): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  return {
    ctx,
    settle,
    async mountSystemPrompt() {
      const module = await optionalImport('@deepseek-ai/dsh-system-prompt')
      const plugin = module?.SystemPrompt ?? module?.default
      if (typeof plugin !== 'function') return false
      ctx.plugin(plugin, {})
      await settle()
      return ctx.get('systemPrompt') !== undefined
    },
    async provideDependencies(dependencies) {
      // A plugin row is the only place a real Context accepts `provide`, so
      // the stubs are mounted as one.
      ctx.plugin({
        name: 'test-stubs',
        apply(scope: HostContext) {
          for (const [key, value] of Object.entries(dependencies)) scope.provide?.(key, value)
        },
      })
      await settle()
    },
    async disposeAll() {
      const root = ctx as unknown as { dispose?: () => Promise<void> | void }
      await root.dispose?.()
      await settle(50)
    },
  }
}
