---
name: session-recall
description: Use BEFORE writing a version, count, size, date or status ("still pending", "already deployed", "not built yet") into a document, commit message, plan or an answer to the user - unless you ran the command that produced it in this same turn. Also at the start of any resumed or compacted session, and whenever the user asks "are you sure", "check this first", or challenges something you stated. Reads the session's own transcript and shows whether a claim was ever measured or only inherited from a summary.
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

## Why the trigger above is worded the way it is

*Changed 2026-09-09, after measuring.*

It used to read: *"use when a fact arrived through a compaction summary rather than from something
you measured."* That instruction cannot be followed. This skill's own first paragraph says why — a
summarised fact is **indistinguishable** from a measured one — so the trigger asked you to notice
exactly the thing the skill exists because nobody can notice.

The result was measurable rather than theoretical: installed, available, and invoked **zero** times
across a session of several hundred megabytes, while other skills in the same folder fired normally.
They fire on something observable — "make a page", "add a hook". This one fired on an internal state
with no tell.

So the trigger is now an **event you can see**: you are about to write a number down, or the session
was just resumed. The one that matters most is the first. The failure it was written from was not a
wrong thought — it was `"17 files"`, inherited from a pre-compaction script, typed into a document.
Nothing was wrong until it was written.

## The hooks beside it

Two, and neither is part of these instructions — that distinction is the whole point. Everything
they cover was already covered by a rule that was present and broken anyway: `&&` in PowerShell sits
in the tool description on **every request**. **A rule has to be applied; a hook does not.**

**`hooks/post-compact.mjs` — PostCompact.** Runs `claims` the moment a compaction happens and puts
the new summary's checkable assertions into context, each with its `trace` command already written
out. This is that same argument turned on this skill's own main feature, which it had never been.
It stays silent when there is nothing checkable to report, caps the list at five, and can never fail
a session. It cannot be proved on demand — a compaction is not triggerable — so it logs every run to
`~/.claude/session-recall-postcompact.log`; that file answers "did it fire" the next day.

**`hooks/guard.mjs` — PreToolUse.**

Refuses `/tmp` paths that cross between Git Bash and a Windows-native interpreter, a backslash
before a quote in a Python heredoc, `&&`/`||` in Windows PowerShell, and an `Edit` whose text is not
in the file (naming whether it is line endings, indentation, or a block that has changed).

**The first three fire live in Claude Code** — confirmed 2026-09-10 by making each mistake on
purpose.

**The Edit one fires for some failures and is pre-empted for others**, measured the same day:

- **text simply not in the file** → the harness answers first with its own
  `String to replace not found`, and the guard never speaks. Handed the identical payload directly
  it denies correctly, so it is right and arrives late.
- **text present but the line endings differ** (a CRLF file, an LF search string) → **the guard
  fires**, by name, and names line endings as the cause. That is the more useful message of the two,
  and it is the one you get.

*An earlier note here said the Edit guard never reaches the tool in this harness. That was one
failure shape generalised into all of them.*

The user installs both with `node hooks/install-hooks.mjs` — not you. Writing hook and permission
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
