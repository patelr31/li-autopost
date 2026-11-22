-- Call li-tick every hour. The function decides whether this hour is a posting slot
-- (li_meta "post_slots": New York weekday -> hour; default Tue 12 pm, Wed 4 pm, Fri 3 pm ET)
-- and skips dates in li_meta "skip_dates". Daylight saving is handled in the function.
-- The tick key is read from li_meta (cfg_LI_TICK_KEY) at run time, so no secret is written here.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'li-tick-daily',
  '0 * * * *',
  $$ select net.http_post(
       url := 'https://afpkwgitlwzvogoqhauw.supabase.co/functions/v1/li-tick',
       headers := jsonb_build_object(
         'x-tick-key', (select value from public.li_meta where key = 'cfg_LI_TICK_KEY'),
         'content-type', 'application/json'),
       body := '{}'::jsonb) $$
);

-- Posting slots and skipped dates (editable any time, no redeploy needed):
insert into public.li_meta (key, value) values
  ('post_slots', '{"2":12,"3":16,"5":15}'),
  ('skip_dates', '2026-11-25,2026-11-26,2026-11-27,2026-12-24,2026-12-25,2026-12-26,2026-12-27,2026-12-28,2026-12-29,2026-12-30,2026-12-31,2027-01-01')
on conflict (key) do update set value = excluded.value, updated_at = now();
