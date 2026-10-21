import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";
import { helpText } from "../src/commands/index.js";
import { createUi } from "../src/core/ui.js";

test("parseArgs separates positionals and flags", () => {
  assert.deepEqual(parseArgs(["use", "vercel", "work", "--discard", "--x=1", "-f"]), {
    positional: ["use", "vercel", "work"],
    flags: { discard: true, x: "1", force: true },
  });
});

test("help text lists every command and stays free of ANSI when color is off", () => {
  const ui = createUi({ env: { NO_COLOR: "1" }, interactive: false, writeOut: () => {}, writeErr: () => {} });
  const h = helpText(ui);
  for (const c of ["add", "import", "use", "list", "current", "check", "rename", "remove", "providers"]) assert.match(h, new RegExp(`\\b${c}\\b`));
  assert.doesNotMatch(h, /\x1b/);
});

test("ui writes status to stderr and data to stdout", () => {
  const out: string[] = []; const err: string[] = [];
  const ui = createUi({ env: { NO_COLOR: "1" }, interactive: false, writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  ui.out("data"); ui.success("done"); ui.error("bad", "fix it");
  assert.deepEqual(out, ["data"]);
  assert.deepEqual(err, ["✓ done", "✗ bad", "  fix it"]);
});
