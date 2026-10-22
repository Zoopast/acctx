import fs from "node:fs/promises";
import path from "node:path";
import { UserError } from "../core/errors.js";
import { exists, writeAtomic } from "../core/fsx.js";
import type { Env } from "../core/env.js";
import type { LiveStore } from "../core/livestore.js";
import { withoutOverrides, type Provider, type Identity, type VerifyResult } from "./types.js";

/**
 * The AWS CLI keeps named profiles in ~/.aws/config and ~/.aws/credentials.
 * acctx never swaps those files: the live login is only the [default] section
 * of each. Everything else (named profiles, comments, other sections) is
 * preserved byte for byte.
 */

export interface IniSection { header: string; name: string; body: string }

/** Section name as the CLI reads it: inner text trimmed, whitespace collapsed. */
function normalizeName(headerLine: string): string {
  const m = /^\s*\[([^\]]*)\]/.exec(headerLine);
  return (m?.[1] ?? "").trim().replace(/\s+/g, " ");
}

const isHeader = (line: string): boolean => /^\s*\[[^\]]*\]/.test(line);

/** Blank lines at the end of `s` (the separator before the next section). */
function trailingBlank(s: string): string {
  const lines = s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let out = "";
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") out = lines.pop()! + out;
  return out;
}

/**
 * Split INI text into a preamble and sections. `header` is the raw header line
 * including its line terminator, `body` everything up to the next header, so
 * `preamble + sections.map(s => s.header + s.body).join("")` equals the input.
 */
export function splitSections(text: string): { preamble: string; sections: IniSection[] } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let preamble = "";
  const sections: IniSection[] = [];
  for (const line of lines) {
    if (isHeader(line)) sections.push({ header: line, name: normalizeName(line), body: "" });
    else if (sections.length === 0) preamble += line;
    else sections[sections.length - 1]!.body += line;
  }
  return { preamble, sections };
}

/** Body of the (last) section with this normalised name, without the header; null when absent. */
export function getSection(text: string, name: string): string | null {
  const want = name.trim().replace(/\s+/g, " ");
  const found = splitSections(text).sections.filter((s) => s.name === want);
  return found.length ? found[found.length - 1]!.body : null;
}

/** Replace the section named like `header`, or append it; `body === null` removes it. */
export function upsertSection(text: string, header: string, body: string | null): string {
  const name = normalizeName(header);
  const { preamble, sections } = splitSections(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const withEol = (s: string): string => (s === "" || s.endsWith("\n") ? s : s + eol);
  const idx = sections.map((s) => s.name).lastIndexOf(name);
  if (idx === -1) {
    if (body === null) return text;
    let out = text;
    if (out !== "" && !out.endsWith("\n")) out += eol;
    if (out !== "" && !trailingBlank(out) && out.trim() !== "") out += eol;
    return out + header.replace(/[\r\n]+$/, "") + eol + withEol(body);
  }
  const old = sections[idx]!;
  if (body === null) sections.splice(idx, 1);
  else {
    let next = withEol(body);
    // Keep the blank separator lines that followed the old section.
    const trailing = trailingBlank(old.body);
    if (trailing && !trailingBlank(next)) next += trailing;
    sections[idx] = { ...old, body: next };
  }
  return preamble + sections.map((s) => s.header + s.body).join("");
}

/** `key = value` pairs of a section body; lowercase keys, comments and indented (nested) lines skipped. */
export function parseKeys(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line)) continue;
    if (line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.search(/[=:]/);
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (key) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

function configPath(env: Env): string {
  return env.vars["AWS_CONFIG_FILE"] || path.join(env.home, ".aws", "config");
}
function credsPath(env: Env): string {
  return env.vars["AWS_SHARED_CREDENTIALS_FILE"] || path.join(env.home, ".aws", "credentials");
}

async function readText(p: string): Promise<string> {
  try { return await fs.readFile(p, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

const hasKeys = (body: string | null): boolean => body !== null && Object.keys(parseKeys(body)).length > 0;

class AwsDefaultStore implements LiveStore {
  constructor(private readonly env: Env) {}

  async exists(): Promise<boolean> {
    const cfg = getSection(await readText(configPath(this.env)), "default");
    const cred = getSection(await readText(credsPath(this.env)), "default");
    return hasKeys(cfg) || hasKeys(cred);
  }

  async read(): Promise<Record<string, Buffer>> {
    const out: Record<string, Buffer> = {};
    const configText = await readText(configPath(this.env));
    const credsText = await readText(credsPath(this.env));
    const cfg = getSection(configText, "default");
    const cred = getSection(credsText, "default");
    if (cfg !== null) {
      const eol = eolOf(configText);
      let text = `[default]${eol}${cfg}`;
      const sso = parseKeys(cfg)["sso_session"];
      const ssoBody = sso ? getSection(configText, `sso-session ${sso}`) : null;
      if (sso && ssoBody !== null) text += `${text.endsWith("\n") ? "" : eol}${eol}[sso-session ${sso}]${eol}${ssoBody}`;
      out["config"] = Buffer.from(text);
    } else if (cred !== null) {
      out["config"] = Buffer.from("[default]\n");
    }
    if (cred !== null) out["credentials"] = Buffer.from(`[default]${eolOf(credsText)}${cred}`);
    return out;
  }

  async write(entries: Record<string, Buffer | null>): Promise<void> {
    if ("config" in entries) {
      const data = entries["config"];
      await this.update(configPath(this.env), (text) => {
        // An entry without a [default] section means "no default login": same as null.
        const { sections } = data ? splitSections(data.toString("utf8")) : { sections: [] as IniSection[] };
        const def = sections.filter((s) => s.name === "default").pop();
        let next = upsertSection(text, "[default]", def ? def.body : null);
        for (const s of sections) if (s.name.startsWith("sso-session ")) next = upsertSection(next, s.header, s.body);
        return next;
      });
    }
    if ("credentials" in entries) {
      const data = entries["credentials"];
      await this.update(credsPath(this.env), (text) => {
        const def = data ? splitSections(data.toString("utf8")).sections.filter((s) => s.name === "default").pop() : undefined;
        return upsertSection(text, "[default]", def ? def.body : null);
      });
    }
  }

  private async update(file: string, change: (text: string) => string): Promise<void> {
    const link = await fs.lstat(file).catch(() => null);
    if (link?.isSymbolicLink()) {
      file = await fs.realpath(file).catch(() => { throw new UserError(`${file} is a symlink to a missing file.`, "Fix or remove the link first."); });
    }
    const before = exists(file) ? await fs.readFile(file, "utf8") : null;
    const after = change(before ?? "");
    if (before === null && after === "") return;
    if (before === after) return;
    let mode = 0o600;
    try { mode = (await fs.stat(file)).mode & 0o777; } catch { /* new file */ }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeAtomic(file, after, mode);
  }
}

const CREDENTIAL_KEYS = ["aws_access_key_id", "sso_session", "sso_account_id", "sso_start_url", "role_arn", "credential_process", "credential_source", "source_profile", "web_identity_token_file"];

/** True when [default] of either file carries a credential-bearing key (not just region). */
async function hasCredentialDefault(dir: string): Promise<boolean> {
  for (const f of ["config", "credentials"]) {
    const body = getSection(await readText(path.join(dir, f)), "default");
    if (body !== null && CREDENTIAL_KEYS.some((k) => k in parseKeys(body))) return true;
  }
  return false;
}

async function hasDefault(dir: string): Promise<boolean> {
  for (const f of ["config", "credentials"]) {
    if (hasKeys(getSection(await readText(path.join(dir, f)), "default"))) return true;
  }
  return false;
}

function stsEnv(dir: string): Record<string, string | undefined> {
  const extra = Object.fromEntries(["AWS_SECURITY_TOKEN", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN"].map((k) => [k, undefined]));
  return { ...withoutOverrides(aws), ...extra, AWS_EC2_METADATA_DISABLED: "true", AWS_CLI_AUTO_PROMPT: "off", AWS_CONFIG_FILE: path.join(dir, "config"), AWS_SHARED_CREDENTIALS_FILE: path.join(dir, "credentials"), AWS_PAGER: "" };
}

async function callerIdentity(dir: string, env: Env): Promise<{ ok: true; id: { Account?: string; Arn?: string } } | { ok: false; reason: string }> {
  let res;
  try {
    res = await env.run("aws", ["sts", "get-caller-identity", "--output", "json"], { stdio: "pipe", timeoutMs: 20_000, env: stsEnv(dir) });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "aws CLI not found" };
    return { ok: false, reason: (e as Error).message.split("\n")[0]!.trim().slice(0, 120) };
  }
  if (res.code !== 0) {
    const err = res.stderr;
    if (/InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken|UnrecognizedClientException/.test(err)) return { ok: false, reason: "credentials rejected by AWS" };
    if (/token.*expired|sso.*(expired|login)/i.test(err)) return { ok: false, reason: "SSO session expired; run: aws sso login" };
    const first = err.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? `aws exited with code ${res.code}`;
    return { ok: false, reason: first.slice(0, 120) };
  }
  try {
    const id = JSON.parse(res.stdout) as { Account?: string; Arn?: string };
    return id.Arn ? { ok: true, id } : { ok: false, reason: "unexpected response from aws sts" };
  } catch {
    return { ok: false, reason: "unexpected response from aws sts" };
  }
}

export const aws: Provider = {
  id: "aws",
  displayName: "AWS",
  installHint: "https://docs.aws.amazon.com/cli/ (aws)",
  cli: "aws",
  loginMode: "isolated",
  storage: {
    summary: "The AWS CLI keeps named profiles in two INI files; acctx manages only the [default] section of each and leaves every named profile alone.",
    location: "$AWS_CONFIG_FILE or ~/.aws/config, and $AWS_SHARED_CREDENTIALS_FILE or ~/.aws/credentials — [default] sections only",
    login: "`aws configure` run with AWS_CONFIG_FILE/AWS_SHARED_CREDENTIALS_FILE pointing at a scratch directory, so your real files are untouched until you switch. SSO users: set up [default] with `aws configure sso` (profile name `default`), then `acctx import aws <name>`.",
    identity: "Offline: aws_access_key_id, or sso_account_id + sso_role_name. Online: `aws sts get-caller-identity` against the profile's files (account id and ARN).",
    overrideEnv: ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
    caveats: [
      "Static access keys in [default] are long-lived secrets; `acctx remove` deletes the local copy but does not deactivate the key in IAM.",
      "An [sso-session] block referenced by [default] is saved with the profile and merged back on switch; the SSO token cache under ~/.aws/sso/cache is shared and is not switched. If it has expired, `acctx check` says so and `aws sso login` refreshes it.",
      "`[profile default]` in config is treated by the AWS CLI as the same profile as `[default]` and acctx does not manage it; rename it if present.",
      "A `[default]` that chains through `source_profile`, `credential_process` or `role_arn` depends on named profiles that are not saved with the acctx profile, so `acctx check` may fail for it and no offline fingerprint is available.",
      "A saved `[sso-session NAME]` block replaces the live block of the same name on switch.",
      "Tools that pin AWS_PROFILE in a .envrc or shell rc bypass the default section entirely; acctx warns when those variables are set.",
    ],
    verified: "Linux, aws-cli 2.36: import of a static-key [default], status, use (round trip), check via sts get-caller-identity.",
  },
  files(env) {
    return [
      { name: "config", path: configPath(env), required: true, mode: 0o600, virtual: true },
      { name: "credentials", path: credsPath(env), required: false, mode: 0o600, virtual: true },
    ];
  },
  liveStore: (env) => new AwsDefaultStore(env),

  async seedScratch(dir) {
    await writeAtomic(path.join(dir, "config"), "", 0o600);
    await writeAtomic(path.join(dir, "credentials"), "", 0o600);
  },

  async loginIsolated(dir, env) {
    const res = await env.run("aws", ["configure"], { stdio: "inherit", env: stsEnv(dir) }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new UserError("The `aws` CLI is not installed or not on PATH.", `Install it: ${aws.installHint}`);
      throw e;
    });
    if (res.code !== 0) throw new UserError("AWS configure failed or was cancelled.");
    if (!(await hasDefault(dir))) {
      throw new UserError("aws configure wrote nothing.", "Enter at least an access key and region, or import an existing [default] with: acctx import aws <name>");
    }
  },

  async validateFiles(dir) {
    if (await hasCredentialDefault(dir)) return null;
    return (await hasDefault(dir)) ? "no credentials in [default] (region only)" : "no [default] section found";
  },

  async fingerprint(paths) {
    const cred = paths["credentials"] ? getSection(await readText(paths["credentials"]), "default") : null;
    const key = cred ? parseKeys(cred)["aws_access_key_id"] : undefined;
    if (key) return `key:${key}`;
    const cfg = paths["config"] ? getSection(await readText(paths["config"]), "default") : null;
    const k = cfg ? parseKeys(cfg) : {};
    return k["sso_account_id"] && k["sso_role_name"] ? `sso:${k["sso_account_id"]}/${k["sso_role_name"]}` : null;
  },

  async identify(dir, env): Promise<Identity | null> {
    const r = await callerIdentity(dir, env);
    if (!r.ok) return null;
    const arn = r.id.Arn!;
    return { label: arn.slice(arn.lastIndexOf(":") + 1), details: { account: r.id.Account ?? "", arn } };
  },

  async verify(dir, env): Promise<VerifyResult> {
    const r = await callerIdentity(dir, env);
    if (!r.ok) return { ok: false, reason: r.reason };
    const arn = r.id.Arn!;
    return { ok: true, label: arn.slice(arn.lastIndexOf(":") + 1) };
  },
};

export const _internal = { splitSections, getSection, upsertSection, parseKeys, AwsDefaultStore };
