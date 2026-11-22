-- Run li-tick every day at 14:00 UTC (9 am New York in winter, 10 am in summer).
-- Needs pg_cron and pg_net. The tick key is read from li_meta (cfg_LI_TICK_KEY) at run time,
-- so no secret is written here.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'li-tick-daily',
  '0 14 * * *',
  $$ select net.http_post(
       url := 'https://afpkwgitlwzvogoqhauw.supabase.co/functions/v1/li-tick',
       headers := jsonb_build_object(
         'x-tick-key', (select value from public.li_meta where key = 'cfg_LI_TICK_KEY'),
         'content-type', 'application/json'),
       body := '{}'::jsonb) $$
);
