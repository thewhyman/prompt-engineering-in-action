/**
 * local-test-nudge.test.ts — XOS-195 local verification love-nudge.
 *
 * Run: bun test plugins/co-dialectic/hooks/local-test-nudge.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const LOCAL_TEST_NUDGE = join(import.meta.dir, "local-test-nudge.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function transcriptWithAssistant(message: string): string {
  return transcriptWithRecords([assistantTextRecord(message)]);
}

function assistantTextRecord(message: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: message }],
    },
  };
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

function bashToolUseRecord(command: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_test",
          name: "Bash",
          input: { command },
        },
      ],
    },
  };
}

function toolResultRecord(content: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_test", content }],
    },
  };
}

function transcriptWithRecords(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function writeTranscript(message: string): string {
  return writeTranscriptBody(transcriptWithAssistant(message));
}

function writeTranscriptRecords(records: Record<string, unknown>[]): string {
  return writeTranscriptBody(transcriptWithRecords(records));
}

function writeTranscriptBody(body: string): string {
  const transcriptPath = join(makeTempDir("codi-xos-195-transcript-"), "transcript.jsonl");
  writeFileSync(transcriptPath, body);
  return transcriptPath;
}

function runHook(input: unknown): { exitCode: number; stdout: string; stderr: string } {
  const stdinPath = join(makeTempDir("codi-xos-195-stdin-"), "stdin.json");
  writeFileSync(stdinPath, JSON.stringify(input));
  const proc = Bun.spawnSync([process.execPath, "run", LOCAL_TEST_NUDGE], {
    stdin: Bun.file(stdinPath),
    stdout: "pipe",
    stderr: "pipe",
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

function expectBlock(result: { exitCode: number; stdout: string; stderr: string }): void {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");

  const payload = JSON.parse(result.stdout);
  expect(payload.decision).toBe("block");
  expect(payload.reason).toContain("Local verification check");
  expect(payload.reason).toContain("project's env/config files");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("local-test-nudge Stop hook", () => {
  test("signal without evidence blocks once with the product-generic nudge", () => {
    const transcriptPath = writeTranscript("I can't test locally, no auth.");

    const result = runHook({ transcript_path: transcriptPath, stop_hook_active: false });

    expectBlock(result);
  });

  test("signal plus this-turn Bash test tool evidence stays silent", () => {
    const transcriptPath = writeTranscriptRecords([
      userTextRecord("Finish the change."),
      bashToolUseRecord("bun test"),
      toolResultRecord("1 pass"),
      assistantTextRecord("I can't test locally, no auth."),
    ]);

    const result = runHook({ transcript_path: transcriptPath });

    expectSilent(result);
  });

  test("signal plus stop_hook_active true stays silent", () => {
    const transcriptPath = writeTranscript("I can't test locally, no auth.");

    const result = runHook({ transcript_path: transcriptPath, stop_hook_active: true });

    expectSilent(result);
  });

  test("ambiguous auth prose without testing context stays silent", () => {
    const transcriptPath = writeTranscript("The API has no auth requirement, shipping now.");

    const result = runHook({ transcript_path: transcriptPath });

    expectSilent(result);
  });

  test("prose-only fenced 'run' with NO tool record still blocks — a claim is not a test", () => {
    const transcriptPath = writeTranscript([
      "I can't test locally, but here is the local run:",
      "",
      "```",
      "$ bun test",
      "1 pass",
      "```",
    ].join("\n"));

    const result = runHook({ transcript_path: transcriptPath });

    expectBlock(result);
  });

  test("plain 'localhost' typed in prose does not silence the block (gaming hole closed)", () => {
    const transcriptPath = writeTranscript(
      "I can't test locally, no auth — localhost:5432 needs the prod password.",
    );

    const result = runHook({ transcript_path: transcriptPath });

    expectBlock(result);
  });

  test("a PRIOR-turn tool run is not this-turn evidence — still blocks", () => {
    const transcriptPath = writeTranscriptRecords([
      bashToolUseRecord("bun test"),
      toolResultRecord("1 pass"),
      userTextRecord("Now do the next change."),
      assistantTextRecord("I can't test locally, no auth."),
    ]);

    const result = runHook({ transcript_path: transcriptPath });

    expectBlock(result);
  });

  test("signal plus a bare code block with no run/test signal still blocks", () => {
    const transcriptPath = writeTranscript([
      "I can't test locally — no auth. Here's the config I was going to use:",
      "",
      "```",
      '{ "feature": "content-nav", "enabled": true }',
      "```",
    ].join("\n"));

    const result = runHook({ transcript_path: transcriptPath });

    expectBlock(result);
  });

  test("normal final assistant message stays silent", () => {
    const transcriptPath = writeTranscript("Implemented the change and verified the behavior.");

    const result = runHook({ transcript_path: transcriptPath });

    expectSilent(result);
  });

  test("missing or malformed transcript_path fails open silently", () => {
    const malformedTranscript = join(makeTempDir("codi-xos-195-malformed-"), "transcript.jsonl");
    writeFileSync(malformedTranscript, "{not json}\n");

    for (const input of [
      {},
      { transcript_path: 42 },
      { transcript_path: join(makeTempDir("codi-xos-195-missing-"), "missing.jsonl") },
      { transcript_path: malformedTranscript },
    ]) {
      const result = runHook(input);

      expectSilent(result);
    }
  });
});
