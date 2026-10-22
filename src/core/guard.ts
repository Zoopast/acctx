const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const PKG_MANAGERS = new Set(["pnpm", "yarn", "bun", "npm"]);
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "{", "!"]);
const WRAPPERS = new Set(["sudo", "time", "command", "env", "nohup", "exec", "xargs", "nice", "doas"]);
const WRAPPERS_WITH_FLAGS = new Set(["sudo", "env", "nice", "doas"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Provider CLIs invoked in command position of any shell segment. Conservative: it is a tokenizer, not a shell parser.
 * Known limitation: a `;` or `&` inside quotes still splits, so `echo "a; vercel"` is a false positive.
 */
export function invokedClis(command: string, clis: readonly string[]): string[] {
  const out: string[] = [];
  const add = (name: string) => { if (!out.includes(name)) out.push(name); };
  for (const segment of command.split(/\|\||&&|\|&|\$\(|[|;&\n()`]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // keywords, env assignments and wrappers can stack in any order
    for (;;) {
      const w = words[i];
      if (w === undefined) break;
      if (KEYWORDS.has(w) || ASSIGNMENT.test(w)) { i++; continue; }
      if (WRAPPERS.has(w)) {
        i++;
        if (WRAPPERS_WITH_FLAGS.has(w)) {
          while (i < words.length && words[i]!.startsWith("-")) {
            const f = words[i]!;
            const takesValue = (w === "nice" && f === "-n") || ((w === "sudo" || w === "doas") && ["-u", "-g", "--user", "--group"].includes(f));
            i += takesValue ? 2 : 1;
          }
        }
        continue;
      }
      break;
    }
    const skipFlags = () => {
      while (i < words.length && words[i]!.startsWith("-")) {
        i += words[i] === "-p" || words[i] === "--package" ? 2 : 1;
      }
    };
    const first = words[i];
    if (first === undefined) continue;
    if (RUNNERS.has(first)) {
      i++; skipFlags();
    } else if (PKG_MANAGERS.has(first)) {
      const next = words[i + 1];
      if (next === "dlx" || (next === "exec" && first !== "bun") || (next === "x" && first === "bun")) { i += 2; skipFlags(); }
      else if (first !== "npm" && next !== undefined && clis.includes(next)) i++;
      else continue;
    } else if (SHELLS.has(first.split("/").pop()!)) {
      const c = words.indexOf("-c", i + 1);
      if (c >= 0) for (const n of invokedClis(words.slice(c + 1).join(" ").replace(/^["']|["']$/g, ""), clis)) add(n);
      continue;
    }
    const head = words[i];
    if (!head) continue;
    const name = head.split("/").pop()!;
    if (clis.includes(name)) add(name);
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
