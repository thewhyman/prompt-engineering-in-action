# XOS-207 — Judge lane that hangs/empties must fail LOUD, not silently drop to single-family

status: design
slug: xos-207-judge-loud-degradation
ticket: XOS-207
repo: ~/aiprojects/prompt-engineering-in-action (plugins/co-dialectic/skills/judge-panel/scripts/judge_panel.ts)

## What

Make `judge_panel.ts` emit a **loud, machine-checkable cross-family-degradation signal** when a family lane errors / times out / returns empty, so a T3 gate that lost its cross-family property can never look like a clean cross-family GREEN.

## Why

Observed 2026-07-04 (XOS-206 session): agy's Google lane was down for hours. Every Gate-A.5 / Stage-6 judge ran **effectively OpenAI-only** while the output just carried `google → error: "no JSON object in response"` inside `stage_1_small_fish` and proceeded. The aggregate, `final_verdict`, and the `ship-feature-judge-receipt` never *loudly* said "cross-family was lost." A reader (human or gate) saw a verdict and moved on. Single-family = same-family blind spots — the exact failure cross-family exists to prevent. This is the same silent-degradation class as codi DEGRADED and the inert-gate: the signal exists in raw data but nothing forces it to the surface.

Root cause in code: `aggregate()` (judge_panel.ts ~L985) filters `small` to only `pass/fail/uncertain` verdicts and **discards error/timeout lanes with no surfaced consequence**; `verdicts.length < 2` returns `"insufficient" → escalate`, but the escalation/`final_verdict` path never records *why* it went single-family, and the top-level output has no "distinct families that actually returned a verdict" field.

## Scope

- In:
  - `judge_panel.ts`: add a top-level `cross_family` health object + a loud flag. Compute from `stage_1_small_fish` (+ tiebreaker): `distinct_families_returned` (families with a real pass/fail/uncertain verdict), `down_lanes` (`[{family, model, reason}]` for error/timeout/empty), `degraded` (true when `distinct_families_returned < 2`). When `degraded`, APPEND a loud entry to `all_flags`: `⚠ CROSS-FAMILY DEGRADED: only <families> returned; <family> lane down (<reason>)` (append, not prepend — preserves existing flag indices; see design decision 1).
  - `judge_panel.ts` types: extend the output interface with `cross_family`.
  - `judge_panel.ts` SKILL.md: document the new field + that consumers MUST surface `degraded`.
- Out:
  - Changing the escalation/verdict *math* (a degraded panel still escalates + returns its best verdict — we make it LOUD, we don't change what it decides). No behavior change to pass/fail.
  - The `ship-feature` receipt consuming this (separate plugin/ticket) — this ticket makes the SIGNAL exist and loud; wiring the receipt to render `families: openai (google DOWN)` and optionally BLOCK T3 on degraded is a companion follow-up noted in the spec.
  - The agy timeout-wrapper bug (already fixed + codified: feedback_never_wrap_agy_cli_in_timeout.md).

## Design decisions

1. **Loud = both structured AND in `all_flags`, but the STRUCTURED field is authoritative** (A.7 finding 2). `cross_family.degraded` (structured, top-level) is the contract gates read — NOT `all_flags[0]`. The `⚠ CROSS-FAMILY DEGRADED …` entry is ADDED to `all_flags` for human skim value, but `all_flags` is a semantically-unordered set (dedup-preserving insertion order, not positional contract) — consumers MUST NOT read it by index. To avoid shifting existing indices for any legacy positional reader, the degraded line is APPENDED (not prepended); prominence comes from the structured field + the `⚠` prefix, not position. SKILL.md states explicitly: read `cross_family.degraded`, never `all_flags[0]`.
   A degradation that lives only in a nested per-juror `error` field is not loud — it must be at top-level (`cross_family`) AND in the flag stream.
6. **Tiebreaker CAN restore cross-family** (A.7 finding 1). `distinct_families_returned` and `down_lanes` are computed over ALL jurors that ran — `stage_1_small_fish` PLUS `stage_2_tiebreaker` when it fired. Worked case: stage-1 google errors + openai passes → escalates → tiebreaker is google/gemini-pro. If the tiebreaker ALSO errors → still only openai returned → `degraded: true`. If the tiebreaker is a DIFFERENT family that returns a real verdict → two distinct families returned across the run → `degraded: false`, and google appears in neither `down_lanes` count as fatal (it's recorded as a down lane in stage-1 but cross-family was ultimately achieved). Rule: `degraded = (distinct families with a real verdict across stage-1 ∪ tiebreaker) < 2`. `down_lanes` lists every lane that errored/timed-out/emptied at any stage (informational), independent of the final degraded verdict.
2. **"Returned a verdict" = pass/fail/uncertain only.** error/timeout/empty are NOT verdicts and never count toward `distinct_families_returned` or agreement/confidence (aggregate already excludes them from `verdicts` — we now also *report* the exclusion).
3. **Degraded ≠ blocked (here).** judge_panel stays a reporter: it emits the loud signal; it does not itself decide to BLOCK. Whether a T3 gate BLOCKs on `degraded` is the CONSUMER's policy (ship-feature/codi Protocol 8) — keeps judge_panel single-responsibility and avoids breaking non-gate callers. The zero-fish FAIL-HARD (CLI_NOT_INSTALLED / no lane at all) stays as-is.
4. **Backward compatible.** Additive field; existing consumers that read `final_verdict`/`all_flags` still work and now see the loud flag for free.

## Acceptance criteria

- [ ] Output includes `cross_family: { distinct_families_returned, degraded, down_lanes: [{family, model, reason}] }`.
- [ ] When one of two lanes errors/times out/empties (and no distinct-family tiebreaker rescues it) → `degraded: true`, `distinct_families_returned: 1`, `down_lanes` names the family + reason, and the `⚠ CROSS-FAMILY DEGRADED …` line is PRESENT in `all_flags` (position not asserted; presence is).
- [ ] When both lanes return real verdicts → `degraded: false`, `distinct_families_returned: 2`, no degraded flag.
- [ ] Tiebreaker interaction (A.7 finding 1): stage-1 has one family down + one pass → escalates; if tiebreaker is a DIFFERENT family returning a real verdict → `degraded: false`, `distinct_families_returned: 2` (cross-family restored). If tiebreaker errors/same-family → `degraded: true`. Unit-tested both ways with injected juror results.
- [ ] `all_flags` positional stability (A.7 finding 2): the degraded line is APPENDED, not prepended — existing flags keep their indices; verified by a test asserting a pre-existing flag stays at index 0 when degradation is added.
- [ ] `final_verdict`/`final_confidence` math is UNCHANGED vs current (regression-tested on a both-lanes-pass case).
- [ ] `distinct_families_returned` counts DISTINCT families (two OpenAI models returning ≠ cross-family) — a degraded case where the only two responders are same-family is still `degraded: true`.
- [ ] SKILL.md documents the field + the consumer-must-surface contract.

## Test plan

- [ ] Unit (injectable juror results — no live CLIs): one-lane-error → degraded+flag; both-pass → not degraded; both-error → degraded (and existing error path intact); same-family-only responders → degraded; tiebreaker-different-family-returns → NOT degraded (restored); tiebreaker-errors → degraded; appended-flag-preserves-index-0; verdict math unchanged on both-pass.
- [ ] Live smoke (agy currently UP): real judge on a trivial artifact → `cross_family.degraded: false`, both families. (Do NOT wrap agy in `timeout` — background+poll.)

## Rollback

Revert the commit — the field is additive and the flag is cosmetic-plus-structured; no consumer behavior depends on it yet, so removal is safe.

## Change manifest

```
+ added     (none — no new files)
~ modified  plugins/co-dialectic/skills/judge-panel/scripts/judge_panel.ts  — cross_family health object + loud all_flags line + type
~ modified  plugins/co-dialectic/skills/judge-panel/scripts/*test*           — degradation unit tests + verdict-unchanged regression
~ modified  plugins/co-dialectic/skills/judge-panel/SKILL.md                 — document cross_family field + consumer contract
− removed   (none)
⚙ migrated  (none — additive, backward compatible)
```

## Companion follow-up (out of scope, note in ticket)

`ship-feature` Stage-6 receipt + codi Protocol 8 should render `cross_family.degraded` (e.g. `families: openai (google DOWN: timeout)`) and decide per-stakes whether a degraded cross-family T3 gate WARNs or BLOCKs. That's the consumer half; this ticket ships the loud signal it consumes.


## Design-review verdict (Gate-A.7)

- verdict: YELLOW
- cycle: 1
- reviewer: anthropic/claude-fable-5
- cross_family: not_required
- manifest_sha256: ab8c64fae6b72999ebb21efa127178b0d6d11dbdcf8bf1d26d047826e696ef5d
- timestamp: 2026-07-04T20:43:03.617Z
- findings:
  - [YELLOW] missing-requirements: Define and test how the tiebreaker lane interacts with `cross_family`: the spec says the health object is computed from `stage_1_small_fish` (+ tiebreaker), but no acceptance criterion or unit test covers the escalation path — e.g., one small-fish lane down, panel escalates, and the tiebreaker returns a verdict from a second (or the same) family. Add an explicit acceptance criterion stating whether a tiebreaker verdict counts toward `distinct_families_returned` (and can flip `degraded` to false), plus a unit test for a down-lane-then-tiebreaker case, so the degraded computation is unambiguous before implementation.
  - [YELLOW] forward-failure: The design PREPENDS the degraded line to `all_flags`, shifting existing flag positions. The spec asserts backward compatibility but only for consumers reading `final_verdict`/`all_flags` as a set. Add a one-line check (grep known consumers: ship-feature receipt, codi Protocol 8, test-plugin.sh assertions) confirming none index `all_flags[0]` or assert flag counts/order, and note the result in the spec; if any do, switch to append-plus-structured or update those consumers in the same change.
- adjustments:
  - Class B; applied=false: Define and test how the tiebreaker lane interacts with `cross_family`: the spec says the health object is computed from `stage_1_small_fish` (+ tiebreaker), but no acceptance criterion or unit test covers the escalation path — e.g., one small-fish lane down, panel escalates, and the tiebreaker returns a verdict from a second (or the same) family. Add an explicit acceptance criterion stating whether a tiebreaker verdict counts toward `distinct_families_returned` (and can flip `degraded` to false), plus a unit test for a down-lane-then-tiebreaker case, so the degraded computation is unambiguous before implementation.
  - Class B; applied=false: The design PREPENDS the degraded line to `all_flags`, shifting existing flag positions. The spec asserts backward compatibility but only for consumers reading `final_verdict`/`all_flags` as a set. Add a one-line check (grep known consumers: ship-feature receipt, codi Protocol 8, test-plugin.sh assertions) confirming none index `all_flags[0]` or assert flag counts/order, and note the result in the spec; if any do, switch to append-plus-structured or update those consumers in the same change.


## Design-review verdict (Gate-A.7)

- verdict: GREEN
- cycle: 2
- reviewer: anthropic/claude-fable-5
- cross_family: not_required
- manifest_sha256: ab8c64fae6b72999ebb21efa127178b0d6d11dbdcf8bf1d26d047826e696ef5d
- timestamp: 2026-07-04T20:46:49.287Z
- findings: none
