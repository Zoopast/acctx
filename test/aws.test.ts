import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { aws, _internal } from "../src/providers/aws.js";
import { Switcher } from "../src/core/switcher.js";
import { UserError } from "../src/core/errors.js";
import { fakeEnv, setup, tmpDir } from "./helpers.js";

const { getSection, upsertSection, parseKeys, splitSections } = _internal;

const KEY = "AKIAEXAMPLE000000001";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const CONFIG = `# my aws config
[default]
region = us-east-1
sso_session = corp
sso_account_id = 123456789012
sso_role_name = Admin
s3 =
  max_concurrent_requests = 10

[profile work]
region = eu-west-1
role_arn = arn:aws:iam::123456789012:role/work

[sso-session corp]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
`;

const CREDS = `[work]
aws_access_key_id = ${KEY}
aws_secret_access_key = ${SECRET}

[default]
aws_access_key_id = AKIAEXAMPLE000000002
aws_secret_access_key = ${SECRET}
`;

async function liveHome() {
  const home = await tmpDir();
  await fs.mkdir(path.join(home, ".aws"));
  await fs.writeFile(path.join(home, ".aws", "config"), CONFIG);
  await fs.writeFile(path.join(home, ".aws", "credentials"), CREDS);
  return home;
}

test("ini helpers get, upsert, remove and parse without touching other sections", () => {
  const body = getSection(CONFIG, "default")!;
  assert.match(body, /^region = us-east-1/);
  assert.equal(getSection(CONFIG, "profile  work")?.includes("eu-west-1"), true);
  assert.equal(getSection(CONFIG, "profile nope"), null);
  assert.deepEqual(parseKeys(body), { region: "us-east-1", sso_session: "corp", sso_account_id: "123456789012", sso_role_name: "Admin", s3: "" });
  assert.deepEqual(parseKeys("# c\n; c\nKey = A = B\n  nested = 1\n"), { key: "A = B" });

  const replaced = upsertSection(CONFIG, "[default]", "region = ap-south-1\n");
  assert.equal(replaced.replace("region = ap-south-1\n", "").length < CONFIG.length, true);
  assert.equal(getSection(replaced, "default"), "region = ap-south-1\n\n");
  assert.equal(getSection(replaced, "profile work"), getSection(CONFIG, "profile work"));
  assert.ok(replaced.startsWith("# my aws config\n[default]\n"));

  const appended = upsertSection("[a]\nx = 1\n", "[b]", "y = 2\n");
  assert.equal(appended, "[a]\nx = 1\n\n[b]\ny = 2\n");
  assert.equal(upsertSection("", "[b]", "y = 2\n"), "[b]\ny = 2\n");

  const removed = upsertSection(CONFIG, "[default]", null);
  const { sections } = splitSections(CONFIG);
  const rest = sections.filter((s) => s.name !== "default").map((s) => s.header + s.body).join("");
  assert.equal(removed, "# my aws config\n" + rest);
  assert.equal(upsertSection(CONFIG, "[profile missing]", null), CONFIG);
});

test("ini helpers keep CRLF files intact", () => {
  const text = "[default]\r\nregion = a\r\n\r\n[profile x]\r\nregion = b\r\n";
  const out = upsertSection(text, "[default]", "region = c\r\n");
  assert.equal(out, "[default]\r\nregion = c\r\n\r\n[profile x]\r\nregion = b\r\n");
  assert.equal(upsertSection(text, "[new]", "k = v\r\n"), text + "\r\n[new]\r\nk = v\r\n");
});

test("store reads default + referenced sso-session and writes only [default]", async () => {
  const home = await liveHome();
  await fs.chmod(path.join(home, ".aws", "config"), 0o640);
  const store = aws.liveStore!(fakeEnv(home));
  assert.equal(await store.exists(), true);
  const read = await store.read();
  const config = read["config"]!.toString();
  assert.ok(config.startsWith("[default]\nregion = us-east-1"));
  assert.match(config, /\[sso-session corp\]\nsso_start_url/);
  assert.doesNotMatch(config, /profile work/);
  assert.equal(read["credentials"]!.toString().startsWith("[default]\naws_access_key_id = AKIAEXAMPLE000000002"), true);
  assert.doesNotMatch(read["credentials"]!.toString(), /work/);

  const next = "[default]\nregion = ap-south-1\nsso_session = corp\n\n[sso-session corp]\nsso_start_url = https://new.example.awsapps.com/start\n";
  await store.write({ config: Buffer.from(next), credentials: null });
  const cfg = await fs.readFile(path.join(home, ".aws", "config"), "utf8");
  assert.ok(cfg.startsWith("# my aws config\n"));
  assert.equal(getSection(cfg, "profile work"), getSection(CONFIG, "profile work"));
  assert.match(getSection(cfg, "default")!, /ap-south-1/);
  assert.match(getSection(cfg, "sso-session corp")!, /new\.example/);
  const creds = await fs.readFile(path.join(home, ".aws", "credentials"), "utf8");
  assert.equal(getSection(creds, "default"), null);
  assert.match(getSection(creds, "work")!, new RegExp(KEY));
  assert.equal((await fs.stat(path.join(home, ".aws", "config"))).mode & 0o777, 0o640);
});

test("store creates ~/.aws privately and honours the AWS_* path variables", async () => {
  const home = await tmpDir();
  const env = fakeEnv(home);
  const store = aws.liveStore!(env);
  assert.equal(await store.exists(), false);
  assert.deepEqual(await store.read(), {});
  await store.write({ config: Buffer.from("[default]\nregion = x\n"), credentials: Buffer.from(`[default]\naws_access_key_id = ${KEY}\n`) });
  assert.equal((await fs.stat(path.join(home, ".aws"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(home, ".aws", "credentials"))).mode & 0o777, 0o600);
  assert.equal(await store.exists(), true);

  const custom = path.join(home, "elsewhere");
  const env2 = fakeEnv(home); env2.vars = { AWS_CONFIG_FILE: path.join(custom, "c"), AWS_SHARED_CREDENTIALS_FILE: path.join(custom, "k") };
  await aws.liveStore!(env2).write({ config: Buffer.from("[default]\nregion = y\n") });
  assert.match(await fs.readFile(path.join(custom, "c"), "utf8"), /region = y/);
  assert.deepEqual(aws.files(env2).map((f) => f.path), [path.join(custom, "c"), path.join(custom, "k")]);
});

test("exists is false with only named profiles and true with a default key", async () => {
  const home = await tmpDir();
  await fs.mkdir(path.join(home, ".aws"));
  await fs.writeFile(path.join(home, ".aws", "credentials"), `[work]\naws_access_key_id = ${KEY}\n`);
  await fs.writeFile(path.join(home, ".aws", "config"), "[default]\n# nothing yet\n");
  const store = aws.liveStore!(fakeEnv(home));
  assert.equal(await store.exists(), false);
  await fs.appendFile(path.join(home, ".aws", "config"), "region = us-east-1\n");
  assert.equal(await store.exists(), true);
});

test("credentials-only default still yields a config entry", async () => {
  const home = await tmpDir();
  await fs.mkdir(path.join(home, ".aws"));
  await fs.writeFile(path.join(home, ".aws", "credentials"), `[default]\naws_access_key_id = ${KEY}\n`);
  const read = await aws.liveStore!(fakeEnv(home)).read();
  assert.equal(read["config"]!.toString(), "[default]\n");
  assert.ok(read["credentials"]);
});

test("fingerprint uses the access key id, else the sso account/role, never the secret", async () => {
  const dir = await tmpDir();
  const c = path.join(dir, "credentials"); const g = path.join(dir, "config");
  await fs.writeFile(c, `[default]\naws_access_key_id = ${KEY}\naws_secret_access_key = ${SECRET}\n`);
  await fs.writeFile(g, "[default]\nsso_account_id = 123456789012\nsso_role_name = Admin\n");
  assert.equal(await aws.fingerprint!({ credentials: c, config: g }), `key:${KEY}`);
  assert.equal(await aws.fingerprint!({ config: g }), "sso:123456789012/Admin");
  assert.equal(await aws.fingerprint!({}), null);
  await fs.writeFile(g, "[default]\nregion = x\n");
  assert.equal(await aws.fingerprint!({ config: g }), null);
});

test("identify and verify call sts get-caller-identity in an isolated environment", async () => {
  const dir = await tmpDir();
  const seen: Array<Record<string, string | undefined>> = [];
  let mode: "ok" | "sso" | "bad" | "other" = "ok";
  const env = fakeEnv("/h", (_cmd, _args, opts) => {
    seen.push(opts.env ?? {});
    if (mode === "ok") return { code: 0, stdout: JSON.stringify({ UserId: "AIDAEXAMPLE", Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/alice" }), stderr: "" };
    if (mode === "sso") return { code: 255, stdout: "", stderr: "\nThe SSO session associated with this profile has expired or is otherwise invalid.\nTo refresh this SSO session run aws sso login\n" };
    if (mode === "bad") return { code: 254, stdout: "", stderr: "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation" };
    return { code: 1, stdout: "", stderr: "\n  something odd happened  \nsecond line" };
  });
  assert.deepEqual(await aws.identify(dir, env), { label: "user/alice", details: { account: "123456789012", arn: "arn:aws:iam::123456789012:user/alice" } });
  assert.equal(env.calls[0]!.cmd, "aws");
  assert.deepEqual(env.calls[0]!.args.slice(0, 2), ["sts", "get-caller-identity"]);
  const e = seen[0]!;
  assert.equal(e["AWS_CONFIG_FILE"], path.join(dir, "config"));
  assert.ok(String(e["AWS_CONFIG_FILE"]).endsWith("/config"));
  for (const k of aws.storage.overrideEnv) assert.ok(!e[k], `${k} must not be set`);
  assert.deepEqual(await aws.verify!(dir, env), { ok: true, label: "user/alice" });

  mode = "sso";
  assert.match((await aws.verify!(dir, env)).reason!, /aws sso login/);
  assert.equal(await aws.identify(dir, env), null);
  mode = "bad";
  assert.equal((await aws.verify!(dir, env)).reason, "credentials rejected by AWS");
  mode = "other";
  assert.equal((await aws.verify!(dir, env)).reason, "something odd happened");
  const missing = fakeEnv("/h", () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); });
  assert.equal((await aws.verify!(dir, missing)).reason, "aws CLI not found");
});

test("core switches the default section end to end and leaves named profiles alone", async () => {
  const { store } = await setup();
  const home = await liveHome();
  const env = fakeEnv(home, () => ({ code: 0, stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/alice" }), stderr: "" }));
  const sw = new Switcher(store, env);
  await sw.importLive(aws, "a");
  assert.equal(await sw.liveFingerprint(aws), await sw.profileFingerprint(aws, "a"));
  assert.equal(await sw.liveFingerprint(aws), "key:AKIAEXAMPLE000000002");

  // A second login: change the live default the way `aws configure` would.
  const live = aws.liveStore!(env);
  await live.write({ config: Buffer.from("[default]\nregion = eu-central-1\n"), credentials: Buffer.from(`[default]\naws_access_key_id = AKIAEXAMPLE000000003\naws_secret_access_key = ${SECRET}\n`) });
  await store.setActive("aws", null);
  await sw.importLive(aws, "b");
  assert.equal(await sw.liveFingerprint(aws), "key:AKIAEXAMPLE000000003");

  await sw.use(aws, "a");
  const cfg = await fs.readFile(path.join(home, ".aws", "config"), "utf8");
  const creds = await fs.readFile(path.join(home, ".aws", "credentials"), "utf8");
  assert.match(cfg, /# my aws config/);
  assert.match(getSection(cfg, "profile work")!, /eu-west-1/);
  assert.match(getSection(cfg, "default")!, /us-east-1/);
  assert.match(getSection(cfg, "sso-session corp")!, /sso_start_url/);
  assert.match(getSection(creds, "default")!, /AKIAEXAMPLE000000002/);
  assert.match(getSection(creds, "work")!, new RegExp(KEY));
  assert.equal(await sw.liveFingerprint(aws), await sw.profileFingerprint(aws, "a"));

  await sw.use(aws, "b");
  const cfg2 = await fs.readFile(path.join(home, ".aws", "config"), "utf8");
  assert.match(getSection(cfg2, "default")!, /eu-central-1/);
  assert.match(getSection(cfg2, "profile work")!, /eu-west-1/);
  assert.match(await fs.readFile(path.join(home, ".aws", "credentials"), "utf8"), /AKIAEXAMPLE000000003/);
});

test("loginIsolated accepts a configured default and rejects an empty result", async () => {
  const dir = await tmpDir();
  await aws.seedScratch!(dir);
  assert.equal((await fs.stat(path.join(dir, "config"))).mode & 0o777, 0o600);
  assert.match((await aws.validateFiles!(dir))!, /no \[default\]/);

  const good = fakeEnv("/h", async (cmd, args, opts) => {
    assert.equal(cmd, "aws"); assert.deepEqual(args, ["configure"]); assert.equal(opts.stdio, "inherit");
    await fs.writeFile(opts.env!["AWS_SHARED_CREDENTIALS_FILE"]!, `[default]\naws_access_key_id = ${KEY}\naws_secret_access_key = ${SECRET}\n`);
    await fs.writeFile(opts.env!["AWS_CONFIG_FILE"]!, "[default]\nregion = us-east-1\n");
    return { code: 0, stdout: "", stderr: "" };
  });
  await aws.loginIsolated!(dir, good);
  assert.equal(await aws.validateFiles!(dir), null);

  const empty = await tmpDir();
  await aws.seedScratch!(empty);
  await assert.rejects(aws.loginIsolated!(empty, fakeEnv("/h")), (e: unknown) => e instanceof UserError && /wrote nothing/.test(e.message));
  await assert.rejects(aws.loginIsolated!(empty, fakeEnv("/h", () => ({ code: 1, stdout: "", stderr: "" }))), /failed or was cancelled/);
  await assert.rejects(aws.loginIsolated!(empty, fakeEnv("/h", () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); })), /not installed/);
});
