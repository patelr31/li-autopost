-- LinkedIn auto-poster: a queue of drafts, the LinkedIn login, and a small key/value store.
-- RLS is on with no policies: only the edge functions (direct DB connection) can read or write.

create table if not exists public.li_posts (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null check (char_length(body) between 1 and 3000),   -- LinkedIn's post limit
  status text not null default 'queued' check (status in ('queued', 'pending', 'posted', 'skipped', 'failed')),
  priority int not null default 100,          -- lower goes first
  notified_at timestamptz,                    -- when the approval prompt was sent
  posted_at timestamptz,
  linkedin_urn text,
  error text,
  created_at timestamptz not null default now()
);
comment on table public.li_posts is 'LinkedIn auto-poster queue. Written only by the li-* edge functions.';
alter table public.li_posts enable row level security;

create table if not exists public.li_auth (
  id int primary key default 1 check (id = 1),
  access_token text,
  expires_at timestamptz,
  person_urn text,
  scope text,
  updated_at timestamptz not null default now()
);
comment on table public.li_auth is 'LinkedIn OAuth token (one row). Never exposed to clients.';
alter table public.li_auth enable row level security;

create table if not exists public.li_meta (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
comment on table public.li_meta is 'Small state for the auto-poster (last reminder times, OAuth state).';
alter table public.li_meta enable row level security;
