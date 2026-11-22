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
export async function push(title: string, message: string, actions: string[] = [], click?: string) {
  const headers: Record<string, string> = { Title: title.replace(/[^\x20-\x7E]/g, "") };
  if (actions.length) headers["Actions"] = actions.join("; ");
  if (click) headers["Click"] = click;
  const r = await fetch(`https://ntfy.sh/${await cfg("NTFY_TOPIC")}`, { method: "POST", headers, body: message.slice(0, 3500) });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
}

// ---------- small HTML page ----------
export function page(title: string, body: string, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;background:#0f1115;color:#eef1f5}
h1{font-size:22px}textarea{width:100%;min-height:340px;font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif;background:#171a21;color:#eef1f5;border:1px solid #2a2f3a;border-radius:10px;padding:12px}
button{font:600 16px -apple-system,Helvetica,Arial,sans-serif;padding:12px 18px;border-radius:10px;border:0;margin:10px 8px 0 0;cursor:pointer}
.go{background:#41d6ba;color:#06231d}.alt{background:#2a2f3a;color:#eef1f5}a{color:#6d8dff}.muted{color:#9aa3ad;font-size:14px}</style>
<h1>${title}</h1>${body}`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

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
