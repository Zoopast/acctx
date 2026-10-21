import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactObject } from "../src/core/redact.js";

test("redact masks secret-looking keys and long opaque strings", () => {
  const s = 'token: "abc", refreshToken=xyz, {"accessToken":"q"} id=' + "A".repeat(40);
  const r = redact(s);
  assert.doesNotMatch(r, /abc|xyz|"q"|AAAA/);
  assert.match(r, /<redacted>/);
  assert.equal(redact("hello world user zoopast"), "hello world user zoopast");
});

test("redactObject masks by key", () => {
  const o = redactObject({ userId: "u1", token: "t", nested: { apiKey: "k", name: "n" } }) as any;
  assert.deepEqual(o, { userId: "u1", token: "<redacted>", nested: { apiKey: "<redacted>", name: "n" } });
});
