import "dotenv/config";
import cors from "cors";
import crypto from "node:crypto";
import express from "express";
import os from "node:os";
import pg from "pg";

const app = express();
const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const host = process.env.API_HOST || "0.0.0.0";
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const geminiModels = getGeminiModels(
  model,
  process.env.GEMINI_FALLBACK_MODELS || ""
);
const mockAi = isTruthyEnv(process.env.MOCK_AI);
const aiRequestSecret = String(process.env.AI_REQUEST_SECRET || "").trim();
const aiRateLimitWindowMs = Number(process.env.AI_RATE_LIMIT_WINDOW_MS || 60_000);
const aiRateLimitMax = Number(process.env.AI_RATE_LIMIT_MAX || 20);
const aiRateLimitBuckets = new Map();
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "12mb" }));

app.use((request, response, next) => {
  const startedAt = Date.now();

  response.on("finish", () => {
    console.log(
      `${request.method} ${request.originalUrl} -> ${response.statusCode} ${Date.now() - startedAt}ms`
    );
  });

  next();
});

app.get("/api/health", async (_request, response) => {
  const database = await getDatabaseHealth();

  response.json({
    ok: true,
    model: geminiModels[0],
    fallbackModels: geminiModels.slice(1),
    mockAi,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    database,
    lanUrls: getLanUrls(port)
  });
});

app.post("/api/auth/register", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const user = sanitizeAuthUser(request.body);
  if (!user.email || !user.password) {
    return response.status(400).json({ error: "Email and password are required." });
  }

  try {
    const result = await pool.query(
      `insert into app_users (display_name, email, password_hash)
       values ($1, $2, $3)
       returning id, display_name, email, created_at, proof_count, avatar`,
      [user.name || "Hoc sinh moi", user.email, hashPassword(user.password)]
    );
    const created = normalizeUser(result.rows[0]);
    await upsertGoal(created.id, sanitizeGoal(request.body?.goal));
    if (Array.isArray(request.body?.tasks)) {
      await replaceTasks(created.id, request.body.tasks.slice(0, 100).map(sanitizeTask));
    }
    if (Array.isArray(request.body?.deadlines)) {
      await replaceDeadlines(created.id, request.body.deadlines.slice(0, 100).map(sanitizeDeadline));
    }
    if (request.body?.studyRhythm) {
      await upsertStudyRhythm(created.id, sanitizeStudyRhythm(request.body.studyRhythm));
    }
    if (Array.isArray(request.body?.focusSessions)) {
      await replaceFocusSessions(created.id, request.body.focusSessions.slice(0, 120).map(sanitizeFocusSession));
    }
    response.status(201).json({ user: created, state: await getStudyState(created.id) });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({ error: "Email already exists." });
    }
    response.status(500).json({ error: error.message || "Cannot register user." });
  }
});

app.post("/api/auth/login", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const user = sanitizeAuthUser(request.body);
  if (!user.email || !user.password) {
    return response.status(400).json({ error: "Email and password are required." });
  }

  try {
    const result = await pool.query(
      `select id, display_name, email, password_hash, created_at, proof_count, avatar
       from app_users
       where email = $1`,
      [user.email]
    );
    const found = result.rows[0];

    if (!found || !verifyPassword(user.password, found.password_hash)) {
      return response.status(401).json({ error: "Invalid email or password." });
    }

    const safeUser = normalizeUser(found);
    response.json({ user: safeUser, state: await getStudyState(safeUser.id) });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot login." });
  }
});

app.get("/api/users/:userId/study-state", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  try {
    response.json(await getStudyState(userId));
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot load study state." });
  }
});

app.put("/api/users/:userId/goal", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  try {
    response.json(await upsertGoal(userId, sanitizeGoal(request.body?.goal)));
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot save goal." });
  }
});

app.put("/api/users/:userId/tasks", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  const tasks = Array.isArray(request.body?.tasks)
    ? request.body.tasks.slice(0, 100).map(sanitizeTask)
    : [];

  try {
    const saved = await replaceTasks(userId, tasks);
    response.json({ tasks: saved });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot save tasks." });
  }
});

app.put("/api/users/:userId/deadlines", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  const deadlines = Array.isArray(request.body?.deadlines)
    ? request.body.deadlines.slice(0, 100).map(sanitizeDeadline)
    : [];

  try {
    const saved = await replaceDeadlines(userId, deadlines);
    response.json({ deadlines: saved });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot save deadlines." });
  }
});

app.put("/api/users/:userId/study-rhythm", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  try {
    const studyRhythm = await upsertStudyRhythm(userId, sanitizeStudyRhythm(request.body?.studyRhythm));
    response.json({ studyRhythm });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot save study rhythm." });
  }
});

app.get("/api/users/:userId/focus-sessions", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  try {
    response.json({ focusSessions: await listFocusSessions(userId) });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot load focus sessions." });
  }
});

app.post("/api/users/:userId/focus-sessions", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  try {
    const session = await saveFocusSession(userId, sanitizeFocusSession(request.body?.session));
    const [studyStats, leaderboard] = await Promise.all([
      getUserStudyStats(userId),
      listStudyLeaderboard(userId)
    ]);
    response.status(201).json({ session, studyStats, leaderboard });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot save focus session." });
  }
});

app.put("/api/users/:userId/profile", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  const body = request.body || {};
  const hasProofs = Object.prototype.hasOwnProperty.call(body, "proofs");
  const hasName = typeof body.name === "string";
  const hasAvatar = typeof body.avatar === "string";
  const proofs = Math.max(0, Math.min(100000, Number(body.proofs || 0)));
  const name = String(body.name || "").trim().slice(0, 80);
  const avatar = String(body.avatar || "").slice(0, 2_800_000);

  try {
    const result = await pool.query(
      `update app_users
       set
         proof_count = case when $2 then $3 else proof_count end,
         display_name = case when $4 and $5 <> '' then $5 else display_name end,
         avatar = case when $6 then $7 else avatar end
       where id = $1
       returning id, display_name, email, created_at, proof_count, avatar`,
      [userId, hasProofs, proofs, hasName, name, hasAvatar, avatar]
    );
    response.json({ user: normalizeUser(result.rows[0]) });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot save profile." });
  }
});

app.get("/api/social", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.query.userId || 0);

  try {
    const [posts, groups] = await Promise.all([
      listPosts(),
      listGroups(Number.isFinite(userId) && userId > 0 ? userId : null)
    ]);
    response.json({ posts, groups });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot load social data." });
  }
});

app.get("/api/leaderboard", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.query.userId || 0);

  try {
    response.json({
      leaderboard: await listStudyLeaderboard(Number.isFinite(userId) && userId > 0 ? userId : null)
    });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot load leaderboard." });
  }
});

app.post("/api/posts", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const post = sanitizePost(request.body?.post);
  const userId = Number(request.body?.userId || 0);
  const safeUserId = Number.isFinite(userId) && userId > 0 ? userId : null;

  try {
    const result = await pool.query(
      `insert into social_posts (user_id, author, author_avatar, type, content, proof, image, study_minutes, likes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 0)
       returning id`,
      [safeUserId, post.author, post.authorAvatar, post.type, post.content, post.proof, post.image, post.studyMinutes]
    );
    const created = await getPost(result.rows[0].id);
    response.status(201).json(created);
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot create post." });
  }
});

app.post("/api/posts/:id/comments", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const comment = sanitizeComment(request.body?.comment);
  const postId = Number(request.params.id);

  if (!Number.isFinite(postId)) {
    return response.status(400).json({ error: "Invalid post id." });
  }

  try {
    const result = await pool.query(
      `insert into post_comments (post_id, author, content)
       values ($1, $2, $3)
       returning id, author, content, created_at`,
      [postId, comment.author, comment.content]
    );
    response.status(201).json(normalizeComment(result.rows[0]));
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot create comment." });
  }
});

app.post("/api/groups", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const group = sanitizeGroup(request.body?.group);
  const userId = Number(request.body?.userId || 0);
  const safeUserId = Number.isFinite(userId) && userId > 0 ? userId : null;

  try {
    const result = await pool.query(
      `insert into study_groups (name, description, owner_name, members, streak, rank)
       values ($1, $2, $3, 0, 1, 99)
       returning id`,
      [group.name, group.description, group.ownerName]
    );
    if (safeUserId) {
      await joinGroupMember(result.rows[0].id, safeUserId, group.ownerName);
    }
    const created = await getGroup(result.rows[0].id);
    response.status(201).json({ ...created, joined: Boolean(safeUserId) });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot create group." });
  }
});

app.post("/api/groups/:id/join", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const groupId = Number(request.params.id);
  if (!Number.isFinite(groupId)) return response.status(400).json({ error: "Invalid group id." });

  const userId = Number(request.body?.userId || 0);
  const memberName = String(request.body?.memberName || "Hoc sinh").slice(0, 80);
  if (!Number.isFinite(userId) || userId <= 0) return response.status(400).json({ error: "User id is required." });

  try {
    const joined = await joinGroupMember(groupId, userId, memberName);
    if (!joined) return response.status(404).json({ error: "Group not found." });
    response.json({ ...(await getGroup(groupId)), joined: true });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot join group." });
  }
});

app.delete("/api/groups/:id/join", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const groupId = Number(request.params.id);
  const userId = Number(request.body?.userId || 0);

  if (!Number.isFinite(groupId)) return response.status(400).json({ error: "Invalid group id." });
  if (!Number.isFinite(userId) || userId <= 0) return response.status(400).json({ error: "User id is required." });

  try {
    const result = await pool.query(
      `delete from group_members
       where group_id = $1 and user_id = $2`,
      [groupId, userId]
    );

    if (result.rowCount > 0) {
      await pool.query(
        `update study_groups
         set members = greatest(0, members - 1)
         where id = $1`,
        [groupId]
      );
    }

    response.json({ ...(await getGroup(groupId)), joined: false });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot leave group." });
  }
});

app.post("/api/study-plan", async (request, response) => {
  const goal = sanitizeGoal(request.body?.goal);
  const blocked = guardAiRequest(request, response);
  if (blocked) return;

  if (mockAi) {
    const parsed = mockStudyPlan(goal);
    await saveAiEvent("study-plan:mock", goal, parsed);
    return response.json({ ...parsed, model: "mock" });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return response.status(500).json({
      error: "GEMINI_API_KEY is missing. Create .env from .env.example and put your new key there."
    });
  }

  try {
    const { data, usedModel } = await generateGeminiContent({
      apiKey,
      prompt: buildStudyPrompt(goal),
      generationConfig: {
        temperature: 0.45,
        maxOutputTokens: 900,
        responseMimeType: "application/json"
      }
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parsePlan(text);
    await saveAiEvent("study-plan", goal, parsed);

    response.json({ ...parsed, model: usedModel });
  } catch (error) {
    if (shouldFallbackFromGeminiError(error)) {
      const parsed = withFallbackWarning(mockStudyPlan(goal), toClientGeminiError(error));
      await saveAiEvent("study-plan:fallback", goal, parsed);
      return response.json({ ...parsed, model: "fallback" });
    }

    response.status(error.status || 500).json({ error: toClientGeminiError(error) });
  }
});

app.post("/api/mistake-analysis", async (request, response) => {
  const mistake = sanitizeMistake(request.body?.mistake);
  const blocked = guardAiRequest(request, response);
  if (blocked) return;

  if (mockAi) {
    const parsed = mockMistakeAnalysis(mistake);
    await saveAiEvent("mistake-analysis:mock", mistake, parsed);
    return response.json({ ...parsed, model: "mock" });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return response.status(500).json({
      error: "GEMINI_API_KEY is missing. Create .env from .env.example and put your new key there."
    });
  }

  try {
    const { data, usedModel } = await generateGeminiContent({
      apiKey,
      prompt: buildMistakePrompt(mistake),
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 700,
        responseMimeType: "application/json"
      }
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parseMistakeAnalysis(text);
    await saveAiEvent("mistake-analysis", mistake, parsed);

    response.json({ ...parsed, model: usedModel });
  } catch (error) {
    if (shouldFallbackFromGeminiError(error)) {
      const parsed = withFallbackWarning(mockMistakeAnalysis(mistake), toClientGeminiError(error));
      await saveAiEvent("mistake-analysis:fallback", mistake, parsed);
      return response.json({ ...parsed, model: "fallback" });
    }

    response.status(error.status || 500).json({ error: toClientGeminiError(error) });
  }
});

app.post("/api/tutor-chat", async (request, response) => {
  const tutorRequest = sanitizeTutorRequest(request.body);
  const blocked = guardAiRequest(request, response);
  if (blocked) return;

  if (mockAi) {
    const parsed = mockTutorAnswer(tutorRequest);
    await saveAiEvent("tutor-chat:mock", tutorRequest, parsed);
    return response.json({ ...parsed, model: "mock" });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return response.status(500).json({
      error: "GEMINI_API_KEY is missing. Create .env from .env.example and put your new key there."
    });
  }

  try {
    const { data, usedModel } = await generateGeminiContent({
      apiKey,
      prompt: buildTutorPrompt(tutorRequest),
      generationConfig: {
        temperature: 0.55,
        maxOutputTokens: 900,
        responseMimeType: "application/json"
      }
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parseTutorAnswer(text);
    await saveAiEvent("tutor-chat", tutorRequest, parsed);

    response.json({ ...parsed, model: usedModel });
  } catch (error) {
    if (shouldFallbackFromGeminiError(error)) {
      const parsed = withFallbackWarning(mockTutorAnswer(tutorRequest), toClientGeminiError(error));
      await saveAiEvent("tutor-chat:fallback", tutorRequest, parsed);
      return response.json({ ...parsed, model: "fallback" });
    }

    response.status(error.status || 500).json({ error: toClientGeminiError(error) });
  }
});

initDatabase()
  .then(() => {
    app.listen(port, host, () => {
      console.log(`Study Compass API running on http://localhost:${port}`);
      for (const url of getLanUrls(port)) {
        console.log(`LAN test URL: ${url}`);
      }
    });
  })
  .catch((error) => {
    console.error("Failed to initialize Study Compass API.", error);
    process.exit(1);
  });

function getLanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item?.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}`);
}

function getGeminiModels(primary, fallbacks) {
  return [primary, ...String(fallbacks || "").split(",")]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, models) => models.indexOf(item) === index);
}

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function guardAiRequest(request, response) {
  if (!mockAi && aiRequestSecret && request.get("x-study-compass-key") !== aiRequestSecret) {
    response.status(401).json({ error: "AI endpoint is locked for this deployment." });
    return true;
  }

  const now = Date.now();
  const key = request.ip || request.get("x-forwarded-for") || "unknown";
  const bucket = aiRateLimitBuckets.get(key) || { count: 0, resetAt: now + aiRateLimitWindowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + aiRateLimitWindowMs;
  }

  bucket.count += 1;
  aiRateLimitBuckets.set(key, bucket);
  pruneAiRateLimitBuckets(now);

  if (bucket.count > aiRateLimitMax) {
    response.status(429).json({
      error: "AI test limit reached. Wait a little before asking again.",
      retryAfterMs: Math.max(0, bucket.resetAt - now)
    });
    return true;
  }

  return false;
}

function pruneAiRateLimitBuckets(now) {
  if (aiRateLimitBuckets.size < 500) return;

  for (const [key, bucket] of aiRateLimitBuckets.entries()) {
    if (now > bucket.resetAt) {
      aiRateLimitBuckets.delete(key);
    }
  }
}

async function generateGeminiContent({ apiKey, prompt, generationConfig }) {
  let lastError = null;

  for (const currentModel of geminiModels) {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig
        })
      }
    );

    const data = await readJson(geminiResponse);

    if (geminiResponse.ok) {
      return { data, usedModel: currentModel };
    }

    const message = data?.error?.message || "Gemini request failed.";
    lastError = createGeminiError(geminiResponse.status, message, currentModel);
    console.warn(`Gemini ${currentModel} failed: ${geminiResponse.status} ${message}`);

    if (!canTryNextGeminiModel(geminiResponse.status, message)) {
      break;
    }
  }

  throw lastError || createGeminiError(500, "Gemini request failed.", geminiModels[0]);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function createGeminiError(status, message, currentModel) {
  const error = new Error(message);
  error.status = status;
  error.model = currentModel;
  return error;
}

function canTryNextGeminiModel(status, message) {
  if (/quota|exceeded|rate limit/i.test(message)) {
    return false;
  }

  return [500, 502, 503, 504].includes(status) || (status === 429 && /high demand|overloaded/i.test(message));
}

function toClientGeminiError(error) {
  const message = error?.message || "Unexpected Gemini error.";

  if (/quota|exceeded|rate limit/i.test(message)) {
    return "Gemini đang bận hoặc tạm hết lượt. Vui lòng thử lại sau ít phút.";
  }

  if (/high demand|overloaded|try again/i.test(message)) {
    return "Gemini đang quá tải tạm thời. Vui lòng thử lại sau 1-2 phút.";
  }

  return message;
}

function shouldFallbackFromGeminiError(error) {
  const message = error?.message || "";
  return /quota|exceeded|rate limit|high demand|overloaded|try again/i.test(message);
}

async function initDatabase() {
  if (!pool) {
    console.log("DATABASE_URL is not set. Running without PostgreSQL persistence.");
    return;
  }

  await pool.query(`
    create table if not exists ai_events (
      id bigserial primary key,
      type text not null,
      request jsonb not null,
      response jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists app_users (
      id bigserial primary key,
      display_name text not null,
      email text unique not null,
      password_hash text,
      proof_count integer not null default 0,
      avatar text not null default '',
      created_at timestamptz not null default now()
    );

    alter table app_users add column if not exists proof_count integer not null default 0;
    alter table app_users add column if not exists avatar text not null default '';

    create table if not exists study_goals (
      user_id bigint primary key references app_users(id) on delete cascade,
      subject text not null,
      target text not null,
      exam_date text not null default '',
      level text not null,
      hours_per_day integer not null default 1,
      updated_at timestamptz not null default now()
    );

    create table if not exists study_tasks (
      id bigserial primary key,
      user_id bigint references app_users(id) on delete cascade,
      day_label text not null default 'Hom nay',
      block_time text not null default '20:00',
      title text not null,
      mode text not null default 'Hoc sau',
      minutes integer not null default 45,
      done boolean not null default false,
      created_at timestamptz not null default now()
    );

    create table if not exists study_sessions (
      id bigserial primary key,
      user_id bigint references app_users(id) on delete cascade,
      task_id bigint references study_tasks(id) on delete set null,
      title text not null,
      minutes integer not null default 0,
      completed_at timestamptz not null default now()
    );

    create table if not exists study_deadlines (
      id bigserial primary key,
      user_id bigint references app_users(id) on delete cascade,
      title text not null,
      subject text not null,
      due_date text not null default '',
      due_time text not null default '20:00',
      scope text not null default 'short',
      priority text not null default 'medium',
      reminder_lead integer not null default 1440,
      note text not null default '',
      done boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists study_deadlines_user_due_idx
      on study_deadlines (user_id, due_date, due_time);

    create table if not exists study_rhythm (
      user_id bigint primary key references app_users(id) on delete cascade,
      preset text not null default 'deep',
      study_minutes integer not null default 45,
      break_minutes integer not null default 10,
      review_minutes integer not null default 8,
      relax_limit_minutes integer not null default 30,
      updated_at timestamptz not null default now()
    );

    create table if not exists focus_sessions (
      id bigserial primary key,
      user_id bigint references app_users(id) on delete cascade,
      client_id text not null,
      subject text not null,
      anchor_type text not null default 'goal',
      anchor_label text not null,
      planned_minutes integer not null default 25,
      actual_minutes integer not null default 1,
      actual_seconds integer not null default 60,
      note text not null default '',
      started_at timestamptz not null default now(),
      ended_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      unique (user_id, client_id)
    );

    create index if not exists focus_sessions_user_ended_idx
      on focus_sessions (user_id, ended_at desc);

    create table if not exists social_posts (
      id bigserial primary key,
      user_id bigint references app_users(id) on delete set null,
      author text not null,
      author_avatar text not null default '',
      type text not null,
      content text not null,
      proof text,
      image text,
      study_minutes integer not null default 0,
      likes integer not null default 0,
      created_at timestamptz not null default now()
    );

    alter table social_posts add column if not exists image text;
    alter table social_posts add column if not exists likes integer not null default 0;
    alter table social_posts add column if not exists author_avatar text not null default '';

    create table if not exists post_comments (
      id bigserial primary key,
      post_id bigint not null references social_posts(id) on delete cascade,
      author text not null,
      content text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists study_groups (
      id bigserial primary key,
      name text not null,
      description text not null default '',
      owner_name text not null,
      members integer not null default 1,
      streak integer not null default 1,
      rank integer not null default 99,
      created_at timestamptz not null default now()
    );

    create table if not exists group_members (
      group_id bigint not null references study_groups(id) on delete cascade,
      user_id bigint not null references app_users(id) on delete cascade,
      member_name text not null,
      joined_at timestamptz not null default now(),
      primary key (group_id, user_id)
    );
  `);

  await seedDatabase();

  console.log("PostgreSQL schema is ready.");
}

async function getDatabaseHealth() {
  if (!pool) return { connected: false, reason: "DATABASE_URL is not set" };

  try {
    const result = await pool.query("select now() as now");
    return { connected: true, now: result.rows[0].now };
  } catch (error) {
    return { connected: false, reason: error.message };
  }
}

async function saveAiEvent(type, request, response) {
  if (!pool) return;

  await pool.query(
    "insert into ai_events (type, request, response) values ($1, $2, $3)",
    [type, request, response]
  );
}

async function getStudyState(userId) {
  const [goalResult, tasksResult, deadlinesResult, rhythmResult, focusSessionsResult, userResult] = await Promise.all([
    pool.query(
      `select subject, target, exam_date, level, hours_per_day
       from study_goals
       where user_id = $1`,
      [userId]
    ),
    pool.query(
      `select id, day_label, block_time, title, mode, minutes, done
       from study_tasks
       where user_id = $1
       order by created_at asc, id asc`,
      [userId]
    ),
    pool.query(
      `select id, title, subject, due_date, due_time, scope, priority, reminder_lead, note, done
       from study_deadlines
       where user_id = $1
       order by done asc, due_date asc, due_time asc, created_at asc, id asc`,
      [userId]
    ),
    pool.query(
      `select preset, study_minutes, break_minutes, review_minutes, relax_limit_minutes
       from study_rhythm
       where user_id = $1`,
      [userId]
    ),
    pool.query(
      `select
         id,
         client_id,
         subject,
         anchor_type,
         anchor_label,
         planned_minutes,
         actual_minutes,
         actual_seconds,
         note,
         started_at,
         ended_at
       from focus_sessions
       where user_id = $1
       order by ended_at desc, id desc
       limit 120`,
      [userId]
    ),
    pool.query("select proof_count from app_users where id = $1", [userId])
  ]);
  const proofCount = Number(userResult.rows[0]?.proof_count || 0);
  const focusSessions = focusSessionsResult.rows.map(normalizeFocusSession);
  const [studyStats, leaderboard] = await Promise.all([
    getUserStudyStats(userId),
    listStudyLeaderboard(userId)
  ]);

  return {
    goal: goalResult.rows[0] ? normalizeGoal(goalResult.rows[0]) : null,
    tasks: tasksResult.rows.map(normalizeTask),
    deadlines: deadlinesResult.rows.map(normalizeDeadline),
    studyRhythm: rhythmResult.rows[0] ? normalizeStudyRhythm(rhythmResult.rows[0]) : null,
    focusSessions,
    studyStats,
    leaderboard,
    proofs: proofCount
  };
}

async function upsertGoal(userId, goal) {
  const result = await pool.query(
    `insert into study_goals (user_id, subject, target, exam_date, level, hours_per_day)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id) do update set
       subject = excluded.subject,
       target = excluded.target,
       exam_date = excluded.exam_date,
       level = excluded.level,
       hours_per_day = excluded.hours_per_day,
       updated_at = now()
     returning subject, target, exam_date, level, hours_per_day`,
    [userId, goal.subject, goal.target, goal.examDate, goal.level, goal.hoursPerDay]
  );

  return normalizeGoal(result.rows[0]);
}

async function replaceTasks(userId, tasks) {
  const previousDone = await pool.query(
    `select id, title, minutes, done
     from study_tasks
     where user_id = $1`,
    [userId]
  );
  const wasDone = new Map(previousDone.rows.map((task) => [Number(task.id), Boolean(task.done)]));

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from study_tasks where user_id = $1", [userId]);

    const saved = [];
    for (const task of tasks) {
      const values = [userId, task.day, task.block, task.title, task.mode, task.minutes, task.done];
      const hasExistingId = Number.isFinite(task.id);
      const result = hasExistingId
        ? await client.query(
          `insert into study_tasks (id, user_id, day_label, block_time, title, mode, minutes, done)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id, day_label, block_time, title, mode, minutes, done`,
          [task.id, ...values]
        )
        : await client.query(
          `insert into study_tasks (user_id, day_label, block_time, title, mode, minutes, done)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning id, day_label, block_time, title, mode, minutes, done`,
          values
        );
      const savedTask = normalizeTask(result.rows[0]);
      saved.push(savedTask);

      if (savedTask.done && !wasDone.get(savedTask.id)) {
        await client.query(
          `insert into study_sessions (user_id, task_id, title, minutes)
           values ($1, $2, $3, $4)`,
          [userId, savedTask.id, savedTask.title, savedTask.minutes]
        );
      }
    }

    await client.query("commit");
    return saved;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function replaceDeadlines(userId, deadlines) {
  const existingResult = await pool.query(
    `select id
     from study_deadlines
     where user_id = $1`,
    [userId]
  );
  const existingIds = new Set(existingResult.rows.map((deadline) => Number(deadline.id)));

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from study_deadlines where user_id = $1", [userId]);

    const saved = [];
    for (const deadline of deadlines) {
      const values = [
        userId,
        deadline.title,
        deadline.subject,
        deadline.dueDate,
        deadline.dueTime,
        deadline.scope,
        deadline.priority,
        deadline.reminderLead,
        deadline.note,
        deadline.done
      ];
      const hasExistingId = existingIds.has(deadline.id);
      const result = hasExistingId
        ? await client.query(
          `insert into study_deadlines (id, user_id, title, subject, due_date, due_time, scope, priority, reminder_lead, note, done)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning id, title, subject, due_date, due_time, scope, priority, reminder_lead, note, done`,
          [deadline.id, ...values]
        )
        : await client.query(
          `insert into study_deadlines (user_id, title, subject, due_date, due_time, scope, priority, reminder_lead, note, done)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning id, title, subject, due_date, due_time, scope, priority, reminder_lead, note, done`,
          values
        );

      saved.push(normalizeDeadline(result.rows[0]));
    }

    await client.query("commit");
    return saved;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertStudyRhythm(userId, studyRhythm) {
  const result = await pool.query(
    `insert into study_rhythm (user_id, preset, study_minutes, break_minutes, review_minutes, relax_limit_minutes)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id) do update set
       preset = excluded.preset,
       study_minutes = excluded.study_minutes,
       break_minutes = excluded.break_minutes,
       review_minutes = excluded.review_minutes,
       relax_limit_minutes = excluded.relax_limit_minutes,
       updated_at = now()
     returning preset, study_minutes, break_minutes, review_minutes, relax_limit_minutes`,
    [
      userId,
      studyRhythm.preset,
      studyRhythm.studyMinutes,
      studyRhythm.breakMinutes,
      studyRhythm.reviewMinutes,
      studyRhythm.relaxLimitMinutes
    ]
  );

  return normalizeStudyRhythm(result.rows[0]);
}

async function listFocusSessions(userId) {
  const result = await pool.query(
    `select
       id,
       client_id,
       subject,
       anchor_type,
       anchor_label,
       planned_minutes,
       actual_minutes,
       actual_seconds,
       note,
       started_at,
       ended_at
     from focus_sessions
     where user_id = $1
     order by ended_at desc, id desc
     limit 120`,
    [userId]
  );

  return result.rows.map(normalizeFocusSession);
}

async function replaceFocusSessions(userId, sessions) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from focus_sessions where user_id = $1", [userId]);

    const saved = [];
    for (const session of sessions) {
      saved.push(await saveFocusSession(userId, session, client));
    }

    await client.query("commit");
    return saved;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function saveFocusSession(userId, session, client = pool) {
  const result = await client.query(
    `insert into focus_sessions (
       user_id,
       client_id,
       subject,
       anchor_type,
       anchor_label,
       planned_minutes,
       actual_minutes,
       actual_seconds,
       note,
       started_at,
       ended_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (user_id, client_id) do update set
       subject = excluded.subject,
       anchor_type = excluded.anchor_type,
       anchor_label = excluded.anchor_label,
       planned_minutes = excluded.planned_minutes,
       actual_minutes = excluded.actual_minutes,
       actual_seconds = excluded.actual_seconds,
       note = excluded.note,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at
     returning
       id,
       client_id,
       subject,
       anchor_type,
       anchor_label,
       planned_minutes,
       actual_minutes,
       actual_seconds,
       note,
       started_at,
       ended_at`,
    [
      userId,
      session.clientId,
      session.subject,
      session.anchorType,
      session.anchorLabel,
      session.plannedMinutes,
      session.actualMinutes,
      session.actualSeconds,
      session.note,
      session.startedAt,
      session.endedAt
    ]
  );

  return normalizeFocusSession(result.rows[0]);
}

async function getUserStudyStats(userId) {
  const result = await pool.query(
    `select
       coalesce(sum(actual_minutes), 0)::int as total_minutes,
       count(*)::int as session_count,
       coalesce(
         array_agg(distinct to_char(ended_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD'))
           filter (where ended_at is not null),
         '{}'
       ) as study_dates
     from focus_sessions
     where user_id = $1`,
    [userId]
  );
  const user = await pool.query("select proof_count from app_users where id = $1", [userId]);
  const row = result.rows[0] || {};

  return makeStudyStats({
    totalMinutes: Number(row.total_minutes || 0),
    sessionCount: Number(row.session_count || 0),
    studyDates: row.study_dates || [],
    proofCount: Number(user.rows[0]?.proof_count || 0)
  });
}

async function listStudyLeaderboard(currentUserId = null) {
  const result = await pool.query(
    `select
       u.id,
       u.display_name,
       u.avatar,
       u.proof_count,
       coalesce(sum(fs.actual_minutes), 0)::int as total_minutes,
       count(fs.id)::int as session_count,
       coalesce(
         array_agg(distinct to_char(fs.ended_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD'))
           filter (where fs.id is not null),
         '{}'
       ) as study_dates
     from app_users u
     left join focus_sessions fs on fs.user_id = u.id
     group by u.id
     limit 200`
  );

  return result.rows
    .map((row) => {
      const stats = makeStudyStats({
        totalMinutes: Number(row.total_minutes || 0),
        sessionCount: Number(row.session_count || 0),
        studyDates: row.study_dates || [],
        proofCount: Number(row.proof_count || 0)
      });

      return {
        userId: Number(row.id),
        name: row.display_name,
        avatar: row.avatar || "",
        totalMinutes: stats.totalMinutes,
        sessionCount: stats.sessionCount,
        streakDays: stats.streak.days,
        rankTitle: stats.rank.title,
        points: stats.rank.points,
        isCurrentUser: currentUserId ? Number(row.id) === Number(currentUserId) : false
      };
    })
    .sort((left, right) => right.points - left.points || right.totalMinutes - left.totalMinutes || left.name.localeCompare(right.name))
    .map((item, index) => ({ ...item, position: index + 1 }))
    .slice(0, 50);
}

function makeStudyStats({ totalMinutes = 0, sessionCount = 0, studyDates = [], proofCount = 0 }) {
  const safeTotalMinutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
  const safeSessionCount = Math.max(0, Math.round(Number(sessionCount || 0)));
  const safeProofCount = Math.max(0, Math.round(Number(proofCount || 0)));
  const streak = calculateStudyStreak(studyDates);
  const points = safeTotalMinutes + safeSessionCount * 12 + streak.days * 30 + safeProofCount * 20;
  const rank = getRankInfo(points);

  return {
    totalMinutes: safeTotalMinutes,
    sessionCount: safeSessionCount,
    proofCount: safeProofCount,
    streak,
    rank
  };
}

function calculateStudyStreak(values = []) {
  const studyDays = new Set(
    values
      .map(toStudyDateKey)
      .filter(Boolean)
  );

  if (!studyDays.size) {
    return {
      days: 0,
      title: "Chưa có streak",
      progress: 0,
      next: "hoàn thành 1 phiên Focus để bắt đầu"
    };
  }

  const today = new Date();
  const todayKey = toStudyDateKey(today);
  const yesterday = addDays(today, -1);
  let cursor = studyDays.has(todayKey) ? today : yesterday;

  if (!studyDays.has(toStudyDateKey(cursor))) {
    return {
      days: 0,
      title: "Streak tạm nghỉ",
      progress: 0,
      next: "học một phiên hôm nay để nối lại"
    };
  }

  let days = 0;
  while (studyDays.has(toStudyDateKey(cursor))) {
    days += 1;
    cursor = addDays(cursor, -1);
  }

  const tiers = [
    { min: 30, title: "Legend Streak", nextAt: 45 },
    { min: 14, title: "Diamond Streak", nextAt: 30 },
    { min: 7, title: "Gold Streak", nextAt: 14 },
    { min: 3, title: "Silver Streak", nextAt: 7 },
    { min: 1, title: "Bronze Streak", nextAt: 3 }
  ];
  const tier = tiers.find((item) => days >= item.min) || tiers[tiers.length - 1];

  return {
    days,
    title: tier.title,
    progress: Math.min(100, Math.round((days / tier.nextAt) * 100)),
    next: days >= 45 ? "đang ở đỉnh bảng" : `còn ${Math.max(1, tier.nextAt - days)} ngày để lên hạng`
  };
}

function getRankInfo(points) {
  const safePoints = Math.max(0, Math.round(Number(points || 0)));
  const tiers = [
    { min: 0, title: "Tân binh", nextAt: 300 },
    { min: 300, title: "Bronze Scholar", nextAt: 900 },
    { min: 900, title: "Silver Scholar", nextAt: 1800 },
    { min: 1800, title: "Gold Scholar", nextAt: 3600 },
    { min: 3600, title: "Platinum Scholar", nextAt: 7200 },
    { min: 7200, title: "Diamond Scholar", nextAt: 12000 },
    { min: 12000, title: "Legend Scholar", nextAt: 12000 }
  ];
  const tier = [...tiers].reverse().find((item) => safePoints >= item.min) || tiers[0];
  const nextTier = tiers.find((item) => item.min > safePoints);
  const span = Math.max(1, (nextTier?.min || tier.nextAt) - tier.min);

  return {
    title: tier.title,
    points: safePoints,
    progress: nextTier ? Math.min(100, Math.round(((safePoints - tier.min) / span) * 100)) : 100,
    next: nextTier ? `còn ${nextTier.min - safePoints} điểm tới ${nextTier.title}` : "đang ở rank cao nhất"
  };
}

function toStudyDateKey(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(parsed);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

async function seedDatabase() {
  const postCount = await pool.query("select count(*)::int as count from social_posts");
  if (postCount.rows[0].count === 0) {
    await pool.query(
      `insert into social_posts (author, type, content, proof, study_minutes, likes)
       values
       ('Minh Anh', 'Điểm số', 'Vừa kéo bài kiểm tra Toán từ 6.5 lên 8.2 sau 2 tuần theo lịch AI.', 'Bảng điểm', 1260, 34),
       ('Quang Huy', 'Kỷ luật', 'Hoàn thành 4 phiên pomodoro 45 phút, không mở TikTok trong giờ học.', 'Timelapse', 180, 21)`
    );
  }

  const groupCount = await pool.query("select count(*)::int as count from study_groups");
  if (groupCount.rows[0].count === 0) {
    await pool.query(
      `insert into study_groups (name, description, owner_name, members, streak, rank)
       values
       ('Lớp Toán bứt tốc', 'Ôn hàm số, lượng giác và mini test mỗi tuần.', 'Minh Anh', 18, 9, 2),
       ('Ôn thi THPT tự học', 'Giữ lịch học đều, hỏi bài và chia sẻ đề.', 'Quang Huy', 42, 14, 5),
       ('Vật lý mỗi ngày', 'Mỗi ngày một chuyên đề nhỏ có minh chứng học.', 'Lan Chi', 12, 6, 1)`
    );
  }
}

async function listPosts() {
  const result = await pool.query(`
    select
      p.id,
      p.author,
      p.author_avatar,
      p.type,
      p.content,
      p.proof,
      p.image,
      p.study_minutes,
      p.likes,
      p.created_at,
      coalesce(
        json_agg(
          json_build_object(
            'id', c.id,
            'author', c.author,
            'content', c.content,
            'createdAt', c.created_at
          )
          order by c.created_at asc
        ) filter (where c.id is not null),
        '[]'
      ) as comments
    from social_posts p
    left join post_comments c on c.post_id = p.id
    group by p.id
    order by p.created_at desc
    limit 60
  `);

  return result.rows.map(normalizePost);
}

async function getPost(id) {
  const posts = await pool.query(
    `select
      p.id,
      p.author,
      p.author_avatar,
      p.type,
      p.content,
      p.proof,
      p.image,
      p.study_minutes,
      p.likes,
      p.created_at,
      '[]'::json as comments
     from social_posts p
     where p.id = $1`,
    [id]
  );

  return normalizePost(posts.rows[0]);
}

async function joinGroupMember(groupId, userId, memberName) {
  const exists = await pool.query("select id from study_groups where id = $1", [groupId]);
  if (!exists.rows[0]) return false;

  const inserted = await pool.query(
    `insert into group_members (group_id, user_id, member_name)
     values ($1, $2, $3)
     on conflict (group_id, user_id) do nothing`,
    [groupId, userId, memberName]
  );

  if (inserted.rowCount > 0) {
    await pool.query(
      `update study_groups
       set members = members + 1
       where id = $1`,
      [groupId]
    );
  }

  return true;
}

async function listGroups(userId = null) {
  const result = await pool.query(
    `select
       g.id,
       g.name,
       g.description,
       g.owner_name,
       g.members,
       g.streak,
       g.rank,
       g.created_at,
       case when gm.user_id is null then false else true end as joined
     from study_groups g
     left join group_members gm on gm.group_id = g.id and gm.user_id = $1
     order by g.rank asc, g.created_at desc
     limit 50`,
    [userId]
  );

  return result.rows.map(normalizeGroup);
}

async function getGroup(id) {
  const result = await pool.query(
    `select id, name, description, owner_name, members, streak, rank, created_at
     from study_groups
     where id = $1`,
    [id]
  );

  return normalizeGroup(result.rows[0]);
}

function normalizePost(row) {
  return {
    id: Number(row.id),
    author: row.author,
    authorAvatar: row.author_avatar || "",
    badge: "Server",
    type: row.type,
    content: row.content,
    proof: row.proof || "",
    image: row.image || "",
    studyMinutes: Number(row.study_minutes || 0),
    likes: Number(row.likes || 0),
    comments: Array.isArray(row.comments) ? row.comments.map(normalizeComment) : [],
    createdAt: row.created_at,
    liked: false
  };
}

function normalizeComment(row) {
  return {
    id: Number(row.id),
    author: row.author,
    content: row.content,
    createdAt: row.createdat || row.createdAt || row.created_at
  };
}

function normalizeGroup(row) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || "",
    ownerName: row.owner_name,
    members: Number(row.members || 1),
    streak: Number(row.streak || 1),
    rank: Number(row.rank || 99),
    joined: Boolean(row.joined)
  };
}

function normalizeUser(row) {
  return {
    id: Number(row.id),
    name: row.display_name,
    email: row.email,
    avatar: row.avatar || "",
    proofs: Number(row.proof_count || 0),
    joinedAt: row.created_at
  };
}

function normalizeGoal(row) {
  return {
    subject: row.subject,
    target: row.target,
    examDate: row.exam_date || "",
    level: row.level,
    hoursPerDay: Number(row.hours_per_day || 1)
  };
}

function normalizeTask(row) {
  return {
    id: Number(row.id),
    day: row.day_label,
    block: row.block_time,
    title: row.title,
    mode: row.mode,
    minutes: Number(row.minutes || 0),
    done: Boolean(row.done)
  };
}

function normalizeDeadline(row) {
  return {
    id: Number(row.id),
    title: row.title,
    subject: row.subject,
    dueDate: row.due_date || "",
    dueTime: row.due_time || "20:00",
    scope: row.scope === "long" ? "long" : "short",
    priority: ["high", "medium", "low"].includes(row.priority) ? row.priority : "medium",
    reminderLead: Number(row.reminder_lead || 1440),
    note: row.note || "",
    done: Boolean(row.done)
  };
}

function normalizeStudyRhythm(row) {
  return {
    preset: row.preset || "deep",
    studyMinutes: Number(row.study_minutes || 45),
    breakMinutes: Number(row.break_minutes || 10),
    reviewMinutes: Number(row.review_minutes || 8),
    relaxLimitMinutes: Number(row.relax_limit_minutes || 30)
  };
}

function normalizeFocusSession(row) {
  return {
    id: Number(row.id),
    clientId: row.client_id,
    subject: row.subject,
    anchorType: row.anchor_type,
    anchorLabel: row.anchor_label,
    plannedMinutes: Number(row.planned_minutes || 25),
    plannedSeconds: Number(row.planned_minutes || 25) * 60,
    actualMinutes: Number(row.actual_minutes || 1),
    actualSeconds: Number(row.actual_seconds || Number(row.actual_minutes || 1) * 60),
    note: row.note || "",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    synced: true
  };
}

function sanitizeAuthUser(user = {}) {
  return {
    name: String(user.name || "").trim().slice(0, 80),
    email: String(user.email || "").trim().toLowerCase().slice(0, 160),
    password: String(user.password || "").slice(0, 200)
  };
}

function sanitizeGoal(goal = {}) {
  return {
    subject: String(goal.subject || "Mon hoc").slice(0, 120),
    target: String(goal.target || "Hoc hieu qua hon").slice(0, 500),
    examDate: String(goal.examDate || "").slice(0, 40),
    level: String(goal.level || "Chua ro").slice(0, 120),
    hoursPerDay: Number(goal.hoursPerDay || 1)
  };
}

function sanitizeTask(task = {}) {
  return {
    id: Number(task.id),
    day: String(task.day || "Hom nay").slice(0, 80),
    block: String(task.block || "20:00").slice(0, 20),
    title: String(task.title || "Phien hoc").trim().slice(0, 180),
    mode: String(task.mode || "Hoc sau").slice(0, 120),
    minutes: Math.max(1, Math.min(480, Number(task.minutes || 45))),
    done: Boolean(task.done)
  };
}

function sanitizeDeadline(deadline = {}) {
  return {
    id: Number(deadline.id),
    title: String(deadline.title || "Deadline hoc tap").trim().slice(0, 160),
    subject: String(deadline.subject || "Mon hoc").trim().slice(0, 120),
    dueDate: sanitizeIsoDate(deadline.dueDate),
    dueTime: sanitizeClockTime(deadline.dueTime || "20:00"),
    scope: deadline.scope === "long" ? "long" : "short",
    priority: ["high", "medium", "low"].includes(deadline.priority) ? deadline.priority : "medium",
    reminderLead: Math.max(0, Math.min(10_080, Number(deadline.reminderLead || 1440))),
    note: String(deadline.note || "").trim().slice(0, 500),
    done: Boolean(deadline.done)
  };
}

function sanitizeStudyRhythm(studyRhythm = {}) {
  return {
    preset: String(studyRhythm.preset || "deep").slice(0, 40),
    studyMinutes: Math.max(5, Math.min(120, Number(studyRhythm.studyMinutes || 45))),
    breakMinutes: Math.max(3, Math.min(45, Number(studyRhythm.breakMinutes || 10))),
    reviewMinutes: Math.max(3, Math.min(30, Number(studyRhythm.reviewMinutes || 8))),
    relaxLimitMinutes: Math.max(0, Math.min(180, Number(studyRhythm.relaxLimitMinutes || 30)))
  };
}

function sanitizeFocusSession(session = {}) {
  const endedAt = sanitizeDateTime(session.endedAt, new Date().toISOString());
  const startedAt = sanitizeDateTime(session.startedAt, endedAt);
  const plannedMinutes = Math.max(1, Math.min(1440, Number(session.plannedMinutes || Math.round(Number(session.plannedSeconds || 1500) / 60))));
  const actualSeconds = Math.max(1, Math.min(86_400, Number(session.actualSeconds || Number(session.actualMinutes || 1) * 60)));

  return {
    clientId: String(session.clientId || session.id || Date.now()).slice(0, 120),
    subject: String(session.subject || "Mon hoc").trim().slice(0, 120),
    anchorType: ["goal", "task", "deadline", "custom"].includes(session.anchorType) ? session.anchorType : "goal",
    anchorLabel: String(session.anchorLabel || "Phien hoc").trim().slice(0, 180),
    plannedMinutes,
    actualMinutes: Math.max(1, Math.min(1440, Number(session.actualMinutes || Math.round(actualSeconds / 60)))),
    actualSeconds,
    note: String(session.note || "").trim().slice(0, 1000),
    startedAt,
    endedAt
  };
}

function sanitizeIsoDate(value = "") {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function sanitizeDateTime(value, fallback) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return fallback;
}

function sanitizeClockTime(value = "") {
  const text = String(value || "20:00").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(text)) return "20:00";

  const [hours, minutes] = text.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return "20:00";
  return text;
}

function sanitizeMistake(mistake = {}) {
  return {
    subject: String(mistake.subject || "Mon hoc").slice(0, 120),
    problem: String(mistake.problem || "").slice(0, 1200),
    wrongAnswer: String(mistake.wrongAnswer || "").slice(0, 800),
    selfReason: String(mistake.selfReason || "Chua ro").slice(0, 160)
  };
}

function sanitizeTutorRequest(request = {}) {
  const messages = Array.isArray(request.messages)
    ? request.messages.slice(-8).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").trim().slice(0, 1200)
    })).filter((message) => message.content)
    : [];

  return {
    goal: sanitizeGoal(request.goal),
    question: String(request.question || "").trim().slice(0, 1600),
    messages
  };
}

function sanitizePost(post = {}) {
  return {
    author: String(post.author || "Hoc sinh").slice(0, 80),
    authorAvatar: String(post.authorAvatar || "").slice(0, 2_800_000),
    type: String(post.type || "Minh chứng học tập").slice(0, 80),
    content: String(post.content || "").trim().slice(0, 1200),
    proof: String(post.proof || "").slice(0, 160),
    image: String(post.image || "").slice(0, 8_500_000),
    studyMinutes: Number(post.studyMinutes || 0)
  };
}

function sanitizeComment(comment = {}) {
  return {
    author: String(comment.author || "Hoc sinh").slice(0, 80),
    content: String(comment.content || "").trim().slice(0, 800)
  };
}

function sanitizeGroup(group = {}) {
  return {
    name: String(group.name || "Nhom hoc moi").trim().slice(0, 120),
    description: String(group.description || "").trim().slice(0, 500),
    ownerName: String(group.ownerName || "Hoc sinh").slice(0, 80)
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, savedHash = "") {
  const [salt, hash] = savedHash.split(":");
  if (!salt || !hash) return false;

  const nextHash = crypto.scryptSync(password, salt, 64);
  const savedBuffer = Buffer.from(hash, "hex");
  return savedBuffer.length === nextHash.length && crypto.timingSafeEqual(savedBuffer, nextHash);
}

function buildStudyPrompt(goal) {
  return `
Ban la co van hoc tap cho hoc sinh Viet Nam. Hay tao lo trinh ngan gon, thuc te, tranh lan man.

Thong tin:
- Mon hoc: ${goal.subject}
- Muc tieu: ${goal.target}
- Ngay kiem tra/deadline: ${goal.examDate || "chua co"}
- Trinh do hien tai: ${goal.level}
- Gio hoc moi ngay: ${goal.hoursPerDay}

Chi tra ve JSON hop le theo dung schema:
{
  "plan": [
    { "title": "toi da 42 ky tu", "detail": "toi da 180 ky tu" }
  ],
  "today": [
    { "time": "HH:mm", "title": "viec can lam", "minutes": 45 }
  ],
  "warning": "mot nhac nho ngan ve viec hoc lech muc tieu"
}

Yeu cau:
- plan co 4 buoc.
- today co 3 phien hoc phu hop voi gio hoc moi ngay.
- Noi dung bang tieng Viet co dau.
`;
}

function buildMistakePrompt(mistake) {
  return `
Ban la gia su phan tich loi sai cho hoc sinh Viet Nam. Hay phan tich ngan gon, cu the, khong che bai hoc sinh.

Thong tin loi sai:
- Mon hoc: ${mistake.subject}
- De bai/mo ta loi: ${mistake.problem || "chua nhap"}
- Dap an sai/cach lam sai: ${mistake.wrongAnswer || "chua nhap"}
- Hoc sinh tu danh gia nguyen nhan: ${mistake.selfReason}

Chi tra ve JSON hop le theo dung schema:
{
  "type": "dang loi sai chinh",
  "why": "vi sao sai",
  "fix": "cach sua loi trong lan toi",
  "review": "phan kien thuc can on lai",
  "practice": "bai tap sua loi cu the hom nay",
  "scheduleTask": { "title": "ten phien hoc sua loi", "minutes": 45 }
}

Yeu cau:
- Noi dung bang tieng Viet co dau.
- Moi field toi da 180 ky tu.
- scheduleTask phai du title va minutes.
`;
}

function buildTutorPrompt(request) {
  const history = request.messages
    .map((message) => `${message.role === "assistant" ? "Gia su" : "Hoc sinh"}: ${message.content}`)
    .join("\n");

  return `
Ban la gia su AI cho hoc sinh Viet Nam trong app Study Compass.
Hay nhan dien y dinh cau hoi truoc khi tra loi:
- "knowledge": cau hoi kien thuc/su that/lich su/khoa hoc, vi du "ai phat minh ra bong den".
- "exercise": bai tap can giai, co du kien, cong thuc, phep tinh, dap an.
- "study": hoi ve cach hoc, lich hoc, deadline, dong luc.
- "clarify": cau hoi qua thieu thong tin.

Muc tieu hoc tap hien tai:
- Mon hoc: ${request.goal.subject}
- Muc tieu: ${request.goal.target}
- Trinh do: ${request.goal.level}
- Deadline: ${request.goal.examDate || "chua co"}

Lich su hoi dap gan day:
${history || "Chua co."}

Cau hoi moi:
${request.question}

Chi tra ve JSON hop le theo schema:
{
  "type": "knowledge | exercise | study | clarify",
  "answer": "cau tra loi chinh bang tieng Viet co dau",
  "steps": ["chi dung khi cau hoi can cac buoc hoac cac y chinh"],
  "hint": "chi dung cho bai tap/cach hoc, de rong neu khong can",
  "practice": "chi goi bai luyen neu that su lien quan",
  "followUp": "mot cau hoi tiep theo ngan neu huu ich"
}

Yeu cau:
- Voi cau hoi knowledge: tra loi truc tiep 2-4 cau, them boi canh ngan neu can; khong bien thanh quy trinh lam bai, khong ep hoc sinh cung cap them thong tin.
- Voi cau hoi exercise: huong dan tung buoc va hoi lai hoc sinh o buoc quan trong, khong chi dua dap an cuoi.
- Voi cau hoi study: dua ra goi y hanh dong ngan, co the gan voi muc tieu hoc tap hien tai.
- Neu cau hoi mo hoac thieu de bai, hoi them thong tin can thiet.
- Moi field toi da 700 ky tu, steps toi da 4 muc.
`;
}

function mockStudyPlan(goal) {
  const hours = Number(goal.hoursPerDay || 1);

  return {
    plan: [
      {
        title: "Chẩn đoán mục tiêu",
        detail: `Tách mục tiêu ${goal.subject} thành 3 phần yếu nhất, làm bài kiểm tra nhanh trong 20 phút.`
      },
      {
        title: "Lịch học cố định",
        detail: `Mỗi ngày học ${hours} giờ, ưu tiên bài nền tảng trước rồi mới luyện đề theo deadline.`
      },
      {
        title: "Sửa lỗi sai",
        detail: "Sau mỗi phiên học ghi 1 lỗi sai chính, nguyên nhân và 1 bài tương tự để tránh lặp lại."
      },
      {
        title: "Đánh giá bằng chứng",
        detail: "Cuối ngày lưu ảnh, ghi chú hoặc timelapse để kiểm tra tiến độ thật thay vì chỉ cảm giác."
      }
    ],
    today: [
      { time: "19:30", title: `Ôn nền tảng ${goal.subject}`, minutes: 45 },
      { time: "20:20", title: "Làm 12 câu trọng tâm", minutes: 45 },
      { time: "21:10", title: "Ghi lỗi sai và việc ngày mai", minutes: 20 }
    ],
    warning: "Đang dùng dữ liệu thử nghiệm để bạn kiểm tra giao diện."
  };
}

function mockMistakeAnalysis(mistake) {
  return {
    type: mistake.selfReason || "Chưa hiểu bản chất",
    why: "Bạn có thể đang thiếu bước kiểm tra điều kiện hoặc chưa nối được công thức với dạng bài.",
    fix: "Trước khi tính, viết rõ dữ kiện, điều kiện áp dụng và mục tiêu cần tìm.",
    review: `Ôn lại phần nền tảng của ${mistake.subject}, tập trung vào dạng vừa sai.`,
    practice: "Làm lại bài sai, sau đó làm thêm 2 bài cùng dạng trong 30 phút.",
    scheduleTask: { title: `Sửa lỗi sai ${mistake.subject}`, minutes: 45 }
  };
}

function mockTutorAnswer(request) {
  const question = String(request.question || "").toLocaleLowerCase("vi-VN");
  const isKnowledgeQuestion = /^(ai|cái gì|gì|vì sao|tại sao|khi nào|ở đâu|who|what|why|when|where)\b/.test(question)
    || question.includes("phát minh")
    || question.includes("là ai")
    || question.includes("là gì");

  if (isKnowledgeQuestion) {
    return {
      type: "knowledge",
      answer: "Thomas Edison thường được nhắc tới với bóng đèn sợi đốt thực dụng vì ông và nhóm của mình cải tiến nó đủ bền, rẻ và dùng được trong hệ thống điện thương mại. Tuy vậy, bóng đèn không phải do một người duy nhất tạo ra; trước Edison đã có nhiều nhà phát minh như Humphry Davy, Warren de la Rue và Joseph Swan đóng góp quan trọng.",
      steps: [],
      hint: "",
      practice: "",
      followUp: "Nếu muốn, mình có thể tóm tắt timeline phát triển bóng đèn trong 5 mốc."
    };
  }

  return {
    type: "exercise",
    answer: `Mình đang dùng câu trả lời thử nghiệm cho mục tiêu ${request.goal.subject}. Với bài tập, mình sẽ đi theo hướng gợi ý từng bước để bạn tự kiểm tra cách làm.`,
    steps: [
      "Xác định dữ kiện đề bài đã cho.",
      "Chọn công thức hoặc phương pháp phù hợp.",
      "Làm từng bước và kiểm tra điều kiện cuối cùng."
    ],
    hint: "Gửi thêm đề bài cụ thể nếu bạn muốn mình bám sát từng dòng.",
    practice: "Tạo một câu hỏi ngắn khác để kiểm tra luồng chat và lưu lịch sử.",
    followUp: ""
  };
}

function withFallbackWarning(payload, reason) {
  const warning = `${reason} Mình tạm hiện gợi ý cơ bản để bạn không bị kẹt.`;

  if ("warning" in payload) {
    return { ...payload, warning };
  }

  if ("answer" in payload) {
    return { ...payload, answer: `${warning}\n\n${payload.answer}` };
  }

  return { ...payload, why: `${warning} ${payload.why || ""}`.trim() };
}

function parsePlan(text) {
  if (!text) {
    return { plan: [], today: [], warning: "Gemini khong tra ve noi dung." };
  }

  try {
    const value = JSON.parse(text);
    return {
      plan: Array.isArray(value.plan) ? value.plan.slice(0, 4) : [],
      today: Array.isArray(value.today) ? value.today.slice(0, 4) : [],
      warning: typeof value.warning === "string" ? value.warning : ""
    };
  } catch {
    return {
      plan: [
        {
          title: "Ket qua AI",
          detail: text.slice(0, 180)
        }
      ],
      today: [],
      warning: "Gemini tra ve van ban, chua dung JSON."
    };
  }
}

function parseTutorAnswer(text) {
  if (!text) {
    return {
      type: "clarify",
      answer: "Gemini khong tra ve noi dung.",
      steps: [],
      hint: "",
      practice: "",
      followUp: "Hay gui lai cau hoi ngan gon hon."
    };
  }

  try {
    const value = JSON.parse(text);
    return {
      type: ["knowledge", "exercise", "study", "clarify"].includes(value.type) ? value.type : "study",
      answer: String(value.answer || "").slice(0, 900),
      steps: Array.isArray(value.steps) ? value.steps.slice(0, 4).map((item) => String(item).slice(0, 240)) : [],
      hint: String(value.hint || "").slice(0, 500),
      practice: String(value.practice || "").slice(0, 500),
      followUp: String(value.followUp || "").slice(0, 500)
    };
  } catch {
    return {
      type: "knowledge",
      answer: text.slice(0, 900),
      steps: [],
      hint: "",
      practice: "",
      followUp: "Neu van chua ro, hay gui them cau hoi cu the hon."
    };
  }
}

function parseMistakeAnalysis(text) {
  if (!text) {
    return {
      type: "Chưa phân loại",
      why: "Gemini không trả về nội dung.",
      fix: "",
      review: "",
      practice: "",
      scheduleTask: { title: "Sửa lỗi sai", minutes: 45 }
    };
  }

  try {
    const value = JSON.parse(text);
    return {
      type: String(value.type || "Chưa phân loại").slice(0, 180),
      why: String(value.why || "").slice(0, 220),
      fix: String(value.fix || "").slice(0, 220),
      review: String(value.review || "").slice(0, 220),
      practice: String(value.practice || "").slice(0, 220),
      scheduleTask: {
        title: String(value.scheduleTask?.title || "Sửa lỗi sai").slice(0, 120),
        minutes: Number(value.scheduleTask?.minutes || 45)
      }
    };
  } catch {
    return {
      type: "Kết quả AI",
      why: text.slice(0, 220),
      fix: "Đọc lại lời giải đúng và ghi một quy tắc tránh lặp lỗi.",
      review: "Ôn lại phần kiến thức liên quan.",
      practice: "Làm lại bài tương tự trong 30-45 phút.",
      scheduleTask: { title: "Sửa lỗi sai", minutes: 45 }
    };
  }
}
