# Obscura Backend v2 — System Design Spec

Status: FINAL DRAFT — all open questions resolved (see §17). Ready for implementation planning.
Replaces the Python/Railway backend for the Flutter mobile app, the ESP32 robot, and (later) a
website.

---

## 1. Project Context & Mission

Obscura is an AI study platform for Sri Lankan O/L and A/L students across three syllabuses
(Local, Edexcel, Cambridge) and three languages (English, Sinhala, Tamil). The product's core
differentiator: **NESH answers directly from real past exam papers, and every answer that draws
on the curriculum must cite the specific paper and year it came from** — this is what separates
it from a generic AI tutor with no grounding in the actual exam history. Accurate retrieval and
citation is not a nice-to-have feature; it's the product's core value proposition, and the design
below treats it that way (see §6).

**Three clients, one backend:**
1. **Mobile app** (Flutter) — live today, text chat only (`POST /chat/ask`).
2. **IoT robot** (ESP32) — live today, voice only (`POST /voice/ask`).
3. **Website** — planned, not yet built. Not designed in detail here, but the API surface below
   (JSON REST for chat/papers, Supabase JWT bearer auth) is client-agnostic by construction: a
   web client authenticates the same way as the mobile app and calls the same `/chat/ask`-shaped
   endpoint, so no backend rework is anticipated when it arrives. CORS config is the only
   web-specific addition, deferred until that build starts.

**Target deadline: 2026-09-15.** Delivery is phased (confirmed, §17) so there are working
milestones along the way rather than one all-or-nothing build: **Phase 1 — text chat + hybrid
RAG + mobile auth** (mirrors what's already proven live), **Phase 2 — voice pipeline** (reuses
Phase 1's retrieval/generation core), **Phase 3 — PDF upload/ingestion + admin tooling**.

---

## 2. Goals & Non-Goals

**Goals**
- Serve both existing client contracts without breaking them: `POST /chat/ask` (mobile, text↔text)
  and `POST /voice/ask` (robot, WAV↔raw PCM), backed by one shared reasoning pipeline.
- Every curriculum-grounded answer cites the specific past paper (subject + year) it came from,
  in all three languages.
- Real auth: Supabase-backed JWT auth for the mobile app, per-device API keys for the robot.
- Hybrid (semantic + keyword) RAG with re-ranking over past exam papers, with a PDF upload →
  parse → chunk → embed → confirm pipeline.
- NestJS throughout; gRPC between internal services; WebSockets for real-time features toward
  the mobile app and robot; Gemini Flash 2.5 for answer generation.
- Runs locally (docker-compose) and deploys to Koyeb.

**Non-Goals (for this spec)**
- Rebuilding the mobile app's mocked screens (Flashcards, Analytics, Pomodoro persistence, etc.)
  — only the backend surfaces those screens will eventually need (`/papers`, `/search`,
  `/chat/history`) are considered, not implemented speculatively beyond what's asked for.
- Designing the website client itself — only ensuring the backend doesn't need rework for it.
- Rewriting the ESP32 firmware's core audio pipeline. Firmware changes are in scope only for
  the additions specified in this doc: the `X-Device-Key` header (§12.2, committed for Phase 2)
  and, optionally later, a WS client for `device:status` (§14, Phase 2/3, not launch-blocking).

---

## 3. High-Level Architecture

```
                          ┌──────────────────────────────────────────┐
                          │              Gateway (NestJS)             │
                          │  HTTP REST  +  WebSocket Gateway          │
  Flutter app  ───HTTP───▶│  /chat/ask   /voice/ask   /papers/upload  │
  (Supabase JWT)          │  /auth/*     /papers      WS: /realtime   │
  ESP32 robot   ───HTTP───▶│  (public-facing, all auth enforced here) │
  (device API key)         └───────────────┬────────────────────────┘
  Website (later,                          │ gRPC (internal, in-process — §15)
  same JSON+JWT)          ┌──────────────┬───────────┼───────────────┬───────────────┐
                          ▼              ▼           ▼               ▼               ▼
                  ┌──────────────┐┌─────────────┐┌──────────┐┌───────────────┐┌─────────────┐
                  │ RAG Service  ││ Chat/LLM Svc ││ Speech Svc││ Ingestion Svc ││ Auth Svc    │
                  │ hybrid search││ Gemini prompt││ STT + TTS ││ PDF→chunks→   ││ JWT verify, │
                  │ + rerank     ││ orchestration││           ││ embeddings    ││ device keys │
                  └──────┬───────┘└──────┬──────┘└─────┬─────┘└───────┬───────┘└──────┬──────┘
                         │               │              │              │               │
                         └───────────────┴──────┬───────┴──────────────┴───────────────┘
                                                 ▼
                              ┌───────────────────────────────────────┐
                              │     Supabase Postgres (+ pgvector)     │
                              │  students · devices · papers ·         │
                              │  paper_chunks (vector + tsvector) ·     │
                              │  chat_sessions/messages · ingest_jobs   │
                              └───────────────────────────────────────┘
                              ┌───────────────────┐   ┌──────────────────┐
                              │ Supabase Storage   │   │ Upstash Redis     │
                              │ (raw PDF bucket)   │   │ (BullMQ job queue)│
                              └───────────────────┘   └──────────────────┘
```

**Deployment topology confirmed (§17, Q1): modular monolith.** All five service modules above run
as one NestJS process on one Koyeb service, communicating over in-process gRPC (Nest's hybrid
application feature — a real gRPC transport, just bound to loopback instead of the network).
This satisfies the "gRPC between internal services" requirement structurally while staying cheap
and simple to run/debug solo on Koyeb. The module boundaries are real (separate Nest modules,
separate `.proto` contracts, separate DI graphs) so splitting any one of them into an
independently-deployed service later is a deployment change, not a rewrite.

---

## 4. Service Breakdown

| Service | Responsibility | Exposed as |
|---|---|---|
| **Gateway** | Public HTTP + WS surface. Terminates all client auth, validates request shape, fans out to internal services over gRPC, assembles responses matching the *existing* client contracts exactly. | HTTP + WS (public) |
| **Auth Service** | Verifies Supabase JWTs (JWKS), verifies device API keys, issues internal principal (`{type: 'student'\|'device'\|'admin', id, role}`) for downstream authorization checks. | gRPC (internal) |
| **RAG Service** | Given a query string + filters (subject/syllabus/level/medium/year), runs hybrid retrieval (pgvector cosine + Postgres full-text) → Reciprocal Rank Fusion → Cohere re-rank → returns top-K chunks with citation metadata. | gRPC (internal) |
| **Chat/LLM Service** | Builds the grounded prompt (system instructions + retrieved chunks + trimmed chat history + question), calls Gemini Flash 2.5, enforces the citation/grounding contract (§6), post-processes into `{answer, sources[]}`. Shared by both text and voice pipelines. | gRPC (internal) |
| **Speech Service** | `Transcribe(wav) → text` (STT) and `Synthesize(text) → pcm16_16k_mono` (TTS), including resampling to the robot's exact expected format. Language-aware per §7. | gRPC (internal) |
| **Ingestion Service** | Consumes upload jobs from the queue: PDF text/structure extraction, chunking, embedding, upsert into `paper_chunks`, status updates, completion notification. | gRPC (internal) + BullMQ worker |

All internal services are defined as `.proto` contracts under a shared `libs/proto` package so
Gateway and workers share generated types.

---

## 5. Reconciling `/chat/ask` and `/voice/ask` into One Pipeline

Both endpoints ultimately need the same thing: *question text + student context + history →
grounded answer text + sources*. That shared core is `AskService.ask()`, implemented by
composing RAG Service + Chat/LLM Service. Each HTTP endpoint is a thin adapter around it:

```
POST /chat/ask  (unchanged contract)
  JSON in  → { question, stream, subject, syllabus, medium, student_id, chat_history[] }
  Gateway  → AskService.ask({ questionText: body.question, ...context })
  JSON out → { answer, sources[] }                              (identical to today)

POST /voice/ask?stream=&subject=&medium=&student_id=  (unchanged contract)
  multipart/form-data "audio" (WAV) in
  Gateway  → SpeechService.Transcribe(wav) → questionText
           → AskService.ask({ questionText, ...contextFromQueryParams })
           → SpeechService.Synthesize(answer.text) → pcm16_16k_mono
  raw PCM out, Content-Type: application/octet-stream          (identical to today)
```

Key implication: **`sources` citation logic, prompt construction, and grounding all live in one
place** (Chat/LLM Service), so improving answer quality/citation accuracy benefits both clients
simultaneously — critical given citation accuracy is the core product promise (§6).

**Latency budget:** the robot firmware blocks synchronously with a 30s response-start timeout
and no retry. The voice path (STT + retrieval + Gemini + TTS) must target p95 < 10s, hard
ceiling 25s. This is the binding constraint on voice pipeline design — no background/async
steps are viable there, unlike the upload pipeline.

**Voice session memory — confirmed (§17, Q4): server-side rolling history per device.** The
Gateway maintains a rolling `chat_sessions`/`chat_messages` history keyed by `device_id` (not
`student_id` — a robot isn't reliably tied to one logged-in student), capped at the same
"last 6 turns" the mobile app already uses client-side. This makes follow-ups like "explain that
differently" work over voice without any firmware change, since history now lives server-side
rather than depending on the client to resend it.

---

## 6. Citation & Grounding Requirements

This is the product's core differentiator, so it gets an explicit contract rather than being an
incidental side effect of RAG:

- **Every answer to a curriculum-content question must be grounded** in at least one retrieved
  chunk above a minimum re-rank relevance threshold. If retrieval returns nothing above
  threshold, Chat/LLM Service does **not** let Gemini answer from general knowledge — it returns
  a localized "I don't have that in the past papers I have yet" response (translated per §7)
  rather than an uncited, potentially hallucinated answer. This is a hard rule in the system
  prompt plus a post-hoc check: if Gemini's response contains no `sources` and the query was
  classified as curriculum-content (vs. small talk/meta questions like "what can you help with"),
  the response is treated as a failure and retried once with a stricter "cite or decline" prompt.
- **Wire contract stays exactly what the mobile app already parses**: `sources: [{ past_papers:
  { subject, year } }]`. Internally, each retrieved chunk carries richer metadata
  (`paper_id`, `chunk_id`, `question_number`, `page`) for debugging/traceability and for a future
  "view the actual paper" deep link, but that's projected down to `{subject, year}` at the
  Gateway edge so today's client (which only renders the first 2 entries as `"{subject} {year}"`
  chips) needs zero changes.
- **Traceability for QA**: `chat_messages.sources` (jsonb, §13) stores the full internal
  citation object (not just the trimmed client-facing one), so answer quality can be audited
  against the actual source chunk later without re-running retrieval.

---

## 7. Multi-Language Support (English / Sinhala / Tamil)

Language support splits cleanly along one line: **text is low-risk, voice has a real vendor gap.**

**Text (chat, both mobile and voice-transcript-to-text stages):**
- Gemini Flash 2.5 is strong across all three languages for both understanding and generation —
  no separate translation step needed for answer generation. The prompt includes the requested
  `medium` and instructs Gemini to answer in that language regardless of what language the
  source paper chunk is written in (cross-lingual grounding: a Sinhala-medium question can be
  answered from an English-medium past paper chunk, with the citation's `subject`/`year` staying
  language-neutral either way).
- Embeddings (`text-embedding-004`) are multilingual (100+ languages) but retrieval quality on
  Sinhala specifically is an unknown — it's a lower-resource language for most embedding models,
  including Google's. **Plan to validate this explicitly in Phase 1** with a small labeled set of
  Sinhala test queries against known-relevant chunks. If native multilingual retrieval
  underperforms, the fallback is a "query translation bridge": translate the Sinhala query to
  English (a single cheap Gemini call) before embedding/retrieval, then generate the final answer
  back in Sinhala. This fallback is a config flag on RAG Service, not a redesign, so it's cheap
  to add if Phase 1 testing shows it's needed.
- PDF ingestion: past papers may be born-digital (text layer) or scanned images, and may be set
  in any of the three languages/scripts. The chunking pipeline's primary path (§11) already uses
  Gemini's native multimodal PDF understanding rather than a text-layer-only extractor
  specifically because it handles OCR for scanned pages and non-Latin scripts (Sinhala, Tamil)
  in the same call — the fixed-window `pdf-parse` fallback only works for born-digital Latin/basic
  Unicode text and is not a safe default for this corpus.

**Voice (STT + TTS on the robot path) — the actual risk:**
- **English**: fully supported by any mainstream STT/TTS vendor (Google Cloud Speech, etc.).
- **Tamil**: reasonably well supported by Google Cloud STT/TTS (`ta-IN` locale).
- **Sinhala**: **not reliably supported by mainstream commercial STT/TTS providers** as of this
  writing — it's a low-resource language largely absent from Google Cloud, Azure, and AWS speech
  voice/model lists. This is a real technical risk to the "all three languages" requirement,
  specific to the *voice* channel only (text chat in Sinhala carries no such risk, per above).
  **Confirmed (§17): voice launches with English + Tamil only.** Speech Service's language
  routing rejects Sinhala `medium` on the voice path specifically (returning a clear "not
  supported over voice yet" response, itself synthesized in English or Tamil since Sinhala TTS
  isn't available) while text chat continues to fully support all three languages unaffected.
  Sinhala voice becomes a post-launch addition once a viable regional STT/TTS vendor is
  evaluated.

---

## 8. Database & Vector Store: Supabase Postgres + pgvector

**Recommendation: use the existing Supabase Postgres project as the single datastore**, with
the `pgvector` extension for embeddings and native full-text search (`tsvector`/`GIN`) for
keyword matching, fused with Reciprocal Rank Fusion (RRF) and re-ranked with a hosted reranker.

**Why, vs. alternatives considered:**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Supabase Postgres + pgvector** (recommended) | Already the auth/profile store — one DB, one connection, transactional consistency between student data and paper data; RLS ties naturally into per-student authorization; SQL metadata filtering (subject/year/syllabus/medium) is trivial; zero new infra; cheap; simple local dev via Supabase CLI/Docker; pgvector HNSW is fast enough up to low millions of vectors — comfortably beyond what a "past exam papers" corpus will reach even at a large multi-year, multi-syllabus, multi-language scale. **Confirmed right-sized**: launch scale is a small beta (dozens of papers, <20 concurrent students/devices, §17) — orders of magnitude below where pgvector or a single small Koyeb instance would be a bottleneck. | Not purpose-built for hybrid search (RRF fusion is done in application code, not a DB primitive); would need migration work if the corpus later grows to tens of millions of chunks. | **Chosen** — corpus size doesn't warrant a dedicated vector DB, and consolidating with the existing Supabase project removes an entire class of ops/consistency problems. |
| Qdrant (self-hosted or Cloud) | Purpose-built hybrid (dense+sparse) search, better at large scale, rich filtering | A second datastore to run/pay for/keep in sync with Postgres; more moving parts on Koyeb; overkill for this corpus size | Rejected for now — revisit if corpus grows past ~1–2M chunks or query latency becomes an issue |
| Pinecone (managed) | Fully managed, decent hybrid support | External vendor, recurring cost, still need Postgres alongside it for relational data — so you'd run *two* databases instead of one | Rejected — no benefit over pgvector at this scale, extra cost and sync complexity |

**Fusion approach:** run the pgvector cosine-similarity query and the Postgres full-text query
in parallel (top ~30 each, filtered by subject/syllabus/level/medium where the question implies
them), merge with RRF, then send the merged top ~20 to a re-ranker for the final top-K
(default K=5) passed to the LLM.

**Multi-language caveat on the keyword side:** Postgres's built-in full-text search only ships a
stemming/dictionary config for `'english'` — there's no native Sinhala or Tamil text-search
config, so `content_tsv` (§13) only does real linguistic keyword matching (stemming, stop-words)
for English-medium content. For Sinhala/Tamil chunks it still indexes as unstemmed token
matching (better than nothing, but weaker than English's). This is an accepted tradeoff, not an
oversight: retrieval for those two languages leans more heavily on the semantic (pgvector) side
of the hybrid search, which is language-agnostic by construction — consistent with the
embeddings choice in §9 and the Phase 1 validation step in §7.

---

## 9. Embeddings: Google `text-embedding-004` (Gemini family)

Single-vendor choice, given Gemini is already required for generation:

- Same vendor/billing/latency profile as the LLM calls; one API key to manage.
- Supports explicit `task_type` (`RETRIEVAL_DOCUMENT` at ingest time, `RETRIEVAL_QUERY` at
  search time), which measurably improves retrieval quality over symmetric embeddings.
- 768-dim output — cheap to store and index in pgvector (HNSW) at this corpus scale.
- Multilingual (100+ languages) — see §7 for the Sinhala-specific quality caveat and the planned
  Phase 1 validation step.
- Alternative considered: Voyage AI (`voyage-3`) — slightly stronger on some retrieval
  benchmarks, but adds a third vendor for a marginal quality gain; not worth it here unless
  Phase 1 testing shows Google's embeddings are insufficient specifically for Sinhala/Tamil.

---

## 10. Re-ranking: Cohere Rerank (`rerank-v3.5`) — confirmed (§17, Q3)

- Purpose-built cross-encoder reranker, cheap per-call, no infra to host.
- Sits after RRF fusion, re-scores the merged candidate set against the raw query text,
  returns the final top-K in relevance order — this is what materially improves citation
  precision over naive vector-only or keyword-only retrieval, which directly serves the
  citation-accuracy product requirement in §6.
- Confirmed as worth the extra vendor for a core feature. If Phase 1 testing shows weak
  multilingual (esp. Sinhala) reranking quality, the fallback is prompting Gemini itself as a
  reranker for that language only — same interface, swappable per-language if needed.

---

## 11. RAG Ingestion Pipeline (PDF Upload Flow)

```
1. Admin → POST /papers/upload   (admin-only at launch — confirmed §17, Q5)
   multipart: file (PDF) + metadata { subject, year, syllabus, level, medium }
   Auth: Supabase JWT, role = 'admin' required

2. Gateway:
   - Validates file (PDF mime, size cap e.g. 25MB)
   - Uploads raw PDF to Supabase Storage (private bucket, path keyed by paper id)
   - Inserts `papers` row, status = 'processing'
   - Enqueues an ingestion job (BullMQ / Upstash Redis) with the paper id
   - Responds immediately: { paper_id, status: "processing" }   ← "confirmed back to uploader"
     is the enqueue confirmation, NOT the finished ingestion (see WS note below)

3. Ingestion Service (BullMQ worker):
   a. Fetch PDF from Storage
   b. Structural extraction: send the PDF to Gemini (native PDF/vision understanding — handles
      both born-digital text and scanned/image pages, and Sinhala/Tamil scripts, in one call;
      see §7) asking it to segment into individually-addressable chunks (e.g. per question) with
      metadata (question number, marks, topic). This gives retrieval-friendly chunks that don't
      cut a question mid-sentence, which fixed sliding-window chunking would risk.
      Fallback: fixed-size token window (e.g. 500 tokens, 50 overlap) via a text-extraction
      library (pdf-parse) only for born-digital Latin/basic-Unicode PDFs where structural
      extraction fails — not a safe default for this corpus generally (§7).
   c. Embed each chunk (`text-embedding-004`, task_type=RETRIEVAL_DOCUMENT)
   d. Upsert into `paper_chunks` (content, embedding vector, tsvector generated column, metadata)
   e. Update `papers.status = 'ready'` (or 'failed' with an error reason)

4. Confirmation to uploader:
   - WebSocket push: `paper:ingestion_status` event with { paper_id, status, chunk_count }
     to the uploader's connected client, if connected.
   - Also polled via `GET /papers/:id` for clients that aren't WS-connected.
```

Admin-only scope at launch (§17, Q5) keeps the corpus trustworthy while the pipeline is new;
opening uploads to students is a config/permission change, not a redesign, once the pipeline is
proven.

---

## 12. Auth Design

### 12.1 Mobile app (and future website) — Supabase JWT

- Mobile app already ships `supabase_flutter` and a working (if unwired) `AuthProvider`. Backend
  work is entirely server-side: no new client library needed, just wire the existing
  `_handleLogin`/`_handleSignUp` to call `AuthProvider.signIn`/`signUp` (a client-side fix,
  called out here because the backend's auth guard depends on it actually happening) and send
  the resulting Supabase access token as `Authorization: Bearer <token>` on every request.
- Gateway validates the JWT against Supabase's JWKS endpoint (standard `jsonwebtoken`/`jwks-rsa`
  verification, no round-trip to Supabase per request beyond key caching).
- Extracted `sub` (user id) becomes the authenticated principal; `students.role` determines
  student vs. admin authorization.
- A future website client authenticates identically via `supabase-js` — same bearer token, same
  guard, no backend change (§1).
- Anonymous/onboarding-only users (pre-login) are **not** granted access to `/chat/ask`,
  `/voice/ask` (from a companion device tied to their account), or upload endpoints. This is a
  deliberate behavior change from today, where zero auth is enforced on either endpoint — the
  mobile app's login screen must be wired to actually call `AuthProvider` (§12.1 above) before
  this guard is switched on, otherwise real users get locked out of a currently-open feature.

### 12.2 Robot — per-device API key

- New `devices` table: `{ id, api_key_hash, owner_student_id (nullable), label, created_at,
  last_seen_at, revoked_at }`. Keys are generated server-side (via an admin provisioning
  endpoint), returned once in plaintext, stored hashed (bcrypt/argon2).
- Device sends the key on every `/voice/ask` request via a new header (`X-Device-Key: <key>`).
  **Confirmed (§17): the firmware can still be reflashed**, so this header is added as part of
  the voice-pipeline phase (Phase 2) — closing the "no authentication header, API key, or bearer
  token" gap flagged in the robot README, and replacing the current fixed placeholder
  `STUDENT_ID` with a real per-device identity resolved server-side from the key.
- Rate limiting and revocation are per-device, so a leaked key can be individually revoked
  without affecting other robots.

### 12.3 Roles

- `students.role`: `'student' | 'admin'`. Admin-only paper uploads at launch (§11).

---

## 13. Data Model

```sql
-- Existing (per mobile-app-README), extended:
create table students (
  id          uuid primary key references auth.users(id),
  email       text,
  name        text,
  grade       text,     -- 'ol' | 'al'
  syllabus    text,     -- 'local' | 'edexcel' | 'cambridge'
  medium      text,     -- 'english' | 'sinhala' | 'tamil'
  stream      text,     -- nullable, A/L only
  role        text not null default 'student'  -- 'student' | 'admin'  [NEW]
);

create table devices (                          -- [NEW] robot auth
  id              uuid primary key default gen_random_uuid(),
  api_key_hash    text not null,
  owner_student_id uuid references students(id),
  label           text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz,
  revoked_at      timestamptz
);

create table papers (                           -- [NEW]
  id            uuid primary key default gen_random_uuid(),
  subject       text not null,
  year          int,
  syllabus      text,
  level         text,          -- 'ol' | 'al'
  medium        text,
  storage_path  text not null, -- Supabase Storage object path
  status        text not null default 'processing', -- processing | ready | failed
  error_reason  text,
  uploaded_by   uuid references students(id),
  created_at    timestamptz not null default now()
);

create table paper_chunks (                     -- [NEW]
  id            uuid primary key default gen_random_uuid(),
  paper_id      uuid not null references papers(id) on delete cascade,
  chunk_index   int not null,
  content       text not null,
  metadata      jsonb,          -- { question_number, marks, topic, page, ... }
  embedding     vector(768),    -- pgvector
  content_tsv   tsvector generated always as (to_tsvector('english', content)) stored
);
create index on paper_chunks using hnsw (embedding vector_cosine_ops);
create index on paper_chunks using gin (content_tsv);

create table chat_sessions (                    -- [NEW] server-side history
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid references students(id),
  device_id     uuid references devices(id),    -- set for voice-originated sessions (§5)
  created_at    timestamptz not null default now()
);

create table chat_messages (                    -- [NEW] backs chatHistoryEndpoint too
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references chat_sessions(id) on delete cascade,
  role          text not null,   -- 'user' | 'assistant'
  content       text not null,
  sources       jsonb,           -- full internal citation object, see §6
  created_at    timestamptz not null default now()
);
```

---

## 14. WebSocket Design

The existing clients speak plain HTTP only today — WS is additive, not a replacement for either
contract. Proposed default use cases:

| Channel | Client | Event | Purpose |
|---|---|---|---|
| `/realtime` (mobile) | Flutter app | `paper:ingestion_status` | Push PDF processing completion instead of polling `GET /papers/:id` |
| `/realtime` (mobile) | Flutter app | `chat:token` (optional) | Stream Gemini's answer token-by-token for a snappier chat UI, as a progressive enhancement over the existing blocking `POST /chat/ask` (which remains supported unchanged for backward compatibility) |
| `/realtime` (robot) | ESP32 robot | `device:status` | Firmware can be reflashed (§17), so this is in scope, but sequenced after the higher-priority `X-Device-Key` auth header — a nice-to-have for Phase 2/3, not a launch blocker |

Auth on the WS gateway mirrors HTTP: JWT passed at connection handshake for mobile; device key
for robot once the `device:status` channel is actually built (Phase 2/3, §2) — the robot's HTTP
voice path gets device-key auth first regardless, since that's the higher-priority security fix.

---

## 15. Deployment (Koyeb)

- **Local-first**: `docker-compose.yml` with Postgres+pgvector (matching Supabase's extension
  set), Redis (for BullMQ, mirroring Upstash locally), and the NestJS app. Supabase itself is
  used directly (dev project) rather than fully emulated, since Auth is central to this spec —
  the Supabase CLI's local stack is the fallback if an isolated dev project is preferred.
- **Koyeb**: one Docker-based service running the modular monolith (§3). Internal gRPC servers
  bind to `localhost` inside the same container — no network hops, no per-service billing. No
  Koyeb org or Redis/Upstash account exists yet (§17) — the implementation plan includes
  provisioning both from scratch (Koyeb app + service, Upstash Redis database, env var/secret
  wiring) as an early setup step, not an assumed prerequisite.
- **Secrets**: Gemini API key, Cohere API key, Supabase service-role key, Supabase JWT
  secret/JWKS URL, Redis URL — all via Koyeb env vars/secrets, never committed (the robot
  firmware's committed WiFi credentials are a cautionary example already flagged in its README).
- **Background worker**: the Ingestion Service's BullMQ worker runs as a second process within
  the same monolith deployment (simplest, consistent with §3).

---

## 16. Non-Functional Concerns

- **Rate limiting**: per-student and per-device, at the Gateway (e.g. `@nestjs/throttler`),
  since neither client currently has any.
- **Observability**: structured logging with request/correlation IDs threaded through gRPC
  calls; latency histograms per pipeline stage (STT/retrieval/rerank/LLM/TTS) given the voice
  path's hard latency budget; a citation-rate metric (% of curriculum answers with sources) as a
  direct proxy for the product's core promise.
- **Error handling**: `/chat/ask` and `/voice/ask` both preserve their existing failure shapes
  as the floor (generic error the client already handles) but the backend distinguishes causes
  internally (auth failure vs. upstream Gemini failure vs. no retrieval hits) for logging.
- **PDF upload limits**: size cap, page cap, and a per-admin/day upload rate limit to bound
  embedding cost from abuse.

---

## 17. Decisions Confirmed

All open questions are resolved. Nothing is pending user input as of this draft.

| # | Question | Decision |
|---|---|---|
| 1 | Deployment topology | Modular monolith, in-process gRPC (§3, §15) |
| 2 | Robot firmware mutability | Firmware can be reflashed — real `X-Device-Key` device auth added in Phase 2 (§12.2) |
| 3 | Re-ranker vendor | Cohere Rerank, worth it for citation accuracy (§10) |
| 4 | Voice session memory | Server-side rolling history per `device_id` (§5) |
| 5 | Upload permissions | Admin-only at launch (§11, §12.3) |
| 6 | Scale | Small beta: dozens of papers, <20 concurrent students/devices (§8) |
| 7 | Existing infra | No Koyeb/Redis accounts yet — implementation plan includes provisioning (§15) |
| 8 | MVP phasing | Phased: text chat → voice → uploads (§1) |
| 9 | Voice language scope | English + Tamil at voice launch; Sinhala voice deferred, text chat unaffected (§7) |
