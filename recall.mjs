#!/usr/bin/env node
/**
 * Read the session's own record, and find out where a "fact" came from.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a conversation is compacted, what survives is a SUMMARY - chosen, compressed and written by
 * the assistant. The full record is not deleted; it stays in the session transcript. But nothing
 * points at it, so a fact that arrived through a summary looks exactly like a fact that was
 * measured, and gets acted on as though it were one.
 *
 * The session this came out of had been compacted 28 times, and nothing anywhere said so. One of
 * its summaries carried a version number and the words "still pending". Both were wrong - the
 * thing had already shipped - and the claim survived several more compactions, was written into
 * plans, and was repeated for hours before anyone thought to check it.
 *
 * Tracing it afterwards took one command, and showed zero occurrences in the record before the
 * summary that asserted it. The number had never been measured. It had been inherited.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It builds no index and caches nothing. A 467-million-character transcript searches in about a
 * second, so a stored summary of it would buy nothing measurable and would go stale - which is the
 * exact failure this exists to prevent. It also never judges whether a claim is TRUE; it shows
 * where the claim entered and leaves the judgement to a person, because a tool that confidently
 * answers a question it cannot actually answer is the disease, not the cure.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const NL = String.fromCharCode(10)

/**
 * The transcript being written right now.
 *
 * By modification time rather than by deriving the project folder from the working directory: that
 * folder is a slug of the path whose casing is not consistent (`C--Users-Admin` sits beside
 * `d--Projects-...`), and a wrong guess reads somebody else's session. The live transcript is the
 * one being appended to, which is a fact rather than a convention.
 */
function liveTranscript(explicit) {
  if (explicit) return explicit
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) throw new Error('No transcripts at ' + root)
  let best = null
  for (const dir of readdirSync(root)) {
    const d = join(root, dir)
    let st
    try { st = statSync(d) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(d, f)
      const s = statSync(p)
      if (!best || s.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: s.mtimeMs }
    }
  }
  if (!best) throw new Error('No .jsonl transcript under ' + root)
  return best.path
}

/** The whole file, once. Everything below works off this. */
function load(path) {
  const text = readFileSync(path, 'utf8')
  return { text, lines: text.split(NL) }
}

function textOf(entry) {
  const c = entry && entry.message && entry.message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
  return ''
}

/** The compaction boundaries, and what each summary carried. */
function compactions(lines, withText) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l || l.indexOf('"isCompactSummary"') < 0) continue
    let d
    try { d = JSON.parse(l) } catch { continue }
    if (!d.isCompactSummary) continue
    const t = textOf(d)
    out.push({ line: i + 1, when: d.timestamp || '', chars: t.length, text: withText ? t : '' })
  }
  return out
}

/**
 * Sentences in a summary that assert a checkable fact.
 *
 * This is a HEURISTIC and it is meant to be one: it produces a starting list, never a verdict. The
 * shapes it looks for are the ones that went wrong in practice - a version number, a count, and the
 * words that quietly turn a past observation into a present-tense claim ("still", "remains",
 * "pending", "already"). A sentence it misses is not cleared; a sentence it flags is not guilty.
 */
function claimSentences(text) {
  const SHAPES = [
    { name: 'version', re: /\bv?\d+\.\d+(\.\d+)?\b/ },
    { name: 'state', re: /\b(still|remains?|pending|not yet|already|never|unchanged|outstanding)\b/i },
    { name: 'count', re: /\b\d{1,6}\s+(of|out of)\s+\d{1,6}\b|\b\d{2,6}\s+(tests?|files?|screens?|rows?|commits?|devices?)\b/i },
    { name: 'done', re: /\b(is|are|was|were)\s+(done|built|deployed|published|fixed|complete|live)\b/i },
  ]
  const out = []
  // Split on sentence ends and on list-item boundaries: summaries are mostly bullets.
  for (const raw of text.split(/(?:\r?\n)+|(?<=[.!?])\s+/)) {
    const s = raw.replace(/\s+/g, ' ').trim().replace(/^[-*\d.)\s]+/, '')
    if (s.length < 25 || s.length > 240) continue
    const tags = SHAPES.filter((sh) => sh.re.test(s)).map((sh) => sh.name)
    if (tags.length === 0) continue
    out.push({ text: s, tags })
  }
  return out
}

/**
 * The most distinctive run of words in a sentence - what to hand to `trace`.
 *
 * Markdown and quotes are stripped first. A summary is written in markdown, so a phrase lifted from
 * it carries `**` and backticks that are not in the underlying record - and an embedded double
 * quote would break the shell command this is printed as. Both were found by running it.
 */
function tracePhrase(sentence) {
  const clean = sentence.replace(/[*`"]/g, '').replace(/\s+/g, ' ').trim()
  const words = clean.split(' ').filter(Boolean)
  // Long enough to be unique, short enough to survive re-wording between summaries.
  const n = Math.min(8, words.length)
  let best = words.slice(0, n).join(' ')
  for (let i = 0; i + n <= words.length; i++) {
    const w = words.slice(i, i + n)
    // Prefer a window that carries a number: that is the part that is checkable.
    if (/\d/.test(w.join(' '))) { best = w.join(' '); break }
  }
  return best.replace(/^[^\w]+|[^\w.)%]+$/g, '')
}

/** The human's own messages - the natural boundaries of what was asked for. */
function humanTurns(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l || l.indexOf('"type":"user"') < 0) continue
    let d
    try { d = JSON.parse(l) } catch { continue }
    if (d.type !== 'user' || d.isCompactSummary) continue
    const c = d.message && d.message.content
    let text = null
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      // A tool result is recorded as a user message too. It is not something a person said.
      if (c.some((b) => b && b.type === 'tool_result')) continue
      text = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
    }
    if (!text || !text.trim()) continue
    if (text.trimStart().startsWith('<system-reminder>')) continue
    out.push({ line: i + 1, when: d.timestamp || '', text: text.trim().replace(/\s+/g, ' ') })
  }
  return out
}

/** Offset -> line number, built once so many hits cost no more than one. */
function lineIndex(text) {
  const starts = [0]
  let i = text.indexOf(NL)
  while (i >= 0) { starts.push(i + 1); i = text.indexOf(NL, i + 1) }
  return (off) => {
    let lo = 0, hi = starts.length - 1, ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid] <= off) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans + 1
  }
}

/** Every byte-exact occurrence of a term. */
function occurrences(text, term, cap) {
  const lineOf = lineIndex(text)
  const hits = []
  let from = 0
  while (hits.length < (cap || 400)) {
    const i = text.indexOf(term, from)
    if (i < 0) break
    from = i + term.length
    hits.push({ off: i, line: lineOf(i) })
  }
  return hits
}

const args = process.argv.slice(2)
const cmd = args[0]
const fileArg = args.indexOf('--file') >= 0 ? args[args.indexOf('--file') + 1] : null
const path = liveTranscript(fileArg)
const say = (s) => console.log(s === undefined ? '' : s)

const COMMANDS = {}

COMMANDS.compactions = {
  use: "compactions",
  blurb: "how many times this session was compacted, and when",
  run() {
  const { lines } = load(path)
  const cs = compactions(lines)
  say(path)
  say()
  if (cs.length === 0) {
    say('  Never compacted. Everything in context arrived first-hand.')
  } else {
    say('  Compacted ' + cs.length + ' time(s). Everything you "remember" from before the last one')
    say('  reached you through a summary somebody wrote, not through the record.')
    say()

    // The most recent few, not all of them. A long session produces dozens, and printing every
    // one scrolls the count - the only number that matters here - off the top of the terminal.
    // `recall compactions all` prints the lot.
    const all = args[1] === 'all'
    const shown = all ? cs : cs.slice(-6)
    if (shown.length < cs.length) {
      say('    ... ' + (cs.length - shown.length) + ' earlier, back to ' +
          cs[0].when.slice(0, 10) + '    (recall compactions all)')
    }
    for (const c of shown) {
      say('    #' + String(cs.indexOf(c) + 1).padStart(2) + '  line ' + String(c.line).padStart(7) +
          '  ' + c.when.slice(0, 16).replace('T', ' ') +
          '  summary of ' + c.chars.toLocaleString('en-US') + ' chars')
    }
    say()
    say('  ' + cs.reduce((n, c) => n + c.chars, 0).toLocaleString('en-US') +
        ' characters of summary have stood in for the record so far.')
  }
  },
}

COMMANDS.errors = {
  use: "errors",
  blurb: "mechanical failures in this record - the ones a hook could refuse",
  run() {
  /**
   * Count the mechanical failures in your own record.
   *
   * Not "mistakes" in general - only the ones a machine can recognise from the error it produced,
   * and therefore the only ones a hook could have refused before they happened. Each is a wasted
   * round-trip: a command that could not have worked, sent anyway.
   */
  const PATTERNS = [
    ['SyntaxError', 'a script that could not parse'],
    ['command not found', 'a command that is not on this machine'],
    ["No such file or directory: '/tmp/", '/tmp meaning two different places'],
    ['unexpected EOF while looking for matching', 'unbalanced quoting in a shell command'],
    ['String to replace not found', 'an Edit whose text was not in the file'],
    ['unterminated string literal', 'a backslash inside a Python string'],
    ['is not a valid statement separator', '&& in Windows PowerShell'],
    ['ModuleNotFoundError', 'a Python import that is not installed'],
    ['is not recognized as the name of a cmdlet', 'a unix command typed into PowerShell'],
  ]
  const { text } = load(path)
  say(path)
  say()
  say('  Mechanical failures in this record - each one a round-trip that could not have worked:')
  say()
  let total = 0
  const rows = PATTERNS.map(([p, what]) => {
    let n = 0, from = 0
    for (;;) { const i = text.indexOf(p, from); if (i < 0) break; n++; from = i + p.length }
    total += n
    return { p, what, n }
  }).sort((a, b) => b.n - a.n)
  for (const r of rows) {
    if (r.n === 0) continue
    say('    ' + String(r.n).padStart(6) + '   ' + r.what)
    say('             ' + r.p)
  }
  say()
  say('    ' + String(total).padStart(6) + '   in total')
  say()
  say('  Every one of these is recognisable before the command runs, which is what hooks/guard.mjs')
  say('  refuses. Counting them here rather than quoting somebody else\'s number: yours are the')
  say('  ones that matter, and they are the argument for installing the guards or not.')
  say()
  say('  (Some hits are the error being discussed rather than thrown - this counts text, not events.)')
  },
}

COMMANDS.claims = {
  use: "claims [n] [max]",
  blurb: "what a summary asserts, each with a ready-made trace",
  run() {
  const { lines } = load(path)
  const cs = compactions(lines, true)
  say(path)
  say()
  if (cs.length === 0) {
    say('  Never compacted, so nothing in your context was inherited. Nothing to check.')
  } else {
    const which = Number(args[1]) || cs.length
    const c = cs[Math.max(0, Math.min(cs.length, which) - 1)]
    const found = claimSentences(c.text)
    say('  Summary #' + which + ' of ' + cs.length + ', line ' + c.line + ', ' +
        c.when.slice(0, 16).replace('T', ' ') + ', ' + c.chars.toLocaleString('en-US') + ' chars.')
    say('  ' + found.length + ' sentence(s) in it assert something checkable.')
    say()
    say('  This is a starting list, not a verdict: a sentence here is not wrong, and one that is')
    say('  missing is not cleared. Trace the ones your next decision depends on.')
    say()
    found.slice(0, Number(args[2]) || 15).forEach((f, i) => {
      say('  ' + String(i + 1).padStart(2) + '. [' + f.tags.join(',') + '] ' + f.text.slice(0, 150))
      say('      recall trace "' + tracePhrase(f.text) + '"')
      say()
    })
    if (found.length > (Number(args[2]) || 15)) {
      say('  ... ' + (found.length - (Number(args[2]) || 15)) + ' more; pass a count: recall claims ' + which + ' 40')
    }
  }
  },
}

COMMANDS.trace = {
  use: "trace \"<text>\"",
  blurb: "where did this fact enter? the record, or only a summary?",
  run() {
  const term = args[1]
  if (!term) { console.error('usage: recall trace "<exact text>"'); process.exit(2) }
  const { text, lines } = load(path)
  const summaryLines = new Set(compactions(lines).map((c) => c.line))
  const hits = occurrences(text, term)

  say(path)
  say()
  if (hits.length === 0) {
    say('  "' + term + '" does not appear in the record at all.')
    say('  If something in your context asserts it, that assertion is its only source.')
  } else {
    const inSummary = hits.filter((h) => summaryLines.has(h.line))
    const inRecord = hits.filter((h) => !summaryLines.has(h.line))
    say('  "' + term + '" - ' + hits.length + ' occurrence(s): ' +
        inRecord.length + ' in the record, ' + inSummary.length + ' inside compaction summaries.')
    say()

    if (inSummary.length === 0) {
      say('  Never carried by a summary. It is in the record itself, first at line ' +
          inRecord[0].line + '.')
      say('  Read it with:  recall around ' + inRecord[0].line)
      say('  and ask whether it was MEASURED there, or merely written down.')
    } else {
      // The question worth asking is not "does it appear" but "was it in the record BEFORE a
      // summary asserted it". A summary that is the earliest source is a summary that invented,
      // or inherited, the claim - and everything after it is repetition, not evidence.
      const firstSummary = inSummary[0].line
      const earlier = inRecord.filter((h) => h.line < firstSummary)
      say('  First stated in a compaction summary at line ' + firstSummary + '.')
      say('  Occurrences in the record BEFORE that: ' + earlier.length)
      say()
      if (earlier.length === 0) {
        say('  THE SUMMARY IS THE ORIGIN. Nothing in the record measured this before a summary')
        say('  asserted it, so there is no evidence behind it in this session. Measure it now')
        say('  rather than repeating it.')
      } else {
        say('  It was in the record first, earliest at line ' + earlier[0].line + '.')
        say('  Read it with:  recall around ' + earlier[0].line)
        say('  and ask whether it was MEASURED there, or merely written down.')
      }
      const later = inRecord.filter((h) => h.line > firstSummary)
      if (later.length) {
        say()
        say('  (' + later.length + ' occurrence(s) after the summary - repetition, and possibly this')
        say('  very command: your own search lands in the record too.)')
      }
    }
  }
  },
}

COMMANDS.turns = {
  use: "turns [n]",
  blurb: "the last n things the operator asked for, with line numbers",
  run() {
  const limit = Number(args[1]) || 40
  const { lines } = load(path)
  const turns = humanTurns(lines)
  say(path)
  say(turns.length + ' things the operator asked for; newest ' + Math.min(limit, turns.length) + ':')
  say()
  for (const t of turns.slice(-limit)) {
    say('  line ' + String(t.line).padStart(7) + '  ' + t.when.slice(0, 16).replace('T', ' ') +
        '  ' + t.text.slice(0, 110))
  }
  },
}

COMMANDS.find = {
  use: "find \"<text>\"",
  blurb: "every byte-exact occurrence, with surrounding context",
  run() {
  const term = args[1]
  if (!term) { console.error('usage: recall find "<exact text>"'); process.exit(2) }
  const pad = Number(args[2]) || 90
  const { text } = load(path)
  const hits = occurrences(text, term, 30)
  say(path)
  say('"' + term + '" - ' + hits.length + (hits.length >= 30 ? '+' : '') + ' occurrence(s)')
  say()
  for (const h of hits) {
    const s = text.slice(Math.max(0, h.off - pad), h.off + term.length + pad).replace(/\s+/g, ' ')
    say('  line ' + String(h.line).padStart(7) + '  ...' + s + '...')
  }
  if (hits.length === 0) say('  Not in the record.')
  },
}

COMMANDS.around = {
  use: "around <line>",
  blurb: "what was being worked on near that point",
  run() {
  const target = Number(args[1])
  if (!target) { console.error('usage: recall around <line>'); process.exit(2) }
  const { lines } = load(path)
  const turns = humanTurns(lines)
  const before = turns.filter((t) => t.line <= target).slice(-3)
  const after = turns.filter((t) => t.line > target).slice(0, 2)
  say(path)
  say('what was being asked for around line ' + target + ':')
  say()
  for (const t of before.concat(after)) {
    say('  ' + (t.line <= target ? ' ' : '>') + ' line ' + String(t.line).padStart(7) +
        '  ' + t.when.slice(0, 16).replace('T', ' ') + '  ' + t.text.slice(0, 110))
  }
  },
}

/**
 * One table, so a command that exists is listed and a listed command exists.
 *
 * The help used to be written out separately, and drifted the first time commands were added: two
 * of them worked and appeared nowhere. Generating it from the same object the dispatch reads makes
 * that impossible rather than unlikely.
 */
function help() {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.use.length)) + 2
  say('recall - read this session\'s own record, so an inherited "fact" can be checked.')
  say()
  for (const c of Object.values(COMMANDS)) say('  recall ' + c.use.padEnd(width) + c.blurb)
  say()
  say('  --file ' + '<path>'.padEnd(width) + 'an older transcript instead of the live one')
  say()
  say('Nothing is written and nothing is cached; the record is searched directly.')
}

const chosen = COMMANDS[cmd]
if (chosen) chosen.run()
else help()
