#!/usr/bin/env node
/**
 * Run the three commands that tell the story, with the pauses a viewer needs.
 *
 * This exists so a recording does not depend on somebody typing accurately while being filmed. It
 * prints each command as if it had been typed, waits long enough to read the output, and stops.
 *
 *     node demo.mjs            # normal pace, about 40 seconds
 *     node demo.mjs --fast     # half the pauses, for a shorter GIF
 *
 * Nothing here is special to the recording: it runs the real commands against your real transcript,
 * so what is filmed is what a viewer will get.
 */

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RECALL = join(HERE, 'recall.mjs')
const FAST = process.argv.includes('--fast')
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

function run(args, hold) {
  type(shown(args))
  const r = spawnSync(process.execPath, [RECALL, ...args], { encoding: 'utf8' })
  process.stdout.write(r.stdout || r.stderr || '')
  wait(hold)
}

// 1. The thing nobody knows is happening.
run(['compactions'], 4500)

// 2. What the latest summary is asserting - the reader's own list, not somebody else's.
run(['claims', '', '3'], 5000)

// 3. The question that matters - shown on a claim where the answer is interesting.
//
// The first suggestion is often a claim that WAS measured, and tracing that proves the tool works
// but shows nothing worth watching. So try them in order and stop at the first one the record does
// not support. If every one of them is well-founded, that is a good session and the last result is
// shown as it is: a demo that manufactures a failure would be worse than a dull one.
const claims = spawnSync(process.execPath, [RECALL, 'claims'], { encoding: 'utf8' }).stdout || ''
const suggestions = [...claims.matchAll(/recall trace "([^"]+)"/g)].map((m) => m[1])

let chosen = suggestions[0]
for (const s of suggestions.slice(0, 8)) {
  const out = spawnSync(process.execPath, [RECALL, 'trace', s], { encoding: 'utf8' }).stdout || ''
  if (out.includes('THE SUMMARY IS THE ORIGIN')) { chosen = s; break }
}
run(['trace', chosen || 'still pending'], 6000)

process.stdout.write('\n')
