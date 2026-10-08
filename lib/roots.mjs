/**
 * Pure filesystem helpers for the configured writable directories: expanding
 * them to canonical paths and deciding whether a path lies inside one.
 *
 * Kept free of Cordis and DSH imports so it can be unit-tested directly.
 */

import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

const isMissing = (error) => MISSING_CODES.has(error?.code)

/** Resolve a configured entry to an absolute path, expanding a leading `~`. */
export function absoluteEntry(entry) {
  if (typeof entry !== 'string') return undefined
  const trimmed = entry.trim()
  if (trimmed === '') return undefined
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : undefined
}

/**
 * Resolve the configured extra directories to the canonical paths the
 * enforcement layers actually compare. Symlinks are resolved because bwrap
 * binds and the fs fence's containment check both match real paths.
 *
 * A missing or non-directory entry is reported instead of being invented:
 * granting a path the caller never named would be the unsafe direction.
 *
 * @param entries - raw configured directory entries.
 * @returns the usable canonical directories plus the rejected entries.
 */
export async function expandExtraDirs(entries) {
  const dirs = []
  const rejected = []
  const seen = new Set()

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      rejected.push({ entry, reason: 'blank entry' })
      continue
    }
    const absolute = absoluteEntry(entry)
    if (absolute === undefined) {
      rejected.push({ entry, reason: 'not an absolute path (a leading ~ is allowed)' })
      continue
    }
    let canonical
    try {
      canonical = await realpath(absolute)
    } catch (error) {
      rejected.push({ entry, reason: isMissing(error) ? 'does not exist' : String(error?.message ?? error) })
      continue
    }
    let info
    try {
      info = await stat(canonical)
    } catch (error) {
      rejected.push({ entry, reason: String(error?.message ?? error) })
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

  return { dirs, rejected }
}

const comparable = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)

async function statIfPresent(path) {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino

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
export async function isPathUnder(path, root) {
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
export async function isUnderAny(path, roots) {
  for (const root of Array.isArray(roots) ? roots : []) {
    if (await isPathUnder(path, root)) return true
  }
  return false
}

export { resolve }
