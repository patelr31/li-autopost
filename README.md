# LinkedIn auto-poster (with a human in the loop)

**Who feels the pain:** anyone building in public. Posting regularly is hard, so good work
goes unseen. **Who would pay:** freelancers, small studios and job seekers who want a
steady, reviewed posting rhythm without a social-media tool's monthly fee.

It keeps a queue of drafted LinkedIn posts. Every 2 days it sends the next one to my
iPhone as a notification with **Approve & post**, **Edit** and **Skip** buttons. Nothing is
published without a tap.

## Flow

1. **The queue:** drafts sit in `li_posts` (Supabase). The first 8 come from
   `scripts/drafts.json`.
2. **The daily check:** `li-tick` runs once a day, triggered by pg_cron, and:
   - offers the next post if none is waiting and the last post was 2 or more days ago;
   - reminds me once if I haven't acted on a post within 2 days;
   - warns when the queue is down to 2 posts or fewer ("running low, ask Claude to draft
     more");
   - warns about a week before the LinkedIn login expires (logins last 60 days), with a
     one-tap re-login link.
3. **Notifications** go through [ntfy](https://ntfy.sh), a free iPhone app with action
   buttons, using a private random topic.
4. **Actions:** `li-post` handles the buttons. Every link is HMAC-signed for that post
   and action. Approve publishes through LinkedIn's official
   [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
   (`w_member_social`). Edit opens a form to change the text first.
5. **Login:** `li-auth` handles the one-time LinkedIn OAuth login (OpenID Connect plus
   `w_member_social`).

## Details that matter

- **Official API only,** no browser automation, so the LinkedIn account isn't put at risk.
- **Text formatting:** posts use LinkedIn's "little text" format. Reserved characters are
  escaped, and `#Tags` become real hashtags.
- **Secrets stay in Supabase, never in this repo:** `LINKEDIN_CLIENT_SECRET` is a function
  secret entered in the dashboard. `LI_LINK_SECRET`, `LI_TICK_KEY` and `NTFY_TOPIC` were
  generated in SQL and live in `li_meta` as `cfg_*` rows (RLS, no policies);
  `LINKEDIN_CLIENT_ID` is stored the same way. A function secret with the same name
  overrides a row.
- **Database:** the tables have row-level security on with no policies, so only the
  functions can touch them.
- **Text-only for now;** image uploads are a next step.

## Files

| Path | Purpose |
|---|---|
| `supabase/migrations/001_li_autopost.sql` | tables |
| `supabase/migrations/002_schedule.sql` | daily pg_cron job calling li-tick |
| `supabase/functions/li-auth` | LinkedIn login and callback |
| `supabase/functions/li-post` | approve, edit and skip |
| `supabase/functions/li-tick` | the daily check |
| `supabase/functions/_shared/lib.ts` | shared helpers, copied into each function at deploy |
| `scripts/drafts.json`, `scripts/seed.py` | the first 8 posts |

Built as part of a personal "vibe coding" practice roadmap.
