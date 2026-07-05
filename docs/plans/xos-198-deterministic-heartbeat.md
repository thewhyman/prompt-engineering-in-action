# XOS-198 — Deterministic heartbeat: the Stop hook writes it, verified against the transcript header

status: design
slug: xos-198-deterministic-heartbeat
ticket: XOS-198
repo: ~/aiprojects/prompt-engineering-in-action (plugins/co-dialectic/hooks/status-liveness-check.ts)

## What
Make codi's Protocol-1 heartbeat **deterministic**: the `status-liveness-check.ts` Stop hook — which already reads the transcript and parses the final-assistant Protocol-1 header — now WRITES `last_protocol_ts` (+ the parsed header fields) to the state file(s) whenever it verifies a valid header was rendered. The model no longer has to write the heartbeat itself.

## Why
The DEGRADED saga (XOS-141/146/149/167/197) has one root generator: **the heartbeat is written by an LLM following prose** ("write last_protocol_ts=current ISO time"). Non-deterministic by construction — the model forgets it (idle gaps → DEGRADED), writes a stale in-context copy (clobbering), or fabricates the timestamp. Every prior fix treated the EVALUATION; none removed the non-deterministic WRITER. This session alone the model re-fired the heartbeat ~40× and still went DEGRADED repeatedly. `status-liveness-check.ts` ALREADY parses the transcript for the header — so the deterministic writer is a few lines away: verify the header in ground truth (the transcript), then code stamps the heartbeat. "Variance is evil" — the prose heartbeat IS the variance; code it away.

## Scope
- In: `plugins/co-dialectic/hooks/status-liveness-check.ts` — after parsing the transcript's final-assistant message, when a **valid Protocol-1 header is present** (a live header with a score/Cal token, OR a `⚠ Codi DEGRADED` header), the hook WRITES the heartbeat to the resolved state file(s): `last_protocol_ts = now`, plus the header-parsed `persona`, `last_score`, `last_cal`, `version` (resolved per Design decision 6), AND `growth_total_turns = (existing ?? 0) + 1` — a deterministic per-turn counter the hook now owns (Design decision 8). Preserve model-owned preference fields (`mode`, `verbosity`, `wildcard`, `active`) via read-modify-write; only stamp the liveness/header/counter fields. Version bump + CHANGELOG.
- In: `plugins/co-dialectic/hooks/user-prompt-submit.ts` (+ the survival-reminder text it emits) — **stop instructing the model to write the LIVENESS heartbeat + counter** (the "write back to ...state.json last_protocol_ts / version / last_score / last_cal / persona / growth_total_turns" lines, incl. lines ~454 and ~460). The hook is now the sole writer of those (Design decision 1 + 8). Keep the header-rendering instruction (UX + proof-of-execution signal), and keep a **narrow** instruction to persist the model-owned PREFERENCE fields (`mode`/`verbosity`/`wildcard`) **only when the user changes them via a command** (`cod cruise`/`cod verbose`/etc.) — those are not per-turn and stay model-owned (Design decision 8). This removes the concurrent per-turn writer that caused the clobbering the ticket names, without freezing the counter or orphaning preferences.
- In: `plugins/co-dialectic/skills/co-dialectic/SKILL.md` (Protocol 1, line ~53) — the runtime survival-reminder is NOT the only model-facing surface that tells the model to write the heartbeat: SKILL.md line 53 also carries "(Keep state current by writing the heartbeat when you render the line — see Protocol 1 Heartbeat below.)" — a write directive AND a dangling forward-reference to a "Protocol 1 Heartbeat" section that does not exist. **Remove that parenthetical** (the hook now keeps state current). Keep the rest of line 53 — the LIVE/DEGRADED **read** rule that references `last_protocol_ts`/`active`/`last_score`/`last_cal` for deciding whether a score may render — that is a read contract, unchanged. `SKILL-lite.md` (lines 43/51) is read-only already (no write directive) → no change needed beyond the version-string bump. This closes the second model-write surface the A.7 cycle-3 finding names.
- Out (follow-on tickets — larger/riskier refactors, do NOT bundle):
  - **Per-session (session-keyed) state store** (Fable finding 1 — concurrent Superset sessions contaminating one shared file). Separate ticket.
  - **Collapse the 3 duplicated liveness evaluators** to one (Fable finding 4). Separate ticket.
  - Any change to `user-prompt-submit.ts` / `statusline.sh` read logic (they already read the state the hook now writes).

## Design decisions
1. **The header IS the proof-of-execution; the hook is the writer.** A model that produced a turn rendered a header → it executed → stamp it LIVE. A dead/stalled/idle model produces NO final-assistant header → no stamp → correctly DEGRADED after the window. Liveness now derives from ground truth (the transcript), not LLM self-report — the ticket's core litmus. This removes model-forgot / model-clobbered / model-fabricated-timestamp in one move.
2. **Write only on a VALID header, never unconditionally.** No header in the final message → do NOT stamp (the existing silent-drop / missing-degraded-header nudge still fires). This keeps the hook honest: it certifies the model actually rendered Protocol 1 before stamping.
3. **Fabrication detection still runs, but the LIVE-fabrication case dissolves.** Today "fabrication" = header shows a score while state is stale/DEGRADED. Once the hook stamps on every headered turn, a headered turn IS live, so a rendered score is legitimately live. Keep the existing fabrication/inconsistent/silent-drop nudges for the pre-write evaluation (they describe the PRIOR state and still catch a genuinely missing/degraded header), but the write happens AFTER, so the NEXT turn is clean. The score VALUE remains model-owned self-assessment (UX), not code-verified — only LIVENESS is now deterministic.
4. **Fail-open, never block.** This is a Stop hook: a write failure (unresolvable path, permission, malformed existing state) must be swallowed — log/skip, never crash or block the session. Same contract the hook already has.
5. **Read-modify-write, atomic-ish.** Load existing state (or {} if absent/corrupt), set only the liveness/header/counter fields, write back. Do not clobber `mode`/`verbosity`/`wildcard` or other model-owned preference fields. Write to a temp file + rename to avoid torn reads by a concurrent user-prompt-submit.
6. **version resolution** (A.7 finding 3). The hook resolves the installed version by reading `plugin.json` relative to the hook file (`<hookdir>/../.claude-plugin/plugin.json` → `version`), the same way `skill-version-banner.ts` already does. If that read fails, fall back to the `version` already in the existing state (preserve it), else omit the field — never crash. Do NOT hardcode the version (it would go stale on the next bump — the exact drift class we keep hitting).
7. **Dual-path write consistency — brain authoritative, legacy is a best-effort mirror** (A.7 finding 2). The resolved BRAIN path (`{BRAIN_WORKSPACE_ROOT|CAREER_HOME|cwd}/co-dialectic/status-state.json`, when the root resolves and the dir exists) is the AUTHORITATIVE write and matches the readers' first-choice (user-prompt-submit + statusline both prefer brain). The legacy `~/.codialectic/state.json` is written as a best-effort mirror AFTER the brain write. Consistency rule that removes the divergence hazard: if the brain path is the resolved authoritative target, readers use it — so a fresh-brain / stale-legacy split is harmless (legacy is never read when brain exists). Only when the brain path does NOT resolve (no workspace root) is legacy the authoritative single target. Never leave the AUTHORITATIVE path stale while a non-authoritative path is fresh: write the authoritative path first; the mirror write failing is a swallowed no-op. (No cross-file 2-phase commit needed — the read-fallback order already makes one file canonical per environment.)
8. **Field ownership — the hook owns the deterministic per-turn fields; the model owns the command-driven preferences** (A.7 cycle-2 finding). Splitting by *cadence*, not by *file*: (a) **Hook-owned, per-turn, deterministic:** `last_protocol_ts`, `persona`, `last_score`, `last_cal`, `version`, `growth_total_turns` (increment by 1 on each stamped turn — it is per-turn and deterministic by construction, so it belongs with the hook that already fires once per turn; the ONBOARDING_TURN_WINDOW gating in user-prompt-submit keeps reading it, unchanged). (b) **Model-owned, command-driven, NOT per-turn:** `mode`, `verbosity`, `wildcard` — these change only when the user issues a toggle command, so the narrow survival-reminder still tells the model to persist them on such a command. The hook's read-modify-write PRESERVES them (never writes them). This closes the "counter freezes / preferences go stale" regression: the counter now has a deterministic writer (better than before — no missed increments when the model forgot), and preferences keep their event-driven model writer. Note `persona`/`last_score`/`last_cal` VALUES remain model self-assessment surfaced in the header (UX); the hook merely copies the header-parsed value into state — it does not compute them.

## Acceptance criteria
- [ ] Given a transcript whose final assistant message contains a valid live Protocol-1 header (persona + `NN%` + `Cal: NN%` + `[HH:MM]`), the hook writes `last_protocol_ts≈now` + parsed persona/score/cal/version to the resolved state file — verified by reading the file back.
- [ ] Given a final message with a `⚠ Codi DEGRADED` header, the hook still stamps `last_protocol_ts≈now` (the model IS executing; DEGRADED was the prior state) — so the next turn is LIVE. (This is the loop-exit: one degraded turn, then self-heals.)
- [ ] Given a final message with NO Protocol-1 header, the hook does NOT write the heartbeat and emits the existing silent-drop / missing-degraded nudge.
- [ ] The hook writes the AUTHORITATIVE brain path first (when the workspace root resolves), then the legacy mirror; existing non-liveness fields preserved (read-modify-write). When the brain path can't resolve, legacy is the single authoritative write. Never leaves the authoritative target stale while a non-authoritative one is fresh (unit-tested).
- [ ] `version` is resolved from `plugin.json` (not hardcoded); if unreadable, the prior state `version` is preserved / omitted, never a crash (unit-tested).
- [ ] `growth_total_turns` is incremented by the hook: given existing state `growth_total_turns: N`, a stamped turn writes `N+1` (unit-tested); across two stamped turns it goes `N → N+2`. The onboarding-window read path in user-prompt-submit still reads it unchanged.
- [ ] Model-owned preference fields survive the hook write: given existing state `mode: "cruise", verbosity: "verbose", wildcard: <x>`, a hook stamp preserves all three unchanged (read-modify-write; unit-tested). The hook never sets them.
- [ ] Single-writer for liveness+counter across ALL model-facing surfaces: grep asserts no model-write instruction for `last_protocol_ts`/`version`/`last_score`/`last_cal`/`persona`/`growth_total_turns` remains in EITHER `user-prompt-submit.ts` (incl. the ~454 heartbeat line and ~460 "Update ... growth_total_turns (increment by 1)" line) OR `skills/co-dialectic/SKILL.md` (the line-53 "writing the heartbeat when you render the line" parenthetical + its dangling "Protocol 1 Heartbeat below" reference). The narrow preference-persist instruction (`mode`/`verbosity`/`wildcard` on user command) remains (grep asserts it is present). The line-53 LIVE/DEGRADED read rule stays intact (grep asserts the `last_protocol_ts`/`active` read contract is still present).
- [ ] Write failure (bad path / permission / corrupt existing JSON) → hook fails open (no crash, no block), matching current behavior.
- [ ] Deterministic self-heal proof: simulate an idle gap (stale heartbeat) → one turn renders a header → hook stamps → a subsequent `user-prompt-submit` liveness eval returns LIVE, with no model-authored state write in between.

## Test plan
- [ ] Unit (inject transcript + state path + now): valid-live-header → writes fresh ts + parsed fields + `growth_total_turns` incremented; degraded-header → writes fresh ts + increments counter; no-header → no write (counter unchanged) + nudge; corrupt-existing-state → fails open; brain + legacy both written; model-owned preference fields (`mode`/`verbosity`/`wildcard`) preserved unchanged.
- [ ] Regression: the existing fabrication/inconsistent/silent-drop nudge tests (xos_146_status_liveness_check.test.ts, xos-197-liveness.test.ts) stay green — the write is additive to the existing evaluation.
- [ ] Live-ish smoke: run the hook against a real transcript fixture with a header; confirm the state file's `last_protocol_ts` advances.

## Rollback
Revert the commit. The write is additive; without it the model-prose heartbeat still works (status quo ante). No consumer depends on the hook-write existing.

## Change manifest
```
+ added     (none — no new files; tests may add a fixture)
~ modified  plugins/co-dialectic/hooks/status-liveness-check.ts  — add deterministic heartbeat write (verified-header → stamp authoritative brain path + legacy mirror, read-modify-write, version-from-plugin.json, fail-open)
~ modified  plugins/co-dialectic/hooks/user-prompt-submit.ts     — drop the liveness+counter "model writes state" survival-reminder (hook is sole writer); keep header-render + narrow mode/verbosity/wildcard-on-command persist instruction
~ modified  plugins/co-dialectic/skills/co-dialectic/SKILL.md    — Protocol 1 line ~53: remove the "writing the heartbeat when you render the line — see Protocol 1 Heartbeat below" parenthetical (dead forward-ref + second write surface); keep the LIVE/DEGRADED read rule
~ modified  plugins/co-dialectic/hooks/*liveness*.test.ts        — write-path unit tests (counter increment, preference preservation, version-from-plugin.json, partial-path-failure) + preserve existing verification tests
~ modified  plugins/co-dialectic/.claude-plugin/plugin.json      — 4.36.0 → 4.37.0
~ modified  plugins/co-dialectic/CHANGELOG.md + root CHANGELOG.md + root marketplace.json + install.sh VERSION + SKILL.md **Version:**  — 4.37.0 (4-source version-consistency gate)
− removed   (none)
⚙ migrated  (none — additive; the model may still write state, but no longer NEEDS to)
```

## Follow-on (noted, not built here)
- Per-session-keyed state store (concurrent-session contamination).
- Collapse the 3 duplicated liveness evaluators to one.
Both are the rest of XOS-198's Fable findings; this slice ships the highest-leverage move (deterministic writer) that ends the "model forgot/clobbered/fabricated" class.


## Design-review verdict (Gate-A.7)

- verdict: YELLOW
- cycle: 1
- reviewer: anthropic/claude-fable-5
- cross_family: not_required
- manifest_sha256: abd7e45b55a3e2d3cef4f5c5c25c2b20ea9424ea9d614da71e29652518eb135a
- timestamp: 2026-07-05T06:09:17.594Z
- findings:
  - [YELLOW] missing-requirements: The spec names 'model writes a stale in-context copy (clobbering)' as a root-cause mode, yet leaves the model-authored heartbeat instruction active ('the model may still write state, but no longer NEEDS to'). Two concurrent writers remain, so a mid-turn model write can still clobber state before the Stop-hook stamp. Add an explicit acceptance criterion + unit test proving write ordering: a stale/fabricated model-authored state write occurring mid-turn is superseded by the Stop-hook stamp (hook write is last-writer at turn end), and non-liveness fields written by the model are preserved by the hook's read-modify-write. Also note in the spec whether/when the Protocol-1 prose instruction telling the model to write last_protocol_ts (and the 'hooks must not fake it' language) gets retired — if deferred, name the follow-on ticket so the dual-writer window is tracked, not silent.
  - [YELLOW] forward-failure: The dual-path write (brain-kernel + legacy ~/.codialectic/state.json) can partially fail under the fail-open contract: one file stamped fresh, the other stale, and the two diverge. Since readers use a fallback order, specify which path is authoritative when they disagree, state that each path's write is independently fail-open (failure of one must not skip the other), and add a unit test for the partial-failure case (e.g., legacy path unwritable → brain path still stamped, hook exits clean).
  - [YELLOW] missing-requirements: Design decision says the hook writes 'version = installed' but the spec never defines how the hook resolves the installed version (plugin.json read? hardcoded constant? env?). Given the change also bumps 4.36.0→4.37.0 across a 4-source version-consistency gate, specify the version source the hook reads at runtime and add it to the unit test assertions so a future version bump can't silently desync the stamped value.
- adjustments:
  - Class B; applied=false: The spec names 'model writes a stale in-context copy (clobbering)' as a root-cause mode, yet leaves the model-authored heartbeat instruction active ('the model may still write state, but no longer NEEDS to'). Two concurrent writers remain, so a mid-turn model write can still clobber state before the Stop-hook stamp. Add an explicit acceptance criterion + unit test proving write ordering: a stale/fabricated model-authored state write occurring mid-turn is superseded by the Stop-hook stamp (hook write is last-writer at turn end), and non-liveness fields written by the model are preserved by the hook's read-modify-write. Also note in the spec whether/when the Protocol-1 prose instruction telling the model to write last_protocol_ts (and the 'hooks must not fake it' language) gets retired — if deferred, name the follow-on ticket so the dual-writer window is tracked, not silent.
  - Class B; applied=false: The dual-path write (brain-kernel + legacy ~/.codialectic/state.json) can partially fail under the fail-open contract: one file stamped fresh, the other stale, and the two diverge. Since readers use a fallback order, specify which path is authoritative when they disagree, state that each path's write is independently fail-open (failure of one must not skip the other), and add a unit test for the partial-failure case (e.g., legacy path unwritable → brain path still stamped, hook exits clean).
  - Class B; applied=false: Design decision says the hook writes 'version = installed' but the spec never defines how the hook resolves the installed version (plugin.json read? hardcoded constant? env?). Given the change also bumps 4.36.0→4.37.0 across a 4-source version-consistency gate, specify the version source the hook reads at runtime and add it to the unit test assertions so a future version bump can't silently desync the stamped value.


## Design-review verdict (Gate-A.7)

- verdict: YELLOW
- cycle: 2
- reviewer: anthropic/claude-fable-5
- cross_family: not_required
- manifest_sha256: 6b0bf8c562de3762b64129fa71fd1401bc2fafee400d788217f763cb9246e20d
- timestamp: 2026-07-05T06:14:36.291Z
- findings:
  - [YELLOW] missing-requirements: The spec removes the model's entire state-write instruction from user-prompt-submit.ts while the hook stamps only liveness/header fields (last_protocol_ts, persona, last_score, last_cal, version) and merely PRESERVES model/brain-owned fields (growth_total_turns, mode/verbosity/etc.). Those fields lose their only writer: growth_total_turns will freeze and preference fields will go stale. Clarify ownership in the spec before build: either (a) keep a narrow survival-reminder instruction covering ONLY non-liveness model-owned fields, (b) have the hook increment growth_total_turns itself on each stamped turn (it is per-turn and deterministic), or (c) explicitly declare those fields frozen/deprecated in this slice — and add an acceptance criterion + unit test pinning the chosen behavior so the counter regression is caught rather than discovered in production.
- adjustments:
  - Class B; applied=false: The spec removes the model's entire state-write instruction from user-prompt-submit.ts while the hook stamps only liveness/header fields (last_protocol_ts, persona, last_score, last_cal, version) and merely PRESERVES model/brain-owned fields (growth_total_turns, mode/verbosity/etc.). Those fields lose their only writer: growth_total_turns will freeze and preference fields will go stale. Clarify ownership in the spec before build: either (a) keep a narrow survival-reminder instruction covering ONLY non-liveness model-owned fields, (b) have the hook increment growth_total_turns itself on each stamped turn (it is per-turn and deterministic), or (c) explicitly declare those fields frozen/deprecated in this slice — and add an acceptance criterion + unit test pinning the chosen behavior so the counter regression is caught rather than discovered in production.


## Design-review verdict (Gate-A.7)

- verdict: YELLOW
- cycle: 3
- reviewer: anthropic/claude-fable-5
- cross_family: not_required
- manifest_sha256: 6b0bf8c562de3762b64129fa71fd1401bc2fafee400d788217f763cb9246e20d
- timestamp: 2026-07-05T06:22:55.629Z
- findings:
  - [YELLOW] missing-requirements: The single-writer acceptance criterion only greps user-prompt-submit.ts, but the Protocol-1 heartbeat write instruction ("write last_protocol_ts...", "increment growth_total_turns") plausibly also lives in the skill definition files (SKILL.md / SKILL-lite.md), which the manifest touches only for a version-string bump. If any SKILL file still instructs the model to write the liveness/counter fields, the concurrent per-turn LLM writer this ticket exists to remove survives. Additive fix: extend the scope and the grep assertion to sweep ALL instruction surfaces (SKILL.md, SKILL-lite.md, and any other prompt/reminder text in the plugin) for heartbeat/counter write instructions, removing or narrowing them the same way as user-prompt-submit.ts, and keep the narrow preference-persist instruction consistent across those surfaces.
- adjustments:
  - Class B; applied=false: The single-writer acceptance criterion only greps user-prompt-submit.ts, but the Protocol-1 heartbeat write instruction ("write last_protocol_ts...", "increment growth_total_turns") plausibly also lives in the skill definition files (SKILL.md / SKILL-lite.md), which the manifest touches only for a version-string bump. If any SKILL file still instructs the model to write the liveness/counter fields, the concurrent per-turn LLM writer this ticket exists to remove survives. Additive fix: extend the scope and the grep assertion to sweep ALL instruction surfaces (SKILL.md, SKILL-lite.md, and any other prompt/reminder text in the plugin) for heartbeat/counter write instructions, removing or narrowing them the same way as user-prompt-submit.ts, and keep the narrow preference-persist instruction consistent across those surfaces.


## Design-review verdict (Gate-A.7)

- verdict: GREEN
- cycle: 4
- reviewer: anthropic/claude-fable-5
- cross_family: not_required
- manifest_sha256: b99064d2aa94971a641c1dfda5fe613d47fe73297c138dc6b32ba44ca7efb66a
- timestamp: 2026-07-05T06:28:04.660Z
- findings: none
