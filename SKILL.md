---
name: session-recall
description: Use when a fact arrived through a compaction summary rather than from something you measured this turn - versions, counts, "still pending", "already done", "last deployed on", anything inherited from earlier context. Reads the session's own transcript to show where the claim entered, so it can be checked instead of repeated. Also use when picking up a long-running session, when you cannot remember what was decided earlier, or when the user says "check this first".
---

# Session Recall

## The failure this exists for

When a conversation is compacted, what survives into the next context window is a **summary**:
chosen, compressed and written by the assistant. The full record is not deleted — it stays in the
session transcript on disk — but nothing points at it.

So a fact that arrived through a summary is **indistinguishable** from one that was measured. It
reads the same, it is stated with the same confidence, and it is acted on the same way. Repeat that
through several compactions and a claim nobody ever checked becomes something everybody believes —
written into plans, carried into the next summary, and repeated until somebody says "check this".

## The rule

**A fact you did not measure this session is a claim until you check it.** Especially:

- version numbers, counts, sizes, dates
- "still pending", "already done", "not built yet", "last deployed on…"
- anything phrased as settled that you cannot point at a command for

Check it one of two ways, and the first is usually better:

1. **Measure it again.** If it can be read off the running system in one command, read it.
2. **Trace it.** `trace "<the claim>"` says whether the record contained it before a summary
   asserted it. Zero occurrences before the summary means the summary is the origin.

## Using it

```bash
node ~/.claude/skills/session-recall/recall.mjs compactions
node ~/.claude/skills/session-recall/recall.mjs claims
node ~/.claude/skills/session-recall/recall.mjs trace "<a phrase from the summary>"
node ~/.claude/skills/session-recall/recall.mjs around <line>
```

| | |
|---|---|
| `compactions` | how many times this session was compacted, when, and how much each summary carried |
| `claims [n] [max]` | what summary *n* asserts that can be checked, each with a ready-made `trace` |
| `trace "<text>"` | **the important one** — did the record contain this before a summary claimed it? |
| `turns [n]` | the last n things the user asked for, with transcript line numbers |
| `find "<text>"` | every byte-exact occurrence, with surrounding context |
| `around <line>` | what was being worked on near that point |

It finds the live transcript itself — the `.jsonl` being appended to under `~/.claude/projects/` —
so no path has to be supplied. `--file <path>` reads an older session instead.

**Start with `claims` when you do not know what to check.** It reads the latest summary and lists
what it asserts, printing the `trace` command for each. That removes the need to guess which phrase
to search for.

## Three things to know before trusting the output

**`claims` is a heuristic.** It looks for version numbers, counts, and the words that turn a past
observation into a present-tense claim — *still*, *remains*, *pending*, *already*. A sentence it
flags is not guilty; a sentence it misses is not cleared. It gives you somewhere to start.

**Trace a claim, not a token.** A bare version string can return hundreds of hits from code comments
and build files, and tells you almost nothing. Trace the distinctive phrase that carries the
assertion — `claims` builds that phrase for you.

**Your own searching lands in the record.** Running `trace` writes that command into the transcript,
so occurrences *after* the summary can include the query itself. The output separates before and
after for exactly this reason — only the "before" count is evidence.

## The guards beside it

`hooks/guard.mjs` is a PreToolUse hook, not part of this skill's instructions, and the distinction
is the point. Everything it refuses was already covered by a rule that was present and broken
anyway — `&&` in PowerShell sits in the tool description on every request. **A rule has to be
applied; a hook does not.**

It refuses `/tmp` paths that cross between Git Bash and a Windows-native interpreter, a backslash
before a quote in a Python heredoc, `&&`/`||` in Windows PowerShell, and an `Edit` whose text is not
in the file (naming whether it is line endings, indentation, or a block that has changed).

The user installs it with `node hooks/install-hooks.mjs` — not you. Writing hook and permission
settings is refused, and that is correct: a limit on your own behaviour is not yours to install.

## What it deliberately is not

**It builds no index and caches nothing.** A transcript of several hundred million characters
searches in about two seconds, so a stored summary of it would buy nothing measurable and would go
stale — which is the exact failure this skill exists to prevent. Reading the record directly cannot
be out of date.

**It never says whether a claim is true.** It says where the claim entered. A tool that confidently
answers a question it cannot actually answer is the disease, not the cure — and the transcript
proves what was *said*, never what is *true now*. Where the running system can be asked, ask the
running system; use this to find out whether anyone ever did.
