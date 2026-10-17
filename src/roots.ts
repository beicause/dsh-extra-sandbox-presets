/**
 * Pure filesystem helpers for the configured writable directories: expanding
 * them to canonical paths and deciding whether a path lies inside one.
 *
 * Kept free of Cordis and DSH imports so it can be unit-tested directly.
 */

import { realpath, stat } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** One configured directory that could not be used, with the reason why. */
export interface RejectedEntry {
  readonly entry: unknown
  readonly reason: string
}

/** The usable directories plus the entries that were rejected. */
export interface ExpandedDirs {
  /** Canonical absolute directories, usable as they are. */
  readonly dirs: string[]
  /** Subpaths of the session workspace, resolvable only per session. */
  readonly workspaceDirs: string[]
  readonly rejected: RejectedEntry[]
}

/**
 * Prefix marking a configured directory as relative to the session workspace.
 *
 * The workspace is a per-session boundary, not a process-wide constant, so an
 * entry that names one cannot be turned into a real path while the plugin
 * loads. It is kept as a subpath and resolved against the workspace root the
 * enforcement layer reports for each call, which is the same boundary the stock
 * policy folds. The workspace belongs to the session, which the plugin does not
 * know while it loads, so an entry naming one cannot become a real path until a
 * call supplies that session's root.
 */
export const WORKSPACE_PREFIX = 'workspace:'

const MISSING_CODES: ReadonlySet<unknown> = new Set(['ENOENT', 'ENOTDIR'])

/** Read `error.code` without asserting the caught value's shape. */
const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined

const isMissing = (error: unknown): boolean => MISSING_CODES.has(codeOf(error))

/** Render `String(error?.message ?? error)` for an unknown caught value. */
const detailOf = (error: unknown): string => {
  const message = typeof error === 'object' && error !== null
    ? (error as { message?: unknown }).message
    : undefined
  return message === undefined || message === null ? String(error) : String(message)
}

/** Resolve a configured entry to an absolute path, expanding a leading `~`. */
export function absoluteEntry(entry: unknown): string | undefined {
  if (typeof entry !== 'string') return undefined
  const trimmed = entry.trim()
  if (trimmed === '') return undefined
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : undefined
}

/**
 * Read one configured entry as a workspace subpath.
 *
 * A workspace-relative entry is kept as a subpath: it can only be resolved
 * against the workspace root of the session making a call, which the loader
 * cannot know. The result distinguishes the cases the caller must treat
 * differently - an entry that is not workspace-relative at all, a usable
 * subpath, and a prefixed entry that cannot name a subpath - so a mistake such
 * as `workspace:/etc` is reported as that mistake rather than as a missing
 * leading slash.
 *
 * @param entry - one raw configured directory entry.
 * @returns `kind: 'none'` for an unprefixed entry, `'subpath'` with the
 *   normalized subpath, or `'invalid'` with the reason it cannot be used.
 */
function readWorkspaceEntry(
  entry: string,
): { kind: 'none' } | { kind: 'subpath'; subpath: string } | { kind: 'invalid'; reason: string } {
  if (!entry.startsWith(WORKSPACE_PREFIX)) return { kind: 'none' }
  const rest = entry.slice(WORKSPACE_PREFIX.length).trim()
  if (rest === '' || rest === '.' || rest === './') return { kind: 'subpath', subpath: '' }
  if (isAbsolute(rest)) {
    return { kind: 'invalid', reason: 'a workspace path must be relative to the workspace' }
  }
  if (rest === '~' || rest.startsWith('~/')) {
    return {
      kind: 'invalid',
      reason: 'a workspace path must be relative to the workspace (a leading ~ does not apply)',
    }
  }
  if (rest.split('/').includes('..')) {
    return { kind: 'invalid', reason: 'a workspace path may not contain ".."' }
  }
  return { kind: 'subpath', subpath: join(rest) }
}

/**
 * Resolve the configured extra directories to the canonical paths the
 * enforcement layers actually compare. Symlinks are resolved because bwrap
 * binds and the fs fence's containment check both match real paths.
 *
 * An entry prefixed with `workspace:` cannot be resolved here: it names a
 * subpath of the session workspace, which differs per session. It is reported
 * as a workspace subpath instead, for the enforcement layer to resolve against
 * the workspace root of the session making the call.
 *
 * A missing or non-directory entry is reported instead of being invented:
 * granting a path the caller never named would be the unsafe direction. The
 * same applies to a `..` inside a workspace subpath, which is refused rather
 * than silently clamped.
 *
 * @param entries - raw configured directory entries.
 * @returns the usable canonical directories, the workspace subpaths, and the
 *   rejected entries.
 */
export async function expandExtraDirs(entries: unknown): Promise<ExpandedDirs> {
  const dirs: string[] = []
  const workspaceDirs: string[] = []
  const rejected: RejectedEntry[] = []
  const seen = new Set<string>()

  for (const entry of Array.isArray(entries) ? (entries as unknown[]) : []) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      rejected.push({ entry, reason: 'blank entry' })
      continue
    }
    const workspace = readWorkspaceEntry(entry.trim())
    if (workspace.kind === 'invalid') {
      rejected.push({ entry, reason: workspace.reason })
      continue
    }
    if (workspace.kind === 'subpath') {
      // Dedupe on the resolved subpath, so two spellings of one directory
      // (`workspace:notes` and `workspace:./notes`) are not both bound.
      const key = WORKSPACE_PREFIX + workspace.subpath
      if (seen.has(key)) continue
      seen.add(key)
      workspaceDirs.push(workspace.subpath)
      continue
    }
    const absolute = absoluteEntry(entry)
    if (absolute === undefined) {
      rejected.push({ entry, reason: 'not an absolute path (a leading ~ is allowed)' })
      continue
    }
    let canonical: string
    try {
      canonical = await realpath(absolute)
    } catch (error) {
      rejected.push({ entry, reason: isMissing(error) ? 'does not exist' : detailOf(error) })
      continue
    }
    let info: Stats
    try {
      info = await stat(canonical)
    } catch (error) {
      rejected.push({ entry, reason: detailOf(error) })
      continue
    }
    if (!info.isDirectory()) {
      rejected.push({ entry, reason: 'not a directory' })
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    dirs.push(canonical)
  }

  return { dirs, workspaceDirs, rejected }
}

/**
 * Join one workspace subpath onto the workspace root of a session.
 *
 * The join is lexical on purpose: the root is already absolute and canonical,
 * and the subpath was normalized when the configuration was read. A path that
 * does not exist yet stays a plain candidate — the fence never grants a path it
 * cannot resolve, and the bwrap profile skips a source that is missing.
 *
 * @param subpath - the subpath recorded for a `workspace:` entry, possibly empty.
 * @param workspaceRoot - the session's absolute workspace root.
 * @returns the absolute path the subpath names.
 */
export function workspaceEntryPath(subpath: string, workspaceRoot: string): string {
  return subpath === '' ? workspaceRoot : join(workspaceRoot, subpath)
}

const comparable = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino

/**
 * Whether `path` is `root` or lies beneath it. The lexical comparison handles
 * normal canonical spellings; when the spellings differ, walking the target's
 * existing ancestors and comparing filesystem identity recognizes aliases such
 * as bind mounts and symlinked prefixes.
 *
 * @param path - canonical target path, which may end in a missing suffix.
 * @param root - canonical writable root.
 * @returns whether the target is the root or a descendant of it.
 */
export async function isPathUnder(path: string, root: string): Promise<boolean> {
  const target = comparable(path)
  const base = comparable(root)
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  if (target.startsWith(prefix)) return true

  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = path
  for (;;) {
    const info = await statIfPresent(ancestor)
    if (info !== undefined && sameIdentity(info, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

/** Whether any configured root contains `path`. */
export async function isUnderAny(path: string, roots: unknown): Promise<boolean> {
  for (const root of Array.isArray(roots) ? (roots as unknown[]) : []) {
    if (typeof root !== 'string') continue
    if (await isPathUnder(path, root)) return true
  }
  return false
}

export { resolve }
