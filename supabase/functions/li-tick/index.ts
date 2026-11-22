// Hourly run (pg_cron, header x-tick-key). Posts automatically at the posting slots, no approval needed.
// Slots are New York weekday + hour, from li_meta "post_slots" (JSON, 0 = Sunday), default
// Tue 12 pm, Wed 4 pm, Fri 3 pm ET (Buffer's 2026 analysis of 4.8M LinkedIn posts; no weekends).
// Dates in li_meta "skip_dates" (comma-separated YYYY-MM-DD, New York) are skipped, e.g. holidays.
//   1. LinkedIn not connected -> push a connect link (at most daily) and stop
//   2. Login expiring within 7 days -> one re-login reminder
//   3. At a slot, and nothing posted in the last 12 hours -> publish the next queued post, then push
//      "Posted" with a link and a heads-up of the next one (Edit / Skip buttons, optional)
//   4. Publish fails -> push the error; the post stays queued and goes out at the next slot
//   5. Queue at or below LOW_WATER -> "running low" reminder (at most every 3 days)
// Drafts are spell- and style-checked before they are queued (scripts/check.py). Here, a last
// link check only warns; it never holds a post back.
import { cfg, editUrl, meta, postToLinkedIn, push, signedUrl, sql } from "./lib.ts";
import type { Action } from "./lib.ts";

const DEFAULT_SLOTS: Record<string, number> = { "2": 12, "3": 16, "5": 15 };
const LOW_WATER = Number(Deno.env.get("LI_LOW_WATER") ?? 2);
const DAY = 86400000;
const since = (iso: string | Date | null) => (iso ? (Date.now() - new Date(iso).getTime()) / DAY : Infinity);
const NEXT = sql`status in ('queued', 'pending')`;
const TZ = "America/New_York";

// New York weekday (0 = Sunday), hour and date for an instant.
function ny(d: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric",
    hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((p) => [p.type, p.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { dow, hour: Number(parts.hour), ymd: `${parts.year}-${parts.month}-${parts.day}` };
}
async function schedule() {
  const slots: Record<string, number> = JSON.parse((await meta("post_slots")) || "null") ?? DEFAULT_SLOTS;
  const skip = new Set(((await meta("skip_dates")) ?? "").split(",").map((x: string) => x.trim()).filter(Boolean));
  const isSlot = (d: Date) => { const t = ny(d); return slots[t.dow] === t.hour && !skip.has(t.ymd); };
  // Next slot strictly after `from`, checking hour by hour for up to 60 days.
  const nextSlot = (from: Date) => {
    const t = new Date(from); t.setUTCMinutes(0, 0, 0);
    for (let i = 1; i <= 24 * 60; i++) { const c = new Date(t.getTime() + i * 3600000); if (isSlot(c)) return c; }
    return null;
  };
  return { isSlot, nextSlot };
}
const fmtSlot = (d: Date) => d.toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric", hour: "numeric" });

async function brokenLinks(text: string) {
  const urls = [...new Set(text.match(/https?:\/\/[^\s)]+/g) ?? [])].map((u) => u.replace(/[.,]$/, ""));
  const bad: string[] = [];
  await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (link check)" } });
      await r.body?.cancel();
      if (r.status >= 400) bad.push(`${u} (${r.status})`);
    } catch { bad.push(`${u} (no response)`); }
  }));
  return bad;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-tick-key") !== (await cfg("LI_TICK_KEY"))) return new Response("forbidden", { status: 403 });
  const log: string[] = [];
  const loginUrl = await signedUrl("li-auth", "start", "login");

  const [auth] = await sql`select expires_at from li_auth where id = 1 and access_token is not null`;
  if (!auth) {
    if (since(await meta("connect_nag")) >= 1) {
      await push("Connect LinkedIn", "Tap to log in once so posts can be published.", [], loginUrl);
      await meta("connect_nag", new Date().toISOString());
    }
    return Response.json({ ok: true, log: ["not connected"] });
  }
  if (new Date(auth.expires_at).getTime() - Date.now() < 7 * DAY && !(await meta("expiry_warned"))) {
    await push("LinkedIn login expires soon", `Expires ${new Date(auth.expires_at).toDateString()}. Tap to log in again (30 seconds), or posting stops.`, [], loginUrl);
    await meta("expiry_warned", new Date().toISOString());
    log.push("expiry warning sent");
  }

  const { isSlot, nextSlot } = await schedule();
  const [last] = await sql`select max(posted_at) as at from li_posts where status = 'posted'`;
  if (!isSlot(new Date())) {
    log.push("not a posting slot");
  } else if (since(last?.at) < 0.5) {
    log.push("already posted in the last 12 hours");
  } else {
    const [p] = await sql`select id, title, body from li_posts where ${NEXT} order by priority, id limit 1`;
    if (!p) log.push("queue empty");
    else {
      const broken = await brokenLinks(p.body);
      try {
        const urn = await postToLinkedIn(p.body);
        await sql`update li_posts set status = 'posted', posted_at = now(), linkedin_urn = ${urn}, error = null where id = ${p.id}`;
        log.push(`posted ${p.id}`);
        const link = urn ? `https://www.linkedin.com/feed/update/${urn}/` : "https://www.linkedin.com/feed/";
        const [n] = await sql`select id, title from li_posts where ${NEXT} order by priority, id limit 1`;
        const actions: Action[] = [{ action: "view", label: "Open on LinkedIn", url: link }];
        let msg = `"${p.title}" is live on LinkedIn.`;
        if (broken.length) msg += `\n\nHeads-up, a link didn't load during the check: ${broken.join(", ")}`;
        if (n) {
          const when = nextSlot(new Date());
          msg += `\n\nNext up${when ? `, ${fmtSlot(when)} ET` : ""}: "${n.title}". Nothing to do unless you want to change it.`;
          actions.push({ action: "view", label: "Edit next", url: await editUrl(n.id) },
            { action: "http", label: "Skip next", url: await signedUrl("li-post", "skip", n.id), method: "POST", clear: true });
        }
        await push(`Posted: ${p.title}`, msg, actions, link);
      } catch (e) {
        await sql`update li_posts set error = ${String(e).slice(0, 500)} where id = ${p.id}`;
        await push(`Couldn't post: ${p.title}`, `${String(e).slice(0, 300)}\n\nNothing was published. It will try again at the next posting slot.`, [], loginUrl);
        log.push(`failed ${p.id}`);
      }
    }
  }

  const [{ n }] = await sql`select count(*)::int as n from li_posts where ${NEXT}`;
  if (isSlot(new Date()) && n <= LOW_WATER && since(await meta("low_nag")) >= 3) {
    await push("Running low on LinkedIn posts", n === 0 ? "The queue is empty. Ask Claude to draft a few more." : `Only ${n} post${n === 1 ? "" : "s"} left in the queue. Ask Claude to draft more.`);
    await meta("low_nag", new Date().toISOString());
    log.push(`low-water reminder (${n})`);
  }
  return Response.json({ ok: true, log });
});
