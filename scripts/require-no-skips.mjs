#!/usr/bin/env node
/**
 * Fail the run when the suite skipped a case.
 *
 * Every case here pins an interface this plugin depends on — a stock method, a
 * prompt-context name, a projection key, or a cordis behaviour. A case skips
 * only because the DSH packages did not resolve, which means the run checked
 * none of that. Treating a skip as a pass is how a compatibility break reaches
 * a release, so the audit job converts any skip into a failure.
 *
 * Usage: node scripts/require-no-skips.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Run the suite with the TAP reporter and collect its output. */
const runSuite = () => new Promise((resolve, reject) => {
  // The reporter flag must precede the path, or Node treats it as a test file.
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'test/'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, output }))
})

/**
 * Read one `# <key> <number>` summary line from TAP output.
 * @param output - the captured TAP text.
 * @param key - the summary key, e.g. `skipped`.
 * @returns the number, or `undefined` when the line is absent.
 */
const summary = (output, key) => {
  const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))
  return match === null ? undefined : Number(match[1])
}

const { code, output } = await runSuite()

const tests = summary(output, 'tests')
const failed = summary(output, 'fail')
const skipped = summary(output, 'skipped')

if (tests === undefined || failed === undefined || skipped === undefined) {
  console.error('could not read the suite summary; the runner did not emit TAP')
  process.exit(1)
}

if (skipped > 0) {
  const names = output
    .split('\n')
    .filter((line) => line.includes('# SKIP'))
    .map((line) => `  ${line.trim()}`)
  console.error(
    `error: ${skipped} of ${tests} cases skipped, so the contracts they pin were never checked\n`
    + `${names.join('\n')}\n\n`
    + 'A skip means the DSH packages did not resolve. Install the pinned devDependencies '
    + '(`pnpm install --frozen-lockfile`) before running this audit.',
  )
  process.exit(1)
}

if (failed > 0 || code !== 0) {
  console.error(`error: ${failed} of ${tests} cases failed`)
  process.exit(1)
}

console.log(`ok: ${tests} cases ran, none skipped`)
