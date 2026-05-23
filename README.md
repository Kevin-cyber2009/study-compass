# Study Compass

Mobile-first Android study planner with Gemini-powered study planning.

## Setup Gemini

Create a local `.env` file from `.env.example`:

```env
GEMINI_API_KEY=your_new_gemini_key
GEMINI_MODEL=gemini-2.5-flash-lite
MOCK_AI=false
AI_REQUEST_SECRET=
AI_RATE_LIMIT_MAX=20
AI_RATE_LIMIT_WINDOW_MS=60000
API_PORT=8787
API_HOST=0.0.0.0
VITE_API_BASE_URL=http://localhost:8787
VITE_AI_REQUEST_SECRET=
```

Do not put a real key in `.env.example`, GitHub, screenshots, or app source code.

## Test AI screens without spending Gemini quota

For UI testing, run the backend in mock mode:

```env
MOCK_AI=true
VITE_API_BASE_URL=http://localhost:8787
```

Then start the app with `npm start`. The AI planner, tutor chat, and mistake analysis endpoints will return deterministic mock responses instead of calling Gemini. Set `MOCK_AI=false` again when you want to test the real Gemini API.

If you test through Render, set the same `MOCK_AI=true` environment variable in the Render Web Service and redeploy. Otherwise the app will keep calling the real Gemini key on Render.

## Protect the public AI endpoint during testing

The Android/web app should never contain `GEMINI_API_KEY`. The backend owns that key, but the backend URL is still public, so protect it while testing:

```env
AI_REQUEST_SECRET=make-a-long-random-test-string
AI_RATE_LIMIT_MAX=20
AI_RATE_LIMIT_WINDOW_MS=60000
```

Then rebuild the app with the matching non-Gemini test header:

```env
VITE_AI_REQUEST_SECRET=make-a-long-random-test-string
```

This header is only a test gate because anything in `VITE_*` is bundled into the app. For production, use real account sessions/tokens and per-user AI quotas.

## Run locally

Start the Gemini backend:

```bash
npm run api
```

Start the mobile web preview:

```bash
npm run dev
```

Or run both together:

```bash
npm start
```

Open the app, go to the AI tab, then tap `Tạo bằng Gemini`.

## Deploy API on Render

Create a Render PostgreSQL database first, then create a Render Web Service from this repository.

Use these Web Service settings:

```text
Runtime: Node
Build Command: npm install
Start Command: npm run api
```

Set these environment variables in Render:

```env
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash
API_HOST=0.0.0.0
DATABASE_URL=your_render_internal_database_url
```

Render provides `PORT` automatically, so you do not need to set `API_PORT` there. After deploy, check:

```text
https://your-render-service.onrender.com/api/health
```

Then set your local app build to call Render:

```env
VITE_API_BASE_URL=https://your-render-service.onrender.com
```

Rebuild and sync Android after changing `VITE_API_BASE_URL`.

## Run API with Local PostgreSQL and pgAdmin

Install PostgreSQL and pgAdmin directly on Windows. Create a database and user:

```sql
create database study_compass;
create user study_compass with encrypted password 'study_compass_dev';
grant all privileges on database study_compass to study_compass;
\c study_compass
grant usage, create on schema public to study_compass;
```

Set your local `.env`:

```env
DATABASE_URL=postgres://study_compass:study_compass_dev@localhost:5432/study_compass
API_HOST=0.0.0.0
API_PORT=8787
VITE_API_BASE_URL=http://192.168.1.52:8787
```

Start the API:

```bash
npm run api
```

The API will create its tables automatically on startup. Check:

```text
http://localhost:8787/api/health
```

In pgAdmin, add your local PostgreSQL server:

```text
Host: localhost
Port: 5432
Database: study_compass
Username: study_compass
Password: study_compass_dev
```

For phone testing on the same Wi-Fi, keep `VITE_API_BASE_URL` set to the computer LAN IP:

```env
VITE_API_BASE_URL=http://192.168.1.52:8787
```

Check from the phone browser:

```text
http://192.168.1.52:8787/api/health
```

The health response should include `database.connected: true`.

If you want to test from outside your home Wi-Fi, configure port forwarding on your router:

```text
External TCP 8787 -> 192.168.1.52:8787
```

Then set `VITE_API_BASE_URL` to your public IP or domain and rebuild the APK. Do not expose pgAdmin (`5050`) to the internet.

The phone should call your API server, and your API server calls Gemini. Do not put `GEMINI_API_KEY` inside the Android app because APK files can be decompiled.

## Android

Sync the Android project after every web build:

```bash
npm run android:sync
npm run android:open
```

For a real phone build, `VITE_API_BASE_URL` must point to a reachable backend URL, not `localhost`.
During local testing on the same Wi-Fi network, use your computer LAN IP, for example:

```env
VITE_API_BASE_URL=http://192.168.1.10:8787
```

On Windows, you can check your LAN IP with:

```powershell
Get-NetIPAddress -AddressFamily IPv4
```

For this machine right now, the detected LAN test URL is:

```text
http://192.168.1.52:8787
```

Keep the backend running while testing on your phone:

```bash
npm run api
```

Then open `http://192.168.1.52:8787/api/health` from the phone browser. If it returns JSON, the phone can reach the AI backend.

Build a debug APK after Android Studio SDK is installed:

```bash
cd android
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
gradlew.bat assembleDebug
```

The APK will be created at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Current features

- Gemini study plan generation.
- Gemini mistake analysis journal with fix suggestions and review tasks.
- Import today's Gemini schedule into the study calendar.
- Import mistake-fix tasks into the study calendar.
- Study calendar with completion tracking.
- Pomodoro focus timer.
- Android real app-usage tracking with Usage Access permission, plus web/mock fallback.
- Achievement profile.
- Social learning feed for flexing grades, streaks, contests, and proof of study.
- Feed question posts for asking classmates about difficult exercises.
- Local image proof upload and preview in feed posts.
- Upgraded streak tiers and goal-change shortcut.
- Android native shell polish: status bar styling, splash screen control, and hardware back button navigation.
- Prototype account system: register, login, logout, and personalized profile/feed names.
- PostgreSQL-backed auth, study goal, study tasks, proof count, and completion session records when `DATABASE_URL` is set, with local fallback when the API/database is unavailable.
- PostgreSQL-backed social feed API for posts, comments, and study groups when `DATABASE_URL` is set.

## Device Usage Tracking

Real app-usage tracking now uses native Android `UsageStatsManager`. On the phone, open the Focus tab, tap `Cấp quyền Usage Access`, enable Study Compass in Android settings, then return to the app and tap refresh. The web preview still uses mock data because browsers cannot read Android app usage.

When `DATABASE_URL` is not set or the API is unreachable, the app falls back to `localStorage` so the prototype still works offline. Before publishing, add production-grade auth sessions/tokens and password reset flows.
