/**
 * xos-198-deterministic-heartbeat.test.ts — Stop-hook owned Protocol 1 heartbeat.
 *
 * Run: bun test hooks/xos-198-deterministic-heartbeat.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  authoritativeStatePath,
  checkStatusLiveness,
  legacyStatePath,
  parseRenderedHeader,
  resolveStateWriteTargets,
  stampProtocolHeartbeat,
} from "./status-liveness-check.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const STATUS_LIVENESS_CHECK = join(import.meta.dir, "status-liveness-check.ts");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    schema_version: "1.0.0",
    active: true,
    mode: "cruise",
    verbosity: "verbose",
    wildcard: true,
    persona: "Product",
    persona_icon: "📦",
    last_score: 88,
    last_cal: 96,
    installed_version: "4.37.0",
    version: "4.37.0",
    last_session_start_ts: isoSeconds(new Date(now - 60_000)),
    last_protocol_ts: isoSeconds(new Date(now - 10_000)),
    growth_total_turns: 7,
    ...overrides,
  };
}

function pluginVersion(): string {
  const parsed = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
  );
  return parsed.version;
}

function legacyPath(home: string): string {
  return join(home, ".codialectic", "state.json");
}

function brainPath(workspace: string): string {
  return join(workspace, "co-dialectic", "status-state.json");
}

function withEnv<T>(updates: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writeLegacyState(home: string, state: Record<string, unknown>): void {
  writeJson(legacyPath(home), state);
}

function writeBrainState(workspace: string, state: Record<string, unknown>): void {
  writeJson(brainPath(workspace), state);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function transcriptWithAssistant(message: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: message }],
    },
  }) + "\n";
}

function runHook(
  home: string,
  workspace: string,
  message: string,
): { exitCode: number; stdout: string; stderr: string } {
  const transcript = join(makeTempDir("codi-xos-198-transcript-"), "transcript.jsonl");
  writeFileSync(transcript, transcriptWithAssistant(message));
  const proc = spawnSync(process.execPath, [STATUS_LIVENESS_CHECK], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      HOME: home,
      BRAIN_WORKSPACE_ROOT: workspace,
      CAREER_HOME: "",
      CODI_STALE_SECS: "900",
    },
    input: JSON.stringify({ transcript_path: transcript }),
    encoding: "utf8",
  });
  return {
    exitCode: proc.status ?? 0,
    stdout: (proc.stdout ?? "").trim(),
    stderr: (proc.stderr ?? "").trim(),
  };
}

function expectFreshIso(value: unknown, before: number, after: number): void {
  expect(typeof value).toBe("string");
  const epoch = Date.parse(value as string);
  expect(Number.isFinite(epoch)).toBe(true);
  expect(epoch).toBeGreaterThanOrEqual(before);
  expect(epoch).toBeLessThanOrEqual(after);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("XOS-198 deterministic heartbeat writer", () => {
  test("score changes and stale resurrection do not nudge, but missing headers still do", () => {
    const now = new Date();
    const fresh = isoSeconds(new Date(now.getTime() - 10_000));
    const stale = isoSeconds(new Date(now.getTime() - 2_000_000));

    const changedScore = checkStatusLiveness(
      "📦 Product · 91% · Cal: 93% · [12:01]\nDone.",
      baseState({ last_protocol_ts: fresh, last_score: 88, last_cal: 96 }),
      now,
      900,
    );
    expect(changedScore.freshness.live).toBe(true);
    expect(changedScore.reason).toBeNull();
    expect(changedScore.nudge).toBeNull();

    const resurrected = checkStatusLiveness(
      "📦 Product · 91% · Cal: 93% · [12:01]\nDone.",
      baseState({ last_protocol_ts: stale, last_score: 88, last_cal: 96 }),
      now,
      900,
    );
    expect(resurrected.freshness.degraded).toBe(true);
    expect(resurrected.header.liveHeader).toBe(true);
    expect(resurrected.reason).toBeNull();
    expect(resurrected.nudge).toBeNull();

    const silentDrop = checkStatusLiveness("Done.", baseState({ last_protocol_ts: fresh }), now, 900);
    expect(silentDrop.reason).toBe("silent-drop");
    expect(silentDrop.nudge).toContain("codi is LIVE");

    const missingDegraded = checkStatusLiveness("Done.", baseState({ last_protocol_ts: stale }), now, 900);
    expect(missingDegraded.reason).toBe("missing-degraded-header");
    expect(missingDegraded.nudge).toContain("codi is DEGRADED");
  });

  test("valid live header stamps only authoritative brain state, preserves preferences, and increments", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    writeBrainState(workspace, baseState());
    writeLegacyState(home, baseState());

    const before = Date.now();
    const first = runHook(home, workspace, "📦 Product (Doshi) · 88% · Cal: 96% · [12:00]\nDone.");
    const after = Date.now();

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe("");

    const brain = readJson(brainPath(workspace));
    const legacy = readJson(legacyPath(home));
    expectFreshIso(brain.last_protocol_ts, before, after);
    expect(brain.persona).toBe("Product (Doshi)");
    expect(brain.persona_icon).toBe("📦");
    expect(brain.last_score).toBe(88);
    expect(brain.last_cal).toBe(96);
    expect(brain.version).toBe(pluginVersion());
    expect(brain.growth_total_turns).toBe(8);
    expect(brain.mode).toBe("cruise");
    expect(brain.verbosity).toBe("verbose");
    expect(brain.wildcard).toBe(true);
    expect(brain.active).toBe(true);
    expect(legacy.growth_total_turns).toBe(7);
    expect(legacy.persona).toBe("Product");
    expect(legacy.last_score).toBe(88);
    expect(Date.parse(legacy.last_protocol_ts as string)).toBeLessThan(before);

    const second = runHook(home, workspace, "📦 Product (Doshi) · 89% · Cal: 97% · [12:01]\nDone.");
    expect(second.exitCode).toBe(0);
    const afterSecond = readJson(brainPath(workspace));
    expect(afterSecond.growth_total_turns).toBe(9);
    expect(afterSecond.last_score).toBe(89);
    expect(afterSecond.last_cal).toBe(97);
  });

  test("degraded header stamps heartbeat and increments counter", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    const stale = isoSeconds(new Date(Date.now() - 2_000_000));
    writeBrainState(workspace, baseState({ last_protocol_ts: stale, growth_total_turns: 3 }));

    const before = Date.now();
    const result = runHook(home, workspace, "⚠ Codi DEGRADED · [12:00]\nDone.");
    const after = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const stamped = readJson(brainPath(workspace));
    expectFreshIso(stamped.last_protocol_ts, before, after);
    expect(stamped.growth_total_turns).toBe(4);
    expect(stamped.last_score).toBe(88);
    expect(stamped.last_cal).toBe(96);
  });

  test("quiet footer stamps liveness only without nudging for live or stale prior state", () => {
    const quietMessage = [
      "Quiet-mode work complete.",
      "",
      "Co-Dialectic tracking silently (type 'codi status' for info, 'codi on' to un-quiet)",
    ].join("\n");

    for (const lastProtocolTs of [
      isoSeconds(new Date(Date.now() - 10_000)),
      isoSeconds(new Date(Date.now() - 2_000_000)),
    ]) {
      const home = makeTempDir("codi-xos-198-home-");
      const workspace = makeTempDir("codi-xos-198-workspace-");
      writeBrainState(workspace, baseState({
        active: undefined,
        last_protocol_ts: lastProtocolTs,
        last_score: 88,
        last_cal: 96,
        persona: "Product",
        persona_icon: "box",
        growth_total_turns: 5,
      }));

      const before = Date.now();
      const result = runHook(home, workspace, quietMessage);
      const after = Date.now();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");

      const stamped = readJson(brainPath(workspace));
      expectFreshIso(stamped.last_protocol_ts, before, after);
      expect(stamped.growth_total_turns).toBe(6);
      expect(stamped.active).toBe(true);
      expect(stamped.version).toBe(pluginVersion());
      expect(stamped.last_score).toBe(88);
      expect(stamped.last_cal).toBe(96);
      expect(stamped.persona).toBe("Product");
      expect(stamped.persona_icon).toBe("box");
    }
  });

  test("quiet phrase away from final line still nudges and does not stamp", () => {
    const message = [
      "Review note:",
      "Co-Dialectic tracking silently is documented here for reviewers.",
      "Done without a status header.",
    ].join("\n");

    for (const [lastProtocolTs, expectedNudge] of [
      [isoSeconds(new Date(Date.now() - 10_000)), "codi is LIVE"],
      [isoSeconds(new Date(Date.now() - 2_000_000)), "codi is DEGRADED"],
    ] as const) {
      const home = makeTempDir("codi-xos-198-home-");
      const workspace = makeTempDir("codi-xos-198-workspace-");
      writeBrainState(workspace, baseState({
        last_protocol_ts: lastProtocolTs,
        growth_total_turns: 5,
      }));

      const result = runHook(home, workspace, message);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("CODI STATUS SILENT DROP");
      expect(result.stdout).toContain(expectedNudge);

      const state = readJson(brainPath(workspace));
      expect(state.last_protocol_ts).toBe(lastProtocolTs);
      expect(state.growth_total_turns).toBe(5);
    }
  });

  test("live persona icon sync clears stale icon on iconless headers and sets present icons", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    writeBrainState(workspace, baseState({
      persona: "Design",
      persona_icon: "art-palette",
      growth_total_turns: 5,
    }));

    const iconless = runHook(home, workspace, "Product (Doshi) · 91% · Cal: 93% · [12:00]\nDone.");

    expect(iconless.exitCode).toBe(0);
    expect(iconless.stderr).toBe("");
    expect(iconless.stdout).toBe("");
    const iconlessState = readJson(brainPath(workspace));
    expect(iconlessState.persona).toBe("Product (Doshi)");
    expect(iconlessState.persona_icon).toBeNull();
    expect(iconlessState.last_score).toBe(91);
    expect(iconlessState.last_cal).toBe(93);

    const withIcon = runHook(home, workspace, "📦 Product (Doshi) · 92% · Cal: 94% · [12:01]\nDone.");

    expect(withIcon.exitCode).toBe(0);
    expect(withIcon.stderr).toBe("");
    expect(withIcon.stdout).toBe("");
    const withIconState = readJson(brainPath(workspace));
    expect(withIconState.persona).toBe("Product (Doshi)");
    expect(withIconState.persona_icon).toBe("📦");
    expect(withIconState.last_score).toBe(92);
    expect(withIconState.last_cal).toBe(94);
  });

  test("no Protocol 1 header does not write and still nudges", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    const prior = "2026-07-04T12:00:00Z";
    writeLegacyState(home, baseState({ last_protocol_ts: prior, growth_total_turns: 5 }));

    const result = runHook(home, workspace, "Done.");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CODI STATUS SILENT DROP");
    const state = readJson(legacyPath(home));
    expect(state.last_protocol_ts).toBe(prior);
    expect(state.growth_total_turns).toBe(5);
  });

  test("corrupt existing state fails open and rewrites from an empty base", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    mkdirSync(join(home, ".codialectic"), { recursive: true });
    writeFileSync(legacyPath(home), '{"active":true,"last_protocol_ts":');

    const result = runHook(home, workspace, "⚠ Codi DEGRADED\nDone.");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const state = readJson(legacyPath(home));
    expect(typeof state.last_protocol_ts).toBe("string");
    expect(state.growth_total_turns).toBe(1);
    // corrupt-recovery rewrites from {} → must self-heal to active, not DEGRADED
    expect(state.active).toBe(true);
  });

  test("missing state file (dir exists) → from-scratch stamp self-heals to active=true (no DEGRADED path)", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    // Brain co-dialectic/ dir exists (as in a real workspace) but the state
    // FILE is missing: the hook must create it from scratch and self-heal to
    // active=true rather than write active:undefined → DEGRADED next turn.
    mkdirSync(dirname(brainPath(workspace)), { recursive: true });
    const before = Date.now();
    const result = runHook(home, workspace, "📦 Product · 88% · Cal: 96% · [12:00]\nDone.");
    const after = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const state = readJson(brainPath(workspace));
    expect(state.active).toBe(true);
    expect(state.growth_total_turns).toBe(1);
    expectFreshIso(state.last_protocol_ts, before, after);
  });

  test("first migration seeds missing brain state from existing legacy state", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    mkdirSync(dirname(brainPath(workspace)), { recursive: true });
    writeLegacyState(home, baseState({
      growth_total_turns: 7,
      mode: "cruise",
      verbosity: "verbose",
      wildcard: true,
    }));

    const result = runHook(home, workspace, "📦 Product · 90% · Cal: 94% · [12:00]\nDone.");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    const brain = readJson(brainPath(workspace));
    const legacy = readJson(legacyPath(home));
    expect(brain.growth_total_turns).toBe(8);
    expect(brain.mode).toBe("cruise");
    expect(brain.verbosity).toBe("verbose");
    expect(brain.wildcard).toBe(true);
    expect(brain.last_score).toBe(90);
    expect(brain.last_cal).toBe(94);
    expect(legacy.growth_total_turns).toBe(7);
    expect(legacy.last_score).toBe(88);
  });

  test("workspace canonical target replaces the legacy mirror", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    mkdirSync(dirname(brainPath(workspace)), { recursive: true });

    withEnv({ HOME: home, BRAIN_WORKSPACE_ROOT: workspace, CAREER_HOME: "" }, () => {
      const targets = resolveStateWriteTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]?.path).toBe(brainPath(workspace));
      expect(targets[0]?.authoritative).toBe(true);
      expect(authoritativeStatePath()).toBe(legacyStatePath());
      expect(legacyStatePath()).toBe(legacyPath(home));
    });
  });

  test("explicit active:false is preserved (user turned codi off), not forced true", () => {
    const home = makeTempDir("codi-xos-198-home-");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    const stale = isoSeconds(new Date(Date.now() - 2_000_000));
    writeBrainState(workspace, baseState({ active: false, last_protocol_ts: stale }));

    const result = runHook(home, workspace, "⚠ Codi DEGRADED · [12:00]\nDone.");

    expect(result.exitCode).toBe(0);
    const state = readJson(brainPath(workspace));
    expect(state.active).toBe(false); // nullish-coalesce preserves explicit false
  });

  test("legacy mirror failure does not prevent authoritative brain stamp", () => {
    const temp = makeTempDir("codi-xos-198-partial-");
    const homeFile = join(temp, "home-is-a-file");
    const workspace = makeTempDir("codi-xos-198-workspace-");
    writeFileSync(homeFile, "not a directory");
    writeBrainState(workspace, baseState({ growth_total_turns: 1 }));

    const result = runHook(homeFile, workspace, "📦 Product · 88% · Cal: 96% · [12:00]\nDone.");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const brain = readJson(brainPath(workspace));
    expect(brain.growth_total_turns).toBe(2);
    expect(brain.version).toBe(pluginVersion());
  });

  test("unreadable plugin version preserves existing version or omits it without crashing", () => {
    const temp = makeTempDir("codi-xos-198-version-");
    const fakeHookDir = join(temp, "hooks");
    mkdirSync(fakeHookDir, { recursive: true });

    const preservePath = join(temp, "preserve.json");
    writeJson(preservePath, { version: "8.8.8", growth_total_turns: 0 });
    stampProtocolHeartbeat(
      parseRenderedHeader("📦 Product · 88% · Cal: 96% · [12:00]"),
      new Date("2026-07-04T12:00:00Z"),
      { hookDir: fakeHookDir, targets: [{ path: preservePath, authoritative: true }] },
    );
    expect(readJson(preservePath).version).toBe("8.8.8");

    const omitPath = join(temp, "omit.json");
    writeJson(omitPath, { growth_total_turns: 0 });
    stampProtocolHeartbeat(
      parseRenderedHeader("📦 Product · 88% · Cal: 96% · [12:00]"),
      new Date("2026-07-04T12:00:00Z"),
      { hookDir: fakeHookDir, targets: [{ path: omitPath, authoritative: true }] },
    );
    expect("version" in readJson(omitPath)).toBe(false);
  });
});
