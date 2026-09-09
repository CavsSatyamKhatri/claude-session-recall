#!/usr/bin/env node
/**
 * Register both hooks: the PreToolUse guards, and the PostCompact claim check.
 *
 * You run this, not the assistant. That is deliberate: a thing whose whole purpose is to put a
 * limit on the assistant's behaviour should not be installed by the assistant. (It also cannot be -
 * writing your permission and hook settings is refused, which is the correct design.)
 *
 * It merges rather than replaces, backs the file up first, and prints exactly what changed. Run it
 * again to update the paths; it will not add a second copy of either.
 *
 * ## The two hooks do different jobs, and only one of them is provable today
 *
 * - `guard.mjs` runs before a tool call and refuses four mechanical mistakes. `prove.mjs` fires
 *   every one of them for real, so it is proved before it is trusted.
 * - `post-compact.mjs` runs after a compaction and puts that summary's checkable claims into
 *   context. `prove.mjs` proves the SCRIPT - given a transcript it produces the right output, and
 *   given nothing to say it stays silent. It cannot prove the EVENT: a compaction is not something
 *   that can be triggered on demand. So the script writes a line to
 *   `~/.claude/session-recall-postcompact.log` every time it runs, and that file answers the
 *   question a day later. Check it; an empty file after a compaction means the matcher is wrong.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SETTINGS = join(homedir(), '.claude', 'settings.json')

/**
 * What gets registered.
 *
 * `file` is what identifies an existing entry on a re-run, so a moved checkout updates its path
 * instead of leaving a stale one beside a new one.
 */
const WANTED = [
  {
    event: 'PreToolUse',
    matcher: 'Bash|PowerShell|Edit|MultiEdit',
    file: 'guard.mjs',
    says: 'refuses four mechanical mistakes before the tool runs',
  },
  {
    // The documented matcher values for a compaction hook are `manual` and `auto`, and matchers are
    // alternations elsewhere (`Write|Edit`), so both are named rather than one being guessed at.
    event: 'PostCompact',
    matcher: 'manual|auto',
    file: 'post-compact.mjs',
    says: "puts the new summary's checkable claims into context",
  },
]

for (const w of WANTED) {
  w.path = resolve(join(HERE, w.file))
  if (!existsSync(w.path)) {
    console.error(w.file + ' is not beside this script: ' + w.path)
    process.exit(1)
  }
  w.command = 'node "' + w.path + '"'
}

if (!existsSync(SETTINGS)) {
  console.error('No settings file at ' + SETTINGS + '. Start Claude Code once, then run this again.')
  process.exit(1)
}

const before = readFileSync(SETTINGS, 'utf8')
let settings
try {
  settings = JSON.parse(before)
} catch (e) {
  console.error('settings.json is not valid JSON, so this will not touch it: ' + e.message)
  process.exit(1)
}

const backup = SETTINGS + '.bak-before-guards'
copyFileSync(SETTINGS, backup)

const hooks = settings.hooks || (settings.hooks = {})

for (const w of WANTED) {
  const list = hooks[w.event] || (hooks[w.event] = [])

  // Merge: never replace what is already there, and never register twice.
  let entry = list.find((h) => h && h.matcher === w.matcher)
  if (!entry) {
    entry = { matcher: w.matcher, hooks: [] }
    list.push(entry)
  }
  entry.hooks = entry.hooks || []

  const already = entry.hooks.find(
    (h) => h && typeof h.command === 'string' && h.command.includes(w.file))

  if (already) {
    already.command = w.command
    console.log('  updated ' + w.event + ' (' + w.matcher + ') - ' + w.says + ':')
  } else {
    entry.hooks.push({ type: 'command', command: w.command })
    console.log('  added ' + w.event + ' (' + w.matcher + ') - ' + w.says + ':')
  }
  console.log('    ' + w.command)
}

writeFileSync(SETTINGS, JSON.stringify(settings, null, 2))

// Say what changed, at the level that matters: nothing else should have moved.
const after = JSON.parse(readFileSync(SETTINGS, 'utf8'))
const beforeParsed = JSON.parse(before)
const keys = (o) => Object.keys(o).sort().join(',')
console.log()
console.log('  top-level keys before : ' + keys(beforeParsed))
console.log('  top-level keys after  : ' + keys(after))
console.log('  permissions untouched : ' +
  (JSON.stringify(beforeParsed.permissions) === JSON.stringify(after.permissions)))
console.log('  backup                : ' + backup)
console.log()
console.log('  Open /hooks in Claude Code once (or restart) so the new configuration is read.')
console.log('  To remove either: delete its entry from ' + SETTINGS + ', or restore the backup.')
console.log()
console.log('  PostCompact cannot be tested on demand. After the next compaction, check:')
console.log('    ' + join(homedir(), '.claude', 'session-recall-postcompact.log'))
console.log('  A line there means it fired. An empty file means the matcher is wrong, not that')
console.log('  there was nothing to say - the script logs its silences too.')
