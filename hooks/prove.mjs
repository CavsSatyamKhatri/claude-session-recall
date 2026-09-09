#!/usr/bin/env node
/**
 * Prove each guard fires, and that ordinary work does not.
 *
 * A guard that cannot be seen to refuse is not a guard, and one that refuses the wrong thing is
 * worse than none - it gets switched off within a week and takes the working guards with it. So
 * every case below is run for real against `guard.mjs`, and the allow cases matter as much as the
 * deny cases.
 */

import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs')

function ask(payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [GUARD], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (c) => { out += c })
    p.on('close', () => {
      let d = {}
      try { d = JSON.parse(out || '{}') } catch { /* treated as allow */ }
      const h = d.hookSpecificOutput || {}
      resolve({ denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason || '' })
    })
    p.stdin.write(JSON.stringify(payload))
    p.stdin.end()
  })
}

// A real file, so the Edit guard has something true to check against.
const dir = mkdtempSync(join(tmpdir(), 'guard-proof-'))
const file = join(dir, 'sample.txt')
writeFileSync(file, 'first line\n    indented line\nlast line\n')

const CASES = [
  // --- must be REFUSED -------------------------------------------------------------------------
  { deny: true, name: '/tmp written in bash, read by python',
    p: { tool_name: 'Bash', tool_input: { command: "echo hi > /tmp/x.txt && python3 /tmp/x.txt" } } },
  { deny: true, name: 'python heredoc with a backslash before a quote',
    p: { tool_name: 'Bash', tool_input: { command: "python3 - <<'PY'\nprint('a'.replace('\\','/'))\nPY" } } },
  { deny: true, name: 'PowerShell &&',
    p: { tool_name: 'PowerShell', tool_input: { command: 'git add -A && git commit -m x' } } },
  { deny: true, name: 'Edit whose text is not in the file',
    p: { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'this text was never there' } } },
  // Six spaces where the file has four - deeper, so it cannot accidentally be a substring. Written
  // this way after two wrong attempts: searching with LESS indentation than the file has still
  // matches, because the shorter run of spaces sits inside the longer one. The guard was right both
  // times and the test was wrong, which is the sort of thing only running it tells you.
  { deny: true, name: 'Edit whose indentation differs (6 spaces vs 4)',
    p: { tool_name: 'Edit', tool_input: { file_path: file, old_string: '      indented line\nlast line' } } },

  // --- must be ALLOWED: ordinary work, and near-misses ------------------------------------------
  { deny: false, name: 'bash using /tmp on its own (no python, no node)',
    p: { tool_name: 'Bash', tool_input: { command: 'echo hi > /tmp/x.txt; cat /tmp/x.txt' } } },
  { deny: false, name: 'python heredoc with no backslash at all',
    p: { tool_name: 'Bash', tool_input: { command: "python3 - <<'PY'\nprint('hello')\nPY" } } },
  { deny: false, name: 'PowerShell using ; instead of &&',
    p: { tool_name: 'PowerShell', tool_input: { command: 'git add -A; if ($?) { git commit -m x }' } } },
  { deny: false, name: 'Edit that really does match',
    p: { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'first line' } } },
  { deny: false, name: 'Edit on a file that does not exist yet',
    p: { tool_name: 'Edit', tool_input: { file_path: join(dir, 'nope.txt'), old_string: 'x' } } },
  { deny: false, name: 'an ordinary command',
    p: { tool_name: 'Bash', tool_input: { command: 'git status --short' } } },
]

let bad = 0
console.log('  ' + 'expected'.padEnd(10) + 'got'.padEnd(10) + 'case')
for (const c of CASES) {
  const r = await ask(c.p)
  const ok = r.denied === c.deny
  if (!ok) bad++
  console.log('  ' + (c.deny ? 'deny' : 'allow').padEnd(10) +
              (r.denied ? 'deny' : 'allow').padEnd(10) +
              (ok ? '   ' : '!! ') + c.name)
  if (r.denied && c.deny) console.log('             -> ' + r.reason.split('. ')[0] + '.')
}
console.log()
console.log(bad === 0
  ? '  All ' + CASES.length + ' guard cases behaved as specified.'
  : '  ' + bad + ' of ' + CASES.length + ' did NOT. The guard is not trustworthy until they do.')

// =================================================================================================
// The PostCompact hook.
//
// What can be proved here is the SCRIPT: given a transcript it says the right thing, and given
// nothing worth saying it says nothing at all. What cannot be proved here is the EVENT - a
// compaction is not something a test can cause. That half is answered by
// ~/.claude/session-recall-postcompact.log after the next real one.
//
// The silent cases are not filler. A hook that speaks on every compaction becomes noise, noise gets
// switched off, and it takes the working guards with it - the same reason the allow cases above
// matter as much as the deny cases.
// =================================================================================================

const POST = join(dirname(fileURLToPath(import.meta.url)), 'post-compact.mjs')

/** One transcript line, in the shape recall.mjs reads: a compaction summary carrying `text`. */
const summaryLine = (text) => JSON.stringify({
  isCompactSummary: true,
  timestamp: '2026-09-09T10:00:00.000Z',
  message: { content: [{ type: 'text', text }] },
})

/** An ordinary line, so a fixture can have a record that is not a summary. */
const plainLine = (text) => JSON.stringify({
  timestamp: '2026-09-09T09:00:00.000Z',
  message: { content: [{ type: 'text', text }] },
})

function fixture(name, lines) {
  const p = join(dir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

function runPostCompact(transcript) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [POST, '--file', transcript],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (c) => { out += c })
    p.on('close', () => resolve(out))
  })
}

// Six claimable sentences, so the cap has something to cut. Each matches one of the heuristic's
// shapes - a version, a count, a "still", a "was deployed".
const LOUD = [
  'The player is still on v0.4.6 and the fleet has not been offered it.',
  'The release chore is still pending and nobody has picked it up.',
  'Only 2 of 7 creation sites were fixed, so the bug remains reachable.',
  'The console was deployed on Tuesday and is live.',
  'There are 14 tests failing in the suite.',
  'The migration was already applied to production.',
].join(' ')

const QUIET = 'We talked about the weather and then about lunch, and agreed to speak again.'

const POST_CASES = [
  {
    name: 'a summary full of checkable claims -> injects them',
    file: fixture('loud.jsonl', [plainLine('some work'), summaryLine(LOUD)]),
    speaks: true,
    // The cap is measured on THIS case's output, by name. It used to be measured on whatever spoke
    // last, and breaking the hook on purpose is what exposed that: with the silence rule disabled
    // the empty `quiet` case spoke too, overwrote the captured text, and the cap check reported 0
    // instead of the 6 it was looking at. It still went red, so the suite was right by luck - and a
    // test that is right by luck is the thing this file exists to not be.
    capped: true,
  },
  {
    name: 'a summary that asserts nothing checkable -> silent',
    file: fixture('quiet.jsonl', [plainLine('some work'), summaryLine(QUIET)]),
    speaks: false,
  },
  {
    name: 'a session never compacted -> silent',
    file: fixture('fresh.jsonl', [plainLine('some work'), plainLine('more work')]),
    speaks: false,
  },
]

console.log()
console.log('  ' + 'expected'.padEnd(10) + 'got'.padEnd(10) + 'case')

let postBad = 0
let injected = ''
let capturedFromCappedCase = ''
for (const c of POST_CASES) {
  const out = await runPostCompact(c.file)
  const spoke = out.trim().length > 0
  let ok = spoke === c.speaks

  // Speaking is not enough: it has to be valid hook JSON, aimed at the right event, and carry the
  // ready-made trace command. Output that is merely non-empty would pass a shape test and be
  // useless in a session.
  if (spoke) {
    try {
      const d = JSON.parse(out)
      const h = d.hookSpecificOutput || {}
      injected = h.additionalContext || ''
      if (h.hookEventName !== 'PostCompact') ok = false
      if (!/recall trace "/.test(injected)) ok = false
    } catch { ok = false }
  }

  if (c.capped) capturedFromCappedCase = injected

  if (!ok) postBad++
  console.log('  ' + (c.speaks ? 'speaks' : 'silent').padEnd(10) +
              (spoke ? 'speaks' : 'silent').padEnd(10) +
              (ok ? '   ' : '!! ') + c.name)
}

// The cap, checked on the case that was built to exceed it. Five is a token budget spent on every
// compaction, and a list nobody reads costs the same as one nobody is shown.
const listed = (capturedFromCappedCase.match(/recall trace "/g) || []).length
const capOk = listed > 0 && listed <= 5
if (!capOk) postBad++
console.log('  ' + 'cap<=5'.padEnd(10) + String(listed).padEnd(10) +
            (capOk ? '   ' : '!! ') + 'six claimable sentences are cut to at most five')

console.log()
console.log(postBad === 0
  ? '  All ' + (POST_CASES.length + 1) + ' PostCompact cases behaved as specified.'
  : '  ' + postBad + ' PostCompact case(s) did NOT.')
console.log()
console.log('  Not proved here, and it cannot be: that the PostCompact EVENT fires. Check')
console.log('  ~/.claude/session-recall-postcompact.log after the next real compaction.')

process.exit(bad + postBad === 0 ? 0 : 1)
