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
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const dshResolver = () => {
    let shim;
    try {
        shim = execSync('command -v dsh', { encoding: 'utf8', shell: '/bin/bash' }).trim();
    }
    catch {
        return undefined;
    }
    if (shim === '')
        return undefined;
    // Read the entry out of the shim generically: whichever manager wrote it,
    // the file it launches is an absolute path ending in `.js`.
    let text;
    try {
        text = readFileSync(shim, 'utf8');
    }
    catch {
        return undefined;
    }
    const entry = (text.match(/\/[^\s"'`)]*\.js/g) ?? []).find((candidate) => existsSync(candidate));
    if (entry === undefined)
        return undefined;
    try {
        return createRequire(realpathSync(entry));
    }
    catch {
        return undefined;
    }
};
/** Node's resolver rooted at the running `dsh`, when it can be found. */
const resolver = dshResolver();
/**
 * Resolve one package directory, by asking Node to resolve the package itself.
 * @param specifier - the package name.
 * @returns its directory, or `undefined` when it is not installed.
 */
export const storeResolve = (/** @type {string} */ specifier) => {
    if (resolver === undefined)
        return undefined;
    try {
        // Let Node pick the package's entry, then walk up to its directory so the
        // caller does not have to know which file the manifest names.
        let directory = dirname(resolver.resolve(specifier));
        for (let hops = 0; hops < 8; hops += 1) {
            if (existsSync(join(directory, 'package.json')))
                return directory;
            const parent = dirname(directory);
            if (parent === directory)
                break;
            directory = parent;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
};
/**
 * Import a package, by bare specifier when this module can see it and through
 * the running `dsh`'s resolution otherwise.
 *
 * The known DSH specifiers resolve to their real module types, so a test that
 * reads a missing export is a type error; anything else falls back to
 * `unknown`. A JSDoc `@property` map cannot spell quoted keys, so the table
 * lives in this conditional return type.
 *
 * @template {string} S
 * @param {S} specifier - the package name.
 * @returns {Promise<(S extends '@deepseek-ai/cordis' ? typeof import('@deepseek-ai/cordis')
 *   : S extends '@deepseek-ai/dsh-system-prompt' ? typeof import('@deepseek-ai/dsh-system-prompt')
 *   : S extends '@deepseek-ai/dsh-fs-sandbox' ? typeof import('@deepseek-ai/dsh-fs-sandbox')
 *   : S extends '@deepseek-ai/dsh-sandbox-local' ? typeof import('@deepseek-ai/dsh-sandbox-local')
 *   : unknown) | undefined>} the module namespace, or `undefined` when it is not available.
 */
export const optionalImport = async (specifier) => {
    try {
        return await import(specifier);
    }
    catch (/** @type {unknown} */ error) {
        if (/** @type {{ code?: unknown }} */ (error)?.code !== 'ERR_MODULE_NOT_FOUND')
            throw error;
    }
    if (resolver === undefined)
        return undefined;
    // Resolve the package's own entry, so a manifest with `exports` or a
    // non-`src/index.js` layout is handled by Node rather than guessed at.
    let entry;
    try {
        entry = resolver.resolve(specifier);
    }
    catch {
        return undefined;
    }
    return await import(pathToFileURL(entry).href);
};
/**
 * The host a test drives: a real root context plus the helpers the cases use.
 *
 * @typedef {object} TestHost
 * @property {import('@deepseek-ai/cordis').Context} ctx - the root context.
 * @property {(ms?: number) => Promise<void>} settle - wait for Cordis to settle.
 * @property {() => Promise<boolean>} mountSystemPrompt - mount the real prompt registry.
 * @property {(deps: Record<string, unknown>) => Promise<void>} provideDependencies - mount service stubs.
 * @property {() => Promise<void>} disposeAll - dispose the whole application.
 */
/**
 * Create a real Cordis application.
 * @returns {Promise<TestHost | undefined>} the host, or `undefined` when Cordis is not available.
 */
export const createHost = async () => {
    const cordis = await optionalImport('@deepseek-ai/cordis');
    const Context = cordis?.Context;
    if (typeof Context !== 'function')
        return undefined;
    const ctx = new Context();
    const settle = async (milliseconds = 200) => {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
    };
    return {
        ctx,
        settle,
        async mountSystemPrompt() {
            const module = await optionalImport('@deepseek-ai/dsh-system-prompt');
            const plugin = module?.SystemPrompt ?? module?.default;
            if (typeof plugin !== 'function')
                return false;
            ctx.plugin(plugin, {});
            await settle();
            return ctx.get('systemPrompt') !== undefined;
        },
        async provideDependencies(/** @type {Record<string, unknown>} */ dependencies) {
            // A plugin row is the only place a real Context accepts `provide`, so
            // the stubs are mounted as one.
            ctx.plugin({
                name: 'test-stubs',
                /** @param {import('@deepseek-ai/cordis').Context} scope - the live child context. */
                apply(scope) {
                    for (const [key, value] of Object.entries(dependencies))
                        scope.provide?.(key, value);
                },
            });
            await settle();
        },
        async disposeAll() {
            const root = /** @type {{ dispose?: () => Promise<void> }} */ (ctx);
            await root.dispose?.();
            await settle(50);
        },
    };
};
