-- Run li-tick at 9 am New York time every day, all year. pg_cron runs in UTC, so the job fires at
-- 13:00 and 14:00 UTC and only calls the function when it is 9 am in New York (EDT or EST).
-- The tick key is read from li_meta (cfg_LI_TICK_KEY) at run time, so no secret is written here.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'li-tick-daily',
  '0 13,14 * * *',
  $$ select net.http_post(
       url := 'https://afpkwgitlwzvogoqhauw.supabase.co/functions/v1/li-tick',
       headers := jsonb_build_object(
         'x-tick-key', (select value from public.li_meta where key = 'cfg_LI_TICK_KEY'),
         'content-type', 'application/json'),
       body := '{}'::jsonb)
     where extract(hour from now() at time zone 'America/New_York') = 9 $$
);
