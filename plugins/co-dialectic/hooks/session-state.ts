import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface SessionAwareHookInput {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  workspace?: string | {
    current_dir?: string;
    project_dir?: string;
  };
}

export function safeSessionId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "");
  if (sanitized.length > 0 && sanitized.length <= 96) return sanitized;
  return `session-${createHash("sha256").update(trimmed).digest("hex").slice(0, 12)}`;
}

export function sessionIdFromHookInput(input: SessionAwareHookInput): string | null {
  return safeSessionId(input.session_id ?? input.sessionId);
}

export function codiStateDir(): string {
  return (
    process.env.CODI_STATE_DIR?.trim() ||
    join(process.env.HOME?.trim() || homedir(), ".codialectic")
  );
}

export function sessionStatePath(sessionId: string): string {
  return join(codiStateDir(), "sessions", `${sessionId}.json`);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function workspaceRootFromInput(input: SessionAwareHookInput): string {
  const explicitRoot = nonEmpty(process.env.BRAIN_WORKSPACE_ROOT);
  if (explicitRoot) return explicitRoot;

  if (typeof input.workspace === "string") {
    const workspace = nonEmpty(input.workspace);
    if (workspace) return workspace;
  } else if (input.workspace && typeof input.workspace === "object") {
    const projectDir = nonEmpty(input.workspace.project_dir);
    if (projectDir) return projectDir;
    const currentDir = nonEmpty(input.workspace.current_dir);
    if (currentDir) return currentDir;
  }

  const cwd = nonEmpty(input.cwd);
  if (cwd) return cwd;
  return nonEmpty(process.env.CAREER_HOME) ?? process.cwd();
}

export function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function atomicWriteJson(path: string, value: Record<string, unknown>): void {
  const dir = dirname(path);
  const tmpPath = join(
    dir,
    `.session-state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmpPath, path);
}
