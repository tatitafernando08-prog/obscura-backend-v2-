# Obscura — AI Study App

Obscura is a Flutter mobile app for Sri Lankan O/L and A/L students. It combines an AI study
assistant ("NESH"), a planner, flashcards, past-paper practice, and progress analytics behind a
Supabase-backed auth/profile layer and a separate Python backend for AI features.

This document is an exhaustive reference of the current client implementation — every screen,
every network call, the auth flow, state management, local persistence, and data models — intended
as a spec for building out the backend.

> **Read this first:** a large portion of the UI is currently **static mock data with no backend
> wiring**. Section [What's Actually Wired Up vs. Mocked](#whats-actually-wired-up-vs-mocked) says
> precisely what talks to a network today and what doesn't, so you don't build endpoints the app
> can't yet call.

---

## Table of Contents

1. [Tech Stack & Key Dependencies](#tech-stack--key-dependencies)
2. [Backend Systems](#backend-systems)
3. [Authentication Flow](#authentication-flow)
4. [State Management Approach](#state-management-approach)
5. [Navigation / Routing](#navigation--routing)
6. [Screens](#screens)
7. [API Endpoints](#api-endpoints)
8. [Supabase Schema (inferred from client calls)](#supabase-schema-inferred-from-client-calls)
9. [Data Models](#data-models)
10. [Local Persistence (SharedPreferences keys)](#local-persistence-sharedpreferences-keys)
11. [Data Flow Walkthroughs](#data-flow-walkthroughs)
12. [What's Actually Wired Up vs. Mocked](#whats-actually-wired-up-vs-mocked)
13. [Dead / Empty Files](#dead--empty-files)
14. [Project Structure](#project-structure)

---

## Tech Stack & Key Dependencies

| Package | Version | Purpose |
|---|---|---|
| `flutter` / `flutter_localizations` | SDK | Framework, `en` / `ta` / `si` locale support |
| `provider` | ^6.1.2 | App-wide state management (`ChangeNotifier`) |
| `go_router` | ^14.8.1 | Declarative routing, shell/tab navigation, auth-gated redirects |
| `supabase_flutter` | ^2.5.6 | Auth (email/password) + Postgres `students` table |
| `http` | ^1.2.1 | REST calls to the Python backend |
| `shared_preferences` | ^2.5.3 | All local persistence (profile, tasks, chat log, flags) |
| `google_fonts` | ^6.2.1 | Poppins (+ Noto Sans Sinhala/Tamil for localized mediums) |
| `speech_to_text` | ^7.0.0 | Voice input in the AI chat screen |
| `flutter_tts` | ^4.2.0 | Speaks NESH's answers aloud |
| `uuid` | ^4.4.0 | Present in deps, not currently referenced in app code |
| `intl` | 0.20.2 | Date/number formatting |
| `url_launcher` | ^6.3.0 | Present in deps, not currently referenced in app code |
| `cached_network_image` | ^3.3.1 | Present in deps, not currently referenced in app code |

App identity: `name: obscura_app`, `version: 1.0.0+1`, Dart SDK `>=3.0.0 <4.0.0`.

Assets: `assets/images/obscura_logo.png`, `assets/sounds/bell.mp3` (bell asset is declared but not
referenced by any Dart code yet).

---

## Backend Systems

The app talks to **two independent backends**:

1. **Supabase** (`https://zsdsqyowcjifbktbolji.supabase.co`) — handles auth (sign up / sign in /
   sign out) and a `students` profile table. Configured in `lib/core/constants/app_constants.dart`
   with the project URL and a public **anon key** (hardcoded in source — standard for Supabase's
   anon key, but flag if you want it moved to a build-time secret).
2. **Python backend on Railway** (`https://obscura-backend-production-d7de.up.railway.app`) —
   handles the NESH AI chat (RAG over past papers). Only one route on this backend is actually
   called by the app today: `POST /chat/ask`.

Both base URLs and the Supabase anon key live in `lib/core/constants/app_constants.dart`.

---

## Authentication Flow

**Supabase Auth (email/password)** is implemented in `lib/providers/auth_provider.dart`
(`AuthProvider extends ChangeNotifier`):

- `signUp({email, password, name})` → `supabase.auth.signUp(email, password, data: {'name': name})`,
  then inserts a row into `students`: `{id: user.id, email, name}`.
- `signIn({email, password})` → `supabase.auth.signInWithPassword(email, password)`.
- `signOut()` → `supabase.auth.signOut()`.
- `updateStudentProfile({level, syllabus, medium, stream?, name?})` → upserts into `students`:
  `{id: userId, grade, syllabus, medium, stream?, name?}`. Intended to run after onboarding, but
  **is not currently called from anywhere** (see gaps below).
- Exposes `currentUser`, `isLoggedIn`, `userId`, `userEmail` derived straight from
  `Supabase.instance.client.auth.currentUser`. Session persistence/refresh is handled entirely by
  `supabase_flutter`'s own local storage — the app does no manual token handling.

**⚠️ Current gap:** `lib/features/auth/nesh_ai_chat/screens/login_screen.dart` renders a full
login/signup UI (email, password, Google/Apple buttons) but its `_handleLogin()` and
`_handleSignUp()` handlers are stubs that just call `context.go(AppRoutes.home)` — **they never
call `AuthProvider.signIn`/`signUp`**. Google/Apple OAuth buttons have empty `onTap: () {}`
handlers (marked `// TODO`). So today, tapping "Login" or "Create Account" navigates straight to
the home screen with no real authentication performed, regardless of what's typed. `AuthProvider`
itself is fully functional and Supabase-ready — it just isn't invoked yet.

**Route gating** (`lib/routes/app_router.dart`) only checks **onboarding completion**
(`UserProfileProvider.hasProfile`, backed by SharedPreferences), not login state — there is no
`redirect` logic based on `AuthProvider.isLoggedIn`. So the router doesn't currently force a user
through Supabase login at all; it only forces them through the onboarding survey once.

**Onboarding → account linkage:** `OnboardingScreen` walks the user through language → level →
syllabus → medium → (stream, if A/L), storing answers in `UserProfileProvider` (SharedPreferences
only) and routing to `LoginScreen` on completion. Because `updateStudentProfile` is never called,
the onboarding answers are **not currently synced to Supabase** — they live only on-device.

---

## State Management Approach

**Provider (`ChangeNotifier`)** is the sole state-management approach — no Bloc/Riverpod/Redux.
All providers are registered app-wide in a single `MultiProvider` in `lib/main.dart`:

| Provider | Backing store | Responsibility |
|---|---|---|
| `UserProfileProvider` | SharedPreferences | Onboarding survey state + completed `UserProfile` |
| `AuthProvider` | Supabase Auth (in-memory getters) | Sign up/in/out, student profile upsert |
| `AppThemeProvider` | In-memory (not persisted) | Selected theme (4 presets) + color-blind mode |
| `DailyCheckInProvider` | SharedPreferences | Whether to show the daily "start your day" dialog |
| `ChatHistoryProvider` | SharedPreferences | Per-day log of NESH Q&A exchanges (for the recap screen) |
| `PlannerProvider` | SharedPreferences | Per-day list of `PlannerTask` |
| `StudyGoalProvider` | SharedPreferences | Whether/what daily study-hours goal was set |

Notes:
- `UserProfileProvider` is constructed and `.load()`-ed **before** `runApp()` so the router has
  synchronous access to onboarding state on first frame.
- `AppThemeProvider`'s selection is **not persisted** — it resets to `obscuraPurple` on app restart.
- Every persisted provider keys its SharedPreferences entries by **calendar date** (`YYYY-MM-DD`),
  so planner tasks, chat history, and check-in/goal flags are all scoped per-day.
- There is a second, unused `ChatProvider` file under `lib/features/auth/nesh_ai_chat/providers/`
  — it's empty (0 bytes) and not registered; the real chat provider is
  `lib/providers/chat_history_provider.dart`.
- Local component state (`setState`) is used for ephemeral UI: timers (Pomodoro, meditation),
  text field controllers, tab/page indices, mock list filtering.

---

## Navigation / Routing

`go_router` (`lib/routes/app_router.dart`) defines:

```
/                → SplashScreen        (decides next route based on hasProfile)
/onboarding      → OnboardingScreen    (5-step PageView survey)
/login           → LoginScreen         (tab-switched Login / Sign Up forms)

ShellRoute (MainShell — bottom nav bar, 5 tabs + hidden routes)
  /home          → HomeScreen (home_screen_v2.dart)      [tab]
  /chat          → AiChatScreen                          [tab]
  /planner       → PlannerScreen                          [tab]
  /analytics     → AnalyticsScreen                        [tab]
  /settings      → SettingsScreen                         [tab]
  /search        → RagSearchScreen        (reachable via Quick Actions, not a tab)
  /flashcards    → FlashcardsScreen       (reachable via Quick Actions, not a tab)
  /pomodoro      → PomodoroScreen         (reachable via Quick Actions, not a tab)
  /past-papers   → PastPapersScreen       (reachable via Quick Actions, not a tab)
```

Redirect logic: if `!UserProfileProvider.hasProfile` and the target route isn't splash/onboarding/
login, redirect to `/onboarding`. No auth-based redirect (see [Authentication Flow](#authentication-flow)).

The bottom nav bar (`MainShell` / `_BottomBar`) renders 5 tabs: Home, AI Chat, Planner, Progress
(Analytics), Profile (Settings).

---

## Screens

### Splash & Onboarding

- **`SplashScreen`** (`/`) — animated logo/wordmark intro (2s), then routes to `/home` if
  `UserProfileProvider.hasProfile`, else `/onboarding`. No network calls.
- **`OnboardingScreen`** (`/onboarding`) — 5-page `PageView` survey, no direct backend calls; each
  step just mutates `UserProfileProvider`'s in-memory `OnboardingState`:
  1. **`LanguageStep`** — pick medium (English / Sinhala / Tamil).
  2. **`LevelStep`** — pick O/L or A/L.
  3. **`SyllabusStep`** — pick Local / Edexcel / Cambridge.
  4. **`MediumStep`** — medium picked again post-syllabus (drives completion for O/L users, who
     skip the stream step).
  5. **`StreamStep`** — (A/L only) pick Science / Commerce / Arts / Technology.
  On completion, `UserProfileProvider.completeOnboarding()` persists the profile to
  SharedPreferences and the screen routes to `/login`.
- **`LoginScreen`** (`/login`) — tabbed Login / Sign Up forms (email, password, name for signup),
  Google/Apple social buttons (stubbed, no-op). See [gap noted above](#authentication-flow) — form
  submission does not currently call `AuthProvider`.

### Home / Dashboard

- **`HomeScreen`** (`home_screen_v2.dart`, route `/home`) — the main landing tab:
  - Personalized greeting (time-of-day + user's first name, sourced from
    `AuthProvider.currentUser.userMetadata['name']` falling back to `UserProfileProvider`).
  - On first frame, sequentially checks and (if due) shows:
    - `DailyCheckInDialog` — "Start your day" modal (Meditate / Recap Yesterday / Skip).
    - `StudyGoalDialog` — "How long will you study today?" slider (1–8h) that auto-generates
      `PlannerTask`s via `StudyPlanGenerator` and inserts them into `PlannerProvider`.
  - "Today's Focus" gradient card (static mock progress: "2/3 topics done").
  - Quick Actions grid → AI Assistant, Study Planner, Flashcards, Pomodoro, Past Papers, RAG Search.
  - "Today's Schedule" list (static mock sessions — Physics/Math/Chemistry with fixed times).
  - Profile summary badge (level · syllabus · stream · medium) if a profile exists.
- **`DailyCheckInDialog`** — routes into:
  - **`MeditationScreen`** — 60-second guided breathing animation, no data persistence.
  - **`RecapScreen`** — reads yesterday's `ChatHistoryProvider` entries and yesterday's
    `PlannerProvider` tasks (completed/total), purely local reads, no network.
- **`StudyGoalDialog`** — see above; writes to `PlannerProvider` and `StudyGoalProvider` only.

### AI Chat ("NESH")

- **`AiChatScreen`** (route `/chat`) — the only screen with a real backend call:
  - Text input + mic button (speech-to-text via `speech_to_text`) + suggestion chips.
  - Sends the question to `POST {backendUrl}/chat/ask` (see [API Endpoints](#api-endpoints)).
  - Renders the AI's answer, plus up to 2 "sources" (past paper subject/year) extracted from the
    response, and speaks the answer aloud via `flutter_tts`.
  - On success, persists the Q&A pair into `ChatHistoryProvider` (SharedPreferences, keyed by
    today's date) so it can surface in tomorrow's Recap screen.
  - **Hardcoded student context** sent with every request (not yet sourced from the real
    logged-in profile): `student_id = '550e8400-e29b-41d4-a716-446655440000'`,
    `stream = 'Commerce'`, `subject = 'Economics'`, `syllabus = 'Local'`, `medium = 'english'`.
    A code comment flags this: `// Student context — later connect to UserProfileProvider`.
  - "Clear Chat" bottom sheet resets the in-memory message list only (does not clear the persisted
    `ChatHistoryProvider` log).

### Planner

- **`PlannerScreen`** (route `/planner`) — weekly day-picker + per-day task list, backed entirely
  by `PlannerProvider`/SharedPreferences:
  - Add task (title + optional subject subtitle) via bottom sheet.
  - Toggle/delete tasks.
  - Static "Focus Timer" card (25:00, non-functional "Start" button — not wired to the real
    Pomodoro screen or a timer).

### Progress / Analytics

- **`AnalyticsScreen`** (route `/analytics`) — **entirely static/mock data**, no providers or
  network calls: period selector (This Week/Month/All Time, doesn't actually filter anything),
  fixed weekly study-hours bar chart, fixed subject-breakdown donut chart, fixed streak card
  ("7 Days"), fixed recent-activity list.

### Settings

- **`SettingsScreen`** (route `/settings`) — mostly static:
  - Profile card with **hardcoded name/email** ("Anaya Sharma" / "anaya.study@gmail.com") — not
    sourced from `AuthProvider` or `UserProfileProvider`.
  - **Theme picker** — real, wired to `AppThemeProvider.setTheme()` (4 presets: Obscura Purple,
    Cozy Pink, Night Owl, Focus Green).
  - **Color-blind friendly mode** toggle — real, wired to `AppThemeProvider.setColorBlindMode()`
    (remaps success/warning/error colors app-wide via a global accessor).
  - Account/Preferences/Support list items — all `onTap: () {}` no-ops.
  - Log Out button — shows a confirm dialog whose "Log Out" action just calls `Navigator.pop`; it
    does **not** call `AuthProvider.signOut()`.

### Flashcards, RAG Search, Pomodoro, Past Papers (mock-data screens)

These four are fully built UIs with **no backend integration** — all data is hardcoded in the
widget's state:

- **`FlashcardsScreen`** (route `/flashcards`) — deck list (5 hardcoded decks) with tabs
  (All/My/Favourites), create-deck bottom sheet (adds to in-memory list only), and a flip-card
  study mode (`_FlashcardStudyScreen`) over 5 hardcoded Physics/Chemistry Q&A pairs.
- **`RagSearchScreen`** (route `/search`) — global search UI: hardcoded recent searches, hardcoded
  popular topics, a Quick Access grid linking to other features, and an "Ask NESH" banner that
  simply navigates to `/chat` (the typed query is **not** passed/pre-filled into the chat screen).
- **`PomodoroScreen`** (route `/pomodoro`) — fully functional focus timer (25/5/15 min modes,
  circular countdown, session counter) and a per-session task list — all state is in-memory only
  (`setState`), nothing persisted.
- **`PastPapersScreen`** (route `/past-papers`) — paper list (8 hardcoded entries) with
  subject-tab filtering and text search (client-side only), tapping a paper opens a detail sheet
  with mock stats; "Practice Now" and "View My Attempts" buttons are no-ops.

There are **duplicate copies** of three of these screens elsewhere in the tree that are not
referenced by the router — see [Dead / Empty Files](#dead--empty-files).

---

## API Endpoints

### Python Backend (Railway) — `https://obscura-backend-production-d7de.up.railway.app`

Only one route is actually called by the client today.

#### `POST /chat/ask` — ask NESH a question

Called from `lib/features/auth/nesh_ai_chat/screens/ai_chat_screen.dart` (`_sendMessage`).

**Request** — `Content-Type: application/json`, 30s client timeout:
```json
{
  "question": "string — the user's message",
  "stream": "string — e.g. 'Commerce'",
  "subject": "string — e.g. 'Economics'",
  "syllabus": "string — e.g. 'Local'",
  "medium": "string — e.g. 'english'",
  "student_id": "string (UUID) — currently hardcoded client-side",
  "chat_history": [
    { "role": "user | assistant", "content": "string" }
  ]
}
```
`chat_history` is built client-side from up to the last 6 prior messages (excluding the initial
welcome message), mapped to `{role, content}` pairs.

**Response — 200 OK:**
```json
{
  "answer": "string — markdown-ish text, rendered directly and spoken via TTS",
  "sources": [
    {
      "past_papers": {
        "subject": "string",
        "year": "number | string"
      }
    }
  ]
}
```
Client renders at most the first 2 `sources` entries as `"{subject} {year}"` chips under the
answer bubble. `sources` is optional/defensively handled (`data['sources'] as List? ?? []`).

**Non-200 or network error:** client shows a generic "NESH is having trouble right now" /
connection-failure bubble; no retry logic.

#### Endpoints defined but **not yet called** anywhere in the app

These are declared as constants in `lib/core/constants/app_constants.dart` but there is currently
**no calling code** for any of them — they appear to be planned/reserved routes for the backend to
implement ahead of client work:

| Constant | Path | Presumed purpose |
|---|---|---|
| `chatHistoryEndpoint` | `GET/POST {backendUrl}/chat/history` | Server-side chat history (client currently only stores history locally via `ChatHistoryProvider`) |
| `papersEndpoint` | `{backendUrl}/papers` | Listing past papers (currently hardcoded in `PastPapersScreen`) |
| `uploadEndpoint` | `POST {backendUrl}/papers/upload` | Uploading a paper/scan (there's an empty, unimplemented `upload_screen.dart` — see below) |
| `searchEndpoint` | `{backendUrl}/search` | Backing `RagSearchScreen` (currently pure client-side string filtering over hardcoded lists) |

### Supabase — `https://zsdsqyowcjifbktbolji.supabase.co`

Accessed via the `supabase_flutter` SDK, not raw REST, from `lib/providers/auth_provider.dart`:

| Operation | SDK call | Notes |
|---|---|---|
| Sign up | `supabase.auth.signUp(email, password, data: {name})` | Then inserts into `students` |
| Sign in | `supabase.auth.signInWithPassword(email, password)` | |
| Sign out | `supabase.auth.signOut()` | |
| Create profile row | `supabase.from('students').insert({id, email, name})` | Runs immediately after sign-up |
| Update profile | `supabase.from('students').upsert({id, grade, syllabus, medium, stream?, name?})` | Written but **never called** by any screen today |

---

## Supabase Schema (inferred from client calls)

The client implies (but a migration/schema file is not present in this repo) a `students` table
shaped roughly like:

```sql
create table students (
  id         uuid primary key references auth.users(id),
  email      text,
  name       text,
  grade      text,   -- 'ol' | 'al'   (from StudyLevel.name)
  syllabus   text,   -- 'local' | 'edexcel' | 'cambridge'
  medium     text,   -- 'english' | 'sinhala' | 'tamil'
  stream     text    -- 'science' | 'commerce' | 'arts' | 'technology' (A/L only, nullable)
);
```

Note the app never *reads* from `students` — it only writes (insert on sign-up, upsert intended
post-onboarding). Nothing currently fetches this row back into the app; `UserProfileProvider`'s
notion of "profile" is purely local (SharedPreferences), independent of this table.

---

## Data Models

### `UserProfile` (`lib/shared/models/user_profile.dart`)
```dart
class UserProfile {
  StudyLevel level;       // enum: ol, al
  Syllabus syllabus;      // enum: local, edexcel, cambridge
  Medium medium;          // enum: english, sinhala, tamil
  ALStream? stream;       // enum: science, commerce, arts, technology (A/L only)
  String? studentName;
}
```
`isComplete` requires `stream` to be set when `level == al`. `profileSummary` renders as
`"A/L · Local · Science · English"`. Enum values also carry `displayName`, `fullName` (level/
syllabus), `fontFamily`/`locale` (medium), and `icon`/`color`/`description` (stream) for UI use.

### `PlannerTask` (`lib/features/auth/planner/screens/models/Planner_task.dart`)
```dart
class PlannerTask {
  String title;
  String subtitle;   // e.g. subject or "45 min focused study"
  bool isDone;
}
```
JSON-serializable (`toJson`/`fromJson`); stored per-day as a `List<String>` of JSON blobs in
SharedPreferences. Note: `lib/providers/planner_provider.dart` (the one actually registered/used)
contains its own identical `PlannerTask` class definition — the two are structurally the same but
are **separate Dart classes in separate files** (see [Dead / Empty Files](#dead--empty-files) for
which one the app really uses).

### `ChatEntry` (`lib/providers/chat_history_provider.dart`)
```dart
class ChatEntry {
  String question;
  String answer;
  DateTime timestamp;
}
```
JSON-serializable; stored per-day as a `List<String>` of JSON blobs in SharedPreferences.

### `Subject` (`lib/core/constants/syllabus.dart`)
```dart
class Subject {
  String id;
  String name;
  String nameTA;   // Tamil translation
  String nameSI;   // Sinhala translation
  String icon;     // emoji
  SubjectCategory category; // mathematics, science, language, humanities, commerce, technology, arts, religion, health
}
```
A large static catalogue of subjects per (level × syllabus × stream) combination — O/L Local/
Edexcel/Cambridge, and A/L Local/Edexcel/Cambridge × Science/Commerce/Arts/Technology. Resolved via
`getSubjects(UserProfile)` / `getSubjectsByCategory(UserProfile)` / `getSubjectById(id, profile)`.
This is a **pure client-side reference dataset** — not fetched from any backend, and not yet wired
into any screen's actual UI (no screen currently calls `getSubjects`).

---

## Local Persistence (SharedPreferences keys)

All keys are plain strings, several date-scoped as `..._YYYY-MM-DD`.

| Key(s) | Written by | Value |
|---|---|---|
| `profile_level`, `profile_syllabus`, `profile_medium`, `profile_stream`, `profile_student_name`, `profile_onboarded` | `UserProfileProvider` | Onboarding survey answers + completion flag |
| `chat_history_YYYY-MM-DD` | `ChatHistoryProvider` | `List<String>` of JSON `ChatEntry` |
| `planner_tasks_YYYY-MM-DD` | `PlannerProvider` | `List<String>` of JSON `PlannerTask` |
| `last_checkin_shown_date` | `DailyCheckInProvider` | Date string; gates the daily check-in dialog |
| `study_goal_shown_date` | `StudyGoalProvider` | Date string; gates the daily study-goal dialog |
| `study_goal_hours_YYYY-MM-DD` | `StudyGoalProvider` | Int; hours the user committed to that day |

Nothing in the app currently syncs any of this to Supabase or the Python backend — it is 100%
on-device and lost on uninstall / app-data clear.

---

## Data Flow Walkthroughs

### First launch → onboarded → chatting with NESH
1. `main()` builds a `UserProfileProvider` and `.load()`s it from SharedPreferences **before**
   `runApp()`.
2. `SplashScreen` plays its intro animation, then checks `UserProfileProvider.hasProfile`.
   First-ever launch → no profile → routes to `/onboarding`.
3. `OnboardingScreen` walks 4–5 steps, mutating `UserProfileProvider`'s in-memory
   `OnboardingState` via `setLevel/setSyllabus/setMedium/setStream`. On the last step,
   `completeOnboarding()` persists the finished `UserProfile` to SharedPreferences and routes to
   `/login`.
4. `LoginScreen` — user fills the form and taps Login/Sign Up. **Currently this just navigates to
   `/home`** without calling Supabase (see [Authentication Flow](#authentication-flow) gap).
5. `HomeScreen` mounts. `go_router`'s redirect now sees `hasProfile == true` so all tabs are
   reachable. On first frame, `DailyCheckInProvider` and `StudyGoalProvider` are consulted; their
   dialogs may appear once per day.
6. User taps "AI Assistant" → `AiChatScreen`. Typing a question calls `POST /chat/ask` with the
   (currently hardcoded) student context + last 6 turns of local chat history. The answer is
   displayed, spoken aloud, and persisted into `ChatHistoryProvider` under today's date key.
7. Next day, if the check-in dialog's "Recap Yesterday" option is chosen, `RecapScreen` reads back
   yesterday's `ChatHistoryProvider` entries and `PlannerProvider` tasks — a purely local read of
   what was written in step 6 / the planner flow below.

### Study goal → auto-generated planner tasks
1. `StudyGoalDialog` (shown once/day from `HomeScreen`) lets the user pick 1–8 hours via a slider.
2. On "Create My Plan": `StudyPlanGenerator.generate(totalHours, stream: profile?.stream)`
   deterministically builds `PlannerTask`s — 45-minute sessions cycling through a
   stream-appropriate subject list (e.g. Commerce → Economics/Accounting/Business Studies;
   falls back to generic "Focused Review/Practice Questions/Revision" if no stream is set).
3. Each generated task is inserted into `PlannerProvider` for *today's* date (persisted to
   SharedPreferences), and `StudyGoalProvider.setGoalForToday(hours)` records the commitment so the
   dialog won't reappear today.
4. `PlannerScreen`, when the user navigates to `/planner`, reads these same tasks back via
   `PlannerProvider.tasksFor(selectedDate)`.

### Theme / accessibility
1. `SettingsScreen` reads/writes `AppThemeProvider` (theme preset + color-blind toggle).
2. `AppThemeProvider.setTheme()` / `setColorBlindMode()` call module-level setter functions
   (`setActiveTheme`, `setGlobalColorBlindMode`) in `core/theme/app_theme.dart` that back the
   static `AppColors.*` getters used throughout the entire UI — so every screen re-reads color
   values from this single mutable global on rebuild. This state is **not persisted**; it resets on
   app restart.

---

## What's Actually Wired Up vs. Mocked

| Feature | Status |
|---|---|
| Onboarding survey → local profile | ✅ Real (SharedPreferences) |
| Supabase sign up / sign in / sign out (`AuthProvider`) | ✅ Implemented, but ⚠️ **not called** by `LoginScreen` or the Settings log-out button |
| Supabase `students` profile sync | ⚠️ Insert-on-signup implemented; upsert-after-onboarding implemented but **never invoked** |
| NESH AI Chat (`POST /chat/ask`) | ✅ Real network call, real response rendering, real TTS/STT |
| Chat history (local, for Recap) | ✅ Real (SharedPreferences) |
| Daily check-in / study-goal dialogs | ✅ Real (SharedPreferences-gated) |
| Study plan auto-generation | ✅ Real (deterministic, client-side, feeds real Planner data) |
| Planner (add/toggle/delete tasks) | ✅ Real (SharedPreferences) |
| Theme switching + color-blind mode | ✅ Real (in-memory only, not persisted) |
| Analytics / Progress screen | ❌ 100% hardcoded mock data |
| Flashcards | ❌ 100% hardcoded mock data, in-memory-only deck creation |
| Past Papers | ❌ 100% hardcoded mock data |
| RAG Search | ❌ Client-side filtering over hardcoded lists; "Ask NESH" ignores the typed query |
| Pomodoro | ⚠️ Fully functional timer UI, but zero persistence — sessions aren't saved anywhere |
| Upload/Scan screen | ❌ Not implemented — file is empty (see below) |
| Settings profile card | ❌ Hardcoded name/email, ignores logged-in user |

---

## Dead / Empty Files

These exist in the repo but are **zero-byte or otherwise unreferenced** — noted so they aren't
mistaken for working code when planning backend integration:

- `lib/services/api_services.dart` — empty
- `lib/services/auth_service.dart` — empty
- `lib/services/storage-service.dart` — empty
- `lib/features/auth/nesh_ai_chat/providers/chat_provider.dart` — empty, not registered (real chat
  state lives in `lib/providers/chat_history_provider.dart`)
- `lib/features/auth/nesh_ai_chat/models/chat_message.dart` — empty (`AiChatScreen` defines its own
  private `_ChatMessage` class inline instead)
- `lib/features/auth/upload_scan/screens/upload_screen.dart` — empty; not routed anywhere
- `lib/features/dashboard/widgets/*.dart` (`focus_card.dart`, `greeting_header.dart`,
  `quick_actions_grid.dart`, `schedule_section.dart`, `subject_section.dart`) and
  `lib/features/dashboard/widgets/widgets/quick_actions_grid.dart` — not imported by anything;
  `HomeScreen` (`home_screen_v2.dart`) defines its own private equivalents inline
- `lib/features/auth/rag_search/screens/rag_search_screen.dart` and
  `lib/core/past_papers/screens/past_papers_screen.dart` — byte-for-byte duplicates of the routed
  `lib/features/rag_search/screens/rag_search_screen.dart` and
  `lib/features/past_papers/screens/past_papers_screen.dart`; the router only wires up the latter
  two (the ones under `lib/features/rag_search/` and `lib/features/past_papers/`)

---

## Project Structure

```
lib/
├── main.dart                      # App entry: Supabase.initialize, MultiProvider, MaterialApp.router
├── routes/
│   └── app_router.dart            # go_router config, AppRoutes, AppTab, tab list
├── core/
│   ├── constants/
│   │   ├── app_constants.dart     # Supabase + backend URLs, endpoint paths
│   │   └── syllabus.dart          # Static subject catalogue per level/syllabus/stream
│   ├── theme/
│   │   └── app_theme.dart         # AppThemeProvider, AppColors/AppTextStyles/AppRadius/AppShadows
│   ├── utils/helpers.dart         # (empty)
│   └── past_papers/screens/...    # (unused duplicate — see Dead Files)
├── providers/                     # App-wide ChangeNotifiers (registered in main.dart)
│   ├── auth_provider.dart
│   ├── user_profile_provider.dart
│   ├── planner_provider.dart
│   ├── chat_history_provider.dart
│   ├── daily_checkin_provider.dart
│   └── study_goal_provider.dart
├── services/
│   └── study_plan_generator.dart  # Deterministic task generator for the study-goal flow
├── shared/
│   ├── models/user_profile.dart   # UserProfile + StudyLevel/Syllabus/Medium/ALStream enums
│   └── widgets/navbar/main_shell.dart  # Bottom tab bar shell
└── features/
    ├── auth/
    │   ├── nesh_ai_chat/screens/  # splash, onboarding, login, ai_chat
    │   ├── planner/screens/       # planner UI + its own local provider/model copies
    │   ├── analytics/screens/
    │   ├── settings/screens/
    │   ├── rag_search/screens/    # (unused duplicate — see Dead Files)
    │   ├── upload_scan/screens/   # (empty — see Dead Files)
    │   ├── steps/                 # onboarding step widgets
    │   └── widgets/                # OptionCard, StreamCard
    ├── dashboard/
    │   ├── screens/home_screen_v2.dart   # the actual routed home screen
    │   └── widgets/                # (unused duplicates — see Dead Files)
    ├── checkin/screens/           # daily_checkin_dialog, meditation, recap
    ├── study_goal/screens/study_goal_dialog.dart
    ├── flashcards/screens/
    ├── rag_search/screens/        # the routed copy
    ├── pomodoro/screens/
    └── past_papers/screens/       # the routed copy
```
