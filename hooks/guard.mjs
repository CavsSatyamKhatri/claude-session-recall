#!/usr/bin/env node
/**
 * Stop the mistakes that were already written down and made anyway.
 *
 * WHY A HOOK AND NOT INSTRUCTIONS
 * -------------------------------
 * Every failure below was already covered by a rule the assistant had in front of it. The
 * PowerShell one is the clearest: "`&&` is not available" sits in the tool description on every
 * single request, and it was broken anyway. So the problem is not that the rule is missing or hard
 * to find - it is that a rule depends on being applied, and attention is not reliable.
 *
 * A hook does not depend on attention. It runs outside the assistant's judgement, before the tool
 * call, and refuses. That is the whole reason this is a hook rather than more words in a skill.
 *
 * MEASURED, NOT GUESSED
 * ---------------------
 * Counts from one long Claude Code session's own transcript (467 million characters):
 *
 *     SyntaxError                                135
 *     command not found                          124
 *     No such file or directory: '/tmp/           56
 *     unexpected EOF while looking for matching   52
 *     String to replace not found                 49
 *     unterminated string literal                 48
 *     is not a valid statement separator           6
 *
 * Roughly 470 round-trips spent on mistakes a few lines of pattern matching can refuse. Each guard
 * below names the count it is there for; if a guard cannot point at a number, it should not exist.
 *
 * SAFETY
 * ------
 * A hook that throws could block every tool call, so everything here is wrapped and the default is
 * always to allow. A guard that is unsure says nothing.
 */

import { readFileSync } from 'node:fs'

const IS_WINDOWS = process.platform === 'win32'

/** Deny with a reason the assistant can act on. Anything else allows. */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function allow() {
  process.stdout.write(JSON.stringify({}))
  process.exit(0)
}

/**
 * `/tmp` is not one place. (56 failures)
 *
 * Git Bash resolves `/tmp` inside its own installation; a Windows-native `python`/`node` resolves
 * the same string to `C:\tmp`. So a file written by one and read by the other is simply not there,
 * and the error arrives as `FileNotFoundError`, several seconds later, pointing at a path that
 * looks perfectly correct.
 */
function tmpCrossesInterpreters(cmd) {
  if (!IS_WINDOWS) return null
  if (!/\/tmp\//.test(cmd)) return null
  if (!/\b(python3?|node)\b/.test(cmd)) return null
  return 'This command writes or reads /tmp AND runs python or node. Those are two different ' +
    'places on Windows: Git Bash resolves /tmp inside its own install, a Windows-native ' +
    'interpreter resolves it to C:\\tmp. The file will not be found. Use a path both agree on - ' +
    'the session scratchpad directory, or $env:TEMP / %TEMP% - and pass it explicitly.'
}

/**
 * A lone backslash inside a Python string. (48 failures, part of 135 SyntaxErrors)
 *
 * Writing `'\'` or `.replace('\','/')` in a heredoc body is an unterminated string literal, and
 * `'\r'`-style sequences inside a non-raw string silently become the control character rather than
 * the two characters that were meant. Both were hit repeatedly while editing Windows paths.
 */
function pythonBackslashInString(cmd) {
  if (!/\bpython3?\b[^|]*<<'?\w+'?/.test(cmd)) return null
  // A backslash immediately before a closing quote is the shape that breaks.
  if (!/\\['"]/.test(cmd)) return null
  return 'This Python heredoc contains a backslash directly before a quote. In a non-raw string ' +
    "that is an unterminated literal or a silent escape - `'\\'` and `.replace('\\','/')` both " +
    'fail this way. Use chr(92) for a literal backslash, or a raw string (r\'...\'), or avoid the ' +
    'question: paths in this transcript format already use forward slashes.'
}

/**
 * `&&` in Windows PowerShell 5.1. (6 failures)
 *
 * Pipeline chain operators arrived in PowerShell 7. In 5.1 this is a parser error before anything
 * runs, and the message ("The token '&&' is not a valid statement separator in this version") does
 * not say what to use instead.
 */
function powershellChain(cmd) {
  if (!/&&|\|\|/.test(cmd)) return null
  return 'Windows PowerShell 5.1 has no && or || - they are a parser error before anything runs. ' +
    'Use `;` to run unconditionally, or `if ($?) { ... }` to run only when the previous command ' +
    'succeeded. If you are handing this to a person to paste, run it yourself first.'
}

/**
 * The text being replaced is not in the file. (49 failures)
 *
 * An Edit that does not match is a whole round-trip spent learning that something invisible
 * differed - almost always line endings or leading whitespace. That is checkable before the call,
 * and the reason can be named instead of guessed at.
 */
function editWillNotMatch(input) {
  const { file_path: file, old_string: oldStr } = input || {}
  if (!file || typeof oldStr !== 'string' || oldStr === '') return null
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }   // a new file is not our business
  if (text.includes(oldStr)) return null

  // It does not match. Say WHY, because "not found" alone is what wasted the round-trip.
  const why = []
  if (text.replace(/\r\n/g, '\n').includes(oldStr.replace(/\r\n/g, '\n'))) {
    why.push('line endings differ (the file has CRLF, or the search text does)')
  }
  const squash = (s) => s.replace(/[ \t]+/g, ' ').trim()
  if (!why.length && squash(text).includes(squash(oldStr))) {
    why.push('the text is there but the indentation or spacing differs')
  }
  const firstLine = oldStr.split('\n')[0].trim()
  if (!why.length && firstLine.length > 8 && text.includes(firstLine)) {
    why.push('the first line matches but the rest does not - the block has changed since it was read')
  }
  if (!why.length) why.push('no part of it is in the file - wrong file, or it was already changed')

  return 'This Edit will not match: ' + why[0] + '. Read the exact bytes first ' +
    '(Read, or grep with -n) and copy the target from what the file actually contains. ' +
    'File: ' + file
}

let raw = ''
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw || '{}')
    const tool = payload.tool_name || ''
    const input = payload.tool_input || {}
    const cmd = typeof input.command === 'string' ? input.command : ''

    let reason = null
    if (tool === 'Bash') {
      reason = tmpCrossesInterpreters(cmd) || pythonBackslashInString(cmd)
    } else if (tool === 'PowerShell') {
      reason = (IS_WINDOWS ? powershellChain(cmd) : null) || tmpCrossesInterpreters(cmd)
    } else if (tool === 'Edit' || tool === 'MultiEdit') {
      reason = editWillNotMatch(input)
    }

    if (reason) deny(reason)
    allow()
  } catch {
    // A guard that is unsure says nothing. Blocking every tool call because this script has a bug
    // would be far worse than the mistakes it is here to prevent.
    allow()
  }
})
