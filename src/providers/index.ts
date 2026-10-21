import type { Provider } from "./types.js";
import { vercel } from "./vercel.js";
import { convex } from "./convex.js";
import { github } from "./github.js";
import { supabase } from "./supabase.js";
import { cloudflare } from "./cloudflare.js";
import { clerk } from "./clerk.js";
import { UserError } from "../core/errors.js";

/** Add a provider: create src/providers/<id>.ts and list it here. */
export const providers: readonly Provider[] = [vercel, convex, github, supabase, cloudflare, clerk];

export function getProvider(id: string): Provider {
  const p = providers.find((x) => x.id === id.toLowerCase());
  if (!p) throw new UserError(`Unknown provider "${id}".`, `Supported: ${providers.map((x) => x.id).join(", ")}`);
  return p;
}
