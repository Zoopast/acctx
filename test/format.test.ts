import { test } from "node:test";
import assert from "node:assert/strict";
import { formatList, formatListJson, relativeTime, shortId, shouldColor } from "../src/core/format.js";

const now = new Date("2026-10-21T22:00:00Z");
const rows = [
  { provider: "vercel", name: "work", meta: { label: "gsanmartin-gravita", identity: { label: "gsanmartin-gravita", details: { userId: "fadxuS9oFdHieoOYl1FrYyJN", team: "team_jBOk3W6v1yEoFzTXMZa7VzaJ" } }, createdAt: "", updatedAt: "2026-10-21T21:00:00Z", lastUsedAt: "2026-10-21T21:58:00Z" } },
  { provider: "vercel", name: "zoopast", meta: { label: "zoopast", identity: { label: "zoopast", details: { userId: "iAzBkq8mRFpiIN7G6sMFMhjw", team: "team_Ei2gYESffUrpPfeoc7V6TOpv" } }, createdAt: "", updatedAt: "2026-10-21T19:00:00Z" } },
];
const providers = [{ id: "vercel", displayName: "Vercel" }, { id: "convex", displayName: "Convex" }];

test("formatList groups by provider, marks active, aligns columns, shows empty providers", () => {
  const out = formatList(rows, { vercel: "work" }, { color: false, now, providers });
  assert.equal(out, [
    "Vercel",
    "  ● work     gsanmartin-gravita  team team_jBOk3W…VzaJ  active · 2m ago",
    "    zoopast                      team team_Ei2gYE…TOpv  3h ago",
    "",
    "Convex",
    "  no profiles yet · acctx add convex <name>",
  ].join("\n"));
});

test("formatList never prints secrets and omits userId (label covers it)", () => {
  const out = formatList(rows, {}, { color: false, now, providers });
  assert.doesNotMatch(out, /fadxuS9oFdHieoOYl1FrYyJN|userId/);
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
  assert.equal(shortId("team_jBOk3W6v1yEoFzTXMZa7VzaJ"), "team_jBOk3W…VzaJ");
  assert.equal(shortId("short"), "short");
  assert.equal(shortId("Gabriel San Martín's team, Gravita"), "Gabriel San Martín's team, Gravita");
});

test("formatListJson is machine readable", () => {
  const j = JSON.parse(formatListJson(rows, { vercel: "work" }));
  assert.equal(j[0].active, true);
  assert.equal(j[1].active, false);
  assert.equal(j[1].lastUsedAt, null);
  assert.equal(j[0].details.team, "team_jBOk3W6v1yEoFzTXMZa7VzaJ");
});
