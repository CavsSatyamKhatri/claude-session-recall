#!/usr/bin/env node
/**
 * Run the commands that tell the story, with the pauses a viewer needs.
 *
 * This exists so a recording does not depend on somebody typing accurately while being filmed. It
 * prints each command as if it had been typed, waits long enough to read the output, and stops.
 *
 *     node demo.mjs                      # all three steps, about 32 seconds
 *     node demo.mjs --fast               # half the pauses
 *     node demo.mjs --only compactions   # the first step only - shows no work of yours
 *     node demo.mjs --trace "<phrase>"   # trace a phrase you choose rather than one it picks
 *     node demo.mjs --no-redact          # leave your paths in
 *
 * Nothing here is special to the recording: it runs the real commands against your real transcript,
 * so what is filmed is what a viewer will get.
 */

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RECALL = join(HERE, 'recall.mjs')
const ARGV = process.argv.slice(2)
const FAST = ARGV.includes('--fast')
const REDACT = !ARGV.includes('--no-redact')
const ONLY = ARGV.includes('--only') ? ARGV[ARGV.indexOf('--only') + 1] : null
const PHRASE = ARGV.includes('--trace') ? ARGV[ARGV.indexOf('--trace') + 1] : null
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FAST ? ms / 2 : ms)

function type(text) {
  process.stdout.write('\n$ ')
  for (const ch of text) {
    process.stdout.write(ch)
    wait(18)
  }
  process.stdout.write('\n')
  wait(300)
}

/** Show the command the way a viewer would have to type it - quoted where it needs quoting. */
function shown(args) {
  return 'recall ' + args
    .filter((a) => a !== '')
    .map((a) => (/[ "]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))
    .join(' ')
}

/**
 * Take your own name out of the picture.
 *
 * A recording of this runs against YOUR transcript, so the header carries your home directory and
 * the slug of the project you were working in - which is an employer's name as often as not. The
 * replacement is written to look like a placeholder, so nobody mistakes it for real output.
 *
 * The home directory is a PATH and not a pattern: `C:\Users\Admin` handed to RegExp raw turns \U
 * and \A into escapes and matches nothing, which is exactly what happened the first time - the path
 * printed in full while this function claimed to be redacting it. Escape it.
 *
 * It only touches paths. What a summary claimed is your own text and cannot be masked without
 * lying about what the tool does; choose the claim with --trace, or record only `compactions`.
 */
const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const home = process.env.USERPROFILE || process.env.HOME || ''
const HOME_RE = home ? new RegExp(escapeForRegex(home), 'gi') : null

function redact(s) {
  if (!REDACT) return s
  const withHome = HOME_RE ? s.replace(HOME_RE, '~') : s
  return withHome.replace(/(\.claude[\\/]projects[\\/])[^\\/\s]+/gi, '$1<your-project>')
}

function run(args, hold) {
  type(shown(args))
  const r = spawnSync(process.execPath, [RECALL, ...args], { encoding: 'utf8' })
  process.stdout.write(redact(r.stdout || r.stderr || ''))
  wait(hold)
}

// 1. The thing nobody knows is happening. Counts and dates only - no work of yours appears here.
run(['compactions'], 4500)

if (ONLY === 'compactions') process.exit(0)

// 2. What the latest summary is asserting.
//
// This prints YOUR summary's own sentences, and no redaction can fix that without lying about what
// the tool does. If the recording is going somewhere public, either stop at step 1 with
// `--only compactions` or pick a harmless claim with `--trace`.
run(['claims', '', '3'], 5000)

// 3. The question that matters - shown on a claim where the answer is interesting.
//
// The first suggestion is often a claim that WAS measured, and tracing that proves the tool works
// while showing nothing worth watching. So try them in order and stop at the first one the record
// does not support. If every one is well-founded, that is a good session and the last result is
// shown as it is: a demo that manufactured a failure would be worse than a dull one.
let chosen = PHRASE
if (!chosen) {
  const claims = spawnSync(process.execPath, [RECALL, 'claims'], { encoding: 'utf8' }).stdout || ''
  const suggestions = [...claims.matchAll(/recall trace "([^"]+)"/g)].map((m) => m[1])
  chosen = suggestions[0]
  for (const s of suggestions.slice(0, 8)) {
    const out = spawnSync(process.execPath, [RECALL, 'trace', s], { encoding: 'utf8' }).stdout || ''
    if (out.includes('THE SUMMARY IS THE ORIGIN')) { chosen = s; break }
  }
}
run(['trace', chosen || 'still pending'], 6000)

process.stdout.write('\n')
