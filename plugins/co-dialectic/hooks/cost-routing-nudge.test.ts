/**
 * cost-routing-nudge.test.ts — XOS-199 cost-routing love-nudge.
 *
 * Run: bun test hooks/cost-routing-nudge.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const COST_ROUTING_NUDGE = join(import.meta.dir, "cost-routing-nudge.ts");
const USER_PROMPT_SUBMIT = join(import.meta.dir, "user-prompt-submit.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `const value${index} = ${index};`).join("\n");
}

function userTextRecord(message: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: message,
    },
  };
}

function toolUse(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "tool_use",
    id: `toolu_${Math.random().toString(16).slice(2)}`,
    name,
    input,
  };
}

function assistantToolRecord(
  model: string | null,
  toolUses: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      ...(model ? { model } : {}),
      content: toolUses,
    },
  };
}

function transcriptWithRecords(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function writeTranscriptRecords(records: Record<string, unknown>[]): string {
  const transcriptPath = join(makeTempDir("codi-xos-199-transcript-"), "transcript.jsonl");
  writeFileSync(transcriptPath, transcriptWithRecords(records));
  return transcriptPath;
}

function qualifyingCodeTranscript(model = "claude-opus-4-8"): string {
  return writeTranscriptRecords([
    userTextRecord("Build it."),
    assistantToolRecord(model, [
      toolUse("Write", { file_path: "src/feature.ts", content: makeLines(60) }),
    ]),
  ]);
}

function hookEnv(stateDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    CODI_STATE_DIR: stateDir,
    HOME: makeTempDir("codi-xos-199-home-"),
    BRAIN_WORKSPACE_ROOT: makeTempDir("codi-xos-199-workspace-"),
    CAREER_HOME: "",
    CLAUDE_PLUGIN_ROOT: "",
    ...extra,
  };
}

function runHook(
  input: unknown,
  env: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const stdinPath = join(makeTempDir("codi-xos-199-stdin-"), "stdin.json");
  writeFileSync(stdinPath, JSON.stringify(input));
  const proc = Bun.spawnSync([process.execPath, "run", COST_ROUTING_NUDGE], {
    stdin: Bun.file(stdinPath),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

function runUserPromptSubmit(
  input: unknown,
  env: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const stdinPath = join(makeTempDir("codi-xos-199-ups-stdin-"), "stdin.json");
  writeFileSync(stdinPath, JSON.stringify(input));
  const proc = Bun.spawnSync([process.execPath, USER_PROMPT_SUBMIT], {
    stdin: Bun.file(stdinPath),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

function expectSilent(result: { exitCode: number; stdout: string; stderr: string }): void {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
}

function expectNudge(result: { exitCode: number; stdout: string; stderr: string }): string {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toBe("");
  const payload = JSON.parse(result.stdout);
  expect(payload.decision).not.toBe("block");
  expect(typeof payload.systemMessage).toBe("string");
  return payload.systemMessage;
}

function costStatePath(stateDir: string, sessionId: string): string {
  return join(stateDir, "cost-nudge", `${sessionId}.json`);
}

function readCostState(stateDir: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(costStatePath(stateDir, sessionId), "utf8"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("cost-routing-nudge Stop hook", () => {
  test("60-line Write to a code file on a whale model fires and writes per-session state", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const transcriptPath = qualifyingCodeTranscript();

    const nudge = expectNudge(runHook({ transcript_path: transcriptPath, session_id: "s1" }, env));

    expect(nudge).toContain("hand-authored ~60 lines of code directly");
    const state = readCostState(stateDir, "s1");
    expect(state.fire_count).toBe(1);
    expect(state.pending).toBe(true);
    expect(state.last_trigger).toBe("code-volume");
    expect(state.last_authored_code_lines).toBe(60);
  });

  test("two small edits stay silent below the volume threshold", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const transcriptPath = writeTranscriptRecords([
      userTextRecord("Patch the small thing."),
      assistantToolRecord("claude-fable-5", [
        toolUse("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "a\nb" }),
        toolUse("Edit", { file_path: "src/b.ts", old_string: "c", new_string: "c\nd" }),
      ]),
    ]);

    const result = runHook({ transcript_path: transcriptPath, session_id: "small-edits" }, env);

    expectSilent(result);
    expect(existsSync(costStatePath(stateDir, "small-edits"))).toBe(false);
  });

  test("delegation evidence suppresses a qualifying code turn", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const transcriptPath = writeTranscriptRecords([
      userTextRecord("Build the feature."),
      assistantToolRecord("claude-opus-4-8", [
        toolUse("Write", { file_path: "src/generated.ts", content: makeLines(80) }),
        toolUse("Bash", { command: "codex exec 'build this feature'" }),
      ]),
    ]);

    const result = runHook({ transcript_path: transcriptPath, session_id: "delegated" }, env);

    expectSilent(result);
  });

  test("markdown and scratchpad/tmp code paths are excluded", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const cases = [
      {
        session: "markdown",
        tool: toolUse("Edit", { file_path: "docs/spec.md", old_string: "", new_string: makeLines(80) }),
      },
      {
        session: "tmp",
        tool: toolUse("Edit", { file_path: "/tmp/x.ts", old_string: "", new_string: makeLines(80) }),
      },
      {
        session: "scratch",
        tool: toolUse("Write", { file_path: "scratchpad/x.ts", content: makeLines(80) }),
      },
    ];

    for (const item of cases) {
      const transcriptPath = writeTranscriptRecords([
        userTextRecord("Analyze with a scratch file."),
        assistantToolRecord("claude-opus-4-8", [item.tool]),
      ]);
      expectSilent(runHook({ transcript_path: transcriptPath, session_id: item.session }, env));
    }
  });

  test("browser trigger ignores one screenshot but fires on three calls and two DOM dumps", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const oneScreenshot = writeTranscriptRecords([
      userTextRecord("Smoke check this page."),
      assistantToolRecord("claude-fable-5", [
        toolUse("mcp__playwright__browser_screenshot", { name: "shot" }),
      ]),
    ]);

    expectSilent(runHook({ transcript_path: oneScreenshot, session_id: "one-shot" }, env));

    const threeBrowser = writeTranscriptRecords([
      userTextRecord("Drive the browser."),
      assistantToolRecord("claude-fable-5", [
        toolUse("mcp__playwright__browser_navigate", { url: "https://example.com" }),
        toolUse("mcp__playwright__browser_click", { selector: "button" }),
        toolUse("mcp__playwright__browser_screenshot", { name: "shot" }),
      ]),
    ]);
    expect(expectNudge(runHook({ transcript_path: threeBrowser, session_id: "three-browser" }, env)))
      .toContain("browser/bulk work directly");

    const twoDomDumps = writeTranscriptRecords([
      userTextRecord("Inspect DOM."),
      assistantToolRecord("claude-opus-4-8", [
        toolUse("mcp__playwright__take_snapshot", {}),
        toolUse("mcp__playwright__read_page", {}),
      ]),
    ]);
    expect(expectNudge(runHook({ transcript_path: twoDomDumps, session_id: "two-dom" }, env)))
      .toContain("browser/bulk work directly");
  });

  test("non-whale and missing model turns stay silent", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    for (const [session, model] of [
      ["haiku", "claude-haiku-4-5"],
      ["sonnet", "claude-sonnet-4-5"],
      ["missing-model", null],
      ["synthetic", "<synthetic>"],
    ] as const) {
      const transcriptPath = writeTranscriptRecords([
        userTextRecord("Build it."),
        assistantToolRecord(model, [
          toolUse("Write", { file_path: "src/feature.ts", content: makeLines(80) }),
        ]),
      ]);
      expectSilent(runHook({ transcript_path: transcriptPath, session_id: session }, env));
    }
  });

  test("escalates through three fires and stays silent on the fourth", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const sessionId = "escalate";

    expect(expectNudge(runHook({ transcript_path: qualifyingCodeTranscript(), session_id: sessionId }, env)))
      .toContain("hand-authored ~60 lines");
    expect(expectNudge(runHook({ transcript_path: qualifyingCodeTranscript(), session_id: sessionId }, env)))
      .toContain("2nd time this session");
    expect(readCostState(stateDir, sessionId).fire_count).toBe(2);
    expect(expectNudge(runHook({ transcript_path: qualifyingCodeTranscript(), session_id: sessionId }, env)))
      .toContain("3rd time this session");
    expect(readCostState(stateDir, sessionId).fire_count).toBe(3);

    expectSilent(runHook({ transcript_path: qualifyingCodeTranscript(), session_id: sessionId }, env));
    expect(readCostState(stateDir, sessionId).fire_count).toBe(3);
  });

  test("UserPromptSubmit injects fresh nudge once and consumes the flag", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const sessionId = "inject";
    expectNudge(runHook({ transcript_path: qualifyingCodeTranscript(), session_id: sessionId }, env));

    const injected = runUserPromptSubmit({ session_id: sessionId }, env);
    expect(injected.exitCode).toBe(0);
    expect(injected.stderr).toBe("");
    const injectedPayload = JSON.parse(injected.stdout);
    const injectedContext = injectedPayload.hookSpecificOutput.additionalContext;
    expect(injectedContext).toContain("🐟 This turn hand-authored ~60 lines");

    const consumed = readCostState(stateDir, sessionId);
    expect(consumed.pending).toBe(false);
    expect(consumed.nudge).toBeNull();
    expect(typeof consumed.consumed_at).toBe("string");

    const noRecord = runUserPromptSubmit({ session_id: "no-record" }, env);
    expect(noRecord.exitCode).toBe(0);
    expect(noRecord.stderr).toBe("");
    const noRecordPayload = JSON.parse(noRecord.stdout);
    expect(noRecordPayload.hookSpecificOutput.additionalContext).not.toContain("🐟");
  });

  test("malformed transcript and missing session_id fail open silently", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const env = hookEnv(stateDir);
    const malformedTranscript = join(makeTempDir("codi-xos-199-malformed-"), "transcript.jsonl");
    writeFileSync(malformedTranscript, "{not json}\n");

    expectSilent(runHook({ transcript_path: malformedTranscript, session_id: "bad" }, env));
    expectSilent(runHook({ transcript_path: qualifyingCodeTranscript() }, env));
  });

  test("GC removes stale per-session files opportunistically", () => {
    const stateDir = makeTempDir("codi-xos-199-state-");
    const staleDir = join(stateDir, "cost-nudge");
    mkdirSync(staleDir, { recursive: true });
    const stalePath = join(staleDir, "old.json");
    writeFileSync(stalePath, JSON.stringify({ fire_count: 1 }) + "\n");
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, oldDate, oldDate);

    const env = hookEnv(stateDir);
    expectNudge(runHook({ transcript_path: qualifyingCodeTranscript(), session_id: "fresh" }, env));

    expect(existsSync(stalePath)).toBe(false);
  });
});
