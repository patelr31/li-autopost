// Approval actions for one queued post (links are HMAC-signed per action and post id).
//   POST|GET ?a=approve&id&s  -> publish now
//   POST|GET ?a=skip&id&s     -> skip it (the next one is offered at the next tick)
//   GET      ?a=edit&id&s     -> edit form;  POST (form) -> save, optionally publish
import { checkSig, esc, page, postToLinkedIn, signedUrl, sql } from "./lib.ts";

async function publish(id: number) {
  const [p] = await sql`select id, body, status from li_posts where id = ${id}`;
  if (!p) return page("Not found", "<p>No such post.</p>", 404);
  if (p.status === "posted") return page("Already posted", "<p>This one is already on LinkedIn.</p>");
  try {
    const urn = await postToLinkedIn(p.body);
    await sql`update li_posts set status = 'posted', posted_at = now(), linkedin_urn = ${urn}, error = null where id = ${id}`;
    const link = urn ? `https://www.linkedin.com/feed/update/${urn}/` : "https://www.linkedin.com/feed/";
    return page("Posted ✓", `<p>It's live. <a href="${link}">Open on LinkedIn</a></p>`);
  } catch (e) {
    await sql`update li_posts set error = ${String(e).slice(0, 500)} where id = ${id}`;
    return page("Couldn't post", `<p>${esc(String(e))}</p><p class="muted">The post is still pending; nothing was published.</p>`, 502);
  }
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const a = u.searchParams.get("a") ?? "", idStr = u.searchParams.get("id") ?? "";
  if (!/^\d+$/.test(idStr) || !["approve", "skip", "edit"].includes(a) || !(await checkSig(a, idStr, u.searchParams.get("s"))))
    return page("Not allowed", "<p>This link is invalid.</p>", 403);
  const id = Number(idStr);

  if (a === "approve") return publish(id);
  if (a === "skip") {
    await sql`update li_posts set status = 'skipped' where id = ${id} and status in ('queued','pending')`;
    return page("Skipped", "<p>Skipped. The next post will be offered at the next check.</p>");
  }
  // edit
  if (req.method === "POST") {
    const f = await req.formData();
    const body = String(f.get("body") ?? "").trim();
    if (body.length < 1 || body.length > 3000) return page("Too long", "<p>Posts must be 1–3000 characters.</p>", 400);
    await sql`update li_posts set body = ${body} where id = ${id} and status <> 'posted'`;
    if (f.get("go") === "post") return publish(id);
    return page("Saved", `<p>Saved. <a href="${await signedUrl("li-post", "approve", id)}">Post it now</a></p>`);
  }
  const [p] = await sql`select title, body, status from li_posts where id = ${id}`;
  if (!p) return page("Not found", "<p>No such post.</p>", 404);
  return page(`Edit: ${esc(p.title)}`, `<form method="post"><textarea name="body" maxlength="3000">${esc(p.body)}</textarea>
    <p class="muted">${p.body.length} / 3000 characters. Status: ${p.status}.</p>
    <button class="go" name="go" value="post">Save and post</button><button class="alt" name="go" value="save">Save only</button></form>`);
});
