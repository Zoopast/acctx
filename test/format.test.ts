import { test } from "node:test";
import assert from "node:assert/strict";
import { formatList, formatListJson, relativeTime, shortId, shouldColor } from "../src/core/format.js";

const now = new Date("2026-10-21T22:00:00Z");
const rows = [
  { provider: "vercel", name: "work", meta: { label: "octocat-at-acmeinc", identity: { label: "octocat-at-acmeinc", details: { userId: "Ab12Cd34Ef56Gh78Ij90Kl12", team: "team_Ab12Cd34Ef56Gh78Ij90Kl12" } }, createdAt: "", updatedAt: "2026-10-21T21:00:00Z", lastUsedAt: "2026-10-21T21:58:00Z" } },
  { provider: "vercel", name: "octocat", meta: { label: "octocat", identity: { label: "octocat", details: { userId: "Mn34Op56Qr78St90Uv12Wx34", team: "team_Mn34Op56Qr78St90Uv12Wx34" } }, createdAt: "", updatedAt: "2026-10-21T19:00:00Z" } },
];
const providers = [{ id: "vercel", displayName: "Vercel" }, { id: "convex", displayName: "Convex" }];

test("formatList groups by provider, marks active, aligns columns, shows empty providers", () => {
  const out = formatList(rows, { vercel: "work" }, { color: false, now, providers });
  assert.equal(out, [
    "Vercel",
    "  ● work     octocat-at-acmeinc  team team_Ab12Cd…Kl12  active · 2m ago",
    "    octocat                      team team_Mn34Op…Wx34  3h ago",
    "",
    "Convex",
    "  no profiles yet · acctx add convex <name>",
  ].join("\n"));
});

test("formatList never prints secrets and omits userId (label covers it)", () => {
  const out = formatList(rows, {}, { color: false, now, providers });
  assert.doesNotMatch(out, /Ab12Cd34Ef56Gh78Ij90Kl12|userId/);
});

test("color output wraps the active row in ANSI codes only when enabled", () => {
  assert.match(formatList(rows, { vercel: "work" }, { color: true, now }), /\x1b\[32m/);
  assert.doesNotMatch(formatList(rows, { vercel: "work" }, { color: false, now }), /\x1b/);
});

test("shouldColor respects NO_COLOR, FORCE_COLOR and TTY", () => {
  assert.equal(shouldColor({ NO_COLOR: "1" }, true), false);
  assert.equal(shouldColor({ FORCE_COLOR: "1" }, false), true);
  assert.equal(shouldColor({}, true), true);
  assert.equal(shouldColor({}, false), false);
  assert.equal(shouldColor({ TERM: "dumb" }, true), false);
});

test("relativeTime and shortId", () => {
  assert.equal(relativeTime("2026-10-21T21:59:40Z", now), "just now");
  assert.equal(relativeTime("2026-10-20T22:00:00Z", now), "1d ago");
  assert.equal(relativeTime(undefined, now), "");
  assert.equal(shortId("team_Ab12Cd34Ef56Gh78Ij90Kl12"), "team_Ab12Cd…Kl12");
  assert.equal(shortId("short"), "short");
  assert.equal(shortId("Octocat Example's team, Acmeinc"), "Octocat Example's team, Acmeinc");
});

test("formatListJson is machine readable", () => {
  const j = JSON.parse(formatListJson(rows, { vercel: "work" }));
  assert.equal(j[0].active, true);
  assert.equal(j[1].active, false);
  assert.equal(j[1].lastUsedAt, null);
  assert.equal(j[0].details.team, "team_Ab12Cd34Ef56Gh78Ij90Kl12");
});

test("list shows tags dimmed and in json", () => {
  const rows = [{ provider: "vercel", name: "work", meta: { label: "me@acme.com", identity: { label: "me@acme.com" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: ["team", "work"] } }];
  const text = formatList(rows, {}, { color: false, now: new Date("2026-01-01T00:00:00Z") });
  assert.match(text, /work\s+me@acme\.com\s+#team #work/);
  assert.deepEqual(JSON.parse(formatListJson(rows, {}))[0].tags, ["team", "work"]);
});
