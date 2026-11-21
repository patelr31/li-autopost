// Daily check, called by pg_cron with header x-tick-key. Sends at most one approval prompt.
//   1. LinkedIn not connected, or login expiring within 7 days -> push a (re)connect link
//   2. A post already waiting for approval -> re-remind once after 2 days, else do nothing
//   3. Last post less than GAP_DAYS ago -> wait
//   4. Otherwise -> next queued post becomes "pending" and goes to the phone with Approve / Edit / Skip
//   5. Queue at or below LOW_WATER -> "running low" reminder (at most every 3 days)
import { meta, push, signedUrl, sql } from "./lib.ts";

const GAP_DAYS = Number(Deno.env.get("LI_GAP_DAYS") ?? 2);
const LOW_WATER = Number(Deno.env.get("LI_LOW_WATER") ?? 2);
const DAY = 86400000;
const since = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / DAY : Infinity);

Deno.serve(async (req) => {
  if (req.headers.get("x-tick-key") !== Deno.env.get("LI_TICK_KEY")) return new Response("forbidden", { status: 403 });
  const log: string[] = [];
  const loginUrl = await signedUrl("li-auth", "start", "login");

  const [auth] = await sql`select expires_at from li_auth where id = 1 and access_token is not null`;
  if (!auth) {
    if (since(await meta("connect_nag")) >= 1) {
      await push("Connect LinkedIn", "Tap to log in once so approved posts can be published.", [], loginUrl);
      await meta("connect_nag", new Date().toISOString());
    }
    log.push("not connected");
  } else if (new Date(auth.expires_at).getTime() - Date.now() < 7 * DAY && !(await meta("expiry_warned"))) {
    await push("LinkedIn login expires soon", `Expires ${new Date(auth.expires_at).toDateString()}. Tap to log in again (30 seconds).`, [], loginUrl);
    await meta("expiry_warned", new Date().toISOString());
    log.push("expiry warning sent");
  }

  const [pending] = await sql`select id, title, notified_at from li_posts where status = 'pending' order by notified_at limit 1`;
  const [last] = await sql`select max(posted_at) as at from li_posts where status = 'posted'`;
  if (pending) {
    if (since(pending.notified_at) >= 2) { await offer(pending.id, true); log.push(`re-reminded ${pending.id}`); }
    else log.push(`waiting on ${pending.id}`);
  } else if (since(last?.at) < GAP_DAYS) {
    log.push("too soon since last post");
  } else {
    const [next] = await sql`select id from li_posts where status = 'queued' order by priority, id limit 1`;
    if (next) { await offer(next.id, false); log.push(`offered ${next.id}`); }
    else log.push("queue empty");
  }

  const [{ n }] = await sql`select count(*)::int as n from li_posts where status = 'queued'`;
  if (n <= LOW_WATER && since(await meta("low_nag")) >= 3) {
    await push("Running low on LinkedIn posts", n === 0 ? "The queue is empty. Ask Claude to draft a few more." : `Only ${n} post${n === 1 ? "" : "s"} left in the queue. Ask Claude to draft more.`);
    await meta("low_nag", new Date().toISOString());
    log.push(`low-water reminder (${n})`);
  }
  return Response.json({ ok: true, log });
});

async function offer(id: number, reminder: boolean) {
  const [p] = await sql`update li_posts set status = 'pending', notified_at = now() where id = ${id} returning title, body`;
  const [approve, edit, skip] = await Promise.all([signedUrl("li-post", "approve", id), signedUrl("li-post", "edit", id), signedUrl("li-post", "skip", id)]);
  await push(`${reminder ? "Reminder: " : ""}LinkedIn post ready: ${p.title}`, p.body, [
    `http, Approve & post, ${approve}, method=POST, clear=true`,
    `view, Edit, ${edit}`,
    `http, Skip, ${skip}, method=POST, clear=true`,
  ], edit);
}
