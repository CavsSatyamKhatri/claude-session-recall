#!/usr/bin/env node
/**
 * Register the guards as PreToolUse hooks.
 *
 * You run this, not the assistant. That is deliberate: a thing whose whole purpose is to put a
 * limit on the assistant's behaviour should not be installed by the assistant. (It also cannot be -
 * writing your permission and hook settings is refused, which is the correct design.)
 *
 * It merges rather than replaces, backs the file up first, and prints exactly what changed. Run it
 * again to update the path; it will not add a second copy.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const GUARD = resolve(join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs'))
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const MATCHER = 'Bash|PowerShell|Edit|MultiEdit'
const command = 'node "' + GUARD + '"'

if (!existsSync(GUARD)) {
  console.error('guard.mjs is not beside this script: ' + GUARD)
  process.exit(1)
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
const pre = hooks.PreToolUse || (hooks.PreToolUse = [])

// Merge: never replace what is already there, and never register twice.
let entry = pre.find((h) => h && h.matcher === MATCHER)
if (!entry) {
  entry = { matcher: MATCHER, hooks: [] }
  pre.push(entry)
}
entry.hooks = entry.hooks || []
const already = entry.hooks.find((h) => h && typeof h.command === 'string' && h.command.includes('guard.mjs'))
if (already) {
  already.command = command
  console.log('  updated the existing guard entry to point at:')
} else {
  entry.hooks.push({ type: 'command', command })
  console.log('  added a PreToolUse guard on ' + MATCHER + ':')
}
console.log('    ' + command)

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
console.log('  To remove it later: delete the entry from ' + SETTINGS + ', or restore the backup.')
