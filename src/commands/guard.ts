import type { Context } from "../cli.js";
import { UserError } from "../core/errors.js";
import { loadProject } from "../core/project.js";
import { invokedClis, parseHookPayload } from "../core/guard.js";
import { projectStatus, formatStatusLine } from "../core/status.js";
import { redact } from "../core/redact.js";
import type { Registry } from "./project.js";

/** Claude Code PreToolUse hook. Exit 0 allows the tool call; exit 2 blocks it and shows stderr to the agent. */
export async function guardCmd(ctx: Context, reg: Registry, readStdin: () => Promise<string>): Promise<number> {
  const { ui } = ctx;
  try {
    const payload = parseHookPayload(await readStdin());
    if (payload.toolName !== "Bash" || !payload.command) return 0;
    const byCli = new Map(reg.providers.map((p) => [p.cli, p] as const));
    const hit = invokedClis(payload.command, [...byCli.keys()]);
    if (hit.length === 0) return 0;
    const project = await loadProject(payload.cwd ?? ctx.cwd, ctx.switcher.env.home, reg.providers.map((p) => p.id));
    if (!project) return 0;
    const wanted = new Set(hit.map((c) => byCli.get(c)!.id));
    const statuses = await projectStatus(ctx.store, ctx.switcher, reg, project, wanted);
    if (statuses.length === 0) return 0;
    const bad = statuses.filter((s) => s.state !== "ok");
    if (bad.length === 0) return 0;
    const w = Math.max(...bad.map((s) => s.provider.length));
    ui.error(`acctx: this project (${project.file}) expects other accounts for: ${bad.map((s) => s.provider).join(", ")}`);
    for (const s of bad) ui.hint(formatStatusLine(s, ui.s, w));
    ui.hint("Run: acctx use   (then retry). Ask the user before passing --discard.");
    return 2;
  } catch (e) {
    const msg = e instanceof UserError ? `${e.message}${e.hint ? "\n  " + e.hint : ""}` : (e as Error).message;
    ui.error(`acctx guard failed: ${redact(msg)}`, "Fix the problem, or remove the acctx guard hook from .claude/settings.json.");
    return 2;
  }
}
