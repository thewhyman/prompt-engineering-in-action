import { describe, expect, test } from "bun:test";
import {
  appendCrossFamilyDegradationFlag,
  computeCrossFamily,
  computeFinalVerdict,
  type JurorResult,
  type Verdict,
} from "./judge_panel.ts";

function juror(
  family: string,
  model: string,
  verdict: Verdict,
  overrides: Partial<JurorResult> = {},
): JurorResult {
  return {
    family,
    model,
    verdict,
    confidence: verdict === "error" || verdict === "timeout" ? 0 : 90,
    flags: [],
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 0,
    raw_response: "",
    error: verdict === "error" ? `${family} failed` : null,
    ...overrides,
  };
}

describe("computeCrossFamily", () => {
  test("one lane error plus one pass is degraded with one returned family", () => {
    const health = computeCrossFamily([
      juror("google", "gemini-flash", "error", {
        error: "no JSON object in response",
      }),
      juror("openai", "gpt-5.4", "pass"),
    ]);

    expect(health.degraded).toBe(true);
    expect(health.distinct_families_returned).toBe(1);
    expect(health.down_lanes).toEqual([
      {
        family: "google",
        model: "gemini-flash",
        reason: "no JSON object in response",
      },
    ]);
  });

  test("both lanes pass across distinct families is not degraded", () => {
    const health = computeCrossFamily([
      juror("google", "gemini-flash", "pass"),
      juror("openai", "gpt-5.4", "pass"),
    ]);

    expect(health.degraded).toBe(false);
    expect(health.distinct_families_returned).toBe(2);
    expect(health.down_lanes).toEqual([]);
  });

  test("both lanes error is degraded with zero returned families", () => {
    const health = computeCrossFamily([
      juror("google", "gemini-flash", "error"),
      juror("openai", "gpt-5.4", "timeout", {
        error: "timeout after 120s",
      }),
    ]);

    expect(health.degraded).toBe(true);
    expect(health.distinct_families_returned).toBe(0);
    expect(health.down_lanes.map((lane) => lane.family)).toEqual([
      "google",
      "openai",
    ]);
  });

  test("two same-family responders are still degraded", () => {
    const health = computeCrossFamily([
      juror("openai", "gpt-5.4", "pass"),
      juror("openai", "gpt-5.4-mini", "pass"),
    ]);

    expect(health.degraded).toBe(true);
    expect(health.distinct_families_returned).toBe(1);
    expect(health.down_lanes).toEqual([]);
  });

  test("stage-1 down plus same down-family tiebreaker error stays degraded", () => {
    const health = computeCrossFamily([
      juror("google", "gemini-flash", "error", {
        error: "no JSON object in response",
      }),
      juror("openai", "gpt-5.4", "pass"),
      juror("google", "gemini-pro", "error", {
        error: "no JSON object in response",
      }),
    ]);

    expect(health.degraded).toBe(true);
    expect(health.distinct_families_returned).toBe(1);
    expect(health.down_lanes.map((lane) => lane.model)).toEqual([
      "gemini-flash",
      "gemini-pro",
    ]);
  });

  test("stage-1 down plus same returned-family tiebreaker verdict stays degraded", () => {
    const health = computeCrossFamily([
      juror("google", "gemini-flash", "error", {
        error: "no JSON object in response",
      }),
      juror("openai", "gpt-5.4", "pass"),
      juror("openai", "gpt-5.4", "pass"),
    ]);

    expect(health.degraded).toBe(true);
    expect(health.distinct_families_returned).toBe(1);
    expect(health.down_lanes).toEqual([
      {
        family: "google",
        model: "gemini-flash",
        reason: "no JSON object in response",
      },
    ]);
  });

  test("stage-1 down plus different-family tiebreaker verdict restores cross-family", () => {
    const health = computeCrossFamily([
      juror("google", "gemini-flash", "error", {
        error: "no JSON object in response",
      }),
      juror("openai", "gpt-5.4", "pass"),
      juror("google", "gemini-pro", "pass"),
    ]);

    expect(health.degraded).toBe(false);
    expect(health.distinct_families_returned).toBe(2);
    expect(health.down_lanes).toEqual([
      {
        family: "google",
        model: "gemini-flash",
        reason: "no JSON object in response",
      },
    ]);
  });

  test("empty/no-json reasoning flags on a real verdict do not mark a lane down", () => {
    const health = computeCrossFamily([
      juror("google", "gemini-flash", "pass", {
        flags: ["artifact is empty and no json is expected in the input"],
      }),
      juror("openai", "gpt-5.4", "pass"),
    ]);

    expect(health.degraded).toBe(false);
    expect(health.distinct_families_returned).toBe(2);
    expect(health.down_lanes).toEqual([]);
  });
});

describe("appendCrossFamilyDegradationFlag", () => {
  test("appends degraded line without shifting an existing index-0 flag", () => {
    const jurors = [
      juror("google", "gemini-flash", "error", {
        error: "no JSON object in response",
      }),
      juror("openai", "gpt-5.4", "pass"),
    ];
    const flags = appendCrossFamilyDegradationFlag(
      ["pre-existing flag"],
      computeCrossFamily(jurors),
      jurors,
    );

    expect(flags[0]).toBe("pre-existing flag");
    expect(
      flags.some((flag) =>
        flag.startsWith(
          "⚠ CROSS-FAMILY DEGRADED: only openai returned; google (no JSON object in response) lane(s) down",
        ),
      ),
    ).toBe(true);
  });

  test("both lanes down banner names zero verdicts and keeps per-lane reasons", () => {
    const jurors = [
      juror("google", "gemini-flash", "timeout", {
        error: "timeout after 120s",
      }),
      juror("openai", "gpt-5.4", "error", {
        error: "no JSON object in response",
      }),
    ];
    const flags = appendCrossFamilyDegradationFlag(
      [],
      computeCrossFamily(jurors),
      jurors,
    );
    const degradedFlag = flags.find((flag) =>
      flag.startsWith("⚠ CROSS-FAMILY DEGRADED:"),
    );

    expect(degradedFlag).toBe(
      "⚠ CROSS-FAMILY DEGRADED: no lane returned a verdict (google (timeout after 120s), openai (no JSON object in response))",
    );
    expect(degradedFlag).toContain("google (timeout after 120s)");
    expect(degradedFlag).toContain("openai (no JSON object in response)");
    expect(degradedFlag).not.toContain("only none returned");
  });

  test("same-family-only degraded line asks for distinct families without lane down", () => {
    const jurors = [
      juror("openai", "gpt-5.4", "pass"),
      juror("openai", "gpt-5.4-mini", "pass"),
    ];
    const flags = appendCrossFamilyDegradationFlag(
      [],
      computeCrossFamily(jurors),
      jurors,
    );
    const degradedFlag = flags.find((flag) =>
      flag.startsWith("⚠ CROSS-FAMILY DEGRADED:"),
    );

    expect(degradedFlag).toContain("need ≥2 distinct families");
    expect(degradedFlag).not.toContain("lane down");
  });
});

describe("computeFinalVerdict", () => {
  test("both-lanes-pass verdict math matches existing no-escalation behavior", () => {
    const result = computeFinalVerdict(
      [
        juror("google", "gemini-flash", "pass", { confidence: 90 }),
        juror("openai", "gpt-5.4", "pass", { confidence: 82 }),
      ],
      null,
      false,
    );

    expect(result.final_verdict).toBe("pass");
    expect(result.final_confidence).toBe(86);
  });
});
