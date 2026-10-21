import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";

test("parseArgs separates positionals and flags", () => {
  assert.deepEqual(parseArgs(["use", "vercel", "work", "--discard", "--x=1", "-f"]), {
    positional: ["use", "vercel", "work"],
    flags: { discard: true, x: "1", force: true },
  });
});
