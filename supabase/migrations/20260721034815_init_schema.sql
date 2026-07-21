create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists students (
  id          uuid primary key references auth.users(id),
  email       text,
  name        text,
  grade       text,
  syllabus    text,
  medium      text,
  stream      text,
  role        text not null default 'student' check (role in ('student', 'admin'))
);

create table if not exists devices (
  id                uuid primary key default gen_random_uuid(),
  api_key_hash      text not null,
  owner_student_id  uuid references students(id),
  label             text,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  revoked_at        timestamptz
);

create table if not exists papers (
  id            uuid primary key default gen_random_uuid(),
  subject       text not null,
  year          int,
  syllabus      text,
  level         text,
  medium        text,
  storage_path  text not null,
  status        text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  error_reason  text,
  uploaded_by   uuid references students(id),
  created_at    timestamptz not null default now()
);

create table if not exists paper_chunks (
  id            uuid primary key default gen_random_uuid(),
  paper_id      uuid not null references papers(id) on delete cascade,
  chunk_index   int not null,
  content       text not null,
  metadata      jsonb,
  embedding     vector(768),
  content_tsv   tsvector generated always as (to_tsvector('english', content)) stored
);
create index if not exists paper_chunks_embedding_hnsw on paper_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists paper_chunks_tsv_gin on paper_chunks using gin (content_tsv);
create index if not exists paper_chunks_paper_id_idx on paper_chunks (paper_id);

create table if not exists chat_sessions (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid references students(id),
  device_id     uuid references devices(id),
  created_at    timestamptz not null default now()
);

create table if not exists chat_messages (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references chat_sessions(id) on delete cascade,
  role          text not null check (role in ('user', 'assistant')),
  content       text not null,
  sources       jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists chat_messages_session_id_idx on chat_messages (session_id);
