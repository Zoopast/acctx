import type { ProfileMeta } from "./store.js";
import type { Provider } from "../providers/types.js";

export interface ListRow { provider: string; name: string; meta: ProfileMeta }

export interface FormatOptions {
  color: boolean;
  now?: Date;
  /** Providers to always show, even with zero profiles. */
  providers?: readonly Pick<Provider, "id" | "displayName">[];
}

const ansi = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const styles = {
  bold: ansi("1"),
  dim: ansi("2"),
  green: ansi("32"),
  cyan: ansi("36"),
};

export function shouldColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  return isTTY && env["TERM"] !== "dumb";
}

export function relativeTime(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** Shorten opaque ids like team_jBOk3W6v1yEoFzTXMZa7VzaJ → team_jBOk3W…VzaJ */
export function shortId(v: string): string {
  // Only opaque ids like team_jBOk3W6v1yEoFzTXMZa7VzaJ; human text is left alone.
  const m = /^([a-z]+_)([A-Za-z0-9]{16,})$/.exec(v);
  if (!m) return v;
  return `${m[1]}${m[2]!.slice(0, 6)}…${m[2]!.slice(-4)}`;
}

function detailsOf(meta: ProfileMeta): string {
  const d = meta.identity?.details;
  if (!d) return "";
  return Object.entries(d)
    .filter(([k]) => k !== "userId") // the label already identifies the user
    .map(([k, v]) => `${k} ${shortId(v)}`)
    .join("  ");
}

export function formatList(rows: ListRow[], active: Record<string, string>, opts: FormatOptions): string {
  const now = opts.now ?? new Date();
  const c = opts.color ? styles : { bold: (s: string) => s, dim: (s: string) => s, green: (s: string) => s, cyan: (s: string) => s };
  const providerIds = new Set<string>([...(opts.providers ?? []).map((p) => p.id), ...rows.map((r) => r.provider)]);
  const names = new Map((opts.providers ?? []).map((p) => [p.id, p.displayName]));
  const out: string[] = [];

  for (const id of providerIds) {
    const group = rows.filter((r) => r.provider === id);
    out.push(c.bold(names.get(id) ?? id));
    if (group.length === 0) {
      out.push(c.dim(`  no profiles yet · acctx add ${id} <name>`));
      out.push("");
      continue;
    }
    const table = group.map((r) => ({
      active: active[id] === r.name,
      name: r.name,
      label: r.meta.label === r.name ? "" : r.meta.label,
      tags: (r.meta.tags ?? []).map((t) => "#" + t).join(" "),
      details: detailsOf(r.meta),
      used: relativeTime(r.meta.lastUsedAt ?? r.meta.updatedAt, now),
    }));
    const w = {
      name: Math.max(...table.map((t) => t.name.length)),
      label: Math.max(...table.map((t) => t.label.length)),
      tags: Math.max(...table.map((t) => t.tags.length)),
      details: Math.max(...table.map((t) => t.details.length)),
    };
    for (const t of table) {
      const marker = t.active ? c.green("●") : " ";
      const name = t.active ? c.bold(c.green(t.name.padEnd(w.name))) : t.name.padEnd(w.name);
      const cells = [name];
      if (w.label) cells.push(c.cyan(t.label.padEnd(w.label)));
      if (w.tags) cells.push(c.dim(t.tags.padEnd(w.tags)));
      if (w.details) cells.push(c.dim(t.details.padEnd(w.details)));
      if (t.used) cells.push(c.dim(t.active ? "active · " + t.used : t.used));
      out.push(`  ${marker} ${cells.join("  ").replace(/\s+$/, "")}`);
    }
    out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function formatListJson(rows: ListRow[], active: Record<string, string>): string {
  return JSON.stringify(
    rows.map((r) => ({
      provider: r.provider,
      name: r.name,
      active: active[r.provider] === r.name,
      label: r.meta.label,
      details: r.meta.identity?.details ?? {},
      tags: r.meta.tags ?? [],
      createdAt: r.meta.createdAt,
      updatedAt: r.meta.updatedAt,
      lastUsedAt: r.meta.lastUsedAt ?? null,
    })),
    null,
    2,
  );
}
