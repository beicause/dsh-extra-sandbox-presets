/**
 * Unit tests for the pure path logic behind the extra writable directories.
 *
 * Run with `node test/roots.test.ts` from the package directory. Uses only
 * Node built-ins so it can run without the DSH dependency tree.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { absoluteEntry, expandExtraDirs, isPathUnder, isUnderAny, workspaceEntryPath } from '../src/roots.js';
const withTempTree = async (/** @type {(base: string) => Promise<unknown>} */ run) => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-extra-dirs-'));
    try {
        return await run(base);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
};
test('absoluteEntry expands ~ and requires an absolute path', () => {
    assert.equal(absoluteEntry('/a/b'), '/a/b');
    assert.equal(absoluteEntry('  /a/b  '), '/a/b');
    assert.equal(absoluteEntry(''), undefined);
    assert.equal(absoluteEntry('   '), undefined);
    assert.equal(absoluteEntry('relative/dir'), undefined);
    assert.equal(absoluteEntry(undefined), undefined);
    assert.equal(absoluteEntry(42), undefined);
    const expanded = absoluteEntry('~/x');
    assert.ok(expanded !== undefined);
    assert.match(expanded, /\/x$/);
});
test('expandExtraDirs keeps directories, dedupes, and reports the rest', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const dir = join(base, 'dir');
        const file = join(base, 'file.txt');
        await mkdir(dir);
        await writeFile(file, 'x');
        const { dirs, rejected } = await expandExtraDirs([
            dir,
            dir,
            file,
            join(base, 'missing'),
            'relative',
            '',
        ]);
        assert.deepEqual(dirs, [dir]);
        const reasons = rejected.map(({ reason }) => reason);
        assert.ok(reasons.includes('not a directory'), reasons.join(' | '));
        assert.ok(reasons.includes('does not exist'), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.startsWith('not an absolute path')), reasons.join(' | '));
        // The blank entry is rejected with its own reason.
        assert.ok(reasons.includes('blank entry'), reasons.join(' | '));
        assert.equal(rejected.length, 4);
    });
});
test('expandExtraDirs resolves a symlinked directory to its target', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const real = join(base, 'real');
        const link = join(base, 'link');
        await mkdir(real);
        await symlink(real, link);
        const { dirs } = await expandExtraDirs([link]);
        assert.equal(dirs.length, 1);
        assert.ok(!dirs[0].endsWith('/link'), dirs[0]);
    });
});
test('isPathUnder accepts the root itself, descendants, and rejects siblings', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const root = join(base, 'root');
        const nested = join(root, 'a', 'b');
        await mkdir(nested, { recursive: true });
        await writeFile(join(base, 'sibling'), 'x');
        assert.equal(await isPathUnder(root, root), true);
        assert.equal(await isPathUnder(nested, root), true);
        assert.equal(await isPathUnder(join(root, 'a'), root), true);
        assert.equal(await isPathUnder(join(base, 'sibling'), root), false);
        assert.equal(await isPathUnder(base, root), false);
        // A not-yet-existing path below the root is still contained lexically.
        assert.equal(await isPathUnder(join(root, 'a', 'new.txt'), root), true);
    });
});
test('isPathUnder does not treat a name prefix as containment', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const root = join(base, 'root');
        const sibling = join(base, 'root-other');
        await mkdir(root);
        await mkdir(sibling);
        assert.equal(await isPathUnder(sibling, root), false);
    });
});
test('isUnderAny matches any configured root', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const one = join(base, 'one');
        const two = join(base, 'two');
        await mkdir(one);
        await mkdir(two);
        assert.equal(await isUnderAny(join(two, 'f'), [one, two]), true);
        assert.equal(await isUnderAny(join(one, 'f'), [one, two]), true);
        assert.equal(await isUnderAny(join(base, 'elsewhere'), [one, two]), false);
        assert.equal(await isUnderAny(join(one, 'f'), []), false);
    });
});
test('a workspace: entry is kept as a subpath instead of being resolved', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const fixed = join(base, 'fixed');
        await mkdir(fixed);
        const { dirs, workspaceDirs, rejected } = await expandExtraDirs([
            fixed,
            'workspace:notes',
            'workspace:./deep/nested',
            'workspace:',
            'workspace:.',
        ]);
        // Only the absolute entry can be made real at configuration time.
        assert.deepEqual(dirs, [fixed]);
        // The rest stay subpaths, in order, with '.' normalized away.
        assert.deepEqual(workspaceDirs, ['notes', 'deep/nested', '']);
        assert.deepEqual(rejected, [], 'a workspace entry is not a rejection');
    });
});
test('a workspace: entry that cannot be a subpath is reported with its own reason', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const { dirs, workspaceDirs, rejected } = await expandExtraDirs([
            'workspace:/etc',
            'workspace:~/secrets',
            'workspace:../escape',
            'workspace:a/../../escape',
            'workspace:ok',
        ]);
        assert.deepEqual(dirs, []);
        assert.deepEqual(workspaceDirs, ['ok'], 'only the usable subpath survives');
        const reasons = rejected.map(({ reason }) => reason);
        assert.equal(rejected.length, 4);
        assert.ok(reasons.every((reason) => reason.startsWith('a workspace path')), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.includes('must be relative to the workspace')), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.includes('".."')), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.includes('a leading ~ does not apply')), reasons.join(' | '));
    });
});
test('two spellings of one workspace directory are not bound twice', async () => {
    const { workspaceDirs } = await expandExtraDirs([
        'workspace:notes',
        'workspace:./notes',
        'workspace: notes ',
        'workspace:other',
    ]);
    assert.deepEqual(workspaceDirs, ['notes', 'other']);
});
test('workspaceDirs is empty when nothing is workspace-relative', async () => {
    const { workspaceDirs } = await expandExtraDirs([]);
    assert.deepEqual(workspaceDirs, []);
    const nonString = await expandExtraDirs([1, null, 'workspace-like']);
    assert.deepEqual(nonString.workspaceDirs, []);
});
test('workspaceEntryPath joins a subpath onto a workspace root', () => {
    assert.equal(workspaceEntryPath('notes', '/ws'), join('/ws', 'notes'));
    assert.equal(workspaceEntryPath('deep/nested', '/ws'), join('/ws', 'deep/nested'));
    // An empty subpath is the workspace root itself, not a stray separator.
    assert.equal(workspaceEntryPath('', '/ws'), '/ws');
    // The root is used as given: already absolute and canonical by contract.
    assert.equal(workspaceEntryPath('notes', '/ws/'), join('/ws/', 'notes'));
});
