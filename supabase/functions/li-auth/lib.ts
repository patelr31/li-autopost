// Shared helpers for the li-* functions: database, signed links, ntfy push, LinkedIn API.
import postgres from "npm:postgres@3.4.5";

export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing secret ${k}`);
  return v;
};
export const BASE = () => `${env("SUPABASE_URL")}/functions/v1`;

// Config: a function secret if set, else the li_meta row "cfg_<name>" (generated in SQL, never in this repo).
const cache: Record<string, string> = {};
export async function cfg(k: string) {
  if (cache[k]) return cache[k];
  const v = Deno.env.get(k) ?? (await sql`select value from li_meta where key = ${"cfg_" + k}`)[0]?.value;
  if (!v) throw new Error(`missing config ${k}`);
  return (cache[k] = v);
}
export const LINKEDIN_VERSION = () => Deno.env.get("LINKEDIN_VERSION") ?? "202609";

// ---------- signed links (HMAC-SHA256 over "action:id") ----------
async function hmac(msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(await cfg("LI_LINK_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function signedUrl(fn: string, action: string, id: number | string) {
  return `${BASE()}/${fn}?a=${action}&id=${id}&s=${await hmac(`${action}:${id}`)}`;
}
export async function checkSig(action: string, id: string, s: string | null) {
  if (!s) return false;
  const want = await hmac(`${action}:${id}`);
  return want.length === s.length && crypto.subtle !== undefined && want === s;
}

// ---------- ntfy push (iPhone app "ntfy", subscribed to a private random topic) ----------
// Sent from the database with pg_net, not from the function: ntfy.sh rate-limits per IP, and the
// function servers' shared IPs hit its daily quota. pg_net sends right after this statement commits.
export type Action = { action: "view" | "http"; label: string; url: string; method?: string; clear?: boolean };
export async function push(title: string, message: string, actions: Action[] = [], click?: string) {
  const payload = { topic: await cfg("NTFY_TOPIC"), title, message: message.slice(0, 3500), ...(click ? { click } : {}), ...(actions.length ? { actions } : {}) };
  await sql`select net.http_post(url := 'https://ntfy.sh/', body := (${JSON.stringify(payload)}::text)::jsonb,
            headers := '{"content-type":"application/json"}'::jsonb)`;
}

// ---------- responses ----------
// Supabase serves function HTML as text/plain, so people-facing pages live on the site:
// result pages are a redirect to SITE#t=..&m=.., and the edit form is SITE?a=edit&id&s (it calls li-post as JSON).
export const SITE = "https://rutulpatel.dev/autopost";
const CORS = { "access-control-allow-origin": "https://rutulpatel.dev", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type", "vary": "origin" };
export const preflight = () => new Response(null, { status: 204, headers: CORS });
export function json(o: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } });
}
export function show(title: string, message = "", error = false) {
  const h = new URLSearchParams({ t: title, m: message, ...(error ? { e: "1" } : {}) });
  return new Response(null, { status: 303, headers: { location: `${SITE}#${h}`, "cache-control": "no-store" } });
}
export async function editUrl(id: number) {
  return `${SITE}?a=edit&id=${id}&s=${await hmac(`edit:${id}`)}`;
}

// ---------- LinkedIn ----------
// LinkedIn's "little text" format reserves | { } @ [ ] ( ) < > # \ * _ ~ ; hashtags become {hashtag|\#|tag}.
export function toLittleText(text: string) {
  const escapeAll = (s: string) => s.replace(/[|{}@\[\]()<>#\\*_~]/g, (c) => "\\" + c);
  return text.split(/(#[A-Za-z][A-Za-z0-9_]*)/g)
    .map((part) => /^#[A-Za-z][A-Za-z0-9_]*$/.test(part) ? `{hashtag|\\#|${part.slice(1)}}` : escapeAll(part)).join("");
}

export async function postToLinkedIn(text: string) {
  const [auth] = await sql`select access_token, expires_at, person_urn from li_auth where id = 1`;
  if (!auth?.access_token) throw new Error("LinkedIn is not connected yet");
  if (new Date(auth.expires_at) < new Date()) throw new Error("LinkedIn login expired; reconnect");
  const r = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0", "LinkedIn-Version": LINKEDIN_VERSION(),
    },
    body: JSON.stringify({
      author: auth.person_urn, commentary: toLittleText(text), visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    }),
  });
  if (r.status !== 201) throw new Error(`LinkedIn ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.headers.get("x-restli-id") ?? "";
}

export async function meta(key: string, value?: string) {
  if (value === undefined) return (await sql`select value from li_meta where key = ${key}`)[0]?.value ?? null;
  await sql`insert into li_meta (key, value) values (${key}, ${value})
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return value;
}
