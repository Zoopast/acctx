import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { shouldColor } from "./format.js";

const code = (n: string) => (s: string) => `\x1b[${n}m${s}\x1b[0m`;
const plain = (s: string) => s;

export interface Styles {
  bold: (s: string) => string; dim: (s: string) => string; green: (s: string) => string;
  red: (s: string) => string; yellow: (s: string) => string; cyan: (s: string) => string; magenta: (s: string) => string;
}

export function styles(color: boolean): Styles {
  return color
    ? { bold: code("1"), dim: code("2"), green: code("32"), red: code("31"), yellow: code("33"), cyan: code("36"), magenta: code("35") }
    : { bold: plain, dim: plain, green: plain, red: plain, yellow: plain, cyan: plain, magenta: plain };
}

export const sym = { ok: "✓", fail: "✗", active: "●", arrow: "›", warn: "!", info: "·" };

export interface Ui {
  color: boolean;
  s: Styles;
  /** Data for stdout (lists, json). */
  out(text: string): void;
  /** Status for stderr, so piped stdout stays clean. */
  success(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, hint?: string): void;
  hint(msg: string): void;
  heading(text: string): string;
  /** Interactive single choice; numbered prompt when not a TTY. Returns null on cancel. */
  select<T>(title: string, items: T[], render: (item: T, i: number) => string): Promise<T | null>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
}

export interface UiOptions {
  env?: Record<string, string | undefined>;
  interactive?: boolean;
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
}

export function createUi(opts: UiOptions = {}): Ui {
  const env = opts.env ?? process.env;
  const color = shouldColor(env, Boolean(stdout.isTTY));
  const s = styles(color);
  const out = opts.writeOut ?? ((t: string) => stdout.write(t + "\n"));
  const err = opts.writeErr ?? ((t: string) => process.stderr.write(t + "\n"));
  const interactive = opts.interactive ?? Boolean(stdin.isTTY && stdout.isTTY);
  return {
    color, s, out,
    success: (m) => err(`${s.green(sym.ok)} ${m}`),
    info: (m) => err(`${s.dim(sym.info)} ${m}`),
    warn: (m) => err(`${s.yellow(sym.warn)} ${m}`),
    error: (m, hint) => { err(`${s.red(sym.fail)} ${m}`); if (hint) err(s.dim(hint.split("\n").map((l) => "  " + l).join("\n"))); },
    hint: (m) => err(s.dim(`  ${m}`)),
    heading: (t) => s.bold(t),
    select: (title, items, render) => interactive ? selectTty(title, items, render, s) : selectNumbered(title, items, render, err),
    confirm: async (q, defaultYes = false) => {
      if (!interactive) return defaultYes;
      const rl = readline.createInterface({ input: stdin, output: process.stderr });
      try {
        const a = (await rl.question(`${q} ${s.dim(defaultYes ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
        return a === "" ? defaultYes : a === "y" || a === "yes";
      } finally { rl.close(); }
    },
  };
}

async function selectNumbered<T>(title: string, items: T[], render: (i: T, n: number) => string, err: (s: string) => void): Promise<T | null> {
  err(title);
  items.forEach((it, i) => err(`  ${String(i + 1).padStart(2)}) ${render(it, i)}`));
  const rl = readline.createInterface({ input: stdin, output: process.stderr });
  try {
    const a = (await rl.question("Number: ")).trim();
    const n = Number(a);
    return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1]! : null;
  } finally { rl.close(); }
}

/** Arrow-key picker drawn on stderr. Restores the terminal on any exit path. */
function selectTty<T>(title: string, items: T[], render: (i: T, n: number) => string, s: Styles): Promise<T | null> {
  return new Promise((resolve) => {
    let idx = 0;
    const w = process.stderr;
    const lines = () => [
      `${s.bold(title)} ${s.dim("↑↓ move · enter select · esc back")}`,
      ...items.map((it, i) => (i === idx ? `${s.cyan(sym.arrow)} ${s.bold(render(it, i))}` : `  ${render(it, i)}`)),
    ];
    let drawn = 0;
    const draw = () => {
      if (drawn) w.write(`\x1b[${drawn}A\x1b[0J`);
      const ls = lines();
      w.write(ls.join("\n") + "\n");
      drawn = ls.length;
    };
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      w.write("\x1b[?25h");
    };
    const finish = (v: T | null) => { cleanup(); resolve(v); };
    const onData = (buf: Buffer) => {
      const k = buf.toString();
      if (k === "\x03") { cleanup(); process.exit(130); }
      if (k === "\x1b" || k === "q") return finish(null);
      if (k === "\r" || k === "\n") return finish(items[idx]!);
      if (k === "\x1b[A" || k === "k") idx = (idx - 1 + items.length) % items.length;
      else if (k === "\x1b[B" || k === "j") idx = (idx + 1) % items.length;
      else if (/^[1-9]$/.test(k) && Number(k) <= items.length) { idx = Number(k) - 1; draw(); return finish(items[idx]!); }
      else return;
      draw();
    };
    w.write("\x1b[?25l");
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    draw();
  });
}
