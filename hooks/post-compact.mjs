#!/usr/bin/env node
/**
 * Run `claims` the moment a compaction happens, and put the result in front of the assistant.
 *
 * ## Why this exists, when the skill was already installed and documented
 *
 * `SKILL.md` used to say: *use this when a fact arrived through a compaction summary rather than
 * from something you measured.* That trigger is impossible to act on, and the skill's own README
 * says why in its first paragraph — a summarised fact is **indistinguishable** from a measured one.
 * So the instruction asked the assistant to notice exactly the thing it exists because nobody can
 * notice, and the result was measurable: registered, available, documented, and invoked **zero**
 * times across a session of several hundred megabytes.
 *
 * The README already had the answer and applied it only to typos:
 *
 *   > A rule has to be applied, and attention is not reliable. A hook does not need attention.
 *
 * That argument was used for `&&` in PowerShell and for an Edit whose text is not in the file. It
 * was never turned on the skill's own main feature. This is that.
 *
 * ## What it does
 *
 * Compaction fires -> this runs -> the checkable claims in the new summary arrive as context, with
 * the `trace` command for each already written out. No judgement is involved and nothing has to be
 * remembered.
 *
 * ## The three things it deliberately does NOT do
 *
 * - **It never speaks when there is nothing to say.** No compactions, or no sentence that asserts
 *   anything checkable, and it prints nothing at all. A hook that reports "nothing to report" on
 *   every compaction is noise, and noise gets switched off within a week — taking the working
 *   guards with it. That is the README's own warning about the deny cases.
 * - **It caps the list.** Five, not the fifteen `claims` prints for a person at a terminal. This
 *   costs tokens on every compaction, and a wall of text is skimmed exactly like no text at all.
 * - **It never fails the session.** Any error — recall.mjs missing, a transcript that cannot be
 *   read, a spawn that will not start — exits silently with no output. A hook whose purpose is to
 *   improve a session must not be able to end one.
 *
 * ## And it records that it ran
 *
 * PostCompact cannot be triggered on demand, so at install time there is no way to prove it fires —
 * which is the exact shape of "a guard that cannot be seen to refuse". So every run appends one
 * line to `~/.claude/session-recall-postcompact.log`. That turns an unprovable claim into one that
 * can be checked the day after: if the file has lines, it fired.
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RECALL = join(HERE, '..', 'recall.mjs')
const LOG = join(homedir(), '.claude', 'session-recall-postcompact.log')

/** How many claims to carry into context. See the header: this is a token cost on every compaction. */
const MAX = 5

/** Passed through for the tests, which point at a fixture instead of the live transcript. */
const fileArg = process.argv.indexOf('--file') >= 0
  ? process.argv[process.argv.indexOf('--file') + 1]
  : null

function note(what) {
  // Best-effort by design: a log line is a convenience, and failing to write one must not stop the
  // hook from doing its actual job.
  try {
    appendFileSync(LOG, new Date().toISOString() + '  ' + what + '\n')
  } catch { /* ignore */ }
}

/** Silence. Not an error — most of the time there is genuinely nothing to say. */
function quiet(why) {
  note('quiet: ' + why)
  process.exit(0)
}

function main() {
  const args = ['claims', '0', String(MAX)]
  if (fileArg) args.push('--file', fileArg)

  const p = spawn(process.execPath, [RECALL, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })

  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.on('error', () => quiet('recall.mjs could not be started'))

  p.on('close', (code) => {
    if (code !== 0) return quiet('recall.mjs exited ' + code)

    // "Never compacted" is the normal answer early in a session and is not worth a word.
    if (/Never compacted/.test(out)) return quiet('never compacted')

    // `claims` numbers each finding "  1. [tags] ...". No numbered line means the heuristic found
    // nothing assertable, which is a real and common outcome — a summary can be all narrative.
    const found = out.split('\n').filter((l) => /^\s{1,3}\d+\.\s\[/.test(l))
    if (found.length === 0) return quiet('no checkable claims in the newest summary')

    // Keep the ready-made `recall trace "..."` line under each finding: it is the whole point, and
    // it is what makes this actionable rather than merely alarming.
    const body = []
    const lines = out.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/^\s{1,3}\d+\.\s\[/.test(lines[i])) {
        body.push(lines[i].trim())
        if (/recall trace/.test(lines[i + 1] || '')) body.push('   ' + lines[i + 1].trim())
      }
    }

    const context = [
      'This session was just compacted. Everything you now "remember" from before it reached you',
      'through a summary, not through the record — and a summarised fact reads exactly like a',
      'measured one.',
      '',
      'These ' + found.length + ' sentence(s) in that summary assert something checkable:',
      '',
      ...body,
      '',
      'This is a starting list, not a verdict. Before you repeat, plan around, or write any of these',
      'into a document, a commit message or an answer, establish it — ask the running system where',
      'you can, and run the trace above where you cannot.',
    ].join('\n')

    note('injected ' + found.length + ' claim(s)')

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostCompact',
        additionalContext: context,
      },
    }))
  })
}

try {
  main()
} catch (e) {
  quiet('threw: ' + (e && e.message))
}
