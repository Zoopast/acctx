const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const DLX = new Set(["pnpm", "yarn", "bun"]);

/** Provider CLIs invoked in command position of any shell segment. Conservative: it is a tokenizer, not a shell parser. */
export function invokedClis(command: string, clis: readonly string[]): string[] {
  const out: string[] = [];
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;        // env assignments
    if (i < words.length && RUNNERS.has(words[i]!)) i++;
    else if (i + 1 < words.length && DLX.has(words[i]!) && words[i + 1] === "dlx") i += 2;
    while (i < words.length && words[i]!.startsWith("-")) i++;                          // runner flags like -y
    const head = words[i];
    if (!head) continue;
    const name = head.split("/").pop()!;
    if (clis.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

export function parseHookPayload(text: string): { toolName: string | null; command: string | null; cwd: string | null } {
  try {
    const j = JSON.parse(text) as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { toolName: str(j.tool_name), command: str(j.tool_input?.command), cwd: str(j.cwd) };
  } catch {
    return { toolName: null, command: null, cwd: null };
  }
}
