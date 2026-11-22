// Approval actions for one post. Every request carries an HMAC signature for that action and post id.
//   POST ?a=approve&id&s  -> publish now        (ntfy "Approve & post" button)
//   POST ?a=skip&id&s     -> skip it             (ntfy "Skip" button)
//   GET  ?a=edit&id&s     -> JSON {title, body, status} for the edit page at SITE
//   POST ?a=edit&id&s     -> JSON body {body, go: "save" | "post"}: save, optionally publish
// Approve and skip are POST-only, so a link preview or a stray tap on a URL can never publish.
import { checkSig, json, postToLinkedIn, preflight, sql } from "./lib.ts";

async function publish(id: number) {
  const [p] = await sql`select id, body, status from li_posts where id = ${id}`;
  if (!p) return json({ error: true, title: "Not found", message: "No such post." }, 404);
  if (p.status === "posted") return json({ title: "Already posted", message: "This one is already on LinkedIn." });
  try {
    const urn = await postToLinkedIn(p.body);
    await sql`update li_posts set status = 'posted', posted_at = now(), linkedin_urn = ${urn}, error = null where id = ${id}`;
    const link = urn ? `https://www.linkedin.com/feed/update/${urn}/` : "https://www.linkedin.com/feed/";
    return json({ title: "Posted", message: "It's live on LinkedIn.", link });
  } catch (e) {
    await sql`update li_posts set error = ${String(e).slice(0, 500)} where id = ${id}`;
    return json({ error: true, title: "Couldn't post", message: `${String(e)}\n\nThe post is still pending; nothing was published.` }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  const u = new URL(req.url);
  const a = u.searchParams.get("a") ?? "", idStr = u.searchParams.get("id") ?? "";
  if (!/^\d+$/.test(idStr) || !["approve", "skip", "edit"].includes(a) || !(await checkSig(a, idStr, u.searchParams.get("s"))))
    return json({ error: true, title: "Not allowed", message: "This link is invalid." }, 403);
  const id = Number(idStr);

  if (a !== "edit" && req.method !== "POST")
    return json({ error: true, title: "Use the buttons", message: "Approve and Skip work from the notification buttons only." }, 405);
  if (a === "approve") return publish(id);
  if (a === "skip") {
    await sql`update li_posts set status = 'skipped' where id = ${id} and status in ('queued','pending')`;
    return json({ title: "Skipped", message: "The next post will be offered at the next daily check." });
  }

  // edit
  if (req.method === "POST") {
    const f = await req.json().catch(() => ({}));
    const body = String(f.body ?? "").trim();
    if (body.length < 1 || body.length > 3000) return json({ error: true, title: "Wrong length", message: "Posts must be 1–3000 characters." }, 400);
    const done = await sql`update li_posts set body = ${body} where id = ${id} and status <> 'posted' returning id`;
    if (!done.length) return json({ error: true, title: "Can't edit", message: "That post doesn't exist or is already on LinkedIn." }, 409);
    if (f.go === "post") return publish(id);
    return json({ title: "Saved", message: "Saved. Tap \"Save and post\" when you're ready." });
  }
  const [p] = await sql`select title, body, status from li_posts where id = ${id}`;
  if (!p) return json({ error: true, title: "Not found", message: "No such post." }, 404);
  return json({ title: p.title, body: p.body, status: p.status });
});
