---
name: waky-waky
description: >
  Aggressive context-restoration ritual for new sessions. Activate on a wide
  range of session-start phrases — "hello", "hi", "hey", "good morning",
  "good evening", "what's up", "let's go", "ready when you are",
  "where were we", "pick up where we left off", "continue", "resume",
  "waky waky", "wake up the swarm", "reincarnate", "reincarnate the swarm",
  "restore context", "codi wake", "codi reincarnate". Loads the user's
  principles file, identity, active handoffs, per-WIP state, people files,
  and recent context so a fresh session never starts cold. Better to
  over-load context than ever miss it — missing context = user frustration.
metadata:
  version: "3.1.0"
  author: "Anand Vallamsetla"
  tier: "continuity"
---

### BEGIN WAKY-WAKY ###
# Waky Waky — Session Reincarnation

**Plugin #12, Continuity tier.** Part of Co-Dialectic v3.1 base plugins (see BASE-PLUGINS-V3.md). Constitution anchor: Session Handoff Protocol; P15 (Multi-Agent — shared state).

## Configuration (env vars — set per user)

This skill reads files from the user's brain layer and workspace. Defaults work for a fresh install; override via env vars if you have an existing layout:

- `COD_BRAIN_DIR` — your principles/governance directory (default: `$HOME/.codialectic`)
- `COD_WORKSPACE_DIR` — your active-work directory with handoffs + WIP (default: `$HOME/codialectic-workspace`)

If neither is set and the defaults don't exist, the skill degrades gracefully: it loads what it can find and reports what was skipped.

## When to activate

Activate on ANY of these triggers — the cost of missing context far exceeds the cost of over-loading:

**Greetings (treat as session-start signals):**
- `hello`, `hi`, `hey`
- `good morning`, `good evening`, `good afternoon`
- `what's up`

**Explicit session-start cues:**
- `let's go`, `ready when you are`, `okay let's start`
- `where were we`, `pick up where we left off`
- `continue`, `resume`, `new session`

**Co-Dialectic-namespaced (power-user):**
- `waky waky`
- `reincarnate`, `reincarnate the swarm` ← maintainer's primary trigger
- `welcome back` ← maintainer's primary trigger
- `wake up the swarm`
- `restore context`
- `codi wake`, `codi reincarnate`

If a greeting fires this skill but the user clearly wants something else (e.g., they say "hi" and immediately ask a specific question), load context silently in the background and answer their actual question — do NOT block on a status block. The status block is for explicit-trigger cases; greetings get silent hydration + direct answer.

## What to do

On trigger, load the FULL context set below. Read each file (silently — no need to dump contents to the user). Then confirm with a compact status line showing what loaded and what was skipped.

### Tier 1 — Principles + Identity (ALWAYS load)

1. `$COD_BRAIN_DIR/CONSTITUTION.md` — your governance/principles file
2. `$COD_WORKSPACE_DIR/.cod/memory/identity.md` — who the user is
3. `$COD_WORKSPACE_DIR/.cod/memory/professional-brand.md` — brand statement

### Tier 2 — Active state (load if present)

4. `$COD_WORKSPACE_DIR/NEXT_SESSION_HANDOFF.md` — root cross-agent relay
5. `$COD_WORKSPACE_DIR/.cod/memory/career-strategy.md` — active arc (if exists)
6. `$COD_WORKSPACE_DIR/workspace.manifest.yaml` — workstream routing map

### Tier 3 — Per-WIP handoffs (glob-load)

7. `$COD_WORKSPACE_DIR/WIP/*/NEXT_SESSION_HANDOFF.md` — every per-workstream handoff
8. `$COD_WORKSPACE_DIR/WIP/*-product/NEXT_SESSION_HANDOFF.md` — every per-product handoff

### Tier 4 — Index-first awareness (ALWAYS scan; deep-load on demand only)

The goal is knowing **what exists**, not reading everything. Loading every people/company/draft file would overflow context for no benefit. Instead:

**Always read (canonical indices — small, high-value):**
- `$COD_WORKSPACE_DIR/.cod/memory/MEMORY.md` — auto-memory index pointing to all stored memories
- `$COD_WORKSPACE_DIR/INPUT/INDEX.md` if it exists, else just `ls $COD_WORKSPACE_DIR/INPUT/` for a filename listing

**Always inventory (filenames only — no content):**
- `ls $COD_WORKSPACE_DIR/.cod/memory/people/` → record the list of slugs that exist
- `ls $COD_WORKSPACE_DIR/.cod/memory/companies/` → record the list of slugs that exist
- `ls $COD_WORKSPACE_DIR/WIP/` → record the list of WIP folder names

**Deep-load (full file content) ONLY when:**
- The trigger utterance names a specific person, company, or WIP → deep-load the matching `<slug>.md`
- A loaded handoff or memory entry references a file by name → deep-load that file
- The user's first request after activation references something on the inventory

This index-first pattern keeps context light while giving the agent the awareness to say "yes, I know about Sahar Kleinman — let me load her file" or "I see we have an INPUT/alumni-conference-followups draft — should I open it?" The knowledge of existence is in scope; the contents are lazy.

Skip any file that does not exist. Never fabricate contents for a missing file.

## Confirmation output

After loading, print this compact status block (no fluff, no recap of file contents):

```
Co-Dialectic · Waky Waky — context restored.
  Principles: loaded (or "skipped — not found")
  Identity: loaded
  Root handoff: loaded (last updated: <date from file>)
  Per-WIP handoffs: loaded (<N> files)
  People index: loaded (<N> files)
  Companies index: loaded (<N> files)
  INPUT drafts: loaded (<N> files)
  Skipped (not found): <list, or "none">

Ready. What are we picking up?
```

For greeting triggers (hello/hi/etc.), suppress the status block and simply hydrate silently — the user said hello, not asked for a status report. Mention "context loaded" briefly only if the user's first request requires it (e.g., they reference a person or WIP and you need to flag what was loaded).

Then wait for the user. Do NOT auto-summarize the handoff — the user will direct the next action. Summarizing unasked = P13 violation (sacred time) and a Calibration Auditor flag (performative warmth).

## Privacy and scope

- Never echo file contents to the user unless asked. Loading is silent.
- Honor scope boundaries (P12): if a file is marked `scope: xFamilyOS` and the session is an xTeamOS session, skip it. (In v3.1 this is advisory — Scope Permissioning plugin #17 enforces at runtime.)
- Never push any of these files to a public repo. They live in private workspace only.
- Never echo file paths in a public-facing artifact (post, blog, public log) — paths leak workspace topology.

## How to verify

**Trigger command:** Type `waky waky`, `hello`, or any greeting in a new session.

**Expected output (explicit trigger like `waky waky`):**
1. The agent reads tier 1-2 files in full, lists tier 3-4 inventories (filenames only).
2. Prints the confirmation status block above with accurate counts.
3. Does NOT bulk-load people/companies/WIPs — those are indexed by filename, deep-loaded on demand.
4. Does NOT dump file contents or auto-summarize — waits for user direction.
5. "Skipped (not found)" list is accurate — any file in tiers 1-2 that doesn't exist is listed there.

**Expected output (greeting trigger like `hello`):**
1. Same hydration as above, silently.
2. Status block SUPPRESSED unless user asks "what loaded?" or first ask requires path-disclosure.
3. Agent answers user's first real ask with full context already loaded.

**Failure modes to check:**
- Hallucinated file contents (e.g., claims a handoff says something it doesn't) → P14 + Ground Zero violation
- Auto-summary of handoff content without being asked → P13 + Calibration Auditor flag
- Missing files not reported in "Skipped" list (when status block is shown) → coherence bug
- Greeting trigger fires status block when it should hydrate silently → UX bug
- Skill activation BUT context loading stops mid-execution (the "stops in the middle" bug) → file the failing trigger phrase as a regression test, fix the activation flow

### END WAKY-WAKY ###
