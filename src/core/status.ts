import type { Store } from "./store.js";
import type { Switcher } from "./switcher.js";
import type { Provider } from "../providers/types.js";
import { resolveSelector, describeSelector, type Selector, type ProjectConfig } from "./project.js";
import { sym, type Styles } from "./ui.js";

export type StatusState = "ok" | "inactive" | "logged-out" | "unresolved" | "ambiguous" | "override";

export interface StatusEntry {
  provider: string;
  selector: Selector;
  profile: string | null;
  label: string | null;
  state: StatusState;
  candidates: string[];
  hint: string | null;
}

export async function entryStatus(store: Store, switcher: Switcher, provider: Provider, selector: Selector): Promise<StatusEntry> {
  const base = { provider: provider.id, selector, profile: null, label: null, candidates: [] as string[] };
  const profiles = await store.listProfiles(provider.id);
  const res = resolveSelector(selector, profiles);
  if (res.kind === "none") return { ...base, state: "unresolved", hint: `No ${provider.displayName} profile matches ${describeSelector(selector)}. Add one: acctx add ${provider.id} <name>${selector.tag ? `, then: acctx tag ${provider.id} <name> ${selector.tag}` : ""}` };
  if (res.kind === "many") return { ...base, state: "ambiguous", candidates: res.names, hint: `Several ${provider.displayName} profiles match ${describeSelector(selector)}: ${res.names.join(", ")}. Add a tag or profile field to pick one.` };
  const meta = profiles.find((p) => p.name === res.name)!.meta;
  const entry = { ...base, profile: res.name, label: meta.identity?.label ?? meta.label };
  const overrides = switcher.activeOverrides(provider);
  if (overrides.length) return { ...entry, state: "override", hint: `${overrides.join(", ")} is set; the ${provider.displayName} CLI will ignore the switched login. Unset it.` };
  const state = await store.readState();
  const live = await switcher.liveExists(provider);
  if (state.active[provider.id] !== res.name) return { ...entry, state: "inactive", hint: "acctx use" };
  if (!live) return { ...entry, state: "logged-out", hint: "acctx use" };
  if (provider.fingerprint) {
    const [lf, pf] = await Promise.all([switcher.liveFingerprint(provider), switcher.profileFingerprint(provider, res.name)]);
    if (lf !== pf) return { ...entry, state: "inactive", hint: "acctx use" };
  }
  return { ...entry, state: "ok", hint: null };
}

export async function projectStatus(store: Store, switcher: Switcher, reg: { getProvider(id: string): Provider }, project: ProjectConfig): Promise<StatusEntry[]> {
  const out: StatusEntry[] = [];
  for (const e of project.entries) out.push(await entryStatus(store, switcher, reg.getProvider(e.provider), e.selector));
  return out;
}

export function formatStatusLine(e: StatusEntry, s: Styles, width: number): string {
  const id = s.cyan(e.provider.padEnd(width));
  const who = e.profile ? `${s.bold(e.profile)} ${s.dim(`(${e.label ?? ""})`)}` : s.dim(describeSelector(e.selector));
  const mark = e.state === "ok" ? s.green(sym.ok) : e.state === "override" ? s.yellow(sym.warn) : s.red(sym.fail);
  const tail = e.hint ? `  ${s.dim(sym.arrow + " " + e.hint)}` : "";
  return `${id}  ${mark} ${e.state.padEnd(10)} ${who}${tail}`;
}
