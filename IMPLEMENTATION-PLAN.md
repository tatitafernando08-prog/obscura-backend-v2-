# Obscura Backend v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python/Railway backend with a NestJS modular monolith (Gateway + Auth + RAG + Chat/LLM + Speech + Ingestion services, in-process gRPC) that serves the Flutter mobile app (`POST /chat/ask`) and the ESP32 robot (`POST /voice/ask`), backed by Supabase Postgres+pgvector, with hybrid RAG retrieval, Gemini-generated grounded answers, and citation of real past exam papers, per `SPEC-SHEET.md`.

**Architecture:** One NestJS process (Nest CLI monorepo: `apps/api` + `libs/*`) exposes public HTTP/WS via a Gateway module and runs Auth/RAG/Chat-LLM/Speech/Ingestion as separate Nest modules, each also bound as an in-process gRPC microservice on `127.0.0.1`. Postgres (Supabase, pgvector + tsvector) is the only datastore; Supabase Storage holds raw PDFs; Upstash Redis backs a BullMQ ingestion queue. Delivery is phased: Phase 1 gets text chat working end-to-end, Phase 2 adds the voice pipeline, Phase 3 adds PDF ingestion and admin tooling.

**Tech Stack:** Node.js 20 LTS, npm, NestJS 10.x, TypeScript 5.x (strict), `@nestjs/microservices` (gRPC, `@grpc/grpc-js` + `@grpc/proto-loader`), `ts-proto` for generated types, raw `pg` (node-postgres) for all Postgres access (no ORM), Supabase CLI for SQL migrations, `@supabase/supabase-js` (service-role) for Storage, `jsonwebtoken` + `jwks-rsa` for Supabase JWT verification, `bcrypt` for device-key hashing, `class-validator`/`class-transformer` DTOs, `@google/generative-ai` (Gemini 2.5 Flash + `text-embedding-004`), `cohere-ai` (`rerank-v3.5`), `@google-cloud/speech` + `@google-cloud/text-to-speech` (Phase 2), `bullmq` + `ioredis` (Phase 3), Jest + `supertest`, Docker Compose for local dev, Koyeb for deployment.

## Status (as of 2026-08-26)

63 of 65 tasks are done. This plan's own checkboxes are left unchecked throughout (per this project's established practice — the SDD execution ledger at `.superpowers/sdd/IMPLEMENTATION-PLAN/progress.md`, gitignored, is the authoritative task-by-task status, not this file); this section is a summary, not a replacement for that ledger.

- **Deploy target switched from Koyeb to Railway** partway through (persistent Koyeb dashboard/CLI-auth issues) — every task below that says "Koyeb" (36, 48, 49, 50, 65) actually targets Railway. Live at `https://obscura-api-production-1ffa.up.railway.app`.
- **Two real production bugs found and fixed post-deploy, not caught by any task's original spec:**
  - `pdf-parse` (Task 57's fallback chunker) corrupts its own internal parse state when concurrent Node I/O races it on the main thread — reproduced live in production, fixed by isolating the parse in its own `worker_threads.Worker`.
  - `GeminiExtractor` (Task 55) had no timeout on its live Gemini call, so a Gemini hang blocked the ingestion pipeline forever, including the pdf-parse fallback above. Fixed with a 45s `AbortController`-based timeout.
- **Four Minor findings deferred across earlier task reviews (Tasks 39/40/46) are now all cleared:** `VoiceController` propagates request-id into its gRPC calls; STT/TTS catch live API failures instead of throwing uncaught; `/voice/ask`'s query params are validated via a DTO; `speech.controller.ts`'s response cast is a real interface, not a blanket `Record`.
- **Remaining (2 tasks, both otherwise complete):** Task 64's final citation check and Task 35's final chat-answer check are blocked purely on Google Gemini's free-tier daily quota (20 requests/day) — every other step of both is independently verified working against production. Not a code issue; retest once the quota resets.

## Global Constraints

- Node.js 20 LTS, npm only (no yarn/pnpm) — every command in this plan assumes `npm`.
- NestJS 10.x, TypeScript strict mode (`"strict": true` in every `tsconfig.json`).
- No ORM. All SQL is hand-written, run through `pg.Pool`, versioned as Supabase CLI migrations under `supabase/migrations/`.
- All internal service-to-service calls use gRPC (`@nestjs/microservices`, `Transport.GRPC`) bound to `127.0.0.1`, never HTTP — per SPEC-SHEET.md §3/§4.
- `.proto` contracts live in `libs/proto/src/*.proto`; generated TypeScript comes from `ts-proto` via `npm run proto:gen`, never hand-edited.
- The wire contracts of `POST /chat/ask` and `POST /voice/ask` (request/response JSON shape, `sources: [{past_papers:{subject,year}}]`) must stay byte-for-byte compatible with what the live mobile app and robot firmware already send/parse — see `mobile-app-README.md` §API Endpoints and `iot-robot-README.md` §5.
- Every curriculum-content answer must be grounded (§6 of SPEC-SHEET.md): no chunks above threshold → localized decline, never a free-hallucinated answer. This is a hard rule, not a best-effort behavior.
- Secrets (Gemini key, Cohere key, Supabase service-role key, Supabase JWT/JWKS URL, Redis URL, GCP service account) are read from environment variables via `@nestjs/config` with a validated schema, and are never committed. `.env` is gitignored; `.env.example` documents every key with a placeholder.
- Voice pipeline latency budget (§5): p95 < 10s, hard ceiling 25s. Every voice-path task that adds latency must be instrumented (a `console.time`-style stage timer at minimum) so this is measurable, not assumed.
- Sinhala is fully supported in text chat, but rejected on the voice path at launch (§7, §17 Q9) — Speech Service must return a clear, English/Tamil-synthesized "not supported over voice yet" response for `medium=sinhala`, not attempt STT/TTS in Sinhala.
- Cross-repo scope: this plan also edits two sibling repos that are **not** part of `obscura-backend-v2`'s git history — `C:\Users\Dell\StudioProjects\Obscura_app\obscura_app` (Flutter mobile app, Phase 1) and `C:\Users\Dell\OneDrive\Documents\Arduino\obscura_nesh_fixed` (ESP32 firmware, Phase 2). Tasks that touch those repos say so explicitly in their **Files** block and are committed separately, in their own repos, with their own commit messages.
- Ingestion Service is implemented as a BullMQ processor only, not also as a gRPC service. SPEC-SHEET.md §4 lists it as "gRPC (internal) + BullMQ worker," but the actual data flow in §11 only ever triggers it via the queue (Gateway enqueues a job; nothing calls it synchronously) — adding a gRPC surface with no caller would violate YAGNI. This is a deliberate deviation from the literal service table, noted here so it isn't mistaken for an oversight.
- SPEC-SHEET.md §15 describes the ingestion worker as running "as a second process within the same monolith deployment (simplest, consistent with §3)." This plan reads that as "a distinct BullMQ `Worker` instance running inside the same single Node.js process" (Task 56), not a literally separate OS process — a second OS process would contradict §3's explicit "one NestJS process on one Koyeb service" framing, and nothing in §11's data flow needs true process isolation at this scale.
- SPEC-SHEET.md §14 lists two WebSocket channels this plan does not implement: `chat:token` (explicitly marked "(optional)" progressive-enhancement streaming) and `device:status` (explicitly marked "Phase 2/3, not launch-blocking"). Only `paper:ingestion_status` (Task 61) is implemented, per §14's own priority ordering. Both deferred channels can be added later without changing anything this plan builds.
- Local dev Supabase project is a **new, dedicated** project for `obscura-backend-v2` (provisioned in Task 3), not the mobile app's existing live project (`zsdsqyowcjifbktbolji`) — migrations and test data must never touch the live project.

---

## Phase 1 — Project Scaffolding, Auth Service, Gateway, RAG Service, Chat/LLM Service

Delivers `POST /chat/ask` working end-to-end against a real Supabase-JWT-authenticated mobile app, with hybrid RAG retrieval and cited, grounded answers.

### Section 1.0 — Provisioning

None of these accounts exist yet (SPEC-SHEET.md §17 Q7). Each task below is a guided manual checklist (account/project creation needs an interactive browser signup I can't perform for you) ending in a CLI/API step that verifies the credentials actually work, so the task has a concrete pass/fail check like every other task in this plan.

### Task 1: Provision Koyeb account, org, and CLI

**Files:**
- Create: `.koyeb.env` (gitignored — stores your Koyeb org/app identifiers locally for later deploy tasks, not secrets)

- [ ] **Step 1: Create the Koyeb account and app**

Manual steps (browser):
1. Go to https://app.koyeb.com/auth/signup and create an account (GitHub OAuth or email).
2. Once logged in, note your **Organization name** (shown top-left after signup).
3. Do **not** create a service yet — that happens in Task 36 once there's a Dockerfile to deploy. For now, just confirm the org exists.

- [ ] **Step 2: Install and authenticate the Koyeb CLI**

```bash
curl -fsSL https://raw.githubusercontent.com/koyeb/koyeb-cli/master/install.sh | sh
koyeb login
```
Follow the browser prompt to authorize the CLI against the account created in Step 1.

- [ ] **Step 3: Verify**

```bash
koyeb organizations list
```
Expected: your organization name from Step 1 appears in the output. Record it:

```bash
echo "KOYEB_ORG=<your-org-name>" >> .koyeb.env
```

- [ ] **Step 4: Commit**

```bash
echo ".koyeb.env" >> .gitignore
git add .gitignore
git commit -m "chore: gitignore local Koyeb org config"
```

---

### Task 2: Provision Upstash Redis database

**Files:**
- Modify: `.env.example` (created in Task 7 — if that task hasn't run yet, create a placeholder now and Task 7 will extend it)

- [ ] **Step 1: Create the Upstash account and Redis database**

Manual steps (browser):
1. Go to https://console.upstash.com and sign up (GitHub/Google/email).
2. Click **Create Database**. Name it `obscura-backend-v2`. Choose a region close to Koyeb's deployment region (pick the same cloud/region family — e.g. AWS us-east-1 if that's where you'll deploy on Koyeb, to minimize latency for BullMQ used in Phase 3).
3. Type: **Regional** (not Global — BullMQ needs strong consistency for job locking, and this is a small beta so cross-region replication isn't needed).
4. Once created, open the database's **Details** tab and copy the **Redis connect URL** (the `rediss://...` TLS URL, not the REST URL — `ioredis`/BullMQ need the native Redis protocol URL).

- [ ] **Step 2: Verify connectivity**

```bash
npx --yes ioredis-cli "rediss://<copied-url>" ping
```
Expected output: `PONG`. (If `ioredis-cli` isn't available, `redis-cli -u "rediss://<copied-url>" ping` works identically if you have `redis-cli` installed locally.)

- [ ] **Step 3: Record for later tasks**

Create a placeholder `.env.example` entry (Task 7 will formalize the full file):
```
REDIS_URL=rediss://default:<password>@<host>:<port>
```
Do **not** commit the real password — this goes in your local `.env` only, created in Task 7.

---

### Task 3: Provision a dedicated Supabase dev project

**Files:**
- Create: `.env.example` entries for `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`

- [ ] **Step 1: Create the project**

Manual steps (browser):
1. Go to https://supabase.com/dashboard and sign in (reuse whatever account already owns the mobile app's `zsdsqyowcjifbktbolji` project, or a fresh one — either is fine as long as this is a **new, separate project**).
2. Click **New project**. Name it `obscura-backend-v2-dev`. Pick a strong generated DB password and save it somewhere safe (you'll need it for direct `psql`/CLI access). Region: same as your Upstash choice if practical, doesn't need to match exactly.
3. Wait for provisioning to finish (~2 min).
4. In **Project Settings → Data API**, copy the **Project URL** and the **anon public key**.
5. In **Project Settings → Data API → Service role**, copy the **service_role key** (keep this one especially secret — it bypasses RLS).
6. In **Project Settings → Data API → JWT Settings**, copy the **JWT Secret** (used later for local JWKS-equivalent verification, or note the **JWKS URL** if using the newer JWT signing keys flow — either works with Task 14's implementation, see that task's note).
7. In the SQL Editor, run:
   ```sql
   create extension if not exists vector;
   ```
   to enable pgvector on this project (needed starting Task 10).

- [ ] **Step 2: Verify**

```bash
curl -s "https://<project-ref>.supabase.co/rest/v1/" -H "apikey: <anon-key>" | head -c 200
```
Expected: a JSON response (OpenAPI root), not a connection error or 401.

- [ ] **Step 3: Record values**

You'll paste these into `.env` in Task 7. For now just keep them somewhere safe — do not commit them anywhere.

---

### Task 4: Obtain a Gemini API key

**Files:** none (credential only, wired into `.env` in Task 7)

- [ ] **Step 1: Create the key**

Manual steps (browser):
1. Go to https://aistudio.google.com/apikey.
2. Click **Create API key**, choose or create a Google Cloud project to associate it with.
3. Copy the generated key.

- [ ] **Step 2: Verify**

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=<your-key>" | head -c 300
```
Expected: a JSON list of models including `gemini-2.5-flash` and `text-embedding-004`, not an auth error.

---

### Task 5: Obtain a Cohere API key

**Files:** none (credential only, wired into `.env` in Task 7)

- [ ] **Step 1: Create the key**

Manual steps (browser):
1. Go to https://dashboard.cohere.com/api-keys and sign up/sign in.
2. Copy the default **Trial key** (sufficient for beta-scale usage per SPEC-SHEET.md §8 scale confirmation — dozens of papers, <20 concurrent users).

- [ ] **Step 2: Verify**

```bash
curl -s https://api.cohere.com/v1/models -H "Authorization: Bearer <your-key>" | head -c 300
```
Expected: a JSON list of models including `rerank-v3.5`.

---

### Section 1.1 — Monorepo & Tooling Scaffolding

### Task 6: Initialize the NestJS monorepo

**Files:**
- Create: `package.json`, `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`, `.eslintrc.js`, `.prettierrc`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/tsconfig.app.json`, `.gitignore`

**Interfaces:**
- Produces: `AppModule` (root module, currently empty — later tasks add imports), the `apps/api` Nest CLI "app" entry point, and the monorepo's `libs/` convention (`@app/<lib-name>` path aliases) that every later task's `libs/*` module relies on.

- [ ] **Step 1: Scaffold via Nest CLI**

```bash
npm i -g @nestjs/cli@10
nest new . --skip-git --package-manager npm
```
When prompted "Which package manager", confirm `npm`. This creates a standard single-app Nest project first; the next step converts it to monorepo (multi-app + libs) mode.

- [ ] **Step 2: Convert to monorepo layout**

```bash
mkdir -p apps/api/src
git mv src/* apps/api/src/ 2>/dev/null || mv src/* apps/api/src/
rmdir src
```

Write `nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "apps/api/src",
  "monorepo": true,
  "root": "apps/api",
  "compilerOptions": {
    "webpack": false,
    "tsConfigPath": "apps/api/tsconfig.app.json"
  },
  "projects": {
    "api": {
      "type": "application",
      "root": "apps/api",
      "entryFile": "main",
      "sourceRoot": "apps/api/src",
      "compilerOptions": {
        "tsConfigPath": "apps/api/tsconfig.app.json"
      }
    }
  }
}
```

Write `apps/api/tsconfig.app.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "../../dist/apps/api"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.spec.ts"]
}
```

Write root `tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": false,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2022",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "strictBindCallApply": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "paths": {
      "@app/proto": ["libs/proto/src"],
      "@app/proto/*": ["libs/proto/src/*"],
      "@app/common": ["libs/common/src"],
      "@app/common/*": ["libs/common/src/*"],
      "@app/database": ["libs/database/src"],
      "@app/database/*": ["libs/database/src/*"],
      "@app/auth-service": ["libs/auth-service/src"],
      "@app/auth-service/*": ["libs/auth-service/src/*"],
      "@app/rag-service": ["libs/rag-service/src"],
      "@app/rag-service/*": ["libs/rag-service/src/*"],
      "@app/chat-service": ["libs/chat-service/src"],
      "@app/chat-service/*": ["libs/chat-service/src/*"],
      "@app/speech-service": ["libs/speech-service/src"],
      "@app/speech-service/*": ["libs/speech-service/src/*"],
      "@app/ingestion-service": ["libs/ingestion-service/src"],
      "@app/ingestion-service/*": ["libs/ingestion-service/src/*"],
      "@app/gateway": ["libs/gateway/src"],
      "@app/gateway/*": ["libs/gateway/src/*"]
    }
  }
}
```

Write `apps/api/src/main.ts`:
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

Write `apps/api/src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';

@Module({
  imports: [],
})
export class AppModule {}
```

- [ ] **Step 3: Add ESLint/Prettier**

```bash
npm i -D eslint prettier eslint-config-prettier eslint-plugin-prettier @typescript-eslint/eslint-plugin @typescript-eslint/parser
```

Write `.prettierrc`:
```json
{ "singleQuote": true, "trailingComma": "all" }
```

Write `.eslintrc.js`:
```javascript
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', sourceType: 'module' },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: { node: true, jest: true },
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
```

- [ ] **Step 4: Verify it builds and runs**

```bash
npm run build
node dist/apps/api/main.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
kill %1
```
Expected: build succeeds with no TypeScript errors; curl prints `404` (empty `AppModule` has no routes yet — a 404 means the HTTP server is actually up).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold NestJS monorepo (apps/api + libs convention)"
```

---

### Task 7: Environment config module

**Files:**
- Create: `libs/common/src/config/env.validation.ts`, `libs/common/src/config/config.module.ts`, `libs/common/src/index.ts`, `.env.example`, `.env` (gitignored)
- Modify: `apps/api/src/app.module.ts`, `.gitignore`

**Interfaces:**
- Produces: `AppConfigModule` (global, exported from `@app/common`), injectable `ConfigService<EnvConfig, true>` typed access to every env var used anywhere in this plan.

- [ ] **Step 1: Install deps**

```bash
npm i @nestjs/config joi
```

- [ ] **Step 2: Write the validation schema**

`libs/common/src/config/env.validation.ts`:
```typescript
import * as Joi from 'joi';

export interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  GEMINI_API_KEY: string;
  COHERE_API_KEY: string;
  AUTH_GRPC_URL: string;
  RAG_GRPC_URL: string;
  CHAT_GRPC_URL: string;
  SPEECH_GRPC_URL: string;
}

export const envValidationSchema = Joi.object<EnvConfig, true>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_ANON_KEY: Joi.string().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),
  SUPABASE_JWT_SECRET: Joi.string().required(),
  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  GEMINI_API_KEY: Joi.string().required(),
  COHERE_API_KEY: Joi.string().required(),
  AUTH_GRPC_URL: Joi.string().default('127.0.0.1:50051'),
  RAG_GRPC_URL: Joi.string().default('127.0.0.1:50052'),
  CHAT_GRPC_URL: Joi.string().default('127.0.0.1:50053'),
  SPEECH_GRPC_URL: Joi.string().default('127.0.0.1:50054'),
});
```

- [ ] **Step 3: Write the config module**

`libs/common/src/config/config.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
  ],
})
export class AppConfigModule {}
```

`libs/common/src/index.ts`:
```typescript
export * from './config/config.module';
export * from './config/env.validation';
```

- [ ] **Step 4: Write `.env.example`**

```
NODE_ENV=development
PORT=3000

SUPABASE_URL=https://your-dev-project-ref.supabase.co
SUPABASE_ANON_KEY=replace-me
SUPABASE_SERVICE_ROLE_KEY=replace-me
SUPABASE_JWT_SECRET=replace-me

DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres

REDIS_URL=rediss://default:replace-me@replace-me.upstash.io:6379

GEMINI_API_KEY=replace-me
COHERE_API_KEY=replace-me

AUTH_GRPC_URL=127.0.0.1:50051
RAG_GRPC_URL=127.0.0.1:50052
CHAT_GRPC_URL=127.0.0.1:50053
SPEECH_GRPC_URL=127.0.0.1:50054
```

Create your real `.env` by copying this and filling in the values gathered in Tasks 2-5 (`DATABASE_URL` comes from Task 9's local Supabase stack, or from the dev project's connection string under **Project Settings → Database** for now — pointing straight at the dev project is fine until Task 9 sets up the local stack).

- [ ] **Step 5: Wire into `AppModule`**

`apps/api/src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';

@Module({
  imports: [AppConfigModule],
})
export class AppModule {}
```

- [ ] **Step 6: Gitignore secrets**

Add to `.gitignore`:
```
.env
```

- [ ] **Step 7: Verify**

```bash
npm run build && node dist/apps/api/main.js
```
Expected: starts cleanly with your real `.env` values. Then temporarily rename `.env` to `.env.bak` and re-run — expected: it throws a `ValidationError` listing every missing required key (proves the schema is actually enforced), then restore `.env`.

- [ ] **Step 8: Commit**

```bash
git add libs/common package.json package-lock.json apps/api/src/app.module.ts .env.example .gitignore
git commit -m "feat: add validated environment config module"
```

---

### Task 8: Docker Compose local stack + Dockerfile

**Files:**
- Create: `docker-compose.yml`, `Dockerfile`, `.dockerignore`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
version: "3.9"
services:
  postgres:
    image: pgvector/pgvector:pg15
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "54322:5432"
    volumes:
      - obscura_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - "6380:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  obscura_pg_data:
```

Note: local `redis` here mirrors Upstash for fully offline dev (matches SPEC-SHEET.md §15); `REDIS_URL` in your local `.env` can point at either `redis://localhost:6380` (this container) or the real Upstash URL from Task 2 — both work since BullMQ/ioredis speak the same protocol.

- [ ] **Step 2: Write the production `Dockerfile`**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run proto:gen && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/libs/proto/src ./libs/proto/src
EXPOSE 3000
CMD ["node", "dist/apps/api/src/main.js"]
```
(`npm run proto:gen` is added in Task 9; this Dockerfile is written now so Task 8 is self-contained, and will just work once that script exists. The `libs/proto/src` copy is required because `@grpc/proto-loader` parses the raw `.proto` text at runtime — the compiled `dist` output alone is not sufficient.)

- [ ] **Step 3: Write `.dockerignore`**

```
node_modules
dist
.env
.git
```

- [ ] **Step 4: Verify Postgres/Redis come up**

```bash
docker compose up -d postgres redis
docker compose ps
```
Expected: both services show `healthy` status within ~15s.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml Dockerfile .dockerignore
git commit -m "chore: add docker-compose local stack and production Dockerfile"
```

---

### Task 9: `libs/proto` scaffolding + ts-proto codegen

**Files:**
- Create: `libs/proto/src/auth.proto`, `libs/proto/tsproto.config.json` (implicit via CLI flags, see below), `package.json` (add `proto:gen` script)

**Interfaces:**
- Produces: `npm run proto:gen`, which every later `.proto`-adding task (13, 19, 24, 38) re-runs. Generated output lands in `libs/proto/src/generated/*.ts` and is imported as `@app/proto/generated/<name>`.

- [ ] **Step 1: Install codegen tooling**

```bash
npm i @grpc/grpc-js @grpc/proto-loader @nestjs/microservices
npm i -D ts-proto grpc-tools
```

- [ ] **Step 2: Seed a minimal proto so the toolchain has something to compile**

`libs/proto/src/health.proto`:
```protobuf
syntax = "proto3";
package health;

service HealthProbe {
  rpc Ping (PingRequest) returns (PingResponse);
}

message PingRequest {}
message PingResponse {
  bool ok = 1;
}
```
(This is a throwaway smoke-test contract, not a real service — it exists purely so this task has something concrete to generate and verify against before Task 13's real `auth.proto` lands.)

- [ ] **Step 3: Add the codegen script**

Add to `package.json` `"scripts"`:
```json
"proto:gen": "protoc --plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto --ts_proto_out=./libs/proto/src/generated --ts_proto_opt=nestJs=true,addGrpcMetadata=true,outputServices=grpc-js -I libs/proto/src libs/proto/src/*.proto"
```
This requires the `protoc` binary on PATH. Install it:
```bash
npm i -D grpc-tools
```
and adjust the script to use the bundled binary instead of relying on a system install:
```json
"proto:gen": "protoc --plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto --ts_proto_out=./libs/proto/src/generated --ts_proto_opt=nestJs=true,addGrpcMetadata=true,outputServices=grpc-js --proto_path=libs/proto/src $(node -e \"console.log(require('fs').readdirSync('libs/proto/src').filter(f=>f.endsWith('.proto')).map(f=>'libs/proto/src/'+f).join(' '))\")"
```
If `protoc` still isn't found, install it via your OS package manager (`choco install protoc` on Windows, or download from https://github.com/protocolbuffers/protobuf/releases) and ensure it's on PATH — `grpc-tools` only ships the Node plugin, not `protoc` itself on all platforms.

- [ ] **Step 4: Verify**

```bash
npm run proto:gen
ls libs/proto/src/generated
```
Expected: `health.ts` (or similarly named generated file) exists and exports `HealthProbeClient`, `PingRequest`, `PingResponse` TypeScript types.

- [ ] **Step 5: Gitignore generated output, commit the rest**

Add to `.gitignore`:
```
libs/proto/src/generated
```
```bash
git add libs/proto/src package.json package-lock.json .gitignore
git commit -m "chore: scaffold libs/proto with ts-proto codegen"
```

---

### Task 10: Supabase CLI local stack + initial schema migration

**Files:**
- Create: `supabase/config.toml` (via CLI), `supabase/migrations/<timestamp>_init_schema.sql`

**Interfaces:**
- Produces: the full Phase 1-3 schema (`students`, `devices`, `papers`, `paper_chunks`, `chat_sessions`, `chat_messages`) that every database-touching task in this plan (11, 12, 20, 23, 30, 44, 52, 55, 59) queries against. Tables outside Phase 1's immediate feature set (`devices`, `papers`, `paper_chunks`) are created now — schema-only — because `chat_sessions.device_id` and `paper_chunks` are foreign-key/query dependencies of Phase 1's RAG Service (Task 20) even though the features that populate them (device auth, PDF ingestion) don't ship until Phase 2/3.

- [ ] **Step 1: Install and link the Supabase CLI**

```bash
npm i -D supabase
npx supabase login
npx supabase init
npx supabase link --project-ref <your-dev-project-ref-from-task-3>
```

- [ ] **Step 2: Write the migration**

```bash
npx supabase migration new init_schema
```
This creates `supabase/migrations/<timestamp>_init_schema.sql`. Replace its contents with:

```sql
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
```

- [ ] **Step 3: Apply it to the dev project**

```bash
npx supabase db push
```

- [ ] **Step 4: Verify**

```bash
npx supabase db diff
```
Expected: empty output (no drift — the remote dev project's schema now matches this migration file exactly).

```sql
-- run in the Supabase SQL editor or via psql against DATABASE_URL
select table_name from information_schema.tables where table_schema = 'public' order by 1;
```
Expected: `students, devices, papers, paper_chunks, chat_sessions, chat_messages` all present.

- [ ] **Step 5: Commit**

```bash
git add supabase
git commit -m "feat: add initial Postgres schema migration (students, devices, papers, paper_chunks, chat_sessions, chat_messages)"
```

---

### Section 1.2 — Database Library

### Task 11: `libs/database` connection pool

**Files:**
- Create: `libs/database/src/database.module.ts`, `libs/database/src/database.service.ts`, `libs/database/src/index.ts`

**Interfaces:**
- Produces: `DatabaseModule` (global), injectable `DatabaseService` with `query<T>(sql: string, params?: unknown[]): Promise<T[]>` — every repository in this plan (Tasks 12, 20, 23, 30, 44, 55, 59, 63) is built on this.

- [ ] **Step 1: Install `pg`**

```bash
npm i pg
npm i -D @types/pg
```

- [ ] **Step 2: Write the service**

`libs/database/src/database.service.ts`:
```typescript
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';
import { EnvConfig } from '@app/common';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.pool = new Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
```

`libs/database/src/database.module.ts`:
```typescript
import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
```

`libs/database/src/index.ts`:
```typescript
export * from './database.module';
export * from './database.service';
```

- [ ] **Step 3: Write an integration test**

`libs/database/src/database.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService],
    }).compile();
    service = moduleRef.get(DatabaseService);
  });

  it('runs a trivial query against the real dev database', async () => {
    const rows = await service.query<{ answer: number }>('select 1 + 1 as answer');
    expect(rows[0].answer).toBe(2);
  });
});
```
This requires `.env`'s `DATABASE_URL` to be reachable — point it at the Supabase dev project's connection string (or `postgresql://postgres:postgres@localhost:54322/postgres` once you're running `docker compose up postgres` locally with the same schema applied via `psql < supabase/migrations/*.sql`).

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/database --runInBand
```
Expected: 1 passing test.

- [ ] **Step 5: Commit**

```bash
git add libs/database package.json package-lock.json
git commit -m "feat: add libs/database Postgres connection pool"
```

---

### Task 12: Students repository

**Files:**
- Create: `libs/database/src/repositories/students.repository.ts`, `libs/database/src/repositories/students.repository.spec.ts`
- Modify: `libs/database/src/index.ts`, `libs/database/src/database.module.ts`

**Interfaces:**
- Consumes: `DatabaseService.query` (Task 11).
- Produces: `StudentsRepository.findById(id: string): Promise<Student | null>`, `.getRole(id: string): Promise<'student' | 'admin' | null>` — Task 14 (Auth Service role resolution) and Task 54 (AdminGuard) depend on these exact signatures.

- [ ] **Step 1: Write the failing test**

`libs/database/src/repositories/students.repository.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database.service';
import { StudentsRepository } from './students.repository';

describe('StudentsRepository', () => {
  let db: DatabaseService;
  let repo: StudentsRepository;
  const testId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, StudentsRepository],
    }).compile();
    db = moduleRef.get(DatabaseService);
    repo = moduleRef.get(StudentsRepository);

    // students.id has a FK to auth.users(id); insert a matching auth.users row first
    // so this test can insert into students without violating the constraint.
    await db.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [testId, `test-${testId}@example.com`],
    );
  });

  afterAll(async () => {
    await db.query('delete from students where id = $1', [testId]);
    await db.query('delete from auth.users where id = $1', [testId]);
  });

  it('returns null for a student that does not exist', async () => {
    const result = await repo.findById(randomUUID());
    expect(result).toBeNull();
  });

  it('finds a student by id after insert, defaulting role to student', async () => {
    await db.query(
      `insert into students (id, email, name) values ($1, $2, $3)`,
      [testId, 'test@example.com', 'Test Student'],
    );

    const found = await repo.findById(testId);
    expect(found).toMatchObject({ id: testId, email: 'test@example.com', role: 'student' });

    const role = await repo.getRole(testId);
    expect(role).toBe('student');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/database/src/repositories/students.repository.spec.ts
```
Expected: FAIL — `Cannot find module './students.repository'`.

- [ ] **Step 3: Implement**

`libs/database/src/repositories/students.repository.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface Student {
  id: string;
  email: string | null;
  name: string | null;
  grade: string | null;
  syllabus: string | null;
  medium: string | null;
  stream: string | null;
  role: 'student' | 'admin';
}

@Injectable()
export class StudentsRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(id: string): Promise<Student | null> {
    const rows = await this.db.query<Student>(
      `select id, email, name, grade, syllabus, medium, stream, role
       from students where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async getRole(id: string): Promise<'student' | 'admin' | null> {
    const student = await this.findById(id);
    return student?.role ?? null;
  }
}
```

Update `libs/database/src/index.ts`:
```typescript
export * from './database.module';
export * from './database.service';
export * from './repositories/students.repository';
```

Update `libs/database/src/database.module.ts` to also provide/export `StudentsRepository`:
```typescript
import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { StudentsRepository } from './repositories/students.repository';

@Global()
@Module({
  providers: [DatabaseService, StudentsRepository],
  exports: [DatabaseService, StudentsRepository],
})
export class DatabaseModule {}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/database/src/repositories/students.repository.spec.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add libs/database
git commit -m "feat: add StudentsRepository"
```

---

### Section 1.3 — Auth Service

### Task 13: `auth.proto` (JWT verification only) + codegen

**Files:**
- Create: `libs/proto/src/auth.proto`
- Delete: `libs/proto/src/health.proto` (was only a codegen smoke test in Task 9)

**Interfaces:**
- Produces: `AuthServiceClient`, `VerifyTokenRequest`, `VerifyTokenResponse`, `Principal` generated types, consumed by Task 14 (implementation), Task 16 (gRPC wiring), and Task 17 (Gateway guard).

- [ ] **Step 1: Write the proto**

`libs/proto/src/auth.proto`:
```protobuf
syntax = "proto3";
package auth;

service AuthService {
  rpc VerifyToken (VerifyTokenRequest) returns (VerifyTokenResponse);
}

message VerifyTokenRequest {
  string token = 1;
}

message Principal {
  string type = 1; // "student" | "admin"
  string id = 2;
  string role = 3; // "student" | "admin"
}
// Device identity is a separate concept, not a Principal — see Task 42's
// VerifyDeviceKey RPC and Task 43's DeviceAuthGuard, which attach a distinct
// {deviceId, ownerStudentId} shape to the request instead of a Principal.

message VerifyTokenResponse {
  bool valid = 1;
  Principal principal = 2;
  string error = 3;
}
```

- [ ] **Step 2: Remove the smoke-test proto and regenerate**

```bash
rm libs/proto/src/health.proto
npm run proto:gen
ls libs/proto/src/generated
```
Expected: `auth.ts` present, exporting `AuthServiceClient`, `VerifyTokenRequest`, `VerifyTokenResponse`, `Principal`; `health.ts` no longer regenerated (delete the stale file if it lingers: `rm -f libs/proto/src/generated/health.ts`).

- [ ] **Step 3: Commit**

```bash
git add libs/proto
git commit -m "feat: define auth.proto (VerifyToken)"
```

---

### Task 14: Supabase JWT verification

**Files:**
- Create: `libs/auth-service/src/jwt-verifier.service.ts`, `libs/auth-service/src/jwt-verifier.service.spec.ts`

**Interfaces:**
- Consumes: `SUPABASE_JWT_SECRET` (Task 7 env config).
- Produces: `JwtVerifierService.verify(token: string): Promise<{sub: string} | null>` — Task 15 wraps this into the full `Principal` resolution used by Task 16's gRPC controller.

- [ ] **Step 1: Install deps**

```bash
npm i jsonwebtoken
npm i -D @types/jsonwebtoken
```

Note: Supabase's default JWT signing is HS256 with a shared secret (`SUPABASE_JWT_SECRET`, gathered in Task 3) — this is simpler than JWKS/RS256 and doesn't need `jwks-rsa` or a network round-trip per verification. If your project has been switched to the newer asymmetric JWT signing keys (visible as "JWKS URL" instead of a plain secret in the dashboard), swap this implementation for `jwks-rsa` + RS256 verification instead; the public interface (`verify(token): Promise<{sub: string} | null>`) stays identical either way, so nothing downstream changes.

- [ ] **Step 2: Write the failing test**

`libs/auth-service/src/jwt-verifier.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwtVerifierService } from './jwt-verifier.service';

describe('JwtVerifierService', () => {
  let service: JwtVerifierService;
  const secret = 'test-secret-at-least-32-characters-long';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [
        JwtVerifierService,
        { provide: ConfigService, useValue: { get: () => secret } },
      ],
    }).compile();
    service = moduleRef.get(JwtVerifierService);
  });

  it('accepts a validly signed, unexpired token and returns its sub claim', async () => {
    const token = jwt.sign({ sub: 'user-123', role: 'authenticated' }, secret, {
      expiresIn: '1h',
    });
    const result = await service.verify(token);
    expect(result).toEqual({ sub: 'user-123' });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = jwt.sign({ sub: 'user-123' }, 'wrong-secret', { expiresIn: '1h' });
    const result = await service.verify(token);
    expect(result).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = jwt.sign({ sub: 'user-123' }, secret, { expiresIn: '-1h' });
    const result = await service.verify(token);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx jest libs/auth-service/src/jwt-verifier.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`libs/auth-service/src/jwt-verifier.service.ts`:
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { EnvConfig } from '@app/common';

@Injectable()
export class JwtVerifierService {
  private readonly logger = new Logger(JwtVerifierService.name);

  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  async verify(token: string): Promise<{ sub: string } | null> {
    try {
      const secret = this.config.get('SUPABASE_JWT_SECRET', { infer: true });
      const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
      if (typeof decoded.sub !== 'string') return null;
      return { sub: decoded.sub };
    } catch (err) {
      this.logger.debug(`JWT verification failed: ${(err as Error).message}`);
      return null;
    }
  }
}
```

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/auth-service/src/jwt-verifier.service.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add libs/auth-service package.json package-lock.json
git commit -m "feat: add Supabase JWT verification"
```

---

### Task 15: Principal resolution

**Files:**
- Create: `libs/auth-service/src/auth.service.ts`, `libs/auth-service/src/auth.service.spec.ts`

**Interfaces:**
- Consumes: `JwtVerifierService.verify` (Task 14), `StudentsRepository.findById` (Task 12).
- Produces: `AuthService.resolvePrincipal(token: string): Promise<Principal | null>` where `Principal = {type: 'student'|'admin', id: string, role: 'student'|'admin'}` — this exact shape is what Task 16's gRPC controller returns and Task 17's Gateway guard consumes.

- [ ] **Step 1: Write the failing test**

`libs/auth-service/src/auth.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { StudentsRepository } from '@app/database';

describe('AuthService', () => {
  let service: AuthService;
  const verify = jest.fn();
  const findById = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: JwtVerifierService, useValue: { verify } },
        { provide: StudentsRepository, useValue: { findById } },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  beforeEach(() => jest.clearAllMocks());

  it('returns null when the token is invalid', async () => {
    verify.mockResolvedValue(null);
    const result = await service.resolvePrincipal('bad-token');
    expect(result).toBeNull();
  });

  it('returns null when the token is valid but no matching student row exists', async () => {
    verify.mockResolvedValue({ sub: 'user-1' });
    findById.mockResolvedValue(null);
    const result = await service.resolvePrincipal('valid-token');
    expect(result).toBeNull();
  });

  it('resolves a student principal for a valid token with a student role', async () => {
    verify.mockResolvedValue({ sub: 'user-1' });
    findById.mockResolvedValue({ id: 'user-1', role: 'student' });
    const result = await service.resolvePrincipal('valid-token');
    expect(result).toEqual({ type: 'student', id: 'user-1', role: 'student' });
  });

  it('resolves an admin principal for a valid token with an admin role', async () => {
    verify.mockResolvedValue({ sub: 'user-2' });
    findById.mockResolvedValue({ id: 'user-2', role: 'admin' });
    const result = await service.resolvePrincipal('valid-token');
    expect(result).toEqual({ type: 'admin', id: 'user-2', role: 'admin' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/auth-service/src/auth.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/auth-service/src/auth.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { StudentsRepository } from '@app/database';

export interface Principal {
  type: 'student' | 'admin';
  id: string;
  role: 'student' | 'admin';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtVerifier: JwtVerifierService,
    private readonly students: StudentsRepository,
  ) {}

  async resolvePrincipal(token: string): Promise<Principal | null> {
    const decoded = await this.jwtVerifier.verify(token);
    if (!decoded) return null;

    const student = await this.students.findById(decoded.sub);
    if (!student) return null;

    return { type: student.role, id: student.id, role: student.role };
  }
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/auth-service/src/auth.service.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add libs/auth-service
git commit -m "feat: resolve auth principal from JWT + student role"
```

---

### Task 16: Wire Auth Service as an in-process gRPC microservice

**Files:**
- Create: `libs/auth-service/src/auth.controller.ts`, `libs/auth-service/src/auth-service.module.ts`, `libs/auth-service/src/index.ts`, `apps/api/test/auth-service.e2e-spec.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `AuthService.resolvePrincipal` (Task 15), `AUTH_GRPC_URL` env var (Task 7).
- Produces: a live gRPC server implementing `auth.AuthService/VerifyToken` on `127.0.0.1:50051` — Task 17 (Gateway guard) is the first real client of this.

- [ ] **Step 1: Write the gRPC controller**

`libs/auth-service/src/auth.controller.ts`:
```typescript
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AuthService } from './auth.service';
import { VerifyTokenRequest, VerifyTokenResponse } from '@app/proto/generated/auth';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @GrpcMethod('AuthService', 'VerifyToken')
  async verifyToken(request: VerifyTokenRequest): Promise<VerifyTokenResponse> {
    const principal = await this.authService.resolvePrincipal(request.token);
    if (!principal) {
      return { valid: false, principal: undefined, error: 'invalid_or_expired_token' };
    }
    return { valid: true, principal, error: '' };
  }
}
```

- [ ] **Step 2: Write the module**

`libs/auth-service/src/auth-service.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtVerifierService } from './jwt-verifier.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtVerifierService],
})
export class AuthServiceModule {}
```

`libs/auth-service/src/index.ts`:
```typescript
export * from './auth-service.module';
export * from './auth.service';
```

- [ ] **Step 3: Wire the gRPC microservice into `main.ts`**

`apps/api/src/main.ts`:
```typescript
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import { AppModule } from './app.module';
import { EnvConfig } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<EnvConfig, true>);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'auth',
      protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
      url: config.get('AUTH_GRPC_URL', { infer: true }),
    },
  });

  await app.startAllMicroservices();
  await app.listen(config.get('PORT', { infer: true }));
}
bootstrap();
```

Update `apps/api/src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { AuthServiceModule } from '@app/auth-service';

@Module({
  imports: [AppConfigModule, DatabaseModule, AuthServiceModule],
})
export class AppModule {}
```

- [ ] **Step 4: Write an e2e test that calls it over real gRPC**

`apps/api/test/auth-service.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Transport, MicroserviceOptions, ClientGrpc, ClientProxyFactory } from '@nestjs/microservices';
import { join } from 'path';
import { firstValueFrom } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { AuthServiceClient } from '@app/proto/generated/auth';

describe('Auth Service (gRPC e2e)', () => {
  let app: INestApplication;
  let client: AuthServiceClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
        url: '127.0.0.1:50061', // distinct test port
      },
    });
    await app.startAllMicroservices();
    await app.init();

    const grpcClient: ClientGrpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
        url: '127.0.0.1:50061',
      },
    }) as unknown as ClientGrpc;
    client = grpcClient.getService<AuthServiceClient>('AuthService');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns valid:false for a garbage token', async () => {
    const result = await firstValueFrom(client.verifyToken({ token: 'not-a-jwt' }));
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 5: Run and verify it passes**

```bash
npm run proto:gen
npx jest apps/api/test/auth-service.e2e-spec.ts
```
Expected: PASS. (This proves the microservice actually boots and answers over the wire, not just that the class methods work in isolation.)

- [ ] **Step 6: Commit**

```bash
git add libs/auth-service apps/api
git commit -m "feat: wire Auth Service as in-process gRPC microservice"
```

---

### Section 1.4 — Gateway AuthGuard

### Task 17: `AuthGuard` (Gateway HTTP → Auth Service gRPC)

**Files:**
- Create: `libs/gateway/src/guards/auth.guard.ts`, `libs/gateway/src/guards/auth.guard.spec.ts`, `libs/gateway/src/grpc-clients/auth-client.provider.ts`, `libs/gateway/src/index.ts`

**Interfaces:**
- Consumes: `auth.AuthService/VerifyToken` over gRPC (Task 16), `AUTH_GRPC_URL` env var.
- Produces: `AuthGuard` (attaches `request.principal: Principal` on success, throws `UnauthorizedException` otherwise) — Task 31 (`/chat/ask` controller) and every later guarded controller (44, 46, 55) apply this guard (or the `AdminGuard`/`DeviceAuthGuard` built on top of it in Tasks 43/54).

- [ ] **Step 1: Write the gRPC client provider**

`libs/gateway/src/grpc-clients/auth-client.provider.ts`:
```typescript
import { Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport, ClientGrpc } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { EnvConfig } from '@app/common';
import { AuthServiceClient } from '@app/proto/generated/auth';

export const AUTH_GRPC_CLIENT = 'AUTH_GRPC_CLIENT';

export const authClientProvider: Provider = {
  provide: AUTH_GRPC_CLIENT,
  useFactory: (config: ConfigService<EnvConfig, true>): AuthServiceClient => {
    const client: ClientGrpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(__dirname, '../../../../libs/proto/src/auth.proto'),
        url: config.get('AUTH_GRPC_URL', { infer: true }),
      },
    }) as unknown as ClientGrpc;
    return client.getService<AuthServiceClient>('AuthService');
  },
  inject: [ConfigService],
};
```

- [ ] **Step 2: Write the failing test**

`libs/gateway/src/guards/auth.guard.spec.ts`:
```typescript
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AuthGuard } from './auth.guard';
import { AUTH_GRPC_CLIENT } from '../grpc-clients/auth-client.provider';

function mockContext(headers: Record<string, string>): ExecutionContext {
  const request: any = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  it('throws when no Authorization header is present', async () => {
    const guard = new AuthGuard({ verifyToken: jest.fn() } as any);
    await expect(guard.canActivate(mockContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('throws when the Auth Service reports the token invalid', async () => {
    const verifyToken = jest.fn().mockReturnValue(of({ valid: false, error: 'bad' }));
    const guard = new AuthGuard({ verifyToken } as any);
    const ctx = mockContext({ authorization: 'Bearer bad-token' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the principal to the request and allows access on a valid token', async () => {
    const principal = { type: 'student', id: 'user-1', role: 'student' };
    const verifyToken = jest.fn().mockReturnValue(of({ valid: true, principal }));
    const guard = new AuthGuard({ verifyToken } as any);
    const ctx = mockContext({ authorization: 'Bearer good-token' });

    const allowed = await guard.canActivate(ctx);

    expect(allowed).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).principal).toEqual(principal);
  });

  it('propagates gRPC transport errors as UnauthorizedException, not a 500', async () => {
    const verifyToken = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const guard = new AuthGuard({ verifyToken } as any);
    const ctx = mockContext({ authorization: 'Bearer good-token' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx jest libs/gateway/src/guards/auth.guard.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`libs/gateway/src/guards/auth.guard.ts`:
```typescript
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AUTH_GRPC_CLIENT } from '../grpc-clients/auth-client.provider';
import { AuthServiceClient } from '@app/proto/generated/auth';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_GRPC_CLIENT) private readonly authClient: AuthServiceClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException('missing_bearer_token');
    }

    let response;
    try {
      response = await firstValueFrom(this.authClient.verifyToken({ token }));
    } catch {
      throw new UnauthorizedException('auth_service_unreachable');
    }

    if (!response.valid || !response.principal) {
      throw new UnauthorizedException(response.error || 'invalid_token');
    }

    request.principal = response.principal;
    return true;
  }
}
```

`libs/gateway/src/index.ts`:
```typescript
export * from './guards/auth.guard';
export * from './grpc-clients/auth-client.provider';
```

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/gateway/src/guards/auth.guard.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add libs/gateway
git commit -m "feat: add Gateway AuthGuard backed by Auth Service gRPC"
```

---

### Task 18: Global HTTP hardening (helmet, CORS skeleton, rate limiting, request-id logging)

**Files:**
- Create: `libs/gateway/src/interceptors/request-id.interceptor.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `libs/gateway/src/index.ts`

**Interfaces:**
- Produces: every response gets `X-Request-Id`; `@nestjs/throttler`'s default guard is registered globally (specific limits are tuned per-route starting Task 31); CORS is configured permissively for now with a single, obvious TODO marking the future web-client origin allowlist (SPEC-SHEET.md §1 — deferred until the website build starts, not implemented speculatively here).

- [ ] **Step 1: Install deps**

```bash
npm i helmet @nestjs/throttler
```

- [ ] **Step 2: Write the request-id interceptor**

`libs/gateway/src/interceptors/request-id.interceptor.ts`:
```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { tap } from 'rxjs/operators';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const requestId: string = request.headers['x-request-id'] ?? randomUUID();
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    return next.handle().pipe(tap());
  }
}
```

- [ ] **Step 3: Wire into `main.ts` and `app.module.ts`**

Add to `apps/api/src/main.ts` (before `app.listen`):
```typescript
import helmet from 'helmet';
import { RequestIdInterceptor } from '@app/gateway';
// ...inside bootstrap(), after app is created:
app.use(helmet());
app.enableCors({ origin: true, credentials: true }); // TODO: restrict to real web-client origin once §1's website client exists
app.useGlobalInterceptors(new RequestIdInterceptor());
```

Add `ThrottlerModule` to `apps/api/src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppConfigModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { AuthServiceModule } from '@app/auth-service';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuthServiceModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]), // 60 req/min/IP default; tuned per-route from Task 31 onward
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

Update `libs/gateway/src/index.ts` to also export the interceptor:
```typescript
export * from './guards/auth.guard';
export * from './grpc-clients/auth-client.provider';
export * from './interceptors/request-id.interceptor';
```

- [ ] **Step 4: Verify**

```bash
npm run build && node dist/apps/api/main.js &
sleep 2
curl -sI http://localhost:3000 | grep -i x-request-id
kill %1
```
Expected: an `X-Request-Id` header is present in the response.

- [ ] **Step 5: Commit**

```bash
git add libs/gateway apps/api package.json package-lock.json
git commit -m "feat: add helmet, CORS skeleton, global rate limiting, request-id logging"
```

---

### Section 1.5 — RAG Service

### Task 19: `rag.proto` + codegen

**Files:**
- Create: `libs/proto/src/rag.proto`

**Interfaces:**
- Produces: `RagServiceClient`, `SearchRequest`, `SearchResponse`, `Chunk` generated types — consumed by Task 20 (implementation), Task 22 (gRPC wiring), Task 24 (`chat.proto` imports `Chunk`), Task 29 (Gateway `AskService` orchestrator).

- [ ] **Step 1: Write the proto**

`libs/proto/src/rag.proto`:
```protobuf
syntax = "proto3";
package rag;

service RagService {
  rpc Search (SearchRequest) returns (SearchResponse);
}

message SearchRequest {
  string query = 1;
  string subject = 2;   // optional filter, empty string = no filter
  string syllabus = 3;
  string level = 4;
  string medium = 5;
  int32 top_k = 6;      // default 5 if 0
}

message Chunk {
  string chunk_id = 1;
  string paper_id = 2;
  string content = 3;
  string subject = 4;
  int32 year = 5;
  string question_number = 6;
  int32 page = 7;
  double relevance_score = 8;
}

message SearchResponse {
  repeated Chunk chunks = 1;
}
```

- [ ] **Step 2: Regenerate**

```bash
npm run proto:gen
ls libs/proto/src/generated
```
Expected: `rag.ts` present, exporting `RagServiceClient`, `SearchRequest`, `SearchResponse`, `Chunk`.

- [ ] **Step 3: Commit**

```bash
git add libs/proto
git commit -m "feat: define rag.proto (Search)"
```

---

### Task 20: Hybrid retrieval (pgvector cosine + Postgres full-text) + Reciprocal Rank Fusion

**Files:**
- Create: `libs/rag-service/src/hybrid-search.ts`, `libs/rag-service/src/hybrid-search.spec.ts`, `libs/rag-service/src/rrf.ts`, `libs/rag-service/src/rrf.spec.ts`

**Interfaces:**
- Consumes: `DatabaseService.query` (Task 11), `GEMINI_API_KEY` (for query embedding — see Step 4).
- Produces: `rrf<T>(rankedLists: T[][], idOf: (item: T) => string): T[]` (pure function, sorted by fused score desc) and `HybridSearchService.retrieveCandidates(query: string, filters: Filters): Promise<CandidateChunk[]>` (top ~20 fused candidates, pre-rerank) — Task 21 (Cohere rerank) takes this output directly.

- [ ] **Step 1: Write the failing RRF test**

`libs/rag-service/src/rrf.spec.ts`:
```typescript
import { rrf } from './rrf';

describe('rrf', () => {
  it('ranks an item that appears near the top of both lists above one that appears in only one list', () => {
    const vectorList = ['a', 'b', 'c'];
    const ftsList = ['b', 'd', 'a'];

    const fused = rrf([vectorList, ftsList], (id) => id);

    // 'b' is rank 2 in vector, rank 1 in fts -> highest combined score
    expect(fused[0]).toBe('b');
  });

  it('applies the standard k=60 RRF constant', () => {
    const fused = rrf<string>([['x']], (id) => id, 60);
    // score for 'x' = 1 / (60 + 1) = 1/61
    expect(fused).toEqual(['x']);
  });

  it('deduplicates items that appear in multiple lists into a single fused entry', () => {
    const fused = rrf([['a', 'b'], ['a', 'c']], (id) => id);
    expect(fused).toHaveLength(3);
    expect(new Set(fused)).toEqual(new Set(['a', 'b', 'c']));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/rag-service/src/rrf.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement RRF**

`libs/rag-service/src/rrf.ts`:
```typescript
export function rrf<T>(
  rankedLists: T[][],
  idOf: (item: T) => string,
  k = 60,
): T[] {
  const scoreById = new Map<string, number>();
  const itemById = new Map<string, T>();

  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const id = idOf(item);
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      scoreById.set(id, (scoreById.get(id) ?? 0) + contribution);
      if (!itemById.has(id)) itemById.set(id, item);
    });
  }

  return [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => itemById.get(id) as T);
}
```

- [ ] **Step 4: Run and verify RRF passes**

```bash
npx jest libs/rag-service/src/rrf.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing hybrid-search test**

`libs/rag-service/src/hybrid-search.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '@app/database';
import { HybridSearchService } from './hybrid-search';
import { GeminiEmbeddingService } from './gemini-embedding.service';

describe('HybridSearchService (integration, real dev DB)', () => {
  let db: DatabaseService;
  let embeddings: GeminiEmbeddingService;
  let service: HybridSearchService;
  const paperId = randomUUID();
  const chunkIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, GeminiEmbeddingService, HybridSearchService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    embeddings = moduleRef.get(GeminiEmbeddingService);
    service = moduleRef.get(HybridSearchService);

    await db.query(
      `insert into papers (id, subject, year, syllabus, level, medium, storage_path, status)
       values ($1, 'Economics', 2022, 'local', 'al', 'english', 'test/path.pdf', 'ready')`,
      [paperId],
    );

    const contents = [
      'The law of demand states that as price increases, quantity demanded decreases, ceteris paribus.',
      'Photosynthesis converts light energy into chemical energy stored in glucose.',
    ];
    for (const [i, content] of contents.entries()) {
      const embedding = await embeddings.embed(content, 'RETRIEVAL_DOCUMENT');
      const rows = await db.query<{ id: string }>(
        `insert into paper_chunks (paper_id, chunk_index, content, embedding)
         values ($1, $2, $3, $4::vector) returning id`,
        [paperId, i, content, `[${embedding.join(',')}]`],
      );
      chunkIds.push(rows[0].id);
    }
  });

  afterAll(async () => {
    await db.query('delete from papers where id = $1', [paperId]); // cascades to paper_chunks
  });

  it('returns the economics chunk as a top candidate for an economics-shaped query, not the biology chunk', async () => {
    const candidates = await service.retrieveCandidates('What happens to demand when price goes up?', {});
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].content).toContain('law of demand');
  });

  it('applies subject filtering', async () => {
    const candidates = await service.retrieveCandidates('law of demand', { subject: 'Economics' });
    expect(candidates.every((c) => c.subject === 'Economics')).toBe(true);

    const noneMatch = await service.retrieveCandidates('law of demand', { subject: 'Physics' });
    expect(noneMatch).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

```bash
npx jest libs/rag-service/src/hybrid-search.spec.ts
```
Expected: FAIL — `HybridSearchService`/`GeminiEmbeddingService` not found.

- [ ] **Step 7: Implement the Gemini embedding wrapper**

`libs/rag-service/src/gemini-embedding.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EnvConfig } from '@app/common';

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

@Injectable()
export class GeminiEmbeddingService {
  private readonly client: GoogleGenerativeAI;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenerativeAI(config.get('GEMINI_API_KEY', { infer: true }));
  }

  async embed(text: string, taskType: EmbeddingTaskType): Promise<number[]> {
    const model = this.client.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await model.embedContent({
      content: { role: 'user', parts: [{ text }] },
      taskType: taskType as any,
    });
    return result.embedding.values;
  }
}
```

```bash
npm i @google/generative-ai
```

- [ ] **Step 8: Implement hybrid search**

`libs/rag-service/src/hybrid-search.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from './gemini-embedding.service';
import { rrf } from './rrf';

export interface Filters {
  subject?: string;
  syllabus?: string;
  level?: string;
  medium?: string;
}

export interface CandidateChunk {
  chunkId: string;
  paperId: string;
  content: string;
  subject: string;
  year: number | null;
  questionNumber: string | null;
  page: number | null;
}

const CANDIDATES_PER_LIST = 30;

@Injectable()
export class HybridSearchService {
  constructor(
    private readonly db: DatabaseService,
    private readonly embeddings: GeminiEmbeddingService,
  ) {}

  async retrieveCandidates(query: string, filters: Filters): Promise<CandidateChunk[]> {
    const [vectorList, ftsList] = await Promise.all([
      this.vectorSearch(query, filters),
      this.fullTextSearch(query, filters),
    ]);

    return rrf([vectorList, ftsList], (c) => c.chunkId);
  }

  private filterClause(filters: Filters, startParam: number): { clause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = startParam;
    for (const [column, value] of [
      ['subject', filters.subject],
      ['syllabus', filters.syllabus],
      ['level', filters.level],
      ['medium', filters.medium],
    ] as const) {
      if (value) {
        conditions.push(`p.${column} = $${i}`);
        params.push(value);
        i += 1;
      }
    }
    return { clause: conditions.length ? `and ${conditions.join(' and ')}` : '', params };
  }

  private async vectorSearch(query: string, filters: Filters): Promise<CandidateChunk[]> {
    const embedding = await this.embeddings.embed(query, 'RETRIEVAL_QUERY');
    const { clause, params } = this.filterClause(filters, 2); // $1 = embedding, filters start at $2
    const rows = await this.db.query<CandidateChunkRow>(
      `select pc.id as chunk_id, pc.paper_id, pc.content, p.subject, p.year,
              pc.metadata->>'question_number' as question_number,
              (pc.metadata->>'page')::int as page
       from paper_chunks pc
       join papers p on p.id = pc.paper_id
       where p.status = 'ready' ${clause}
       order by pc.embedding <=> $1::vector
       limit ${CANDIDATES_PER_LIST}`,
      [`[${embedding.join(',')}]`, ...params],
    );
    return rows.map(toCandidateChunk);
  }

  private async fullTextSearch(query: string, filters: Filters): Promise<CandidateChunk[]> {
    const { clause, params } = this.filterClause(filters, 2);
    const rows = await this.db.query<CandidateChunkRow>(
      `select pc.id as chunk_id, pc.paper_id, pc.content, p.subject, p.year,
              pc.metadata->>'question_number' as question_number,
              (pc.metadata->>'page')::int as page
       from paper_chunks pc
       join papers p on p.id = pc.paper_id
       where p.status = 'ready' and pc.content_tsv @@ plainto_tsquery('english', $1) ${clause}
       order by ts_rank(pc.content_tsv, plainto_tsquery('english', $1)) desc
       limit ${CANDIDATES_PER_LIST}`,
      [query, ...params],
    );
    return rows.map(toCandidateChunk);
  }
}

interface CandidateChunkRow {
  chunk_id: string;
  paper_id: string;
  content: string;
  subject: string;
  year: number | null;
  question_number: string | null;
  page: number | null;
}

function toCandidateChunk(row: CandidateChunkRow): CandidateChunk {
  return {
    chunkId: row.chunk_id,
    paperId: row.paper_id,
    content: row.content,
    subject: row.subject,
    year: row.year,
    questionNumber: row.question_number,
    page: row.page,
  };
}
```

Both queries call `filterClause(filters, 2)`: in `vectorSearch`, `$1` is the embedding and filters start at `$2`; in `fullTextSearch`, `$1` is the query text (used twice — once in the `where` clause, once in `order by ts_rank`) and filters also start at `$2`. The params array passed to `db.query` must list values in that exact order for both methods.

- [ ] **Step 9: Run and verify it passes**

```bash
npm i -D dotenv-cli
npx dotenv -e .env -- npx jest libs/rag-service/src/hybrid-search.spec.ts --runInBand
```
Expected: PASS, 2 tests, run against your real Supabase dev project.

- [ ] **Step 10: Commit**

```bash
git add libs/rag-service package.json package-lock.json
git commit -m "feat: hybrid retrieval (pgvector + full-text) with Reciprocal Rank Fusion"
```

---

### Task 21: Cohere rerank integration

**Files:**
- Create: `libs/rag-service/src/rerank.service.ts`, `libs/rag-service/src/rerank.service.spec.ts`

**Interfaces:**
- Consumes: `CandidateChunk[]` (Task 20's output shape), `COHERE_API_KEY` env var.
- Produces: `RerankService.rerank(query: string, candidates: CandidateChunk[], topK: number): Promise<RankedChunk[]>` where `RankedChunk = CandidateChunk & {relevanceScore: number}` — Task 22's gRPC controller calls this directly after `HybridSearchService.retrieveCandidates`.

- [ ] **Step 1: Install the SDK**

```bash
npm i cohere-ai
```

- [ ] **Step 2: Write the failing test**

`libs/rag-service/src/rerank.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RerankService } from './rerank.service';
import { CandidateChunk } from './hybrid-search';

const mockRerank = jest.fn();
jest.mock('cohere-ai', () => ({
  CohereClient: jest.fn().mockImplementation(() => ({ rerank: mockRerank })),
}));

describe('RerankService', () => {
  let service: RerankService;

  const candidates: CandidateChunk[] = [
    { chunkId: 'a', paperId: 'p1', content: 'irrelevant text about photosynthesis', subject: 'Biology', year: 2021, questionNumber: null, page: null },
    { chunkId: 'b', paperId: 'p1', content: 'the law of demand and price elasticity', subject: 'Economics', year: 2022, questionNumber: null, page: null },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [RerankService],
    }).compile();
    service = moduleRef.get(RerankService);
  });

  it('reorders candidates by Cohere relevance score, highest first', async () => {
    mockRerank.mockResolvedValue({
      results: [
        { index: 1, relevanceScore: 0.91 }, // candidate 'b'
        { index: 0, relevanceScore: 0.12 }, // candidate 'a'
      ],
    });

    const ranked = await service.rerank('what happens to demand when price rises?', candidates, 5);

    expect(ranked[0].chunkId).toBe('b');
    expect(ranked[0].relevanceScore).toBeCloseTo(0.91);
    expect(ranked[1].chunkId).toBe('a');
  });

  it('truncates to topK', async () => {
    mockRerank.mockResolvedValue({
      results: [
        { index: 0, relevanceScore: 0.5 },
        { index: 1, relevanceScore: 0.9 },
      ],
    });
    const ranked = await service.rerank('query', candidates, 1);
    expect(ranked).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx jest libs/rag-service/src/rerank.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`libs/rag-service/src/rerank.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CohereClient } from 'cohere-ai';
import { EnvConfig } from '@app/common';
import { CandidateChunk } from './hybrid-search';

export type RankedChunk = CandidateChunk & { relevanceScore: number };

@Injectable()
export class RerankService {
  private readonly client: CohereClient;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new CohereClient({ token: config.get('COHERE_API_KEY', { infer: true }) });
  }

  async rerank(query: string, candidates: CandidateChunk[], topK: number): Promise<RankedChunk[]> {
    if (candidates.length === 0) return [];

    const response = await this.client.rerank({
      model: 'rerank-v3.5',
      query,
      documents: candidates.map((c) => c.content),
      topN: Math.min(topK, candidates.length),
    });

    return response.results.map((result) => ({
      ...candidates[result.index],
      relevanceScore: result.relevanceScore,
    }));
  }
}
```

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/rag-service/src/rerank.service.spec.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add libs/rag-service package.json package-lock.json
git commit -m "feat: add Cohere rerank-v3.5 integration"
```

---

### Task 22: Wire RAG Service as an in-process gRPC microservice

**Files:**
- Create: `libs/rag-service/src/rag.controller.ts`, `libs/rag-service/src/rag-service.module.ts`, `libs/rag-service/src/index.ts`, `apps/api/test/rag-service.e2e-spec.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `HybridSearchService.retrieveCandidates` (Task 20), `RerankService.rerank` (Task 21), `RAG_GRPC_URL` env var.
- Produces: a live gRPC server implementing `rag.RagService/Search` on `127.0.0.1:50052`, with a configurable **minimum relevance threshold** (default `0.3`) below which chunks are dropped before being returned — this threshold is what makes SPEC-SHEET.md §6's grounding rule enforceable downstream in Task 27.

- [ ] **Step 1: Write the controller**

`libs/rag-service/src/rag.controller.ts`:
```typescript
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { HybridSearchService } from './hybrid-search';
import { RerankService } from './rerank.service';
import { SearchRequest, SearchResponse } from '@app/proto/generated/rag';

const DEFAULT_TOP_K = 5;
const MIN_RELEVANCE_THRESHOLD = 0.3;

@Controller()
export class RagController {
  constructor(
    private readonly hybridSearch: HybridSearchService,
    private readonly rerank: RerankService,
  ) {}

  @GrpcMethod('RagService', 'Search')
  async search(request: SearchRequest): Promise<SearchResponse> {
    const candidates = await this.hybridSearch.retrieveCandidates(request.query, {
      subject: request.subject || undefined,
      syllabus: request.syllabus || undefined,
      level: request.level || undefined,
      medium: request.medium || undefined,
    });

    const ranked = await this.rerank.rerank(
      request.query,
      candidates.slice(0, 20),
      request.topK || DEFAULT_TOP_K,
    );

    const aboveThreshold = ranked.filter((c) => c.relevanceScore >= MIN_RELEVANCE_THRESHOLD);

    return {
      chunks: aboveThreshold.map((c) => ({
        chunkId: c.chunkId,
        paperId: c.paperId,
        content: c.content,
        subject: c.subject,
        year: c.year ?? 0,
        questionNumber: c.questionNumber ?? '',
        page: c.page ?? 0,
        relevanceScore: c.relevanceScore,
      })),
    };
  }
}
```

- [ ] **Step 2: Write the module**

`libs/rag-service/src/rag-service.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { HybridSearchService } from './hybrid-search';
import { RerankService } from './rerank.service';
import { GeminiEmbeddingService } from './gemini-embedding.service';

@Module({
  controllers: [RagController],
  providers: [HybridSearchService, RerankService, GeminiEmbeddingService],
})
export class RagServiceModule {}
```

`libs/rag-service/src/index.ts`:
```typescript
export * from './rag-service.module';
```

- [ ] **Step 3: Wire into `main.ts` and `app.module.ts`**

Add another `app.connectMicroservice` block to `apps/api/src/main.ts`, mirroring Task 16's, with `package: 'rag'`, `protoPath` pointing at `rag.proto`, and `url: config.get('RAG_GRPC_URL', { infer: true })`.

Add `RagServiceModule` to `apps/api/src/app.module.ts`'s imports.

- [ ] **Step 4: Write an e2e test**

`apps/api/test/rag-service.e2e-spec.ts` — mirror Task 16's `auth-service.e2e-spec.ts` structure exactly (bind to a distinct test port, e.g. `127.0.0.1:50062`), asserting: searching for a query with zero matching chunks in the DB returns `{ chunks: [] }` (proves the empty/no-match path doesn't throw).

- [ ] **Step 5: Run and verify it passes**

```bash
npm run proto:gen
npx jest apps/api/test/rag-service.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add libs/rag-service apps/api
git commit -m "feat: wire RAG Service as in-process gRPC microservice"
```

---

### Task 23: Dev seed script for RAG testing

**Files:**
- Create: `scripts/seed-papers.ts`
- Modify: `package.json` (add `seed:papers` script)

**Interfaces:**
- Consumes: `GeminiEmbeddingService.embed` (Task 20), `DatabaseService.query` (Task 11).
- Produces: ~8 hand-written past-paper chunks across 2-3 subjects/years in `paper_chunks`, giving Task 31's end-to-end verification and Task 34's mobile-app manual test something real to retrieve and cite. This is explicitly a **stand-in for the real Ingestion Service pipeline**, which doesn't exist until Phase 3 (Tasks 51-65) — delete or ignore this script once that pipeline is live and real papers have been uploaded.

- [ ] **Step 1: Write the script**

`scripts/seed-papers.ts`:
```typescript
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';
import { DatabaseModule, DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';

const SEED_PAPERS: Array<{
  subject: string;
  year: number;
  syllabus: string;
  level: string;
  medium: string;
  chunks: string[];
}> = [
  {
    subject: 'Economics',
    year: 2022,
    syllabus: 'local',
    level: 'al',
    medium: 'english',
    chunks: [
      'Question 3(a): State the law of demand. The law of demand states that, ceteris paribus, as the price of a good rises, the quantity demanded falls, and vice versa.',
      'Question 3(b): Explain price elasticity of demand. Price elasticity of demand measures the responsiveness of quantity demanded to a change in price, calculated as %ΔQd / %ΔP.',
    ],
  },
  {
    subject: 'Physics',
    year: 2021,
    syllabus: 'local',
    level: 'al',
    medium: 'english',
    chunks: [
      "Question 5: State Newton's Second Law of Motion. The rate of change of momentum of a body is directly proportional to the applied force and occurs in the direction of the force: F = ma.",
      'Question 6: Define kinetic energy and derive its formula. Kinetic energy is the energy possessed by a body due to its motion, given by KE = 1/2 mv^2.',
    ],
  },
  {
    subject: 'Combined Mathematics',
    year: 2023,
    syllabus: 'local',
    level: 'al',
    medium: 'english',
    chunks: [
      'Question 1: Solve the quadratic equation x^2 - 5x + 6 = 0. Factorising gives (x-2)(x-3)=0, so x=2 or x=3.',
      'Question 2: Differentiate y = x^3 + 2x with respect to x. dy/dx = 3x^2 + 2.',
    ],
  },
];

@Module({ imports: [AppConfigModule, DatabaseModule] })
class SeedModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule);
  const db = app.get(DatabaseService);
  const embeddings = new GeminiEmbeddingService(app.get('ConfigService'));

  for (const paper of SEED_PAPERS) {
    const [{ id: paperId }] = await db.query<{ id: string }>(
      `insert into papers (subject, year, syllabus, level, medium, storage_path, status)
       values ($1, $2, $3, $4, $5, $6, 'ready') returning id`,
      [paper.subject, paper.year, paper.syllabus, paper.level, paper.medium, `seed/${paper.subject}-${paper.year}.pdf`],
    );

    for (const [index, content] of paper.chunks.entries()) {
      const embedding = await embeddings.embed(content, 'RETRIEVAL_DOCUMENT');
      await db.query(
        `insert into paper_chunks (paper_id, chunk_index, content, embedding)
         values ($1, $2, $3, $4::vector)`,
        [paperId, index, content, `[${embedding.join(',')}]`],
      );
    }
    console.log(`Seeded ${paper.subject} ${paper.year}: ${paper.chunks.length} chunks`);
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add to `package.json` `"scripts"`:
```json
"seed:papers": "ts-node -r tsconfig-paths/register scripts/seed-papers.ts"
```
```bash
npm i -D ts-node tsconfig-paths dotenv
```

- [ ] **Step 2: Run it**

```bash
npm run seed:papers
```
Expected: 3 "Seeded ..." lines, no errors.

- [ ] **Step 3: Verify against the RAG Service**

```bash
node dist/apps/api/main.js &
sleep 2
npx ts-node -e "
  import('@nestjs/microservices').then(async ({ClientProxyFactory, Transport}) => {
    const client = ClientProxyFactory.create({transport: Transport.GRPC, options: {package: 'rag', protoPath: 'libs/proto/src/rag.proto', url: '127.0.0.1:50052'}});
    const svc = client.getService('RagService');
    svc.search({query: 'what happens to demand when price rises', subject: '', syllabus: '', level: '', medium: '', topK: 5}).subscribe(console.log);
  });
"
kill %1
```
Expected: response includes the Economics 2022 demand-law chunk with a `relevanceScore` above the `0.3` threshold, and does not include the Physics/Maths chunks.

- [ ] **Step 4: Commit**

```bash
git add scripts package.json package-lock.json
git commit -m "chore: add dev seed script for RAG Service testing (stand-in for Phase 3 ingestion)"
```

---

### Task 23.1: Validate Sinhala retrieval quality (labeled query set)

SPEC-SHEET.md §7 flags Sinhala retrieval quality as an explicit unknown ("a lower-resource language for most embedding models, including Google's") and requires validating it in Phase 1 with a small labeled set before deciding whether the query-translation-bridge fallback is needed. This task is that validation. (Numbered `23.1` rather than renumbering every subsequent task — see this plan's task list as the source of truth for ordering, not strict integer sequence.)

**Files:**
- Create: `scripts/validate-sinhala-retrieval.ts`

**Interfaces:**
- Consumes: `HybridSearchService.retrieveCandidates` (Task 20), `RerankService.rerank` (Task 21), Task 23's seeded English chunks plus a handful of new Sinhala-medium seed chunks added by this task.
- Produces: a labeled-eval script and a recorded pass/fail judgment call for the Phase 1 codebase — if it fails, the fallback described below is what Task 25's `buildPrompt`/Task 20's `retrieveCandidates` would need a `translateQuery` config flag added to, but that implementation is **only built if this task's validation shows it's needed** (matching the spec's "cheap to add if needed," not built speculatively here).

- [ ] **Step 1: Add 4-5 Sinhala-medium seed chunks**

Extend `SEED_PAPERS` in `scripts/seed-papers.ts` (Task 23) with one Sinhala-medium entry, e.g.:
```typescript
{
  subject: 'Economics',
  year: 2022,
  syllabus: 'local',
  level: 'al',
  medium: 'sinhala',
  chunks: [
    'ප්‍රශ්නය 1: ඉල්ලුමේ නියමය පවසන්න. මිල ඉහළ යන විට, අනෙකුත් සාධක නියතව පවතින විට, ඉල්ලුම් කරන ප්‍රමාණය අඩු වේ.',
    'ප්‍රශ්නය 2: මිල ඉල්ලුම් ප්‍රත්‍යාස්ථතාව යනු කුමක්ද? මිල වෙනසකට ප්‍රතිචාර වශයෙන් ඉල්ලුම් කරන ප්‍රමාණයේ වෙනස මැනීමකි.',
  ],
},
```
Re-run `npm run seed:papers` to insert these.

- [ ] **Step 2: Write the eval script**

`scripts/validate-sinhala-retrieval.ts`:
```typescript
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { HybridSearchService } from '@app/rag-service/hybrid-search';
import { RerankService } from '@app/rag-service/rerank.service';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';

const LABELED_QUERIES: { query: string; expectedSubstring: string }[] = [
  { query: 'මිල ඉහළ ගියොත් ඉල්ලුමට වෙන දේ මොකක්ද?', expectedSubstring: 'ඉල්ලුමේ නියමය' }, // "what happens to demand if price rises?"
  { query: 'ප්‍රත්‍යාස්ථතාව යනු කුමක්ද?', expectedSubstring: 'ප්‍රත්‍යාස්ථතාව' }, // "what is elasticity?"
];

@Module({ imports: [AppConfigModule, DatabaseModule] })
class EvalModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(EvalModule);
  const embeddings = new GeminiEmbeddingService(app.get('ConfigService'));
  const hybridSearch = new HybridSearchService(app.get('DatabaseService'), embeddings);
  const rerank = new RerankService(app.get('ConfigService'));

  let hits = 0;
  for (const { query, expectedSubstring } of LABELED_QUERIES) {
    const candidates = await hybridSearch.retrieveCandidates(query, { medium: 'sinhala' });
    const ranked = await rerank.rerank(query, candidates.slice(0, 20), 3);
    const found = ranked.some((c) => c.content.includes(expectedSubstring));
    console.log(`${found ? 'HIT ' : 'MISS'} — "${query}" (top result: ${ranked[0]?.content.slice(0, 60) ?? 'none'})`);
    if (found) hits += 1;
  }

  const hitRate = hits / LABELED_QUERIES.length;
  console.log(`\nSinhala retrieval hit rate: ${(hitRate * 100).toFixed(0)}% (${hits}/${LABELED_QUERIES.length})`);
  console.log(
    hitRate >= 0.7
      ? 'PASS: native multilingual retrieval looks adequate — no query-translation-bridge needed for now.'
      : 'FAIL: consider implementing the query-translation-bridge fallback described in SPEC-SHEET.md §7 before relying on Sinhala text-chat retrieval quality.',
  );

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```
Add to `package.json` `"scripts"`: `"validate:sinhala": "ts-node -r tsconfig-paths/register scripts/validate-sinhala-retrieval.ts"`.

- [ ] **Step 3: Run it and record the result**

```bash
npm run validate:sinhala
```
Expand `LABELED_QUERIES` with a few more real query/expected-chunk pairs before treating the result as conclusive — 2 is the bare minimum to prove the script works, not a statistically meaningful sample. Whatever the outcome (PASS or FAIL), this is a judgment call for you to record in your own notes; this plan does not build the query-translation-bridge fallback itself, since per SPEC-SHEET.md §7 it should only be added if this validation shows it's needed.

- [ ] **Step 4: Commit**

```bash
git add scripts package.json package-lock.json
git commit -m "test: add Sinhala retrieval quality validation (SPEC-SHEET.md §7)"
```

---

### Section 1.6 — Chat/LLM Service

This is the service that enforces SPEC-SHEET.md §6's citation/grounding contract. The design: Gemini is given numbered excerpts and asked to return **structured JSON** (`answer`, `is_curriculum_question`, `cited_indices`) rather than free-text citations — the backend, not Gemini, maps `cited_indices` back to the real chunk metadata (subject/year) it already retrieved. This avoids trusting the model to reproduce a citation verbatim and makes the "no sources on a curriculum question → retry with a stricter prompt" rule (§6) mechanically checkable: `is_curriculum_question === true && cited_indices.length === 0`.

### Task 24: `chat.proto` (imports `rag.proto`) + codegen

**Files:**
- Create: `libs/proto/src/chat.proto`

**Interfaces:**
- Consumes: `rag.Chunk` (Task 19).
- Produces: `ChatLlmServiceClient`, `AskRequest`, `AskResponse`, `HistoryTurn`, `SourceCitation` — consumed by Task 25-28 (implementation) and Task 29 (Gateway `AskService` orchestrator).

- [ ] **Step 1: Write the proto**

`libs/proto/src/chat.proto`:
```protobuf
syntax = "proto3";
package chat;

import "rag.proto";

service ChatLlmService {
  rpc Ask (AskRequest) returns (AskResponse);
}

message HistoryTurn {
  string role = 1;    // "user" | "assistant"
  string content = 2;
}

message AskRequest {
  string question_text = 1;
  string medium = 2;       // "english" | "sinhala" | "tamil"
  repeated HistoryTurn history = 3;   // last 6 turns, oldest first
  repeated rag.Chunk retrieved_chunks = 4;
}

message SourceCitation {
  string subject = 1;
  string year = 2;
}

message AskResponse {
  string answer = 1;
  repeated SourceCitation sources = 2;
  bool grounded = 3;
}
```

- [ ] **Step 2: Regenerate**

```bash
npm run proto:gen
ls libs/proto/src/generated
```
Expected: `chat.ts` present, importing `Chunk` from the generated `rag.ts`.

- [ ] **Step 3: Commit**

```bash
git add libs/proto
git commit -m "feat: define chat.proto (Ask), importing rag.Chunk"
```

---

### Task 25: Grounded prompt builder

**Files:**
- Create: `libs/chat-service/src/prompt-builder.ts`, `libs/chat-service/src/prompt-builder.spec.ts`

**Interfaces:**
- Produces: `buildPrompt(input: PromptInput): string` where `PromptInput = {questionText: string; medium: string; history: {role: string; content: string}[]; chunks: {index: number; content: string; subject: string; year: number}[]; strict?: boolean}` — Task 26 (Gemini call wrapper) passes this directly as the model's input; Task 27's retry logic sets `strict: true` on the second attempt.

- [ ] **Step 1: Write the failing test**

`libs/chat-service/src/prompt-builder.spec.ts`:
```typescript
import { buildPrompt } from './prompt-builder';

describe('buildPrompt', () => {
  const baseInput = {
    questionText: 'What is the law of demand?',
    medium: 'english',
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hey!' }],
    chunks: [{ index: 1, content: 'The law of demand states...', subject: 'Economics', year: 2022 }],
  };

  it('numbers excerpts starting at 1 and includes their content', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('[1] The law of demand states...');
  });

  it('instructs the model to answer in the requested medium', () => {
    const prompt = buildPrompt({ ...baseInput, medium: 'sinhala' });
    expect(prompt).toMatch(/sinhala/i);
  });

  it('includes the hard grounding rule: decline rather than answer from general knowledge when ungrounded', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toMatch(/do not (use|answer from) (outside|general) knowledge/i);
  });

  it('requests structured JSON output with answer, is_curriculum_question, cited_indices', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('is_curriculum_question');
    expect(prompt).toContain('cited_indices');
  });

  it('includes chat history in order', () => {
    const prompt = buildPrompt(baseInput);
    const hiIndex = prompt.indexOf('hi');
    const heyIndex = prompt.indexOf('Hey!');
    expect(hiIndex).toBeGreaterThan(-1);
    expect(heyIndex).toBeGreaterThan(hiIndex);
  });

  it('adds a stricter cite-or-decline instruction when strict=true', () => {
    const normal = buildPrompt(baseInput);
    const strict = buildPrompt({ ...baseInput, strict: true });
    expect(strict.length).toBeGreaterThan(normal.length);
    expect(strict).toMatch(/must (cite|decline)/i);
  });

  it('handles zero retrieved chunks by instructing a decline for curriculum questions', () => {
    const prompt = buildPrompt({ ...baseInput, chunks: [] });
    expect(prompt).toMatch(/no excerpts/i);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/chat-service/src/prompt-builder.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/chat-service/src/prompt-builder.ts`:
```typescript
export interface PromptChunk {
  index: number;
  content: string;
  subject: string;
  year: number;
}

export interface PromptInput {
  questionText: string;
  medium: string;
  history: { role: string; content: string }[];
  chunks: PromptChunk[];
  strict?: boolean;
}

export function buildPrompt(input: PromptInput): string {
  const excerptsBlock = input.chunks.length
    ? input.chunks.map((c) => `[${c.index}] (${c.subject}, ${c.year}) ${c.content}`).join('\n\n')
    : '(no excerpts were retrieved for this question)';

  const historyBlock = input.history.length
    ? input.history.map((h) => `${h.role}: ${h.content}`).join('\n')
    : '(no prior turns)';

  const strictClause = input.strict
    ? `\nSTRICT MODE: Your previous attempt at this question produced no citations for what was judged a curriculum-content question. You must now either (a) cite at least one of the excerpts above by index in cited_indices, or (b) set is_curriculum_question=true and answer with the localized "I don't have that in the past papers I have yet" decline message, with an empty cited_indices array. Do not answer from general knowledge.`
    : '';

  return `You are NESH, an AI study assistant for Sri Lankan O/L and A/L students.

RULES:
1. Answer ONLY using the numbered EXCERPTS below when the question is about curriculum content (a subject, topic, or exam-style question). Do not use outside/general knowledge to answer curriculum-content questions.
2. If none of the EXCERPTS are relevant to the question, and the question is curriculum content, respond with the localized equivalent of "I don't have that in the past papers I have yet" and set cited_indices to an empty array.
3. If you use an excerpt, you must list its number in cited_indices.
4. For small talk or meta questions (greetings, "what can you help with", etc.), answer normally, set is_curriculum_question=false, and leave cited_indices empty — no citation is required for these.
5. Always answer in this language regardless of the excerpts' language: ${input.medium}.
6. Respond with ONLY a JSON object of the shape: {"answer": string, "is_curriculum_question": boolean, "cited_indices": number[]}.
${strictClause}

EXCERPTS:
${excerptsBlock}

CHAT HISTORY:
${historyBlock}

QUESTION:
${input.questionText}`;
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/chat-service/src/prompt-builder.spec.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add libs/chat-service
git commit -m "feat: add grounded prompt builder with structured-output + strict retry mode"
```

---

### Task 26: Gemini call wrapper with structured JSON parsing

**Files:**
- Create: `libs/chat-service/src/gemini-chat.service.ts`, `libs/chat-service/src/gemini-chat.service.spec.ts`

**Interfaces:**
- Consumes: `buildPrompt` (Task 25), `GEMINI_API_KEY` env var.
- Produces: `GeminiChatService.generate(prompt: string): Promise<{answer: string; isCurriculumQuestion: boolean; citedIndices: number[]}>` — Task 27 calls this once, then again with `strict: true` if the grounding check fails.

- [ ] **Step 1: Write the failing test**

`libs/chat-service/src/gemini-chat.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { GeminiChatService } from './gemini-chat.service';

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
}));

describe('GeminiChatService', () => {
  let service: GeminiChatService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [GeminiChatService],
    }).compile();
    service = moduleRef.get(GeminiChatService);
  });

  it('parses a well-formed structured JSON response', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"answer":"The law of demand says...","is_curriculum_question":true,"cited_indices":[1]}' },
    });
    const result = await service.generate('some prompt');
    expect(result).toEqual({
      answer: 'The law of demand says...',
      isCurriculumQuestion: true,
      citedIndices: [1],
    });
  });

  it('strips markdown code fences if Gemini wraps the JSON in ```json ... ```', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '```json\n{"answer":"hi","is_curriculum_question":false,"cited_indices":[]}\n```' },
    });
    const result = await service.generate('some prompt');
    expect(result.answer).toBe('hi');
  });

  it('throws a clear error if the response is not valid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'not json at all' } });
    await expect(service.generate('some prompt')).rejects.toThrow(/failed to parse/i);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/chat-service/src/gemini-chat.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/chat-service/src/gemini-chat.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EnvConfig } from '@app/common';

export interface GeminiStructuredResult {
  answer: string;
  isCurriculumQuestion: boolean;
  citedIndices: number[];
}

@Injectable()
export class GeminiChatService {
  private readonly client: GoogleGenerativeAI;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenerativeAI(config.get('GEMINI_API_KEY', { infer: true }));
  }

  async generate(prompt: string): Promise<GeminiStructuredResult> {
    const model = this.client.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const jsonText = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`Failed to parse Gemini structured output as JSON: ${raw.slice(0, 200)}`);
    }

    return {
      answer: String(parsed.answer ?? ''),
      isCurriculumQuestion: Boolean(parsed.is_curriculum_question),
      citedIndices: Array.isArray(parsed.cited_indices) ? parsed.cited_indices.map(Number) : [],
    };
  }
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/chat-service/src/gemini-chat.service.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add libs/chat-service
git commit -m "feat: add Gemini structured-output wrapper"
```

---

### Task 27: Citation resolver + grounding retry (§6 hard rule)

**Files:**
- Create: `libs/chat-service/src/ask.service.ts`, `libs/chat-service/src/ask.service.spec.ts`

**Interfaces:**
- Consumes: `buildPrompt` (Task 25), `GeminiChatService.generate` (Task 26).
- Produces: `ChatLlmAskService.ask(input: {questionText, medium, history, chunks}): Promise<{answer: string; sources: {subject: string; year: string}[]; grounded: boolean}>` — this is the function Task 28's gRPC controller calls, and it's where §6's "retry once with a stricter prompt" rule actually lives.

- [ ] **Step 1: Write the failing test**

`libs/chat-service/src/ask.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ChatLlmAskService } from './ask.service';
import { GeminiChatService } from './gemini-chat.service';

describe('ChatLlmAskService', () => {
  let service: ChatLlmAskService;
  const generate = jest.fn();

  const chunks = [
    { index: 1, content: 'law of demand text', subject: 'Economics', year: 2022 },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ChatLlmAskService, { provide: GeminiChatService, useValue: { generate } }],
    }).compile();
    service = moduleRef.get(ChatLlmAskService);
  });

  beforeEach(() => jest.clearAllMocks());

  it('resolves cited_indices back to real chunk subject/year, not whatever Gemini said', async () => {
    generate.mockResolvedValue({
      answer: 'Demand falls as price rises.',
      isCurriculumQuestion: true,
      citedIndices: [1],
    });

    const result = await service.ask({ questionText: 'q', medium: 'english', history: [], chunks });

    expect(result.sources).toEqual([{ subject: 'Economics', year: '2022' }]);
    expect(result.grounded).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not require sources for small-talk questions', async () => {
    generate.mockResolvedValue({ answer: 'I can help with your studies!', isCurriculumQuestion: false, citedIndices: [] });

    const result = await service.ask({ questionText: 'what can you help with', medium: 'english', history: [], chunks: [] });

    expect(result.sources).toEqual([]);
    expect(result.grounded).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries once with a stricter prompt when a curriculum question gets zero citations', async () => {
    generate
      .mockResolvedValueOnce({ answer: 'Some hallucinated answer', isCurriculumQuestion: true, citedIndices: [] })
      .mockResolvedValueOnce({ answer: "I don't have that in the past papers I have yet.", isCurriculumQuestion: true, citedIndices: [] });

    const result = await service.ask({ questionText: 'q', medium: 'english', history: [], chunks });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.answer).toMatch(/don't have that/i);
    expect(result.sources).toEqual([]);
    expect(result.grounded).toBe(false);
  });

  it('marks grounded=true if the retry succeeds in producing a citation', async () => {
    generate
      .mockResolvedValueOnce({ answer: 'hallucinated', isCurriculumQuestion: true, citedIndices: [] })
      .mockResolvedValueOnce({ answer: 'grounded answer', isCurriculumQuestion: true, citedIndices: [1] });

    const result = await service.ask({ questionText: 'q', medium: 'english', history: [], chunks });

    expect(result.grounded).toBe(true);
    expect(result.sources).toEqual([{ subject: 'Economics', year: '2022' }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/chat-service/src/ask.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/chat-service/src/ask.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { buildPrompt, PromptChunk } from './prompt-builder';
import { GeminiChatService } from './gemini-chat.service';

export interface AskInput {
  questionText: string;
  medium: string;
  history: { role: string; content: string }[];
  chunks: PromptChunk[];
}

export interface SourceCitation {
  subject: string;
  year: string;
}

export interface AskResult {
  answer: string;
  sources: SourceCitation[];
  grounded: boolean;
}

@Injectable()
export class ChatLlmAskService {
  constructor(private readonly gemini: GeminiChatService) {}

  async ask(input: AskInput): Promise<AskResult> {
    const first = await this.attempt(input, false);
    if (this.isGrounded(first)) {
      return this.toResult(first, input.chunks);
    }

    const retry = await this.attempt(input, true);
    return this.toResult(retry, input.chunks);
  }

  private async attempt(input: AskInput, strict: boolean) {
    const prompt = buildPrompt({ ...input, strict });
    return this.gemini.generate(prompt);
  }

  private isGrounded(result: { isCurriculumQuestion: boolean; citedIndices: number[] }): boolean {
    // Small talk never needs grounding. Curriculum questions need at least one citation.
    return !result.isCurriculumQuestion || result.citedIndices.length > 0;
  }

  private toResult(
    result: { answer: string; isCurriculumQuestion: boolean; citedIndices: number[] },
    chunks: PromptChunk[],
  ): AskResult {
    const sources = result.citedIndices
      .map((i) => chunks.find((c) => c.index === i))
      .filter((c): c is PromptChunk => Boolean(c))
      .map((c) => ({ subject: c.subject, year: String(c.year) }));

    return {
      answer: result.answer,
      sources,
      grounded: this.isGrounded(result),
    };
  }
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/chat-service/src/ask.service.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add libs/chat-service
git commit -m "feat: add citation resolver with cite-or-decline retry (SPEC-SHEET.md §6)"
```

---

### Task 28: Wire Chat/LLM Service as an in-process gRPC microservice

**Files:**
- Create: `libs/chat-service/src/chat.controller.ts`, `libs/chat-service/src/chat-service.module.ts`, `libs/chat-service/src/index.ts`, `apps/api/test/chat-service.e2e-spec.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `ChatLlmAskService.ask` (Task 27), `CHAT_GRPC_URL` env var.
- Produces: a live gRPC server implementing `chat.ChatLlmService/Ask` on `127.0.0.1:50053` — Task 29's Gateway `AskService` orchestrator is its first caller.

- [ ] **Step 1: Write the controller**

`libs/chat-service/src/chat.controller.ts`:
```typescript
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ChatLlmAskService } from './ask.service';
import { AskRequest, AskResponse } from '@app/proto/generated/chat';

@Controller()
export class ChatController {
  constructor(private readonly askService: ChatLlmAskService) {}

  @GrpcMethod('ChatLlmService', 'Ask')
  async ask(request: AskRequest): Promise<AskResponse> {
    const chunks = request.retrievedChunks.map((c, i) => ({
      index: i + 1,
      content: c.content,
      subject: c.subject,
      year: c.year,
    }));

    const result = await this.askService.ask({
      questionText: request.questionText,
      medium: request.medium,
      history: request.history.map((h) => ({ role: h.role, content: h.content })),
      chunks,
    });

    return {
      answer: result.answer,
      sources: result.sources,
      grounded: result.grounded,
    };
  }
}
```

- [ ] **Step 2: Write the module and index**

`libs/chat-service/src/chat-service.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatLlmAskService } from './ask.service';
import { GeminiChatService } from './gemini-chat.service';

@Module({
  controllers: [ChatController],
  providers: [ChatLlmAskService, GeminiChatService],
})
export class ChatServiceModule {}
```

`libs/chat-service/src/index.ts`:
```typescript
export * from './chat-service.module';
```

- [ ] **Step 3: Wire into `main.ts` and `app.module.ts`**

Same pattern as Tasks 16/22: add a third `app.connectMicroservice` block with `package: 'chat'`, `protoPath` for `chat.proto`, `url: CHAT_GRPC_URL`. Add `ChatServiceModule` to `app.module.ts` imports.

Note: `chat.proto` imports `rag.proto`, so its `protoPath` for `@grpc/proto-loader` needs `loader: { includeDirs: [join(__dirname, '../../../libs/proto/src')] }` added to the microservice options so the `import "rag.proto"` line resolves — add this to all three `connectMicroservice` blocks now for consistency (harmless for `auth.proto`/`rag.proto`, which don't import anything).

- [ ] **Step 4: Write an e2e test**

`apps/api/test/chat-service.e2e-spec.ts` — mirror Task 16's structure on a distinct test port (`127.0.0.1:50063`), asserting that a small-talk question ("hi there") with zero `retrieved_chunks` returns `grounded: true` and `sources: []` without requiring a live Gemini call to be mocked (this is a real call against the real Gemini API using your `.env` key — acceptable here since Phase 1 has no CI pipeline yet; if that changes later, inject a test double instead of hitting the live API in e2e tests).

- [ ] **Step 5: Run and verify it passes**

```bash
npm run proto:gen
npx jest apps/api/test/chat-service.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add libs/chat-service apps/api
git commit -m "feat: wire Chat/LLM Service as in-process gRPC microservice"
```

---

### Section 1.7 — Gateway Composition (`POST /chat/ask`)

### Task 29: `AskService` orchestrator (Gateway-side composition of RAG + Chat/LLM)

**Files:**
- Create: `libs/gateway/src/ask/ask.service.ts`, `libs/gateway/src/ask/ask.service.spec.ts`, `libs/gateway/src/grpc-clients/rag-client.provider.ts`, `libs/gateway/src/grpc-clients/chat-client.provider.ts`
- Modify: `libs/gateway/src/index.ts`

**Interfaces:**
- Consumes: `rag.RagService/Search` (Task 22), `chat.ChatLlmService/Ask` (Task 28).
- Produces: `GatewayAskService.ask(input: {questionText, subject?, syllabus?, medium, history}): Promise<{answer: string; sources: {subject,year}[]}>` — this is the exact shared core SPEC-SHEET.md §5 describes; Task 31 (`/chat/ask` controller) and Task 46 (`/voice/ask` controller, Phase 2) both call it.

- [ ] **Step 1: Write the gRPC client providers**

`libs/gateway/src/grpc-clients/rag-client.provider.ts` and `chat-client.provider.ts` — copy Task 17's `auth-client.provider.ts` pattern exactly, swapping `package: 'rag'`/`RagServiceClient`/`RAG_GRPC_URL` and `package: 'chat'`/`ChatLlmServiceClient`/`CHAT_GRPC_URL` respectively (the `chat` client's proto loader also needs `includeDirs` for `rag.proto`, per Task 28 Step 3's note). Export tokens `RAG_GRPC_CLIENT` and `CHAT_GRPC_CLIENT`.

- [ ] **Step 2: Write the failing test**

`libs/gateway/src/ask/ask.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { GatewayAskService } from './ask.service';
import { RAG_GRPC_CLIENT } from '../grpc-clients/rag-client.provider';
import { CHAT_GRPC_CLIENT } from '../grpc-clients/chat-client.provider';

describe('GatewayAskService', () => {
  const search = jest.fn();
  const ask = jest.fn();
  let service: GatewayAskService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        GatewayAskService,
        { provide: RAG_GRPC_CLIENT, useValue: { search } },
        { provide: CHAT_GRPC_CLIENT, useValue: { ask } },
      ],
    }).compile();
    service = moduleRef.get(GatewayAskService);
  });

  beforeEach(() => jest.clearAllMocks());

  it('calls RAG Search then Chat Ask, passing retrieved chunks through', async () => {
    search.mockReturnValue(of({ chunks: [{ chunkId: 'c1', paperId: 'p1', content: 'x', subject: 'Economics', year: 2022, questionNumber: '', page: 0, relevanceScore: 0.9 }] }));
    ask.mockReturnValue(of({ answer: 'The answer', sources: [{ subject: 'Economics', year: '2022' }], grounded: true }));

    const result = await service.ask({
      questionText: 'what is demand',
      subject: 'Economics',
      syllabus: 'local',
      medium: 'english',
      history: [],
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'what is demand', subject: 'Economics' }));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      questionText: 'what is demand',
      retrievedChunks: expect.arrayContaining([expect.objectContaining({ chunkId: 'c1' })]),
    }));
    expect(result).toEqual({ answer: 'The answer', sources: [{ subject: 'Economics', year: '2022' }] });
  });

  it('still calls Chat Ask with an empty chunk list when RAG finds nothing (small talk path)', async () => {
    search.mockReturnValue(of({ chunks: [] }));
    ask.mockReturnValue(of({ answer: 'Hi! I can help with...', sources: [], grounded: true }));

    const result = await service.ask({ questionText: 'hi', medium: 'english', history: [] });

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ retrievedChunks: [] }));
    expect(result.sources).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx jest libs/gateway/src/ask/ask.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`libs/gateway/src/ask/ask.service.ts`:
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { RAG_GRPC_CLIENT } from '../grpc-clients/rag-client.provider';
import { CHAT_GRPC_CLIENT } from '../grpc-clients/chat-client.provider';
import { RagServiceClient } from '@app/proto/generated/rag';
import { ChatLlmServiceClient } from '@app/proto/generated/chat';

export interface GatewayAskInput {
  questionText: string;
  subject?: string;
  syllabus?: string;
  level?: string;
  medium: string;
  history: { role: string; content: string }[];
}

export interface GatewayAskResult {
  answer: string;
  sources: { subject: string; year: string }[];
}

@Injectable()
export class GatewayAskService {
  constructor(
    @Inject(RAG_GRPC_CLIENT) private readonly ragClient: RagServiceClient,
    @Inject(CHAT_GRPC_CLIENT) private readonly chatClient: ChatLlmServiceClient,
  ) {}

  async ask(input: GatewayAskInput): Promise<GatewayAskResult> {
    const searchResult = await firstValueFrom(
      this.ragClient.search({
        query: input.questionText,
        subject: input.subject ?? '',
        syllabus: input.syllabus ?? '',
        level: input.level ?? '',
        medium: input.medium,
        topK: 5,
      }),
    );

    const askResult = await firstValueFrom(
      this.chatClient.ask({
        questionText: input.questionText,
        medium: input.medium,
        history: input.history,
        retrievedChunks: searchResult.chunks,
      }),
    );

    return { answer: askResult.answer, sources: askResult.sources };
  }
}
```

Update `libs/gateway/src/index.ts` to also export `GatewayAskService` and the two new client providers/tokens.

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/gateway/src/ask/ask.service.spec.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add libs/gateway
git commit -m "feat: add Gateway AskService orchestrator (RAG + Chat/LLM composition)"
```

---

### Task 30: `chat_sessions`/`chat_messages` repository + persistence wiring

**Files:**
- Create: `libs/database/src/repositories/chat-sessions.repository.ts`, `libs/database/src/repositories/chat-sessions.repository.spec.ts`
- Modify: `libs/database/src/database.module.ts`, `libs/database/src/index.ts`, `libs/gateway/src/ask/ask.service.ts`, `libs/gateway/src/ask/ask.service.spec.ts`

**Interfaces:**
- Consumes: `DatabaseService.query` (Task 11).
- Produces: `ChatSessionsRepository.getOrCreateForStudent(studentId: string): Promise<string>` (returns `session_id`), `.appendMessage(sessionId, role, content, sources?): Promise<void>`, `.getRecentHistory(sessionId, limit=6): Promise<{role,content}[]>` — Task 31's controller and Task 46's `/voice/ask` controller (Phase 2, keyed by `device_id` instead) both depend on this exact signature set.

- [ ] **Step 1: Write the failing test**

`libs/database/src/repositories/chat-sessions.repository.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database.service';
import { ChatSessionsRepository } from './chat-sessions.repository';

describe('ChatSessionsRepository', () => {
  let db: DatabaseService;
  let repo: ChatSessionsRepository;
  const studentId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, ChatSessionsRepository],
    }).compile();
    db = moduleRef.get(DatabaseService);
    repo = moduleRef.get(ChatSessionsRepository);

    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [studentId, `${studentId}@example.com`]);
    await db.query(`insert into students (id, email) values ($1, $2)`, [studentId, `${studentId}@example.com`]);
  });

  afterAll(async () => {
    await db.query('delete from students where id = $1', [studentId]); // cascades chat_sessions -> chat_messages
    await db.query('delete from auth.users where id = $1', [studentId]);
  });

  it('creates a new session on first call and reuses it on subsequent calls for the same student', async () => {
    const first = await repo.getOrCreateForStudent(studentId);
    const second = await repo.getOrCreateForStudent(studentId);
    expect(second).toBe(first);
  });

  it('appends messages and returns the last N in chronological order', async () => {
    const sessionId = await repo.getOrCreateForStudent(studentId);
    await repo.appendMessage(sessionId, 'user', 'What is demand?');
    await repo.appendMessage(sessionId, 'assistant', 'Demand is...', [{ subject: 'Economics', year: '2022' }]);

    const history = await repo.getRecentHistory(sessionId, 6);
    expect(history.map((h) => h.role)).toEqual(['user', 'assistant']);
    expect(history[0].content).toBe('What is demand?');
  });

  it('caps history at the requested limit, keeping the most recent turns', async () => {
    const sessionId = await repo.getOrCreateForStudent(studentId);
    for (let i = 0; i < 10; i++) {
      await repo.appendMessage(sessionId, i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`);
    }
    const history = await repo.getRecentHistory(sessionId, 6);
    expect(history).toHaveLength(6);
    expect(history[history.length - 1].content).toBe('turn 9');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/database/src/repositories/chat-sessions.repository.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/database/src/repositories/chat-sessions.repository.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable()
export class ChatSessionsRepository {
  constructor(private readonly db: DatabaseService) {}

  async getOrCreateForStudent(studentId: string): Promise<string> {
    const existing = await this.db.query<{ id: string }>(
      `select id from chat_sessions where student_id = $1 order by created_at desc limit 1`,
      [studentId],
    );
    if (existing[0]) return existing[0].id;

    const created = await this.db.query<{ id: string }>(
      `insert into chat_sessions (student_id) values ($1) returning id`,
      [studentId],
    );
    return created[0].id;
  }

  async getOrCreateForDevice(deviceId: string): Promise<string> {
    const existing = await this.db.query<{ id: string }>(
      `select id from chat_sessions where device_id = $1 order by created_at desc limit 1`,
      [deviceId],
    );
    if (existing[0]) return existing[0].id;

    const created = await this.db.query<{ id: string }>(
      `insert into chat_sessions (device_id) values ($1) returning id`,
      [deviceId],
    );
    return created[0].id;
  }

  async appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    sources?: { subject: string; year: string }[],
  ): Promise<void> {
    await this.db.query(
      `insert into chat_messages (session_id, role, content, sources) values ($1, $2, $3, $4)`,
      [sessionId, role, content, sources ? JSON.stringify(sources) : null],
    );
  }

  async getRecentHistory(sessionId: string, limit = 6): Promise<HistoryTurn[]> {
    const rows = await this.db.query<HistoryTurn>(
      `select role, content from chat_messages
       where session_id = $1
       order by created_at desc
       limit $2`,
      [sessionId, limit],
    );
    return rows.reverse();
  }
}
```

Update `libs/database/src/database.module.ts` and `index.ts` to also provide/export `ChatSessionsRepository` (same pattern as Task 12).

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/database/src/repositories/chat-sessions.repository.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire persistence into `GatewayAskService`**

Update `libs/gateway/src/ask/ask.service.ts` to accept a `sessionId` (already resolved by the caller — Task 31's controller resolves it via `ChatSessionsRepository.getOrCreateForStudent`) and persist both turns:
```typescript
// add to GatewayAskService's constructor:
private readonly chatSessions: ChatSessionsRepository,

// change ask()'s signature to accept sessionId, and add after computing askResult:
async ask(input: GatewayAskInput & { sessionId: string }): Promise<GatewayAskResult> {
  // ...existing search + chatClient.ask logic...
  await this.chatSessions.appendMessage(input.sessionId, 'user', input.questionText);
  await this.chatSessions.appendMessage(input.sessionId, 'assistant', askResult.answer, askResult.sources);
  return { answer: askResult.answer, sources: askResult.sources };
}
```
Update `libs/gateway/src/ask/ask.service.spec.ts`'s existing two tests to inject a mocked `ChatSessionsRepository` (`{ appendMessage: jest.fn() }`) and pass `sessionId: 'test-session'` in each call's input, asserting `appendMessage` was called twice (once per role).

- [ ] **Step 6: Run and verify the updated tests pass**

```bash
npx jest libs/gateway/src/ask/ask.service.spec.ts libs/database/src/repositories/chat-sessions.repository.spec.ts
```
Expected: PASS, 5 tests total.

- [ ] **Step 7: Commit**

```bash
git add libs/database libs/gateway
git commit -m "feat: persist chat_sessions/chat_messages, wire into AskService"
```

---

### Task 31: `POST /chat/ask` controller

**Files:**
- Create: `libs/gateway/src/chat/chat.controller.ts`, `libs/gateway/src/chat/dto/chat-ask.dto.ts`, `apps/api/test/chat-ask.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`, `libs/gateway/src/index.ts`

**Interfaces:**
- Consumes: `GatewayAskService.ask` (Tasks 29-30), `AuthGuard` (Task 17), `ChatSessionsRepository.getOrCreateForStudent`/`getRecentHistory` (Task 30).
- Produces: `POST /chat/ask` matching `mobile-app-README.md`'s exact wire contract — request `{question, stream, subject, syllabus, medium, student_id, chat_history[]}`, response `{answer, sources: [{past_papers:{subject,year}}]}`.

- [ ] **Step 1: Write the DTO**

`libs/gateway/src/chat/dto/chat-ask.dto.ts`:
```typescript
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

class ChatHistoryTurnDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  content: string;
}

export class ChatAskDto {
  @IsString()
  question: string;

  @IsOptional() @IsString()
  stream?: string;

  @IsOptional() @IsString()
  subject?: string;

  @IsOptional() @IsString()
  syllabus?: string;

  @IsString()
  medium: string;

  @IsString()
  student_id: string;

  @IsOptional() @IsArray()
  chat_history?: ChatHistoryTurnDto[];
}
```

- [ ] **Step 2: Write the controller**

`libs/gateway/src/chat/chat.controller.ts`:
```typescript
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../guards/auth.guard';
import { GatewayAskService } from '../ask/ask.service';
import { ChatSessionsRepository } from '@app/database';
import { ChatAskDto } from './dto/chat-ask.dto';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly askService: GatewayAskService,
    private readonly chatSessions: ChatSessionsRepository,
  ) {}

  @Post('ask')
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async ask(@Body() body: ChatAskDto) {
    const sessionId = await this.chatSessions.getOrCreateForStudent(body.student_id);

    const result = await this.askService.ask({
      questionText: body.question,
      subject: body.subject,
      syllabus: body.syllabus,
      medium: body.medium,
      history: (body.chat_history ?? []).slice(-6),
      sessionId,
    });

    return {
      answer: result.answer,
      sources: result.sources.map((s) => ({ past_papers: { subject: s.subject, year: s.year } })),
    };
  }
}
```

Note: `body.student_id` is trusted from the request body here to match the *existing* wire contract exactly (the client already sends it) — but the `AuthGuard` has already independently verified the caller's JWT and attached `request.principal`. Cross-checking `body.student_id === request.principal.id` and rejecting on mismatch is a reasonable hardening step; it's deliberately left out of Phase 1 to keep this task's scope to "make the existing contract work under real auth," and can be added later without changing the wire contract.

- [ ] **Step 3: Wire into `app.module.ts`**

Add `ChatController` and `GatewayAskService` (plus the RAG/Chat gRPC client providers from Task 29) to a `GatewayModule` (create `libs/gateway/src/gateway.module.ts` bundling `AuthGuard`'s dependency, `ChatController`, `GatewayAskService`, and the three gRPC client providers), then import `GatewayModule` into `apps/api/src/app.module.ts`.

- [ ] **Step 4: Write the e2e test**

`apps/api/test/chat-ask.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';

describe('POST /chat/ask (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects requests with no Authorization header', async () => {
    await request(app.getHttpServer())
      .post('/chat/ask')
      .send({ question: 'hi', medium: 'english', student_id: 'x' })
      .expect(401);
  });

  it('returns the mobile app wire contract shape for a seeded curriculum question', async () => {
    // Requires: a real student row + valid JWT for it (see Task 3's dev project),
    // and the Task 23 seed script already run.
    const token = process.env.TEST_STUDENT_JWT!; // set locally before running this test
    const res = await request(app.getHttpServer())
      .post('/chat/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({
        question: 'What happens to demand when price rises?',
        subject: 'Economics',
        syllabus: 'local',
        medium: 'english',
        student_id: process.env.TEST_STUDENT_ID!,
        chat_history: [],
      })
      .expect(200);

    expect(res.body).toHaveProperty('answer');
    expect(Array.isArray(res.body.sources)).toBe(true);
    if (res.body.sources.length > 0) {
      expect(res.body.sources[0]).toHaveProperty('past_papers.subject');
      expect(res.body.sources[0]).toHaveProperty('past_papers.year');
    }
  });
});
```

- [ ] **Step 5: Run and verify it passes**

Create a throwaway test student + JWT for local testing (Supabase SQL editor: insert a row into `auth.users`/`students`, or sign up a test account via the Supabase JS client and copy its access token), export `TEST_STUDENT_JWT` and `TEST_STUDENT_ID`, then:
```bash
npx jest apps/api/test/chat-ask.e2e-spec.ts --runInBand
```
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add libs/gateway apps/api
git commit -m "feat: add POST /chat/ask controller matching the existing mobile wire contract"
```

---

### Task 32: Manual end-to-end verification (local stack)

**Files:** none — this is a verification-only task.

- [ ] **Step 1: Bring up the full local stack**

```bash
docker compose up -d postgres redis
npm run proto:gen
npm run build
node dist/apps/api/main.js &
```

- [ ] **Step 2: Seed and query**

```bash
npm run seed:papers
curl -s -X POST http://localhost:3000/chat/ask \
  -H "Authorization: Bearer $TEST_STUDENT_JWT" \
  -H "Content-Type: application/json" \
  -d '{"question":"What is the law of demand?","subject":"Economics","syllabus":"local","medium":"english","student_id":"'"$TEST_STUDENT_ID"'","chat_history":[]}' | jq
```
Expected: a JSON response with a real, on-topic `answer` and `sources` containing `{"past_papers":{"subject":"Economics","year":2022}}`.

- [ ] **Step 3: Verify the decline path**

```bash
curl -s -X POST http://localhost:3000/chat/ask \
  -H "Authorization: Bearer $TEST_STUDENT_JWT" \
  -H "Content-Type: application/json" \
  -d '{"question":"What is the capital of France?","subject":"Economics","syllabus":"local","medium":"english","student_id":"'"$TEST_STUDENT_ID"'","chat_history":[]}' | jq
```
Expected: the answer is the localized decline message ("I don't have that in the past papers I have yet." or equivalent), `sources` is empty — proving Gemini did **not** free-answer a geography question from general knowledge.

- [ ] **Step 4: Verify small talk still works without citations**

```bash
curl -s -X POST http://localhost:3000/chat/ask \
  -H "Authorization: Bearer $TEST_STUDENT_JWT" \
  -H "Content-Type: application/json" \
  -d '{"question":"What can you help me with?","medium":"english","student_id":"'"$TEST_STUDENT_ID"'","chat_history":[]}' | jq
```
Expected: a normal, non-declined answer with empty `sources`.

- [ ] **Step 5: Shut down**

```bash
kill %1
docker compose down
```

No commit — this task is pure verification. If any step fails, fix the root cause in the relevant earlier task before continuing to Section 1.8.

---

### Section 1.8 — Mobile App Auth Wiring (cross-repo: `Obscura_app/obscura_app`)

All file paths in this section are relative to `C:\Users\Dell\StudioProjects\Obscura_app\obscura_app`, a **separate git repository** from `obscura-backend-v2`. Commit these changes there, not here.

### Task 33: Wire real Supabase auth into login, signup, logout, and route gating

**Files:**
- Modify: `lib/features/auth/nesh_ai_chat/screens/login_screen.dart`, `lib/routes/app_router.dart`, `lib/main.dart`, `lib/features/auth/settings/screens/settings_screen.dart`
- Create: `lib/core/constants/app_constants.dart` update only (Task 34 handles the backend URL — this task doesn't touch that file)

**Interfaces:**
- Consumes: the already-implemented `AuthProvider.signIn`/`signUp`/`signOut` (`lib/providers/auth_provider.dart` — unchanged, already correct) against the **new dedicated dev Supabase project's** URL/anon key from Task 3 (update `AppConstants.supabaseUrl`/`supabaseAnonKey` first — see Step 0).
- Produces: a login screen that actually authenticates, a router that redirects unauthenticated users to `/login`, and a logout button that actually signs out — closing the gap `mobile-app-README.md` §Authentication Flow flags.

- [ ] **Step 0: Point the dev build at the new Supabase dev project**

In `lib/core/constants/app_constants.dart`, replace `supabaseUrl` and `supabaseAnonKey` with the values from Task 3 (the dedicated `obscura-backend-v2-dev` project, not the live `zsdsqyowcjifbktbolji` one) — otherwise the JWTs this app issues won't match what the backend's `SUPABASE_JWT_SECRET` (Task 7) can verify. This is a local/dev-only swap; revert it back to the live project's values before this app is ever built for production distribution.

- [ ] **Step 1: Wire `LoginScreen`'s handlers**

In `lib/features/auth/nesh_ai_chat/screens/login_screen.dart`, replace:
```dart
Future<void> _handleLogin() async {
  context.go(AppRoutes.home);
}
```
with:
```dart
Future<void> _handleLogin() async {
  if (!_loginFormKey.currentState!.validate()) return;
  final auth = context.read<AuthProvider>();
  final ok = await auth.signIn(
    email: _loginEmailCtrl.text.trim(),
    password: _loginPasswordCtrl.text,
  );
  if (!mounted) return;
  if (ok) {
    context.go(AppRoutes.home);
  } else {
    _showError(auth.error ?? 'Login failed — please try again');
  }
}
```
and replace:
```dart
Future<void> _handleSignUp() async {
  context.go(AppRoutes.home);
}
```
with:
```dart
Future<void> _handleSignUp() async {
  if (!_signupFormKey.currentState!.validate()) return;
  final auth = context.read<AuthProvider>();
  final ok = await auth.signUp(
    email: _signupEmailCtrl.text.trim(),
    password: _signupPasswordCtrl.text,
    name: _signupNameCtrl.text.trim(),
  );
  if (!mounted) return;
  if (ok) {
    context.go(AppRoutes.home);
  } else {
    _showError(auth.error ?? 'Sign up failed — please try again');
  }
}
```

- [ ] **Step 2: Add login-state redirect gating to the router**

In `lib/routes/app_router.dart`, change `buildAppRouter`'s signature to also take an `AuthProvider` and use it as `refreshListenable` (so the router re-evaluates `redirect` when auth state changes, not just on navigation):
```dart
GoRouter buildAppRouter(UserProfileProvider profileProvider, AuthProvider authProvider) {
  return GoRouter(
    initialLocation: AppRoutes.splash,
    refreshListenable: authProvider,
    redirect: (context, state) {
      final location = state.matchedLocation;
      final hasProfile = profileProvider.hasProfile;
      final isLoggedIn = authProvider.isLoggedIn;

      final onSplash = location == AppRoutes.splash;
      final onOnboarding = location.startsWith(AppRoutes.onboarding);
      final onLogin = location.startsWith(AppRoutes.login);
      final onProtected = !onSplash && !onOnboarding && !onLogin;

      if (!hasProfile && onProtected) return AppRoutes.onboarding;
      if (hasProfile && !isLoggedIn && onProtected) return AppRoutes.login;

      return null;
    },
    routes: [
      // ...unchanged...
```
Add `import '../providers/auth_provider.dart';` at the top of the file.

- [ ] **Step 3: Update the call site in `main.dart`**

In `lib/main.dart`, change:
```dart
routerConfig: buildAppRouter(profileProvider),
```
to:
```dart
routerConfig: buildAppRouter(profileProvider, context.watch<AuthProvider>()),
```

- [ ] **Step 4: Wire the logout button**

In `lib/features/auth/settings/screens/settings_screen.dart`, change `SettingsScreen` from `StatelessWidget` to allow `BuildContext` access for `AuthProvider` (it already has `context` in `build`, so no widget-type change is needed — just fix the dialog's confirm action). Replace the "Log Out" `TextButton`'s `onPressed`:
```dart
TextButton(
  onPressed: () => Navigator.pop(context),
  child: Text('Log Out', style: TextStyle(color: AppColors.error)),
),
```
with:
```dart
TextButton(
  onPressed: () async {
    Navigator.pop(context); // close the dialog first
    await context.read<AuthProvider>().signOut();
  },
  child: Text('Log Out', style: TextStyle(color: AppColors.error)),
),
```
Add `import '../../../../providers/auth_provider.dart';` at the top of the file if not already present.

- [ ] **Step 5: Verify with `flutter analyze` and a manual run**

```bash
cd "C:\Users\Dell\StudioProjects\Obscura_app\obscura_app"
flutter analyze
flutter run
```
Manually: complete onboarding, land on `/login`, sign up with a test email — expect navigation to `/home`. Go to Settings, tap Log Out, confirm — expect an automatic redirect back to `/login` (proving `refreshListenable` is wired correctly, not just that `signOut()` was called).

- [ ] **Step 6: Commit (in the `Obscura_app/obscura_app` repo)**

```bash
git add lib/features/auth/nesh_ai_chat/screens/login_screen.dart lib/routes/app_router.dart lib/main.dart lib/features/auth/settings/screens/settings_screen.dart lib/core/constants/app_constants.dart
git commit -m "feat: wire real Supabase auth into login/signup/logout, add login-state route gating"
```

---

### Task 34: Wire `AiChatScreen` to send real auth + real student context

**Files:**
- Modify: `lib/features/auth/nesh_ai_chat/screens/ai_chat_screen.dart`

**Interfaces:**
- Consumes: `AuthProvider.currentUser`/`userId` (already implemented), the backend's `POST /chat/ask` (Task 31) which now requires `Authorization: Bearer <token>` via `AuthGuard` (Task 17).
- Produces: the chat screen sends the real logged-in student's JWT and UUID instead of the hardcoded placeholder, and points at the local dev backend instead of the retired Railway URL.

- [ ] **Step 1: Replace the hardcoded student context and backend URL**

In `lib/features/auth/nesh_ai_chat/screens/ai_chat_screen.dart`, replace:
```dart
// Student context — later connect to UserProfileProvider
final String _studentId = '550e8400-e29b-41d4-a716-446655440000';
final String _stream = 'Commerce';
final String _subject = 'Economics';
final String _syllabus = 'Local';
final String _medium = 'english';

// Backend URL
static const String _baseUrl =
    'https://obscura-backend-production-d7de.up.railway.app';
```
with:
```dart
final String _stream = 'Commerce';
final String _subject = 'Economics';
final String _syllabus = 'Local';
final String _medium = 'english';

// Local dev backend (obscura-backend-v2). Update to the Koyeb URL once Task 36 deploys it.
static const String _baseUrl = 'http://10.0.2.2:3000'; // Android emulator loopback to host localhost:3000
```
(`10.0.2.2` is the Android emulator's alias for the host machine's `localhost`; if testing on a physical device or iOS simulator, use your machine's LAN IP or `localhost` respectively instead.)

- [ ] **Step 2: Send the real bearer token and student id in `_sendMessage`**

Add `import 'package:supabase_flutter/supabase_flutter.dart';` and `import 'package:provider/provider.dart';` (provider is likely already imported) at the top. Replace the `http.post` call's `headers`/`body`:
```dart
final session = Supabase.instance.client.auth.currentSession;
final studentId = Supabase.instance.client.auth.currentUser?.id;

final response = await http
    .post(
      Uri.parse('$_baseUrl/chat/ask'),
      headers: {
        'Content-Type': 'application/json',
        if (session != null) 'Authorization': 'Bearer ${session.accessToken}',
      },
      body: jsonEncode({
        'question': userMsg,
        'stream': _stream,
        'subject': _subject,
        'syllabus': _syllabus,
        'medium': _medium,
        'student_id': studentId,
        'chat_history': history,
      }),
    )
    .timeout(const Duration(seconds: 30));
```

- [ ] **Step 3: Verify**

```bash
flutter analyze
```
Expected: no new errors. Manual run: log in, ask NESH a question from Task 32's seeded corpus (e.g. "What is the law of demand?") — expect a real answer with citation chips rendered, exactly as before but now authenticated.

- [ ] **Step 4: Commit (in the `Obscura_app/obscura_app` repo)**

```bash
git add lib/features/auth/nesh_ai_chat/screens/ai_chat_screen.dart
git commit -m "feat: send real bearer token + student id to /chat/ask, point at local backend-v2"
```

---

### Task 35: Manual end-to-end verification (mobile app + local backend)

**Files:** none — verification only.

- [ ] **Step 1: Run both stacks**

Backend: `docker compose up -d postgres redis && node dist/apps/api/main.js` (from `obscura-backend-v2`).
Mobile: `flutter run` (from `Obscura_app/obscura_app`), on an emulator so `10.0.2.2` resolves correctly.

- [ ] **Step 2: Walk the full flow**

1. Fresh install / clear app data so onboarding runs.
2. Complete onboarding → lands on `/login`.
3. Sign up with a new test email/password → lands on `/home`.
4. Open AI Chat, ask "What is the law of demand?" → expect a real, cited answer.
5. Go to Settings → Log Out → confirm → expect redirect to `/login`.
6. Log back in with the same credentials → expect `/home` again.

Expected: every step works with no crashes, no "trouble connecting" fallback message, and citations render as `"Economics 2022"`-style chips under the answer.

No commit — verification only. If anything fails, fix it in Task 33/34 rather than patching around it here.

---

### Section 1.9 — Deploy Phase 1 to Koyeb

### Task 36: Deploy `apps/api` to Koyeb, wire secrets, smoke-test in production

**Files:**
- Create: `.koyeb.yaml` (optional declarative service definition, or use CLI flags directly — see Step 2)

- [ ] **Step 1: Push the repo to a Git remote Koyeb can build from**

Koyeb's Docker-build-from-Git flow needs a pushed branch. If not already pushed:
```bash
git remote -v   # confirm a remote exists; if not, ask the user to provide one before proceeding
git push origin master
```

- [ ] **Step 2: Create the Koyeb service**

```bash
koyeb service create obscura-api \
  --app obscura-backend-v2 \
  --git github.com/<your-org>/obscura-backend-v2 \
  --git-branch master \
  --git-builder docker \
  --ports 3000:http \
  --routes /:3000 \
  --env NODE_ENV=production \
  --env PORT=3000
```
(`koyeb app create obscura-backend-v2` first if the app doesn't exist yet.)

- [ ] **Step 3: Set secrets**

```bash
for key in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET DATABASE_URL REDIS_URL GEMINI_API_KEY COHERE_API_KEY; do
  koyeb secret create "$key" --value "<paste-real-value>"
done
koyeb service update obscura-api \
  --env SUPABASE_URL=@SUPABASE_URL \
  --env SUPABASE_ANON_KEY=@SUPABASE_ANON_KEY \
  --env SUPABASE_SERVICE_ROLE_KEY=@SUPABASE_SERVICE_ROLE_KEY \
  --env SUPABASE_JWT_SECRET=@SUPABASE_JWT_SECRET \
  --env DATABASE_URL=@DATABASE_URL \
  --env REDIS_URL=@REDIS_URL \
  --env GEMINI_API_KEY=@GEMINI_API_KEY \
  --env COHERE_API_KEY=@COHERE_API_KEY
```

- [ ] **Step 4: Wait for deploy and smoke-test**

```bash
koyeb service get obscura-api
```
Wait until status is `HEALTHY`, then note the public URL (`https://<something>.koyeb.app`):
```bash
curl -s -X POST https://<your-app>.koyeb.app/chat/ask \
  -H "Authorization: Bearer $TEST_STUDENT_JWT" \
  -H "Content-Type: application/json" \
  -d '{"question":"What is the law of demand?","subject":"Economics","syllabus":"local","medium":"english","student_id":"'"$TEST_STUDENT_ID"'","chat_history":[]}'
```
Expected: same successful, cited response as Task 32's local test — note that the seed script (Task 23) must be re-run once, pointed at the production `DATABASE_URL`, before this returns citations (Koyeb's Postgres is the same Supabase dev project, so this is usually already true if you ran `npm run seed:papers` with `.env` pointed at the dev project).

- [ ] **Step 5: Point the mobile app at production (optional at this stage)**

In `Obscura_app/obscura_app`'s `lib/features/auth/nesh_ai_chat/screens/ai_chat_screen.dart`, update `_baseUrl` to `https://<your-app>.koyeb.app` when ready to test against production instead of local — not required to consider Phase 1 done, since Task 35 already verified the full flow locally.

- [ ] **Step 6: Commit**

```bash
git add .koyeb.yaml 2>/dev/null; git status # only if you created a declarative config in Step 2
git commit -m "chore: document Koyeb deploy of apps/api" --allow-empty
```

**Phase 1 complete.** `POST /chat/ask` works end-to-end: real Supabase JWT auth, hybrid RAG retrieval with RRF fusion + Cohere rerank, Gemini-generated grounded answers with the exact citation contract the live mobile app already parses, and a hard decline rule for ungrounded curriculum questions.

---

## Phase 2 — Speech Service, Device Auth, Voice Pipeline

Delivers `POST /voice/ask` working end-to-end against a real per-device API key, reusing Phase 1's `GatewayAskService` unchanged. English and Tamil only — Sinhala is rejected on the voice path per SPEC-SHEET.md §7/§17 Q9, with text chat unaffected.

### Task 37: Provision GCP Cloud Speech-to-Text & Text-to-Speech

**Files:**
- Create: `secrets/gcp-speech-service-account.json` (gitignored)
- Modify: `.env.example`, `.gitignore`

- [ ] **Step 1: Create/select a GCP project and enable the APIs**

Manual steps (browser):
1. Go to https://console.cloud.google.com and create a new project (or reuse the one the Gemini API key from Task 4 is billed under — either works, they're independent APIs).
2. Enable billing on the project (required for Speech-to-Text/Text-to-Speech beyond the free tier — small beta usage per SPEC-SHEET.md §8 should stay well within free-tier limits, but billing must still be enabled to call the API at all).
3. Go to **APIs & Services → Library**, enable **Cloud Speech-to-Text API** and **Cloud Text-to-Speech API**.
4. Go to **IAM & Admin → Service Accounts → Create Service Account**, name it `obscura-speech`, grant it the **Cloud Speech Client** and **Cloud Text-to-Speech User**-equivalent roles (or simply `roles/speech.client` — search "Speech" in the role picker and pick the closest client/user role, avoid Owner/Editor).
5. Create a JSON key for this service account and download it.

- [ ] **Step 2: Store the key locally, never commit it**

```bash
mkdir -p secrets
mv ~/Downloads/<downloaded-key>.json secrets/gcp-speech-service-account.json
echo "secrets/" >> .gitignore
```

Add to `.env.example`:
```
GOOGLE_APPLICATION_CREDENTIALS=./secrets/gcp-speech-service-account.json
```
Add the same line to your real `.env`, and add `GOOGLE_APPLICATION_CREDENTIALS` to `env.validation.ts` (Task 7) as a required string.

- [ ] **Step 3: Verify**

```bash
npm i -D @google-cloud/speech
node -e "
  const speech = require('@google-cloud/speech');
  const client = new speech.SpeechClient();
  client.getProjectId().then(id => console.log('OK, project:', id)).catch(e => { console.error(e); process.exit(1); });
"
```
Expected: prints `OK, project: <your-project-id>`, not an auth error.

- [ ] **Step 4: Commit**

```bash
git add .gitignore .env.example
git commit -m "chore: document GCP Speech credentials wiring (key itself gitignored)"
```

---

### Task 38: `speech.proto` + codegen

**Files:**
- Create: `libs/proto/src/speech.proto`

**Interfaces:**
- Produces: `SpeechServiceClient`, `TranscribeRequest/Response`, `SynthesizeRequest/Response` — consumed by Task 39-41 (implementation + wiring) and Task 46 (Gateway `/voice/ask` controller).

- [ ] **Step 1: Write the proto**

`libs/proto/src/speech.proto`:
```protobuf
syntax = "proto3";
package speech;

service SpeechService {
  rpc Transcribe (TranscribeRequest) returns (TranscribeResponse);
  rpc Synthesize (SynthesizeRequest) returns (SynthesizeResponse);
}

message TranscribeRequest {
  bytes wav_audio = 1;
  string medium = 2; // "english" | "tamil" — "sinhala" is rejected
}

message TranscribeResponse {
  bool success = 1;
  string text = 2;
  string error = 3;
}

message SynthesizeRequest {
  string text = 1;
  string medium = 2;
}

message SynthesizeResponse {
  bool success = 1;
  bytes pcm16_16k_mono = 2;
  string error = 3;
}
```

- [ ] **Step 2: Regenerate and verify**

```bash
npm run proto:gen
ls libs/proto/src/generated
```
Expected: `speech.ts` present.

- [ ] **Step 3: Commit**

```bash
git add libs/proto
git commit -m "feat: define speech.proto (Transcribe, Synthesize)"
```

---

### Task 39: STT implementation (`Transcribe`)

**Files:**
- Create: `libs/speech-service/src/stt.service.ts`, `libs/speech-service/src/stt.service.spec.ts`, `libs/speech-service/src/language.ts`

**Interfaces:**
- Consumes: `@google-cloud/speech`, `GOOGLE_APPLICATION_CREDENTIALS` (Task 37).
- Produces: `SttService.transcribe(wavAudio: Buffer, medium: string): Promise<{success: boolean; text: string; error: string}>` — Task 41's gRPC controller calls this directly; rejects `medium==='sinhala'` before ever calling Google.

- [ ] **Step 1: Write the language routing table**

`libs/speech-service/src/language.ts`:
```typescript
export const STT_LANGUAGE_CODES: Record<string, string> = {
  english: 'en-US',
  tamil: 'ta-IN',
};

export const TTS_LANGUAGE_CODES: Record<string, string> = {
  english: 'en-US',
  tamil: 'ta-IN',
};

export const VOICE_UNSUPPORTED_MEDIUM_MESSAGE: Record<'english' | 'tamil', string> = {
  english: "Sorry, voice isn't available in Sinhala yet — please use the app for Sinhala questions.",
  tamil: 'மன்னிக்கவும், சிங்களத்தில் குரல் இன்னும் கிடைக்கவில்லை — சிங்கள கேள்விகளுக்கு ஆப்ஸைப் பயன்படுத்தவும்.',
};

export function isVoiceSupportedMedium(medium: string): medium is 'english' | 'tamil' {
  return medium === 'english' || medium === 'tamil';
}
```

- [ ] **Step 2: Write the failing test**

`libs/speech-service/src/stt.service.spec.ts`:
```typescript
import { SttService } from './stt.service';

const mockRecognize = jest.fn();
jest.mock('@google-cloud/speech', () => ({
  SpeechClient: jest.fn().mockImplementation(() => ({ recognize: mockRecognize })),
}));

describe('SttService', () => {
  let service: SttService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SttService();
  });

  it('rejects Sinhala before calling Google Speech at all', async () => {
    const result = await service.transcribe(Buffer.from('fake wav'), 'sinhala');
    expect(result).toEqual({
      success: false,
      text: '',
      error: 'sinhala_not_supported_on_voice',
    });
    expect(mockRecognize).not.toHaveBeenCalled();
  });

  it('transcribes English audio using the en-US language code', async () => {
    mockRecognize.mockResolvedValue([{ results: [{ alternatives: [{ transcript: 'what is the law of demand' }] }] }]);
    const result = await service.transcribe(Buffer.from('fake wav'), 'english');
    expect(result).toEqual({ success: true, text: 'what is the law of demand', error: '' });
    expect(mockRecognize.mock.calls[0][0].config.languageCode).toBe('en-US');
  });

  it('transcribes Tamil audio using the ta-IN language code', async () => {
    mockRecognize.mockResolvedValue([{ results: [{ alternatives: [{ transcript: 'tamil text' }] }] }]);
    const result = await service.transcribe(Buffer.from('fake wav'), 'tamil');
    expect(result.success).toBe(true);
    expect(mockRecognize.mock.calls[0][0].config.languageCode).toBe('ta-IN');
  });

  it('returns success:false with a clear error when Google returns no results (silence)', async () => {
    mockRecognize.mockResolvedValue([{ results: [] }]);
    const result = await service.transcribe(Buffer.from('fake wav'), 'english');
    expect(result).toEqual({ success: false, text: '', error: 'no_speech_detected' });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx jest libs/speech-service/src/stt.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`libs/speech-service/src/stt.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { SpeechClient } from '@google-cloud/speech';
import { STT_LANGUAGE_CODES } from './language';

export interface TranscribeResult {
  success: boolean;
  text: string;
  error: string;
}

@Injectable()
export class SttService {
  private readonly client = new SpeechClient();

  async transcribe(wavAudio: Buffer, medium: string): Promise<TranscribeResult> {
    if (medium === 'sinhala') {
      return { success: false, text: '', error: 'sinhala_not_supported_on_voice' };
    }

    const languageCode = STT_LANGUAGE_CODES[medium] ?? STT_LANGUAGE_CODES.english;

    const [response] = await this.client.recognize({
      audio: { content: wavAudio.toString('base64') },
      config: {
        encoding: 'LINEAR16' as const,
        sampleRateHertz: 16000,
        languageCode,
      },
    });

    const transcript = response.results?.[0]?.alternatives?.[0]?.transcript;
    if (!transcript) {
      return { success: false, text: '', error: 'no_speech_detected' };
    }

    return { success: true, text: transcript, error: '' };
  }
}
```

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/speech-service/src/stt.service.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add libs/speech-service
git commit -m "feat: add STT implementation with English/Tamil routing, Sinhala rejection"
```

---

### Task 40: TTS implementation (`Synthesize`)

**Files:**
- Create: `libs/speech-service/src/tts.service.ts`, `libs/speech-service/src/tts.service.spec.ts`

**Interfaces:**
- Consumes: `@google-cloud/text-to-speech`, `language.ts` (Task 39).
- Produces: `TtsService.synthesize(text: string, medium: string): Promise<{success: boolean; pcm16_16k_mono: Buffer; error: string}>` matching the exact format `iot-robot-README.md` §4.3 expects (headerless raw 16-bit/16kHz mono PCM — no WAV wrapper, or the firmware will play the 44-byte header as an audible click).

- [ ] **Step 1: Write the failing test**

`libs/speech-service/src/tts.service.spec.ts`:
```typescript
import { TtsService } from './tts.service';

const mockSynthesizeSpeech = jest.fn();
jest.mock('@google-cloud/text-to-speech', () => ({
  TextToSpeechClient: jest.fn().mockImplementation(() => ({ synthesizeSpeech: mockSynthesizeSpeech })),
}));

describe('TtsService', () => {
  let service: TtsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TtsService();
  });

  it('requests LINEAR16 / 16kHz mono audio (headerless, robot-firmware-compatible)', async () => {
    mockSynthesizeSpeech.mockResolvedValue([{ audioContent: Buffer.from([1, 2, 3, 4]) }]);
    await service.synthesize('Demand falls as price rises.', 'english');

    const [requestArg] = mockSynthesizeSpeech.mock.calls[0];
    expect(requestArg.audioConfig.audioEncoding).toBe('LINEAR16');
    expect(requestArg.audioConfig.sampleRateHertz).toBe(16000);
    expect(requestArg.voice.languageCode).toBe('en-US');
  });

  it('uses the ta-IN voice for Tamil', async () => {
    mockSynthesizeSpeech.mockResolvedValue([{ audioContent: Buffer.from([1, 2]) }]);
    await service.synthesize('சில உரை', 'tamil');
    const [requestArg] = mockSynthesizeSpeech.mock.calls[0];
    expect(requestArg.voice.languageCode).toBe('ta-IN');
  });

  it('returns the raw PCM buffer on success', async () => {
    const fakePcm = Buffer.from([9, 9, 9]);
    mockSynthesizeSpeech.mockResolvedValue([{ audioContent: fakePcm }]);
    const result = await service.synthesize('hi', 'english');
    expect(result).toEqual({ success: true, pcm16_16k_mono: fakePcm, error: '' });
  });

  it('returns success:false with a clear error for Sinhala (should be routed to the fixed decline message upstream, not synthesized freely)', async () => {
    const result = await service.synthesize('x', 'sinhala');
    expect(result).toEqual({ success: false, pcm16_16k_mono: Buffer.alloc(0), error: 'sinhala_not_supported_on_voice' });
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/speech-service/src/tts.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/speech-service/src/tts.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { TTS_LANGUAGE_CODES } from './language';

export interface SynthesizeResult {
  success: boolean;
  pcm16_16k_mono: Buffer;
  error: string;
}

@Injectable()
export class TtsService {
  private readonly client = new TextToSpeechClient();

  async synthesize(text: string, medium: string): Promise<SynthesizeResult> {
    if (medium === 'sinhala') {
      return { success: false, pcm16_16k_mono: Buffer.alloc(0), error: 'sinhala_not_supported_on_voice' };
    }

    const languageCode = TTS_LANGUAGE_CODES[medium] ?? TTS_LANGUAGE_CODES.english;

    const [response] = await this.client.synthesizeSpeech({
      input: { text },
      voice: { languageCode, ssmlGender: 'NEUTRAL' as const },
      audioConfig: { audioEncoding: 'LINEAR16' as const, sampleRateHertz: 16000 },
    });

    return {
      success: true,
      pcm16_16k_mono: Buffer.from(response.audioContent as Uint8Array),
      error: '',
    };
  }
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/speech-service/src/tts.service.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add libs/speech-service
git commit -m "feat: add TTS implementation producing headerless PCM16/16kHz/mono"
```

---

### Task 41: Wire Speech Service as an in-process gRPC microservice

**Files:**
- Create: `libs/speech-service/src/speech.controller.ts`, `libs/speech-service/src/speech-service.module.ts`, `libs/speech-service/src/index.ts`, `apps/api/test/speech-service.e2e-spec.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `SttService.transcribe` (Task 39), `TtsService.synthesize` (Task 40), `SPEECH_GRPC_URL` env var (add to `env.validation.ts`, default `127.0.0.1:50054`).
- Produces: a live gRPC server implementing `speech.SpeechService/{Transcribe,Synthesize}` — Task 46's Gateway `/voice/ask` controller is its first caller.

- [ ] **Step 1: Write the controller**

`libs/speech-service/src/speech.controller.ts`:
```typescript
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { SttService } from './stt.service';
import { TtsService } from './tts.service';
import { TranscribeRequest, TranscribeResponse, SynthesizeRequest, SynthesizeResponse } from '@app/proto/generated/speech';

@Controller()
export class SpeechController {
  constructor(private readonly stt: SttService, private readonly tts: TtsService) {}

  @GrpcMethod('SpeechService', 'Transcribe')
  async transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
    const result = await this.stt.transcribe(Buffer.from(request.wavAudio), request.medium);
    return { success: result.success, text: result.text, error: result.error };
  }

  @GrpcMethod('SpeechService', 'Synthesize')
  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResponse> {
    const result = await this.tts.synthesize(request.text, request.medium);
    return { success: result.success, pcm16_16k_mono: result.pcm16_16k_mono, error: result.error };
  }
}
```

- [ ] **Step 2: Write the module, index, and wire into `main.ts`/`app.module.ts`**

Same pattern as Tasks 16/22/28: `SpeechServiceModule` exports `SpeechController` + `SttService` + `TtsService`; add a fourth `app.connectMicroservice` block with `package: 'speech'`, `SPEECH_GRPC_URL`; add `SpeechServiceModule` to `app.module.ts` imports.

- [ ] **Step 3: Write an e2e test**

`apps/api/test/speech-service.e2e-spec.ts` — mirror Task 16's structure on a distinct test port (`127.0.0.1:50064`), asserting that `Transcribe` with `medium: 'sinhala'` returns `success: false, error: 'sinhala_not_supported_on_voice'` over real gRPC (no live Google call needed for this specific assertion, since the Sinhala short-circuit happens before any API call).

- [ ] **Step 4: Run and verify it passes**

```bash
npm run proto:gen
npx jest apps/api/test/speech-service.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/speech-service apps/api
git commit -m "feat: wire Speech Service as in-process gRPC microservice"
```

---

### Task 42: Extend `auth.proto` with `VerifyDeviceKey` + implement device-key verification

**Files:**
- Modify: `libs/proto/src/auth.proto`, `libs/auth-service/src/auth.service.ts`, `libs/auth-service/src/auth.service.spec.ts`, `libs/auth-service/src/auth.controller.ts`
- Create: `libs/auth-service/src/device-key.service.ts`, `libs/auth-service/src/device-key.service.spec.ts`

**Interfaces:**
- Consumes: `devices` table (already created in Task 10), `bcrypt`.
- Produces: `DeviceKeyService.hashKey(plaintext): Promise<string>`, `.verifyKey(plaintext): Promise<{deviceId, ownerStudentId} | null>`; extends `auth.AuthService` with `VerifyDeviceKey` RPC — Task 43's `DeviceAuthGuard` and Task 44's admin provisioning endpoint both depend on this.

- [ ] **Step 1: Extend the proto**

Add to `libs/proto/src/auth.proto`:
```protobuf
service AuthService {
  rpc VerifyToken (VerifyTokenRequest) returns (VerifyTokenResponse);
  rpc VerifyDeviceKey (VerifyDeviceKeyRequest) returns (VerifyDeviceKeyResponse);
}

message VerifyDeviceKeyRequest {
  string key = 1;
}

message VerifyDeviceKeyResponse {
  bool valid = 1;
  string device_id = 2;
  string owner_student_id = 3;
  string error = 4;
}
```
```bash
npm run proto:gen
```

- [ ] **Step 2: Install bcrypt**

```bash
npm i bcrypt
npm i -D @types/bcrypt
```

- [ ] **Step 3: Write the failing test**

`libs/auth-service/src/device-key.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '@app/database';
import { DeviceKeyService } from './device-key.service';

describe('DeviceKeyService (integration, real dev DB)', () => {
  let db: DatabaseService;
  let service: DeviceKeyService;
  let deviceId: string;
  let plaintextKey: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, DeviceKeyService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    service = moduleRef.get(DeviceKeyService);

    plaintextKey = `test-key-${randomUUID()}`;
    const hash = await service.hashKey(plaintextKey);
    const rows = await db.query<{ id: string }>(
      `insert into devices (api_key_hash, label) values ($1, 'test device') returning id`,
      [hash],
    );
    deviceId = rows[0].id;
  });

  afterAll(async () => {
    await db.query('delete from devices where id = $1', [deviceId]);
  });

  it('resolves a valid key to its device id', async () => {
    const result = await service.verifyKey(plaintextKey);
    expect(result).toEqual({ deviceId, ownerStudentId: null });
  });

  it('rejects an unknown key', async () => {
    const result = await service.verifyKey('not-a-real-key');
    expect(result).toBeNull();
  });

  it('rejects a revoked key', async () => {
    await db.query('update devices set revoked_at = now() where id = $1', [deviceId]);
    const result = await service.verifyKey(plaintextKey);
    expect(result).toBeNull();
    await db.query('update devices set revoked_at = null where id = $1', [deviceId]); // restore for other tests
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
npx jest libs/auth-service/src/device-key.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

`libs/auth-service/src/device-key.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '@app/database';

const SALT_ROUNDS = 12;

export interface DeviceKeyMatch {
  deviceId: string;
  ownerStudentId: string | null;
}

interface DeviceRow {
  id: string;
  api_key_hash: string;
  owner_student_id: string | null;
}

@Injectable()
export class DeviceKeyService {
  constructor(private readonly db: DatabaseService) {}

  async hashKey(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, SALT_ROUNDS);
  }

  async verifyKey(plaintext: string): Promise<DeviceKeyMatch | null> {
    // bcrypt hashes can't be looked up by equality, so this checks every
    // non-revoked device's hash. Fine at this corpus's scale (<20 devices,
    // SPEC-SHEET.md §8); revisit with a fast lookup prefix if the device
    // fleet ever grows into the hundreds.
    const devices = await this.db.query<DeviceRow>(
      `select id, api_key_hash, owner_student_id from devices where revoked_at is null`,
    );

    for (const device of devices) {
      if (await bcrypt.compare(plaintext, device.api_key_hash)) {
        await this.db.query('update devices set last_seen_at = now() where id = $1', [device.id]);
        return { deviceId: device.id, ownerStudentId: device.owner_student_id };
      }
    }
    return null;
  }
}
```

- [ ] **Step 6: Run and verify it passes**

```bash
npx jest libs/auth-service/src/device-key.service.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 7: Wire into `AuthService`/`AuthController`**

Add to `libs/auth-service/src/auth.service.ts`: inject `DeviceKeyService`, add method:
```typescript
async resolveDevicePrincipal(key: string): Promise<{ deviceId: string; ownerStudentId: string | null } | null> {
  return this.deviceKeyService.verifyKey(key);
}
```
Add to `libs/auth-service/src/auth.service.spec.ts`: 2 new tests mirroring the existing `resolvePrincipal` tests' structure, mocking `DeviceKeyService`.

Add to `libs/auth-service/src/auth.controller.ts`:
```typescript
@GrpcMethod('AuthService', 'VerifyDeviceKey')
async verifyDeviceKey(request: VerifyDeviceKeyRequest): Promise<VerifyDeviceKeyResponse> {
  const match = await this.authService.resolveDevicePrincipal(request.key);
  if (!match) {
    return { valid: false, deviceId: '', ownerStudentId: '', error: 'invalid_or_revoked_key' };
  }
  return { valid: true, deviceId: match.deviceId, ownerStudentId: match.ownerStudentId ?? '', error: '' };
}
```
Add `DeviceKeyService` to `AuthServiceModule`'s providers (Task 16).

- [ ] **Step 8: Run the full Auth Service test suite and commit**

```bash
npx jest libs/auth-service
git add libs/proto libs/auth-service
git commit -m "feat: add device-key verification (VerifyDeviceKey RPC)"
```

---

### Task 43: `DeviceAuthGuard`

**Files:**
- Create: `libs/gateway/src/guards/device-auth.guard.ts`, `libs/gateway/src/guards/device-auth.guard.spec.ts`

**Interfaces:**
- Consumes: `auth.AuthService/VerifyDeviceKey` (Task 42) via the same `AUTH_GRPC_CLIENT` provider `AuthGuard` uses (Task 17) — the client now needs a `verifyDeviceKey` method too, which `proto:gen` already generated onto `AuthServiceClient` in Task 42.
- Produces: `DeviceAuthGuard` (reads `X-Device-Key` header, attaches `request.device: {deviceId, ownerStudentId}`) — Task 46's `/voice/ask` controller applies this instead of `AuthGuard`.

- [ ] **Step 1: Write the failing test**

`libs/gateway/src/guards/device-auth.guard.spec.ts` — mirror `auth.guard.spec.ts` (Task 17) exactly, but asserting on the `x-device-key` header and `request.device` instead of `authorization`/`request.principal`. Four tests: missing header throws, invalid key throws, valid key attaches `request.device` and returns true, gRPC transport error throws `UnauthorizedException` not a 500.

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/gateway/src/guards/device-auth.guard.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/gateway/src/guards/device-auth.guard.ts`:
```typescript
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AUTH_GRPC_CLIENT } from '../grpc-clients/auth-client.provider';
import { AuthServiceClient } from '@app/proto/generated/auth';

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(@Inject(AUTH_GRPC_CLIENT) private readonly authClient: AuthServiceClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const key: string | undefined = request.headers['x-device-key'];

    if (!key) {
      throw new UnauthorizedException('missing_device_key');
    }

    let response;
    try {
      response = await firstValueFrom(this.authClient.verifyDeviceKey({ key }));
    } catch {
      throw new UnauthorizedException('auth_service_unreachable');
    }

    if (!response.valid) {
      throw new UnauthorizedException(response.error || 'invalid_device_key');
    }

    request.device = { deviceId: response.deviceId, ownerStudentId: response.ownerStudentId || null };
    return true;
  }
}
```

Update `libs/gateway/src/index.ts` to export `DeviceAuthGuard`.

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/gateway/src/guards/device-auth.guard.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add libs/gateway
git commit -m "feat: add DeviceAuthGuard (X-Device-Key)"
```

---

### Task 44: Admin device-provisioning endpoint

**Files:**
- Create: `libs/gateway/src/admin/devices.controller.ts`, `libs/gateway/src/admin/guards/admin.guard.ts`, `libs/gateway/src/admin/guards/admin.guard.spec.ts`, `apps/api/test/admin-devices.e2e-spec.ts`
- Modify: `libs/gateway/src/gateway.module.ts`

**Interfaces:**
- Consumes: `request.principal.role` (set by `AuthGuard`, Task 17), `DeviceKeyService.hashKey` (Task 42).
- Produces: `AdminGuard` (role==='admin' check, composed after `AuthGuard`) and `POST /admin/devices` → `{device_id, api_key}` (plaintext key returned exactly once) — this is how a real ESP32 gets provisioned before Task 48's firmware update can use it.

- [ ] **Step 1: Write the failing `AdminGuard` test**

`libs/gateway/src/admin/guards/admin.guard.spec.ts`:
```typescript
import { ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function mockContext(principal: any) {
  return { switchToHttp: () => ({ getRequest: () => ({ principal }) }) } as any;
}

describe('AdminGuard', () => {
  it('allows a principal with role=admin', () => {
    const guard = new AdminGuard();
    expect(guard.canActivate(mockContext({ role: 'admin' }))).toBe(true);
  });

  it('rejects a principal with role=student', () => {
    const guard = new AdminGuard();
    expect(() => guard.canActivate(mockContext({ role: 'student' }))).toThrow(ForbiddenException);
  });

  it('rejects when no principal is present (AuthGuard did not run first)', () => {
    const guard = new AdminGuard();
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run it, see it fail, implement**

```bash
npx jest libs/gateway/src/admin/guards/admin.guard.spec.ts
```
Expected: FAIL — module not found.

`libs/gateway/src/admin/guards/admin.guard.ts`:
```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (request.principal?.role !== 'admin') {
      throw new ForbiddenException('admin_role_required');
    }
    return true;
  }
}
```

```bash
npx jest libs/gateway/src/admin/guards/admin.guard.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 3: Write the controller**

`libs/gateway/src/admin/devices.controller.ts`:
```typescript
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { randomBytes } from 'crypto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { DatabaseService } from '@app/database';
import { DeviceKeyService } from '@app/auth-service';

class CreateDeviceDto {
  @IsOptional() @IsString()
  label?: string;

  @IsOptional() @IsUUID()
  owner_student_id?: string;
}

@Controller('admin/devices')
@UseGuards(AuthGuard, AdminGuard)
export class AdminDevicesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly deviceKeys: DeviceKeyService,
  ) {}

  @Post()
  async create(@Body() body: CreateDeviceDto) {
    const plaintextKey = randomBytes(24).toString('hex');
    const hash = await this.deviceKeys.hashKey(plaintextKey);

    const rows = await this.db.query<{ id: string }>(
      `insert into devices (api_key_hash, label, owner_student_id) values ($1, $2, $3) returning id`,
      [hash, body.label ?? null, body.owner_student_id ?? null],
    );

    return { device_id: rows[0].id, api_key: plaintextKey };
  }
}
```
Export `DeviceKeyService` from `@app/auth-service`'s `index.ts` (it's currently internal-only to that lib). Add `AdminDevicesController` to `GatewayModule`.

- [ ] **Step 4: Write an e2e test**

`apps/api/test/admin-devices.e2e-spec.ts` — mirror Task 31's e2e test structure: a non-admin JWT gets `403`, an admin JWT (manually promote a test student's `role` to `'admin'` via SQL for this test) gets `201` with `device_id` and a 48-char hex `api_key` in the body.

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest apps/api/test/admin-devices.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add libs/gateway libs/auth-service apps/api
git commit -m "feat: add admin device-provisioning endpoint"
```

---

### Task 45: Extend session repository for device-keyed rolling history

**Files:**
- Modify: `libs/gateway/src/ask/ask.service.ts`, `libs/gateway/src/ask/ask.service.spec.ts`

**Interfaces:**
- Consumes: `ChatSessionsRepository.getOrCreateForDevice` (already implemented in Task 30, unused until now).
- Produces: `GatewayAskService.ask` accepts a `sessionId` regardless of whether it came from a student or device session — no interface change needed here, since Task 30 already made `sessionId` a plain string parameter. This task is really just the **test** proving the device path works, since the production code path is already generic.

- [ ] **Step 1: Write the failing test**

Add to `libs/gateway/src/ask/ask.service.spec.ts`:
```typescript
it('persists to whatever sessionId is passed, regardless of whether it came from a student or device session', async () => {
  search.mockReturnValue(of({ chunks: [] }));
  ask.mockReturnValue(of({ answer: 'hi', sources: [], grounded: true }));
  const appendMessage = jest.fn();
  // re-create the module with a spy on ChatSessionsRepository for this one test,
  // or reuse the existing mocked provider from Task 30's Step 5 update and assert
  // appendMessage was called with the device-originated sessionId string passed in.

  await service.ask({ questionText: 'hi', medium: 'english', history: [], sessionId: 'device-session-abc' });

  expect(appendMessage).toHaveBeenCalledWith('device-session-abc', 'user', 'hi');
});
```
(Wire this into the existing `beforeAll`'s `ChatSessionsRepository` mock provider from Task 30 Step 5, rather than duplicating the whole test module setup.)

- [ ] **Step 2: Run it**

```bash
npx jest libs/gateway/src/ask/ask.service.spec.ts
```
Expected: PASS immediately (no implementation change needed — this confirms Task 30's generic `sessionId` design already supports both paths, closing the loop on SPEC-SHEET.md §5's "keyed by `device_id`, not `student_id`" requirement).

- [ ] **Step 3: Commit**

```bash
git add libs/gateway
git commit -m "test: confirm AskService session persistence is transport-agnostic (student or device)"
```

---

### Task 46: `POST /voice/ask` controller

**Files:**
- Create: `libs/gateway/src/voice/voice.controller.ts`, `libs/gateway/src/voice/multipart-wav.interceptor.ts`, `apps/api/test/voice-ask.e2e-spec.ts`
- Modify: `libs/gateway/src/gateway.module.ts`

**Interfaces:**
- Consumes: `DeviceAuthGuard` (Task 43), `speech.SpeechService/{Transcribe,Synthesize}` (Task 41), `GatewayAskService.ask` (Tasks 29-30/45), `ChatSessionsRepository.getOrCreateForDevice` (Task 30).
- Produces: `POST /voice/ask?stream=&subject=&medium=&student_id=` matching `iot-robot-README.md` §5 exactly — multipart WAV in, raw headerless PCM out, `Content-Type: application/octet-stream`.

- [ ] **Step 1: Install multipart handling**

```bash
npm i @nestjs/platform-express multer
npm i -D @types/multer
```

- [ ] **Step 2: Write the controller**

`libs/gateway/src/voice/voice.controller.ts`:
```typescript
import { Controller, Inject, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import { DeviceAuthGuard } from '../guards/device-auth.guard';
import { GatewayAskService } from '../ask/ask.service';
import { ChatSessionsRepository } from '@app/database';
import { SPEECH_GRPC_CLIENT } from '../grpc-clients/speech-client.provider';
import { SpeechServiceClient } from '@app/proto/generated/speech';
import { Logger } from '@nestjs/common';

@Controller('voice')
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private readonly askService: GatewayAskService,
    private readonly chatSessions: ChatSessionsRepository,
    @Inject(SPEECH_GRPC_CLIENT) private readonly speechClient: SpeechServiceClient,
  ) {}

  @Post('ask')
  @UseGuards(DeviceAuthGuard)
  @UseInterceptors(FileInterceptor('audio'))
  async ask(
    @UploadedFile() audio: Express.Multer.File,
    @Query('subject') subject: string | undefined,
    @Query('medium') medium: string,
    @Res() res: Response,
    req: any,
  ) {
    const stageTimings: Record<string, number> = {};
    const start = Date.now();

    const transcribeResult = await firstValueFrom(
      this.speechClient.transcribe({ wavAudio: audio.buffer, medium }),
    );
    stageTimings.stt = Date.now() - start;

    if (!transcribeResult.success) {
      this.logger.warn(`Transcribe failed: ${transcribeResult.error}`);
      return res.status(422).json({ error: transcribeResult.error });
    }

    const sessionId = await this.chatSessions.getOrCreateForDevice(req.device.deviceId);
    const history = await this.chatSessions.getRecentHistory(sessionId, 6);

    const askStart = Date.now();
    const askResult = await this.askService.ask({
      questionText: transcribeResult.text,
      subject,
      medium,
      history,
      sessionId,
    });
    stageTimings.ask = Date.now() - askStart;

    const ttsStart = Date.now();
    const synthResult = await firstValueFrom(
      this.speechClient.synthesize({ text: askResult.answer, medium }),
    );
    stageTimings.tts = Date.now() - ttsStart;

    const totalMs = Date.now() - start;
    this.logger.log(`voice/ask stage timings: ${JSON.stringify(stageTimings)}, total=${totalMs}ms`);
    if (totalMs > 25_000) {
      this.logger.error(`voice/ask exceeded the 25s hard ceiling: ${totalMs}ms`);
    }

    if (!synthResult.success) {
      return res.status(422).json({ error: synthResult.error });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(synthResult.pcm16_16k_mono));
  }
}
```

Note: `medium` is read from the query string per the existing firmware contract (`iot-robot-README.md` §5.1: `?stream=&subject=&medium=&student_id=`) — it is **not** validated against the student's stored profile here, matching the existing behavior where the ESP32 sends whatever's hardcoded in its firmware. `student_id` from the query string is intentionally unused now that `DeviceAuthGuard` resolves the real identity server-side (§12.2's stated goal: "replacing the current fixed placeholder `STUDENT_ID` with a real per-device identity resolved server-side from the key").

Write `libs/gateway/src/grpc-clients/speech-client.provider.ts` following Task 17's `auth-client.provider.ts` pattern (package `'speech'`, `SPEECH_GRPC_URL`, token `SPEECH_GRPC_CLIENT`).

- [ ] **Step 3: Wire into `GatewayModule`**

Add `VoiceController` and the new `speech-client.provider` to `libs/gateway/src/gateway.module.ts`.

- [ ] **Step 4: Write the e2e test**

`apps/api/test/voice-ask.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';

describe('POST /voice/ask (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects requests with no X-Device-Key header', async () => {
    await request(app.getHttpServer())
      .post('/voice/ask?medium=english')
      .attach('audio', Buffer.from('fake'), 'mic.wav')
      .expect(401);
  });

  it('returns raw PCM for a valid device key and a real WAV fixture', async () => {
    // Requires: a device provisioned via Task 44's endpoint, key exported as TEST_DEVICE_KEY;
    // a short real WAV fixture at apps/api/test/fixtures/sample-question.wav (record yourself
    // saying "what is the law of demand" at 16kHz mono 16-bit).
    const wavPath = join(__dirname, 'fixtures/sample-question.wav');
    const res = await request(app.getHttpServer())
      .post('/voice/ask?subject=Economics&medium=english')
      .set('X-Device-Key', process.env.TEST_DEVICE_KEY!)
      .attach('audio', readFileSync(wavPath), 'mic.wav')
      .expect(200);

    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.body.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Run and verify it passes**

Record a short WAV fixture (any phone voice-memo app, converted to 16kHz/16-bit/mono via `ffmpeg -i input.m4a -ar 16000 -ac 1 -sample_fmt s16 apps/api/test/fixtures/sample-question.wav`), provision a test device via Task 44's endpoint, export `TEST_DEVICE_KEY`, then:
```bash
npx jest apps/api/test/voice-ask.e2e-spec.ts --runInBand
```
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add libs/gateway apps/api
git commit -m "feat: add POST /voice/ask controller (device-authed voice pipeline)"
```

---

### Task 47: Sinhala-over-voice rejection path

**Files:**
- Modify: `libs/gateway/src/voice/voice.controller.ts`

**Interfaces:**
- Consumes: `SttService`'s existing `sinhala_not_supported_on_voice` error (Task 39).
- Produces: instead of a bare `422` for the Sinhala case specifically, the robot gets back a *synthesized* decline message (English, since Tamil TTS for a Sinhala-request edge case is arbitrary — English is the safer universal default here) so the user hears something instead of silence/error tone.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/voice-ask.e2e-spec.ts`:
```typescript
it('returns a synthesized "not supported" message (not a bare error) for medium=sinhala', async () => {
  const wavPath = join(__dirname, 'fixtures/sample-question.wav');
  const res = await request(app.getHttpServer())
    .post('/voice/ask?medium=sinhala')
    .set('X-Device-Key', process.env.TEST_DEVICE_KEY!)
    .attach('audio', readFileSync(wavPath), 'mic.wav')
    .expect(200); // 200, not 422 — the robot still gets playable audio back

  expect(res.headers['content-type']).toBe('application/octet-stream');
  expect(res.body.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest apps/api/test/voice-ask.e2e-spec.ts -t "sinhala"
```
Expected: FAIL — current controller returns `422` for any `!transcribeResult.success`, including the Sinhala short-circuit.

- [ ] **Step 3: Implement**

In `libs/gateway/src/voice/voice.controller.ts`, replace the `if (!transcribeResult.success)` branch:
```typescript
if (!transcribeResult.success) {
  if (transcribeResult.error === 'sinhala_not_supported_on_voice') {
    const declineText = "Sorry, voice isn't available in Sinhala yet. Please use the app for Sinhala questions.";
    const synth = await firstValueFrom(this.speechClient.synthesize({ text: declineText, medium: 'english' }));
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.send(Buffer.from(synth.pcm16_16k_mono));
  }
  this.logger.warn(`Transcribe failed: ${transcribeResult.error}`);
  return res.status(422).json({ error: transcribeResult.error });
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest apps/api/test/voice-ask.e2e-spec.ts
```
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add libs/gateway
git commit -m "feat: synthesize a spoken decline for Sinhala-over-voice instead of a bare error"
```

---

### Task 48: Firmware — add `X-Device-Key` header

**Files:**
- Modify: `obscura_nesh_fixed.ino` in `C:\Users\Dell\OneDrive\Documents\Arduino\obscura_nesh_fixed` (**separate repo/directory from `obscura-backend-v2`**)

**Interfaces:**
- Consumes: a real device key from Task 44's admin endpoint.
- Produces: every `/voice/ask` request now carries `X-Device-Key: <key>`, closing the "no authentication header" gap `iot-robot-README.md` §5.2 flags.

- [ ] **Step 1: Add the device key to the USER CONFIG block**

In `obscura_nesh_fixed.ino`, after line 33 (`const char* STUDENT_ID = ...`), add:
```cpp
const char* DEVICE_KEY   = "PASTE-THE-KEY-FROM-POST-/admin/devices-HERE";
```
`STUDENT_ID` can stay as-is for now (still sent as an unused query param per Task 46's note — removing it entirely is a firmware-contract change beyond this task's scope) or be deleted; leaving it is lower-risk.

- [ ] **Step 2: Send the header in `sendAudioAndPlayResponse()`**

At line ~522-528, change:
```cpp
secureClient.print(
  String("POST ") + path + " HTTP/1.1\r\n"
  "Host: " + host + "\r\n"
  "Content-Type: multipart/form-data; boundary=" + boundary + "\r\n"
  "Content-Length: " + String(contentLengthOut) + "\r\n"
  "Connection: close\r\n\r\n"
);
```
to:
```cpp
secureClient.print(
  String("POST ") + path + " HTTP/1.1\r\n"
  "Host: " + host + "\r\n"
  "X-Device-Key: " + String(DEVICE_KEY) + "\r\n"
  "Content-Type: multipart/form-data; boundary=" + boundary + "\r\n"
  "Content-Length: " + String(contentLengthOut) + "\r\n"
  "Connection: close\r\n\r\n"
);
```

- [ ] **Step 3: Update `SERVER_URL` to point at the Koyeb deployment**

Line 32: change to your Task 36 Koyeb URL's `/voice/ask` path:
```cpp
const char* SERVER_URL    = "https://<your-app>.koyeb.app/voice/ask";
```

- [ ] **Step 4: Verify by compiling**

In Arduino IDE (or `arduino-cli compile --fqbn esp32:esp32:esp32s3 obscura_nesh_fixed.ino`): expect a clean compile with no new errors. Full hardware verification happens in Task 49.

- [ ] **Step 5: Commit (in the firmware repo, if it's under git — if not, this step is just "save the file")**

```bash
cd "C:\Users\Dell\OneDrive\Documents\Arduino\obscura_nesh_fixed"
git init 2>/dev/null # only if not already a repo
git add obscura_nesh_fixed.ino
git commit -m "feat: add X-Device-Key header, point at obscura-backend-v2 Koyeb deployment"
```

---

### Task 49: Manual end-to-end voice verification

**Files:** none — verification only.

- [ ] **Step 1: Provision a real device**

```bash
curl -s -X POST https://<your-app>.koyeb.app/admin/devices \
  -H "Authorization: Bearer $TEST_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"label":"test-esp32-01"}'
```
Copy the returned `api_key` into the firmware's `DEVICE_KEY` constant (Task 48 Step 1) and reflash, **or** skip hardware entirely and simulate with curl:
```bash
curl -s -X POST "https://<your-app>.koyeb.app/voice/ask?subject=Economics&medium=english" \
  -H "X-Device-Key: <the-api_key-from-above>" \
  -F "audio=@apps/api/test/fixtures/sample-question.wav;type=audio/wav" \
  --output response.pcm
```

- [ ] **Step 2: Verify the response is playable audio**

```bash
ffplay -f s16le -ar 16000 -ac 1 response.pcm
```
Expected: audible speech, answering the question from `sample-question.wav`, matching whatever RAG-grounded answer Phase 1's corpus would produce for that question via `/chat/ask`.

- [ ] **Step 3: If using real hardware, verify the full physical loop**

Press the button, ask a question out loud, expect: `FACE_LISTENING` → `FACE_THINKING` → spoken response through the speaker → `FACE_IDLE`. Check Serial Monitor for the `[HTTP]` logs confirming a `200` response.

- [ ] **Step 4: Verify latency**

Check the Koyeb service logs for the `voice/ask stage timings` log line from Task 46:
```bash
koyeb service logs obscura-api --since 5m | grep "stage timings"
```
Expected: `total` consistently under 10000ms (p95 target), always under 25000ms (hard ceiling per SPEC-SHEET.md §5).

No commit — verification only.

---

### Task 50: Deploy Phase 2 to Koyeb

**Files:** none.

- [ ] **Step 1: Add the new secret and redeploy**

```bash
koyeb secret create GOOGLE_APPLICATION_CREDENTIALS_JSON --value "$(cat secrets/gcp-speech-service-account.json)"
```
Since Koyeb env vars are strings, not files, adjust `libs/speech-service`'s client construction to accept inline JSON credentials instead of a file path in production:
```typescript
// in stt.service.ts and tts.service.ts constructors, replace the bare `new SpeechClient()`/`new TextToSpeechClient()`:
const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const client = credsJson
  ? new SpeechClient({ credentials: JSON.parse(credsJson) })
  : new SpeechClient(); // falls back to GOOGLE_APPLICATION_CREDENTIALS file path locally
```
Apply the same pattern to `TtsService`. Re-run Tasks 39/40's tests to confirm this change doesn't break the existing mocks (it shouldn't — the constructor logic isn't mocked, only the client methods are).

```bash
koyeb service update obscura-api --env GOOGLE_APPLICATION_CREDENTIALS_JSON=@GOOGLE_APPLICATION_CREDENTIALS_JSON
git add libs/speech-service
git commit -m "feat: support inline JSON GCP credentials for Koyeb deployment"
git push origin master
```

- [ ] **Step 2: Wait for redeploy and smoke-test**

```bash
koyeb service get obscura-api
```
Wait for `HEALTHY`, then repeat Task 49's curl-based verification against the production URL.

**Phase 2 complete.** `POST /voice/ask` works end-to-end with real per-device auth, English/Tamil STT/TTS, and the same grounded-answer pipeline as `/chat/ask`, within the latency budget.

---

## Phase 3 — Ingestion Service, Admin Tooling

Delivers `POST /papers/upload` → BullMQ → Gemini structural extraction → embedding → `paper_chunks`, replacing Task 23's dev seed script with the real pipeline SPEC-SHEET.md §11 describes, plus the admin tooling needed to actually operate it (promote an admin, check ingestion status, list papers).

### Task 51: BullMQ queue module

**Files:**
- Create: `libs/ingestion-service/src/queue/ingestion-queue.module.ts`, `libs/ingestion-service/src/queue/ingestion-queue.service.ts`, `libs/ingestion-service/src/queue/ingestion-queue.service.spec.ts`, `libs/ingestion-service/src/queue/ingestion-job.types.ts`

**Interfaces:**
- Consumes: `REDIS_URL` env var (Task 2/7).
- Produces: `IngestionQueueService.enqueue(job: IngestionJobPayload): Promise<void>` where `IngestionJobPayload = {paperId: string}` — Task 55's `/papers/upload` controller calls this; Task 56's worker consumes what it produces.

- [ ] **Step 1: Install deps**

```bash
npm i bullmq ioredis
```

- [ ] **Step 2: Write the job payload type**

`libs/ingestion-service/src/queue/ingestion-job.types.ts`:
```typescript
export const INGESTION_QUEUE_NAME = 'paper-ingestion';

export interface IngestionJobPayload {
  paperId: string;
}
```

- [ ] **Step 3: Write the failing test**

`libs/ingestion-service/src/queue/ingestion-queue.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { IngestionQueueService } from './ingestion-queue.service';
import { INGESTION_QUEUE_NAME } from './ingestion-job.types';

describe('IngestionQueueService (integration, real Redis)', () => {
  let service: IngestionQueueService;
  let inspectQueue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [IngestionQueueService],
    }).compile();
    service = moduleRef.get(IngestionQueueService);
    inspectQueue = new Queue(INGESTION_QUEUE_NAME, { connection: { url: process.env.REDIS_URL } as any });
  });

  afterAll(async () => {
    await inspectQueue.obliterate({ force: true });
    await inspectQueue.close();
    await service.onModuleDestroy();
  });

  it('enqueues a job that becomes visible in the queue', async () => {
    await service.enqueue({ paperId: 'paper-123' });
    const waiting = await inspectQueue.getWaiting();
    expect(waiting.some((j) => j.data.paperId === 'paper-123')).toBe(true);
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
npx jest libs/ingestion-service/src/queue/ingestion-queue.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

`libs/ingestion-service/src/queue/ingestion-queue.service.ts`:
```typescript
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { EnvConfig } from '@app/common';
import { IngestionJobPayload, INGESTION_QUEUE_NAME } from './ingestion-job.types';

@Injectable()
export class IngestionQueueService implements OnModuleDestroy {
  private readonly queue: Queue<IngestionJobPayload>;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.queue = new Queue(INGESTION_QUEUE_NAME, {
      connection: { url: config.get('REDIS_URL', { infer: true }) } as any,
    });
  }

  async enqueue(payload: IngestionJobPayload): Promise<void> {
    await this.queue.add('ingest', payload, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
```

`libs/ingestion-service/src/queue/ingestion-queue.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { IngestionQueueService } from './ingestion-queue.service';

@Module({
  providers: [IngestionQueueService],
  exports: [IngestionQueueService],
})
export class IngestionQueueModule {}
```

- [ ] **Step 6: Run and verify it passes**

```bash
npx jest libs/ingestion-service/src/queue/ingestion-queue.service.spec.ts
```
Expected: PASS, 1 test, against your real Redis (local docker-compose or Upstash — whichever `REDIS_URL` points to).

- [ ] **Step 7: Commit**

```bash
git add libs/ingestion-service package.json package-lock.json
git commit -m "feat: add BullMQ ingestion queue module"
```

---

### Task 52: Supabase Storage bucket + upload helper

**Files:**
- Create: `libs/database/src/storage.service.ts`, `libs/database/src/storage.service.spec.ts`
- Modify: `libs/database/src/database.module.ts`, `libs/database/src/index.ts`

**Interfaces:**
- Consumes: `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS — Storage access is admin-only anyway per §11/§12.3).
- Produces: `StorageService.uploadPdf(path: string, buffer: Buffer): Promise<void>`, `.downloadPdf(path: string): Promise<Buffer>` — Task 55 (`/papers/upload`) calls `uploadPdf`; Task 56 (ingestion worker) calls `downloadPdf`.

- [ ] **Step 1: Create the private bucket**

Manual (browser, Supabase dashboard for the dev project from Task 3): **Storage → New bucket** → name `papers`, **Public: off**.

Or via SQL editor:
```sql
insert into storage.buckets (id, name, public) values ('papers', 'papers', false)
on conflict (id) do nothing;
```

- [ ] **Step 2: Install the SDK**

```bash
npm i @supabase/supabase-js
```

- [ ] **Step 3: Write the failing test**

`libs/database/src/storage.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';

describe('StorageService (integration, real Supabase Storage)', () => {
  let service: StorageService;
  const testPath = `test/${Date.now()}.pdf`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await service.deletePdf(testPath);
  });

  it('round-trips a PDF buffer through upload and download', async () => {
    const original = Buffer.from('%PDF-1.4 fake pdf content for testing');
    await service.uploadPdf(testPath, original);
    const downloaded = await service.downloadPdf(testPath);
    expect(downloaded.equals(original)).toBe(true);
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
npx jest libs/database/src/storage.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

`libs/database/src/storage.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EnvConfig } from '@app/common';

const BUCKET = 'papers';

@Injectable()
export class StorageService {
  private readonly client: SupabaseClient;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = createClient(
      config.get('SUPABASE_URL', { infer: true }),
      config.get('SUPABASE_SERVICE_ROLE_KEY', { infer: true }),
    );
  }

  async uploadPdf(path: string, buffer: Buffer): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).upload(path, buffer, {
      contentType: 'application/pdf',
      upsert: false,
    });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async downloadPdf(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(BUCKET).download(path);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async deletePdf(path: string): Promise<void> {
    await this.client.storage.from(BUCKET).remove([path]);
  }
}
```

Update `libs/database/src/database.module.ts`/`index.ts` to provide/export `StorageService` (same pattern as Task 12).

- [ ] **Step 6: Run and verify it passes**

```bash
npx jest libs/database/src/storage.service.spec.ts
```
Expected: PASS, 1 test.

- [ ] **Step 7: Commit**

```bash
git add libs/database package.json package-lock.json
git commit -m "feat: add Supabase Storage upload/download helper for PDFs"
```

---

### Task 53: Admin bootstrap script

**Files:**
- Create: `scripts/promote-admin.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DatabaseService.query` (Task 11).
- Produces: `npm run promote-admin -- --email you@example.com` — the only way to create the first admin, since there's no self-serve UI for it (out of scope per SPEC-SHEET.md's non-goals) and `students.role` defaults to `'student'`.

- [ ] **Step 1: Write the script**

`scripts/promote-admin.ts`:
```typescript
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';
import { DatabaseModule, DatabaseService } from '@app/database';

@Module({ imports: [AppConfigModule, DatabaseModule] })
class PromoteAdminModule {}

async function main() {
  const emailArg = process.argv.find((a) => a.startsWith('--email='));
  if (!emailArg) {
    console.error('Usage: npm run promote-admin -- --email=you@example.com');
    process.exit(1);
  }
  const email = emailArg.split('=')[1];

  const app = await NestFactory.createApplicationContext(PromoteAdminModule);
  const db = app.get(DatabaseService);

  const rows = await db.query<{ id: string }>(
    `update students set role = 'admin' where email = $1 returning id`,
    [email],
  );

  if (rows.length === 0) {
    console.error(`No student found with email ${email}. Sign up in the app first, then re-run this.`);
    process.exit(1);
  }

  console.log(`Promoted ${email} (id ${rows[0].id}) to admin.`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add to `package.json` `"scripts"`:
```json
"promote-admin": "ts-node -r tsconfig-paths/register scripts/promote-admin.ts"
```

- [ ] **Step 2: Verify**

Sign up a test account through the mobile app (or Task 31's e2e test student), then:
```bash
npm run promote-admin -- --email=your-test-account@example.com
```
Expected: `Promoted ... to admin.` Then confirm:
```sql
select email, role from students where email = 'your-test-account@example.com';
```
Expected: `role = 'admin'`.

- [ ] **Step 3: Commit**

```bash
git add scripts package.json package-lock.json
git commit -m "chore: add admin bootstrap script (promote-admin)"
```

---

### Task 54: `AdminGuard` reuse note

Task 44 (Phase 2) already built `AdminGuard` (`libs/gateway/src/admin/guards/admin.guard.ts`) for the device-provisioning endpoint. Task 55 below reuses it directly — no new task needed. (This entry exists so the task numbering stays traceable to the original ~65-task estimate; skip straight to Task 55.)

---

### Task 55: `POST /papers/upload` controller

**Files:**
- Create: `libs/gateway/src/admin/papers-upload.controller.ts`, `libs/gateway/src/admin/dto/upload-paper.dto.ts`, `apps/api/test/papers-upload.e2e-spec.ts`
- Modify: `libs/gateway/src/gateway.module.ts`

**Interfaces:**
- Consumes: `AuthGuard` + `AdminGuard` (Tasks 17/44), `StorageService.uploadPdf` (Task 52), `IngestionQueueService.enqueue` (Task 51).
- Produces: `POST /papers/upload` matching SPEC-SHEET.md §11 step 1-2: multipart `file` + metadata fields in, `{paper_id, status: "processing"}` out, immediately (enqueue confirmation, not finished ingestion).

- [ ] **Step 1: Write the DTO**

`libs/gateway/src/admin/dto/upload-paper.dto.ts`:
```typescript
import { IsIn, IsOptional, IsString, IsNumberString } from 'class-validator';

export class UploadPaperDto {
  @IsString()
  subject: string;

  @IsOptional() @IsNumberString()
  year?: string;

  @IsOptional() @IsString()
  syllabus?: string;

  @IsOptional() @IsIn(['ol', 'al'])
  level?: string;

  @IsOptional() @IsString()
  medium?: string;
}
```

- [ ] **Step 2: Write the controller**

`libs/gateway/src/admin/papers-upload.controller.ts`:
```typescript
import { BadRequestException, Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { DatabaseService, StorageService } from '@app/database';
import { IngestionQueueService } from '@app/ingestion-service';
import { UploadPaperDto } from './dto/upload-paper.dto';

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25MB, per SPEC-SHEET.md §11/§16

@Controller('papers')
@UseGuards(AuthGuard, AdminGuard)
export class PapersUploadController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly queue: IngestionQueueService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: Express.Multer.File, @Body() body: UploadPaperDto, req: any) {
    if (!file || file.mimetype !== 'application/pdf') {
      throw new BadRequestException('file must be a PDF');
    }
    if (file.size > MAX_SIZE_BYTES) {
      throw new BadRequestException('file exceeds 25MB limit');
    }

    const paperId = randomUUID();
    const storagePath = `${paperId}.pdf`;

    await this.storage.uploadPdf(storagePath, file.buffer);

    await this.db.query(
      `insert into papers (id, subject, year, syllabus, level, medium, storage_path, status, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'processing', $8)`,
      [paperId, body.subject, body.year ? Number(body.year) : null, body.syllabus ?? null, body.level ?? null, body.medium ?? null, storagePath, req.principal.id],
    );

    await this.queue.enqueue({ paperId });

    return { paper_id: paperId, status: 'processing' };
  }
}
```

- [ ] **Step 3: Wire into `GatewayModule`**

Add `PapersUploadController` to `libs/gateway/src/gateway.module.ts`, importing `IngestionQueueModule` (Task 51) into `GatewayModule`'s (or `AppModule`'s) imports.

- [ ] **Step 4: Write the e2e test**

`apps/api/test/papers-upload.e2e-spec.ts` — mirror Task 44's admin e2e test structure: non-admin gets `403`; admin with a real tiny PDF fixture gets `201` with `{paper_id, status: "processing"}`; then verify the row exists in `papers` with `status = 'processing'` and a job is visible in the BullMQ queue (reuse Task 51's `inspectQueue.getWaiting()` pattern).

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest apps/api/test/papers-upload.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add libs/gateway apps/api
git commit -m "feat: add POST /papers/upload (admin-only, enqueues ingestion job)"
```

---

### Task 56: Ingestion worker skeleton

**Files:**
- Create: `libs/ingestion-service/src/ingestion.processor.ts`, `libs/ingestion-service/src/ingestion.processor.spec.ts`, `libs/ingestion-service/src/ingestion-service.module.ts`, `libs/ingestion-service/src/index.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `INGESTION_QUEUE_NAME` (Task 51), `StorageService.downloadPdf` (Task 52).
- Produces: a BullMQ `Worker` that picks up jobs and, for now, just updates `papers.status` — Task 57-60 fill in the real extraction/embedding/upsert logic between "job received" and "status updated," without changing this task's wiring.

- [ ] **Step 1: Write the failing test**

`libs/ingestion-service/src/ingestion.processor.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { DatabaseService } from '@app/database';
import { IngestionProcessor } from './ingestion.processor';
import { INGESTION_QUEUE_NAME } from './queue/ingestion-job.types';

describe('IngestionProcessor (integration, real Redis + DB)', () => {
  let db: DatabaseService;
  let processor: IngestionProcessor;
  let queue: Queue;
  const paperId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, IngestionProcessor],
    }).compile();
    db = moduleRef.get(DatabaseService);
    processor = moduleRef.get(IngestionProcessor);
    queue = new Queue(INGESTION_QUEUE_NAME, { connection: { url: process.env.REDIS_URL } as any });

    await db.query(
      `insert into papers (id, subject, storage_path, status) values ($1, 'Test Subject', 'test/does-not-matter.pdf', 'processing')`,
      [paperId],
    );
  });

  afterAll(async () => {
    await db.query('delete from papers where id = $1', [paperId]);
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('marks the paper failed if PDF extraction throws (proves the error path updates status, not just the happy path)', async () => {
    // processHatch: with a bogus storage_path, downloadPdf will throw — this test only
    // exercises the processor's error-handling wrapper, not real extraction (that's Task 57+).
    await processor.process({ id: 'job-1', data: { paperId } } as any);

    const rows = await db.query<{ status: string; error_reason: string | null }>(
      'select status, error_reason from papers where id = $1',
      [paperId],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_reason).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/ingestion-service/src/ingestion.processor.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the skeleton**

`libs/ingestion-service/src/ingestion.processor.ts`:
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DatabaseService, StorageService } from '@app/database';
import { IngestionJobPayload } from './queue/ingestion-job.types';

@Injectable()
export class IngestionProcessor {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  async process(job: Job<IngestionJobPayload>): Promise<void> {
    const { paperId } = job.data;
    try {
      const paper = await this.loadPaper(paperId);
      const pdfBuffer = await this.storage.downloadPdf(paper.storage_path);

      // Task 57 replaces this line with real Gemini structural extraction.
      throw new Error('extraction not yet implemented (Task 57)');
    } catch (err) {
      this.logger.error(`Ingestion failed for paper ${paperId}: ${(err as Error).message}`);
      await this.db.query(`update papers set status = 'failed', error_reason = $2 where id = $1`, [
        paperId,
        (err as Error).message,
      ]);
    }
  }

  private async loadPaper(paperId: string): Promise<{ storage_path: string }> {
    const rows = await this.db.query<{ storage_path: string }>(
      'select storage_path from papers where id = $1',
      [paperId],
    );
    if (!rows[0]) throw new Error(`paper ${paperId} not found`);
    return rows[0];
  }
}
```

- [ ] **Step 4: Wire a real BullMQ `Worker` around it**

`libs/ingestion-service/src/ingestion-service.module.ts`:
```typescript
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { EnvConfig } from '@app/common';
import { IngestionProcessor } from './ingestion.processor';
import { IngestionQueueModule } from './queue/ingestion-queue.module';
import { INGESTION_QUEUE_NAME } from './queue/ingestion-job.types';

@Module({
  imports: [IngestionQueueModule],
  providers: [IngestionProcessor],
  exports: [IngestionProcessor],
})
export class IngestionServiceModule implements OnModuleInit {
  private worker: Worker;

  constructor(private readonly processor: IngestionProcessor, private readonly config: ConfigService<EnvConfig, true>) {}

  onModuleInit(): void {
    this.worker = new Worker(
      INGESTION_QUEUE_NAME,
      (job) => this.processor.process(job),
      { connection: { url: this.config.get('REDIS_URL', { infer: true }) } as any },
    );
  }
}
```

`libs/ingestion-service/src/index.ts`:
```typescript
export * from './ingestion-service.module';
export * from './queue/ingestion-queue.module';
export * from './queue/ingestion-queue.service';
export * from './queue/ingestion-job.types';
```

Add `IngestionServiceModule` to `apps/api/src/app.module.ts`'s imports — per this plan's Global Constraints, this runs as a BullMQ worker within the same process, not a separate deployable.

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/ingestion-service/src/ingestion.processor.spec.ts
```
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add libs/ingestion-service apps/api
git commit -m "feat: add ingestion worker skeleton (BullMQ Worker + error-path status updates)"
```

---

### Task 57: PDF structural extraction via Gemini multimodal

**Files:**
- Create: `libs/ingestion-service/src/extraction/gemini-extractor.ts`, `libs/ingestion-service/src/extraction/gemini-extractor.spec.ts`, `libs/ingestion-service/test/fixtures/sample-paper.pdf`

**Interfaces:**
- Consumes: `@google/generative-ai` (already a dependency since Task 20), `GEMINI_API_KEY`.
- Produces: `GeminiExtractor.extractChunks(pdfBuffer: Buffer): Promise<ExtractedChunk[]>` where `ExtractedChunk = {content: string; questionNumber?: string; marks?: number; topic?: string; page?: number}` — Task 59 embeds and upserts whatever this returns; Task 58's fallback produces the same shape.

- [ ] **Step 1: Add a tiny real PDF fixture**

Create any 1-2 page PDF with a couple of exam-style questions (export from a text editor to PDF, or use an existing sample past paper) and save it at `libs/ingestion-service/test/fixtures/sample-paper.pdf`.

- [ ] **Step 2: Write the failing test**

`libs/ingestion-service/src/extraction/gemini-extractor.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GeminiExtractor } from './gemini-extractor';

describe('GeminiExtractor (integration, real Gemini call)', () => {
  let extractor: GeminiExtractor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [GeminiExtractor],
    }).compile();
    extractor = moduleRef.get(GeminiExtractor);
  });

  it('extracts at least one non-empty chunk from a real sample PDF', async () => {
    const pdf = readFileSync(join(__dirname, '../../test/fixtures/sample-paper.pdf'));
    const chunks = await extractor.extractChunks(pdf);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content.length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx jest libs/ingestion-service/src/extraction/gemini-extractor.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`libs/ingestion-service/src/extraction/gemini-extractor.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EnvConfig } from '@app/common';

export interface ExtractedChunk {
  content: string;
  questionNumber?: string;
  marks?: number;
  topic?: string;
  page?: number;
}

const EXTRACTION_PROMPT = `You are segmenting a past exam paper PDF into individually-addressable
chunks, one per question (or sub-question if long). For each chunk, extract:
- content: the full question text, verbatim, in its original language/script (English, Sinhala, or Tamil)
- question_number: e.g. "3(a)" if visible
- marks: the mark allocation if shown, as a number
- topic: a short topic label if inferable (e.g. "Demand and Supply")
- page: the 1-indexed page number the question appears on

Respond with ONLY a JSON array of objects with exactly these keys: content, question_number, marks, topic, page.
Do not cut any question mid-sentence. Do not merge multiple distinct questions into one chunk.`;

@Injectable()
export class GeminiExtractor {
  private readonly client: GoogleGenerativeAI;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenerativeAI(config.get('GEMINI_API_KEY', { infer: true }));
  }

  async extractChunks(pdfBuffer: Buffer): Promise<ExtractedChunk[]> {
    const model = this.client.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { text: EXTRACTION_PROMPT },
    ]);

    const raw = result.response.text().trim();
    const jsonText = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    let parsed: any[];
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`Gemini structural extraction returned non-JSON output: ${raw.slice(0, 200)}`);
    }

    return parsed
      .filter((c) => typeof c.content === 'string' && c.content.trim().length > 0)
      .map((c) => ({
        content: c.content,
        questionNumber: c.question_number || undefined,
        marks: typeof c.marks === 'number' ? c.marks : undefined,
        topic: c.topic || undefined,
        page: typeof c.page === 'number' ? c.page : undefined,
      }));
  }
}
```

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/ingestion-service/src/extraction/gemini-extractor.spec.ts
```
Expected: PASS, 1 test, against the real Gemini API and your fixture PDF.

- [ ] **Step 6: Commit**

```bash
git add libs/ingestion-service
git commit -m "feat: add Gemini multimodal PDF structural extraction"
```

---

### Task 58: `pdf-parse` fixed-window fallback

**Files:**
- Create: `libs/ingestion-service/src/extraction/fallback-chunker.ts`, `libs/ingestion-service/src/extraction/fallback-chunker.spec.ts`

**Interfaces:**
- Produces: `chunkByFixedWindow(text: string, windowTokens=500, overlapTokens=50): ExtractedChunk[]` — same `ExtractedChunk` shape as Task 57, so Task 59 can consume either extractor's output identically. Only invoked when `GeminiExtractor.extractChunks` throws (born-digital-only fallback per SPEC-SHEET.md §11 step 3b/§7).

- [ ] **Step 1: Install `pdf-parse`**

```bash
npm i pdf-parse
npm i -D @types/pdf-parse
```

- [ ] **Step 2: Write the failing test**

`libs/ingestion-service/src/extraction/fallback-chunker.spec.ts`:
```typescript
import { chunkByFixedWindow } from './fallback-chunker';

describe('chunkByFixedWindow', () => {
  it('splits long text into overlapping windows of roughly the requested token count', () => {
    const words = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkByFixedWindow(words, 500, 50);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].content.split(' ')).toHaveLength(500);
  });

  it('produces overlapping content between consecutive chunks', () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkByFixedWindow(words, 500, 50);

    const firstChunkWords = chunks[0].content.split(' ');
    const secondChunkWords = chunks[1].content.split(' ');
    const overlap = firstChunkWords.slice(-50);
    expect(secondChunkWords.slice(0, 50)).toEqual(overlap);
  });

  it('returns a single chunk for text shorter than the window size', () => {
    const chunks = chunkByFixedWindow('short text here', 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('short text here');
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx jest libs/ingestion-service/src/extraction/fallback-chunker.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`libs/ingestion-service/src/extraction/fallback-chunker.ts`:
```typescript
import { ExtractedChunk } from './gemini-extractor';

export function chunkByFixedWindow(text: string, windowTokens = 500, overlapTokens = 50): ExtractedChunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= windowTokens) {
    return [{ content: words.join(' ') }];
  }

  const chunks: ExtractedChunk[] = [];
  const stride = windowTokens - overlapTokens;
  for (let start = 0; start < words.length; start += stride) {
    const windowWords = words.slice(start, start + windowTokens);
    if (windowWords.length === 0) break;
    chunks.push({ content: windowWords.join(' ') });
    if (start + windowTokens >= words.length) break;
  }
  return chunks;
}
```

- [ ] **Step 5: Run and verify it passes**

```bash
npx jest libs/ingestion-service/src/extraction/fallback-chunker.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Wire the fallback into the processor**

Update `libs/ingestion-service/src/ingestion.processor.ts`'s `process()` method — replace the `throw new Error('extraction not yet implemented (Task 57)')` line with:
```typescript
import { GeminiExtractor } from './extraction/gemini-extractor';
import pdfParse from 'pdf-parse';
import { chunkByFixedWindow } from './extraction/fallback-chunker';

// ...in the constructor, inject `private readonly geminiExtractor: GeminiExtractor,`

let chunks: ExtractedChunk[];
try {
  chunks = await this.geminiExtractor.extractChunks(pdfBuffer);
} catch (extractionErr) {
  this.logger.warn(`Gemini extraction failed for paper ${paperId}, falling back to fixed-window: ${(extractionErr as Error).message}`);
  const parsed = await pdfParse(pdfBuffer);
  chunks = chunkByFixedWindow(parsed.text);
}
```
Add `GeminiExtractor` to `IngestionServiceModule`'s providers.

- [ ] **Step 7: Run the processor test suite and commit**

```bash
npx jest libs/ingestion-service
git add libs/ingestion-service package.json package-lock.json
git commit -m "feat: add pdf-parse fixed-window fallback chunker, wire into processor"
```

---

### Task 59: Chunk embedding + `paper_chunks` upsert

**Files:**
- Create: `libs/ingestion-service/src/chunk-upsert.service.ts`, `libs/ingestion-service/src/chunk-upsert.service.spec.ts`
- Modify: `libs/ingestion-service/src/ingestion.processor.ts`, `libs/ingestion-service/src/ingestion.processor.spec.ts`, `libs/ingestion-service/src/ingestion-service.module.ts`

**Interfaces:**
- Consumes: `GeminiEmbeddingService.embed` (Task 20, `RETRIEVAL_DOCUMENT` task type), `DatabaseService.query`.
- Produces: `ChunkUpsertService.upsertChunks(paperId: string, chunks: ExtractedChunk[]): Promise<number>` (returns count inserted) — Task 60 uses the returned count for `papers.status`/`chunk_count` reporting.

- [ ] **Step 1: Write the failing test**

`libs/ingestion-service/src/chunk-upsert.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';
import { ChunkUpsertService } from './chunk-upsert.service';

describe('ChunkUpsertService (integration, real dev DB + Gemini)', () => {
  let db: DatabaseService;
  let service: ChunkUpsertService;
  const paperId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, GeminiEmbeddingService, ChunkUpsertService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    service = moduleRef.get(ChunkUpsertService);

    await db.query(
      `insert into papers (id, subject, storage_path, status) values ($1, 'Test', 'test/x.pdf', 'processing')`,
      [paperId],
    );
  });

  afterAll(async () => {
    await db.query('delete from papers where id = $1', [paperId]);
  });

  it('embeds and inserts each chunk, returning the count', async () => {
    const count = await service.upsertChunks(paperId, [
      { content: 'Question 1: State the law of demand.', questionNumber: '1', page: 1 },
      { content: 'Question 2: Define elasticity.', questionNumber: '2', page: 1 },
    ]);

    expect(count).toBe(2);

    const rows = await db.query<{ content: string; chunk_index: number }>(
      'select content, chunk_index from paper_chunks where paper_id = $1 order by chunk_index',
      [paperId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].chunk_index).toBe(0);
    expect(rows[1].chunk_index).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/ingestion-service/src/chunk-upsert.service.spec.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`libs/ingestion-service/src/chunk-upsert.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';
import { ExtractedChunk } from './extraction/gemini-extractor';

@Injectable()
export class ChunkUpsertService {
  constructor(
    private readonly db: DatabaseService,
    private readonly embeddings: GeminiEmbeddingService,
  ) {}

  async upsertChunks(paperId: string, chunks: ExtractedChunk[]): Promise<number> {
    let inserted = 0;
    for (const [index, chunk] of chunks.entries()) {
      const embedding = await this.embeddings.embed(chunk.content, 'RETRIEVAL_DOCUMENT');
      const metadata = {
        question_number: chunk.questionNumber,
        marks: chunk.marks,
        topic: chunk.topic,
        page: chunk.page,
      };
      await this.db.query(
        `insert into paper_chunks (paper_id, chunk_index, content, metadata, embedding)
         values ($1, $2, $3, $4, $5::vector)`,
        [paperId, index, chunk.content, JSON.stringify(metadata), `[${embedding.join(',')}]`],
      );
      inserted += 1;
    }
    return inserted;
  }
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/ingestion-service/src/chunk-upsert.service.spec.ts
```
Expected: PASS, 1 test.

- [ ] **Step 5: Wire into the processor**

Update `libs/ingestion-service/src/ingestion.processor.ts`: inject `ChunkUpsertService`, and after the `chunks = ...` extraction block from Task 58, add:
```typescript
const insertedCount = await this.chunkUpsert.upsertChunks(paperId, chunks);
```
(Task 60 adds the `papers.status = 'ready'` update immediately after this line.)

Add `ChunkUpsertService` to `IngestionServiceModule`'s providers, and import `RagServiceModule`'s `GeminiEmbeddingService` provider (or re-provide it directly in `IngestionServiceModule` — simplest: export `GeminiEmbeddingService` from `@app/rag-service`'s `index.ts` if not already, and add it to both modules' providers arrays, since Nest doesn't share provider instances across sibling modules without an explicit shared module).

- [ ] **Step 6: Update the processor's existing failure-path test, then run the full suite**

Task 56's test asserted extraction throws → status `failed`. That's still true (a bogus `storage_path` still fails at `downloadPdf`, before extraction/upsert runs) — no test change needed. Run:
```bash
npx jest libs/ingestion-service
```
Expected: all tests still pass.

- [ ] **Step 7: Commit**

```bash
git add libs/ingestion-service libs/rag-service
git commit -m "feat: embed and upsert extracted chunks into paper_chunks"
```

---

### Task 60: Ingestion completion — `papers.status` + chunk count

**Files:**
- Modify: `libs/ingestion-service/src/ingestion.processor.ts`, `libs/ingestion-service/src/ingestion.processor.spec.ts`

**Interfaces:**
- Produces: on success, `papers.status = 'ready'`; the processor's `process()` return value changes from `void` to `{status: 'ready'|'failed'; chunkCount?: number}` so Task 61's WS push has something to broadcast without re-querying the DB.

- [ ] **Step 1: Write the failing test**

Add to `libs/ingestion-service/src/ingestion.processor.spec.ts`:
```typescript
it('marks the paper ready with a chunk count on successful extraction + upsert', async () => {
  // Requires a real, small PDF fixture uploaded to Storage at a real path first —
  // reuse Task 52's StorageService to upload libs/ingestion-service/test/fixtures/sample-paper.pdf
  // to a throwaway path, then point this paper's storage_path at it.
  const realPath = `test/${randomUUID()}.pdf`;
  // ... upload sample-paper.pdf to realPath via StorageService, insert a papers row pointing at it ...

  const result = await processor.process({ id: 'job-2', data: { paperId: /* that paper's id */ '' } } as any);

  expect(result.status).toBe('ready');
  expect(result.chunkCount).toBeGreaterThan(0);
});
```
(Flesh this out following the exact pattern of Task 56/59's existing integration tests — upload the fixture via `StorageService.uploadPdf`, insert a matching `papers` row, run the processor, assert on both the return value and the actual `papers`/`paper_chunks` rows.)

- [ ] **Step 2: Run it to see it fail**

```bash
npx jest libs/ingestion-service/src/ingestion.processor.spec.ts
```
Expected: FAIL — `process()` currently returns `void`/`undefined`.

- [ ] **Step 3: Implement**

Update `libs/ingestion-service/src/ingestion.processor.ts`'s `process()`:
```typescript
async process(job: Job<IngestionJobPayload>): Promise<{ status: 'ready' | 'failed'; chunkCount?: number }> {
  const { paperId } = job.data;
  try {
    const paper = await this.loadPaper(paperId);
    const pdfBuffer = await this.storage.downloadPdf(paper.storage_path);

    let chunks: ExtractedChunk[];
    try {
      chunks = await this.geminiExtractor.extractChunks(pdfBuffer);
    } catch (extractionErr) {
      this.logger.warn(`Gemini extraction failed for paper ${paperId}, falling back to fixed-window: ${(extractionErr as Error).message}`);
      const parsed = await pdfParse(pdfBuffer);
      chunks = chunkByFixedWindow(parsed.text);
    }

    const chunkCount = await this.chunkUpsert.upsertChunks(paperId, chunks);
    await this.db.query(`update papers set status = 'ready' where id = $1`, [paperId]);

    return { status: 'ready', chunkCount };
  } catch (err) {
    this.logger.error(`Ingestion failed for paper ${paperId}: ${(err as Error).message}`);
    await this.db.query(`update papers set status = 'failed', error_reason = $2 where id = $1`, [
      paperId,
      (err as Error).message,
    ]);
    return { status: 'failed' };
  }
}
```
Update `IngestionServiceModule.onModuleInit`'s `Worker` callback to just discard the return value (BullMQ doesn't need it, Task 61's WS push reads it via a job event instead — see Task 61).

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/ingestion-service/src/ingestion.processor.spec.ts
```
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add libs/ingestion-service
git commit -m "feat: return ready/failed status + chunk count from ingestion processor"
```

---

### Task 61: WebSocket `paper:ingestion_status` push

**Files:**
- Create: `libs/gateway/src/realtime/realtime.gateway.ts`, `libs/gateway/src/realtime/realtime.gateway.spec.ts`
- Modify: `libs/ingestion-service/src/ingestion-service.module.ts`, `libs/gateway/src/gateway.module.ts`

**Interfaces:**
- Consumes: BullMQ's `QueueEvents` (`completed`/`failed` events) for `INGESTION_QUEUE_NAME`.
- Produces: `RealtimeGateway` (Socket.IO namespace `/realtime`), broadcasting `paper:ingestion_status` with `{paper_id, status, chunk_count}` — matching SPEC-SHEET.md §14's mobile channel.

- [ ] **Step 1: Install the WS adapter**

```bash
npm i @nestjs/websockets @nestjs/platform-socket.io socket.io
```

- [ ] **Step 2: Write the gateway**

`libs/gateway/src/realtime/realtime.gateway.ts`:
```typescript
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({ namespace: '/realtime', cors: { origin: true } })
export class RealtimeGateway {
  @WebSocketServer() server: Server;

  emitIngestionStatus(payload: { paper_id: string; status: string; chunk_count?: number }): void {
    this.server.emit('paper:ingestion_status', payload);
  }
}
```

- [ ] **Step 3: Write the failing test**

`libs/gateway/src/realtime/realtime.gateway.spec.ts`:
```typescript
import { RealtimeGateway } from './realtime.gateway';

describe('RealtimeGateway', () => {
  it('emits paper:ingestion_status on the server with the given payload', () => {
    const gateway = new RealtimeGateway();
    gateway.server = { emit: jest.fn() } as any;

    gateway.emitIngestionStatus({ paper_id: 'p1', status: 'ready', chunk_count: 5 });

    expect(gateway.server.emit).toHaveBeenCalledWith('paper:ingestion_status', {
      paper_id: 'p1',
      status: 'ready',
      chunk_count: 5,
    });
  });
});
```

- [ ] **Step 4: Run and verify it passes**

```bash
npx jest libs/gateway/src/realtime/realtime.gateway.spec.ts
```
Expected: PASS, 1 test.

- [ ] **Step 5: Wire BullMQ job events to trigger the push**

Update `libs/ingestion-service/src/ingestion-service.module.ts`: add a `QueueEvents` listener alongside the existing `Worker` in `onModuleInit`, injecting `RealtimeGateway`:
```typescript
import { QueueEvents } from 'bullmq';
import { RealtimeGateway } from '@app/gateway';
// ...
private queueEvents: QueueEvents;

constructor(
  private readonly processor: IngestionProcessor,
  private readonly config: ConfigService<EnvConfig, true>,
  private readonly realtimeGateway: RealtimeGateway,
) {}

onModuleInit(): void {
  const connection = { url: this.config.get('REDIS_URL', { infer: true }) } as any;
  this.worker = new Worker(INGESTION_QUEUE_NAME, (job) => this.processor.process(job), { connection });

  this.queueEvents = new QueueEvents(INGESTION_QUEUE_NAME, { connection });
  this.queueEvents.on('completed', async ({ jobId, returnvalue }) => {
    const job = await this.worker.getNextJob; // not used; returnvalue already has what we need
    const result = returnvalue as unknown as { status: string; chunkCount?: number };
    // paperId isn't in returnvalue — fetch it from the job data via the queue instead:
  });
}
```
This naive approach doesn't have `paperId` in scope from `completed`'s payload. Fix it properly: have `IngestionProcessor.process()` itself call `RealtimeGateway.emitIngestionStatus` directly right before returning (simpler than threading data through BullMQ's event payload) — inject `RealtimeGateway` into `IngestionProcessor` instead:
```typescript
// in ingestion.processor.ts, after `await this.db.query(\`update papers set status = 'ready'...\`)`:
this.realtimeGateway.emitIngestionStatus({ paper_id: paperId, status: 'ready', chunk_count: chunkCount });
// and in the catch block, after the failed status update:
this.realtimeGateway.emitIngestionStatus({ paper_id: paperId, status: 'failed' });
```
Remove the `QueueEvents` listener entirely — it was solving a problem the direct call already solves more simply. Add `RealtimeGateway` to `IngestionServiceModule`'s providers (or import a shared module exporting it — `GatewayModule` already provides it after Step 6).

- [ ] **Step 6: Wire `RealtimeGateway` into `GatewayModule` and `AppModule`**

Add `RealtimeGateway` to `libs/gateway/src/gateway.module.ts`'s providers/exports; ensure `IngestionServiceModule` imports `GatewayModule` (or both import a small shared `RealtimeModule` — simplest is exporting `RealtimeGateway` from `GatewayModule` and importing `GatewayModule` into `IngestionServiceModule`, watching for circular-import issues since `GatewayModule` also imports `IngestionQueueModule` — if a cycle occurs, extract `RealtimeGateway` into its own tiny module with no other dependencies and have both `GatewayModule` and `IngestionServiceModule` import that instead).

- [ ] **Step 7: Verify with a manual WS client**

```bash
npm run build && node dist/apps/api/main.js &
npx wscat -c "ws://localhost:3000/realtime/?EIO=4&transport=websocket" # or use a Socket.IO-aware client; raw wscat may not complete the handshake — a quick alternative is a 5-line Node script using `socket.io-client` to connect and log all events
```
In another terminal, trigger an upload (Task 55) and watch for the `paper:ingestion_status` event to arrive once the worker finishes.

- [ ] **Step 8: Commit**

```bash
git add libs/gateway libs/ingestion-service package.json package-lock.json
git commit -m "feat: push paper:ingestion_status over WebSocket on job completion"
```

---

### Task 62: `GET /papers/:id` and `GET /papers`

**Files:**
- Create: `libs/gateway/src/papers/papers.controller.ts`, `apps/api/test/papers-list.e2e-spec.ts`
- Modify: `libs/gateway/src/gateway.module.ts`

**Interfaces:**
- Consumes: `AuthGuard` (any authenticated student, not admin-only — reading paper status/list doesn't need elevated privileges), `DatabaseService.query`.
- Produces: `GET /papers/:id` → `{paper_id, status, subject, year, chunk_count}` (polling fallback per §11 step 4) and `GET /papers` → list, for `PastPapersScreen`'s eventual real backend per `mobile-app-README.md`'s `papersEndpoint` (not wired client-side in this plan — out of scope per this plan's Global Constraints/SPEC-SHEET.md non-goals, but the endpoint now exists for when that client work happens).

- [ ] **Step 1: Write the controller**

`libs/gateway/src/papers/papers.controller.ts`:
```typescript
import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { DatabaseService } from '@app/database';

@Controller('papers')
@UseGuards(AuthGuard)
export class PapersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list() {
    const rows = await this.db.query(
      `select id as paper_id, subject, year, syllabus, level, medium, status
       from papers order by created_at desc limit 100`,
    );
    return { papers: rows };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const rows = await this.db.query<{
      paper_id: string; subject: string; year: number | null; status: string;
    }>(
      `select p.id as paper_id, p.subject, p.year, p.status,
              (select count(*) from paper_chunks pc where pc.paper_id = p.id) as chunk_count
       from papers p where p.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('paper_not_found');
    return rows[0];
  }
}
```

Note: this `@Controller('papers')` has the same route prefix as Task 55's `PapersUploadController` — Nest allows this as long as the specific paths (`upload` vs `:id`/``) don't collide, which they don't here. Keep them as separate controller classes (separation of concerns: upload is admin-gated, read is any-authenticated-user), both mounted under `papers`.

- [ ] **Step 2: Wire into `GatewayModule` and write an e2e test**

Add `PapersController` to `libs/gateway/src/gateway.module.ts`. `apps/api/test/papers-list.e2e-spec.ts`: authenticated request to `GET /papers` returns `200` with a `papers` array (using Task 23's seeded papers or Task 55's uploaded one); `GET /papers/:id` with a bogus UUID returns `404`; with a real id returns the expected shape including `chunk_count`.

- [ ] **Step 3: Run and verify it passes**

```bash
npx jest apps/api/test/papers-list.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add libs/gateway apps/api
git commit -m "feat: add GET /papers and GET /papers/:id"
```

---

### Task 63: Per-admin/day upload rate limit

**Files:**
- Modify: `libs/gateway/src/admin/papers-upload.controller.ts`

**Interfaces:**
- Consumes: `@nestjs/throttler`'s `Throttle` decorator (already installed, Task 18).
- Produces: a documented, enforced daily cap on `/papers/upload` per admin, per SPEC-SHEET.md §16's "per-admin/day upload rate limit to bound embedding cost from abuse."

- [ ] **Step 1: Apply a daily throttle**

`@nestjs/throttler`'s default TTL is in milliseconds and doesn't natively express "per day" cleanly across restarts without a persistent store, but for this beta's scale (SPEC-SHEET.md §8: dozens of papers total, not per day) a simple in-memory 24h-window throttle is sufficient — add to `PapersUploadController`'s `upload` method:
```typescript
import { Throttle } from '@nestjs/throttler';
// ...
@Post('upload')
@Throttle({ default: { limit: 20, ttl: 86_400_000 } }) // 20 uploads/24h per admin (keyed by IP by default)
@UseInterceptors(FileInterceptor('file'))
async upload(...) { ... }
```
This throttles per-IP by default, not per-admin-id — for a true per-admin limit, override `ThrottlerGuard`'s `getTracker` to use `request.principal.id` instead of the IP. Do that now since the spec explicitly says "per-admin":

Create `libs/gateway/src/guards/per-principal-throttler.guard.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class PerPrincipalThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.principal?.id ?? req.ip;
  }
}
```
Apply it to the upload route specifically: `@UseGuards(AuthGuard, AdminGuard, PerPrincipalThrottlerGuard)` (replacing reliance on the global `ThrottlerGuard` for this one route — Nest applies the most specific guard when both global and route-level guards are present, so this route-level one takes over the tracking key for this endpoint only).

- [ ] **Step 2: Verify manually**

Upload 21 tiny PDFs in a loop with the same admin token within a short window (or temporarily lower the limit to `2` for a quick manual check), expect the 21st (or 3rd, with the lowered limit) to return `429`.

- [ ] **Step 3: Commit**

```bash
git add libs/gateway
git commit -m "feat: add per-admin daily upload rate limit"
```

---

### Task 64: Manual end-to-end ingestion verification

**Files:** none — verification only.

- [ ] **Step 1: Promote yourself to admin and get a real past paper**

```bash
npm run promote-admin -- --email=your-test-account@example.com
```
Find or create a real (or realistic) past exam paper PDF — even a 1-2 page excerpt is enough to prove the pipeline.

- [ ] **Step 2: Upload it**

```bash
curl -s -X POST http://localhost:3000/papers/upload \
  -H "Authorization: Bearer $TEST_ADMIN_JWT" \
  -F "file=@/path/to/real-paper.pdf;type=application/pdf" \
  -F "subject=Chemistry" -F "year=2023" -F "syllabus=local" -F "level=al" -F "medium=english"
```
Expected: `{"paper_id":"...","status":"processing"}`.

- [ ] **Step 3: Watch it finish**

```bash
watch -n2 "curl -s http://localhost:3000/papers/<paper_id> -H \"Authorization: Bearer $TEST_ADMIN_JWT\" | jq"
```
Expected: `status` transitions from `processing` to `ready` within roughly a minute, with `chunk_count > 0`. (Or watch the WS event from Task 61's Step 7 instead of polling.)

- [ ] **Step 4: Confirm it's actually retrievable and citable**

```bash
curl -s -X POST http://localhost:3000/chat/ask \
  -H "Authorization: Bearer $TEST_STUDENT_JWT" -H "Content-Type: application/json" \
  -d '{"question":"<a question you know is answered in that real paper>","subject":"Chemistry","syllabus":"local","medium":"english","student_id":"'"$TEST_STUDENT_ID"'","chat_history":[]}' | jq
```
Expected: an answer citing `{"subject":"Chemistry","year":2023}` — proving the full loop from PDF upload to a cited chat answer works without Task 23's seed script.

No commit — verification only.

---

### Task 64.1: Citation-rate metric + request-id propagation over gRPC (SPEC-SHEET.md §16 closeout)

SPEC-SHEET.md §16 names two observability requirements not yet addressed by any earlier task: "a citation-rate metric (% of curriculum answers with sources) as a direct proxy for the product's core promise," and "structured logging with request/correlation IDs threaded through gRPC calls." (Numbered `64.1` for the same reason as Task 23.1 — see that task's note.)

**Files:**
- Create: `supabase/migrations/<timestamp>_add_grounded_to_chat_messages.sql`, `libs/gateway/src/admin/metrics.controller.ts`
- Modify: `libs/database/src/repositories/chat-sessions.repository.ts`, `libs/database/src/repositories/chat-sessions.repository.spec.ts`, `libs/gateway/src/ask/ask.service.ts`, `libs/gateway/src/grpc-clients/auth-client.provider.ts` (and the other three gRPC client providers), `libs/gateway/src/gateway.module.ts`

**Interfaces:**
- Consumes: `RequestIdInterceptor`'s `request.requestId` (Task 18), Task 27's `AskResult.grounded` (already computed, not yet persisted).
- Produces: `ChatSessionsRepository.appendMessage`'s signature grows a `grounded: boolean` parameter for assistant messages; `GET /admin/metrics/citation-rate?days=7` → `{grounded_rate: number, total_curriculum_responses: number}`.

- [ ] **Step 1: Migrate the schema**

```bash
npx supabase migration new add_grounded_to_chat_messages
```
```sql
alter table chat_messages add column if not exists grounded boolean;
```
```bash
npx supabase db push
```

- [ ] **Step 2: Persist `grounded` on assistant messages**

Update `libs/database/src/repositories/chat-sessions.repository.ts`'s `appendMessage`:
```typescript
async appendMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  sources?: { subject: string; year: string }[],
  grounded?: boolean,
): Promise<void> {
  await this.db.query(
    `insert into chat_messages (session_id, role, content, sources, grounded) values ($1, $2, $3, $4, $5)`,
    [sessionId, role, content, sources ? JSON.stringify(sources) : null, grounded ?? null],
  );
}
```
Add one assertion to `libs/database/src/repositories/chat-sessions.repository.spec.ts`'s existing "appends messages" test: after calling `appendMessage(sessionId, 'assistant', 'Demand is...', [...], true)`, query `chat_messages` directly and assert `grounded === true` on that row.

Update `libs/gateway/src/ask/ask.service.ts`'s persistence call (added in Task 30 Step 5) to pass `askResult.grounded` as the fifth argument to `appendMessage`.

- [ ] **Step 3: Add the metrics endpoint**

`libs/gateway/src/admin/metrics.controller.ts`:
```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { DatabaseService } from '@app/database';

@Controller('admin/metrics')
@UseGuards(AuthGuard, AdminGuard)
export class MetricsController {
  constructor(private readonly db: DatabaseService) {}

  @Get('citation-rate')
  async citationRate(@Query('days') days = '7') {
    const rows = await this.db.query<{ total: string; grounded_count: string }>(
      `select count(*) filter (where grounded is not null) as total,
              count(*) filter (where grounded = true) as grounded_count
       from chat_messages
       where role = 'assistant' and created_at > now() - ($1 || ' days')::interval`,
      [days],
    );
    const total = Number(rows[0].total);
    const groundedCount = Number(rows[0].grounded_count);
    return {
      grounded_rate: total > 0 ? groundedCount / total : null,
      total_curriculum_responses: total,
    };
  }
}
```
Note: this measures `grounded` (Task 27's definition: true for small-talk-no-citation-needed *and* curriculum-with-citation; false only for curriculum-that-still-failed-after-retry), which is a close but not identical proxy for spec's literal "% of curriculum answers with sources" — the two diverge only in how small-talk responses are counted, and small-talk responses are always `grounded=true` by construction, so a low `grounded_rate` still reliably signals real citation failures. Documented here as a deliberate simplification, not a silent substitution.

Add `MetricsController` to `libs/gateway/src/gateway.module.ts`.

- [ ] **Step 4: Propagate `X-Request-Id` as gRPC metadata**

Update each of the four gRPC client providers (`auth-client.provider.ts` from Task 17, `rag-client.provider.ts`/`chat-client.provider.ts` from Task 29, `speech-client.provider.ts` from Task 46) to pass a `Metadata` object carrying the current request's id on every call. Since the factory functions build a plain client object once at module-init time (not per-request), the cleanest fix is at the call sites, not the provider: in every controller method that calls one of these clients (Tasks 17's guard doesn't have request-id context easily; focus this on the ones that matter most for tracing a single user-facing call — `ChatController.ask` (Task 31) and `VoiceController.ask` (Task 46)), pass metadata explicitly:
```typescript
import { Metadata } from '@grpc/grpc-js';
// ...
const metadata = new Metadata();
metadata.set('x-request-id', req.requestId ?? '');
const searchResult = await firstValueFrom(this.ragClient.search({...}, metadata));
```
This requires threading `req` (for `req.requestId`, set by Task 18's `RequestIdInterceptor`) into `GatewayAskService.ask` as an optional parameter, or simpler: read `req.requestId` in the controller and pass it as a plain string field through `GatewayAskService.ask`'s input (`requestId?: string`), letting `GatewayAskService` build the `Metadata` object itself right before each gRPC call. Take the simpler path — it keeps `Metadata`/`@grpc/grpc-js` construction out of the controller layer.

- [ ] **Step 5: Verify**

```bash
npx jest libs/database/src/repositories/chat-sessions.repository.spec.ts libs/gateway/src/ask/ask.service.spec.ts
```
Expected: PASS (existing tests plus the new grounded-column assertion from Step 2).

Manual check: make a few `/chat/ask` calls (some curriculum, some small talk, one deliberately out-of-corpus to trigger the decline path), then:
```bash
curl -s "http://localhost:3000/admin/metrics/citation-rate?days=1" -H "Authorization: Bearer $TEST_ADMIN_JWT" | jq
```
Expected: a `grounded_rate` between 0 and 1 reflecting the mix of calls just made.

- [ ] **Step 6: Commit**

```bash
git add supabase libs/database libs/gateway
git commit -m "feat: persist grounded flag, add citation-rate metric endpoint, propagate request-id over gRPC"
```

---

### Task 65: Deploy Phase 3 to Koyeb, final smoke test of all three endpoints

**Files:** none.

- [ ] **Step 1: Push and redeploy**

```bash
git push origin master
koyeb service redeploy obscura-api
koyeb service get obscura-api
```
Wait for `HEALTHY`.

- [ ] **Step 2: Smoke-test all three endpoints against production**

```bash
BASE=https://<your-app>.koyeb.app

curl -s -X POST $BASE/chat/ask -H "Authorization: Bearer $TEST_STUDENT_JWT" -H "Content-Type: application/json" \
  -d '{"question":"What is the law of demand?","subject":"Economics","syllabus":"local","medium":"english","student_id":"'"$TEST_STUDENT_ID"'","chat_history":[]}' | jq '.answer, .sources'

curl -s -X POST "$BASE/voice/ask?subject=Economics&medium=english" \
  -H "X-Device-Key: $TEST_DEVICE_KEY" \
  -F "audio=@apps/api/test/fixtures/sample-question.wav;type=audio/wav" --output /tmp/prod-response.pcm
ls -la /tmp/prod-response.pcm

curl -s -X POST $BASE/papers/upload -H "Authorization: Bearer $TEST_ADMIN_JWT" \
  -F "file=@apps/api/test/fixtures/sample-paper.pdf;type=application/pdf" \
  -F "subject=Test" -F "year=2024" | jq
```
Expected: all three succeed — a cited chat answer, a non-empty PCM file, and a `{"paper_id":...,"status":"processing"}` response that later transitions to `ready`.

- [ ] **Step 3: Retire the Task 23 seed script's role**

No code change required — the seed script still works and is harmless to leave in `scripts/`, but it's no longer the primary way test data gets into the corpus now that real ingestion (Tasks 55-60) exists. Note this in your own working notes if useful; nothing to commit.

**Phase 3 complete.** All three of SPEC-SHEET.md's target milestones are live: text chat (Phase 1), voice (Phase 2), and PDF ingestion + admin tooling (Phase 3), each independently verified end-to-end against the real deployed Koyeb service.

---
