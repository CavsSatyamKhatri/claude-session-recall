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
  ? '  All ' + CASES.length + ' cases behaved as specified.'
  : '  ' + bad + ' of ' + CASES.length + ' did NOT. The guard is not trustworthy until they do.')
process.exit(bad === 0 ? 0 : 1)
