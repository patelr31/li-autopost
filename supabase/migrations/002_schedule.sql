-- Run li-tick every day at 14:00 UTC (9 am New York in winter, 10 am in summer).
-- Needs the pg_cron and pg_net extensions. Replace <TICK_KEY> with the LI_TICK_KEY secret
-- before running (it is not stored in this repo).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'li-tick-daily',
  '0 14 * * *',
  $$ select net.http_post(
       url := 'https://afpkwgitlwzvogoqhauw.supabase.co/functions/v1/li-tick',
       headers := jsonb_build_object('x-tick-key', '<TICK_KEY>', 'content-type', 'application/json'),
       body := '{}'::jsonb) $$
);
