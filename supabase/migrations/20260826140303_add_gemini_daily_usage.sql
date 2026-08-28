-- Backend-owned shared Gemini usage counter (Flashcards feature hand-off,
-- 2026-08-26-flashcards-design.md). No RLS policies are defined, which with
-- RLS enabled blocks all access via the anon/authenticated roles the frontend's
-- Supabase client uses -- only this backend's own service-role/direct-pg
-- connection (which bypasses RLS) can read or write it. A student must not be
-- able to inflate or reset this counter directly.
create table if not exists gemini_daily_usage (
  usage_date    date not null,
  feature       text not null,
  request_count int not null default 0,
  daily_limit   int not null,
  primary key (usage_date, feature)
);

alter table gemini_daily_usage enable row level security;
