import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";

/** Install dirs per agent, relative to the project root / $HOME (vercel-labs/skills conventions). */
export const AGENTS: Record<string, { project: string; global: string }> = {
  "claude-code": { project: ".claude/skills", global: ".claude/skills" },
  universal: { project: ".agents/skills", global: ".config/agents/skills" },
  cursor: { project: ".agents/skills", global: ".cursor/skills" },
  codex: { project: ".agents/skills", global: ".agents/skills" },
};
export const DEFAULT_AGENTS = ["claude-code", "universal"];

/** dist/src/core/skillfile.js → package root (three levels up). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function skillSourcePath(): string {
  return path.join(packageRoot(), "skills", "acctx", "SKILL.md");
}

export function skillTargets(agents: string[], scope: "project" | "global", cwd: string, home: string): string[] {
  const out: string[] = [];
  for (const a of agents) {
    const dirs = AGENTS[a];
    if (!dirs) throw new UserError(`Unknown agent "${a}".`, `Known: ${Object.keys(AGENTS).join(", ")}`);
    const p = path.join(scope === "project" ? cwd : home, dirs[scope], "acctx", "SKILL.md");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export const GUARD_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "acctx guard" }] };

export function mergeGuardHook(settingsText: string | null): { text: string; changed: boolean } {
  let settings: Record<string, unknown> = {};
  if (settingsText !== null && settingsText.trim() !== "") {
    try { settings = JSON.parse(settingsText); } catch (e) { throw new UserError(`settings.json is not valid JSON: ${(e as Error).message}`, "Fix it by hand, then run the install again."); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new UserError("settings.json must be a JSON object.");
  }
  const hooks = (settings["hooks"] && typeof settings["hooks"] === "object" ? settings["hooks"] : {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks["PreToolUse"]) ? (hooks["PreToolUse"] as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>) : [];
  const present = pre.some((h) => (h.hooks ?? []).some((x) => x.command === "acctx guard"));
  if (present) return { text: settingsText ?? "", changed: false };
  const next = { ...settings, hooks: { ...hooks, PreToolUse: [...pre, GUARD_HOOK] } };
  return { text: JSON.stringify(next, null, 2) + "\n", changed: true };
}
