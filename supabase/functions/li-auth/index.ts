// LinkedIn OAuth: one-time login (and re-login every ~60 days).
//   GET ?a=start&id=login&s=<sig>  -> redirect to LinkedIn's consent screen
//   GET ?code=...&state=...         -> LinkedIn redirects back here; store the token
// Deployed with verify_jwt=false (opened from a phone notification).
import { cfg, checkSig, meta, push, show, sql, BASE } from "./lib.ts";

const SCOPES = "openid profile w_member_social";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const redirect = `${BASE()}/li-auth`;
  const clientId = await cfg("LINKEDIN_CLIENT_ID"), secret = Deno.env.get("LINKEDIN_CLIENT_SECRET") ?? "";

  if (u.searchParams.get("a") === "start") {
    if (!(await checkSig("start", u.searchParams.get("id") ?? "", u.searchParams.get("s")))) return show("Not allowed", "Bad link.", true);
    const state = crypto.randomUUID();
    await meta("oauth_state", state);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state, scope: SCOPES });
    return Response.redirect(`https://www.linkedin.com/oauth/v2/authorization?${q}`, 302);
  }

  const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  if (u.searchParams.get("error")) return show("LinkedIn said no", u.searchParams.get("error_description") ?? "", true);
  if (!code || !state || state !== (await meta("oauth_state"))) {
    // A second load of the same return link (reload, prefetch) after a successful login.
    const [recent] = await sql`select expires_at from li_auth where access_token is not null and updated_at > now() - interval '10 minutes'`;
    if (recent) return show("LinkedIn connected", `Posting is enabled until ${new Date(recent.expires_at).toDateString()}.`);
    return show("Not allowed", "Missing or stale login state. Start again from the link.", true);
  }
  await meta("oauth_state", "");

  const tok = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, client_secret: secret }),
  }).then((r) => r.json());
  if (!tok.access_token) return show("Login failed", JSON.stringify(tok).slice(0, 300), true);

  const me = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  if (!me.sub) return show("Login failed", "Couldn't read your LinkedIn member id.", true);

  const expires = new Date(Date.now() + (tok.expires_in ?? 5184000) * 1000);
  await sql`insert into li_auth (id, access_token, expires_at, person_urn, scope, updated_at)
            values (1, ${tok.access_token}, ${expires}, ${"urn:li:person:" + me.sub}, ${tok.scope ?? SCOPES}, now())
            on conflict (id) do update set access_token = excluded.access_token, expires_at = excluded.expires_at,
              person_urn = excluded.person_urn, scope = excluded.scope, updated_at = now()`;
  await meta("expiry_warned", "");
  await push("LinkedIn connected", `Logged in as ${me.name ?? "you"}. Valid until ${expires.toDateString()}.`).catch(() => {});
  return show("LinkedIn connected", `Logged in as ${me.name ?? "you"}. Posting is enabled until ${expires.toDateString()}. You'll get a reminder a week before it expires.`);
});
