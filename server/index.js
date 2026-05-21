import "dotenv/config";
import cors from "cors";
import crypto from "node:crypto";
import express from "express";
import os from "node:os";
import pg from "pg";

const app = express();
const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const host = process.env.API_HOST || "0.0.0.0";
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const geminiModels = getGeminiModels(
  model,
  process.env.GEMINI_FALLBACK_MODELS || "gemini-2.0-flash"
);
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

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
       returning id, display_name, email, created_at, proof_count`,
      [user.name || "Hoc sinh moi", user.email, hashPassword(user.password)]
    );
    const created = normalizeUser(result.rows[0]);
    await upsertGoal(created.id, sanitizeGoal(request.body?.goal));
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
      `select id, display_name, email, password_hash, created_at, proof_count
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

app.put("/api/users/:userId/profile", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const userId = Number(request.params.userId);
  if (!Number.isFinite(userId)) return response.status(400).json({ error: "Invalid user id." });

  const proofs = Math.max(0, Math.min(100000, Number(request.body?.proofs || 0)));

  try {
    const result = await pool.query(
      `update app_users
       set proof_count = $2
       where id = $1
       returning id, display_name, email, created_at, proof_count`,
      [userId, proofs]
    );
    response.json({ user: normalizeUser(result.rows[0]) });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot save profile." });
  }
});

app.get("/api/social", async (_request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  try {
    const [posts, groups] = await Promise.all([listPosts(), listGroups()]);
    response.json({ posts, groups });
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot load social data." });
  }
});

app.post("/api/posts", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const post = sanitizePost(request.body?.post);

  try {
    const result = await pool.query(
      `insert into social_posts (author, type, content, proof, image, study_minutes, likes)
       values ($1, $2, $3, $4, $5, $6, 0)
       returning id`,
      [post.author, post.type, post.content, post.proof, post.image, post.studyMinutes]
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

  try {
    const result = await pool.query(
      `insert into study_groups (name, description, owner_name, members, streak, rank)
       values ($1, $2, $3, 1, 1, 99)
       returning id`,
      [group.name, group.description, group.ownerName]
    );
    const created = await getGroup(result.rows[0].id);
    response.status(201).json(created);
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot create group." });
  }
});

app.post("/api/groups/:id/join", async (request, response) => {
  if (!pool) return response.status(503).json({ error: "DATABASE_URL is not set." });

  const groupId = Number(request.params.id);
  if (!Number.isFinite(groupId)) return response.status(400).json({ error: "Invalid group id." });

  try {
    const result = await pool.query(
      `update study_groups
       set members = members + 1
       where id = $1
       returning id`,
      [groupId]
    );

    if (!result.rows[0]) return response.status(404).json({ error: "Group not found." });
    response.json(await getGroup(result.rows[0].id));
  } catch (error) {
    response.status(500).json({ error: error.message || "Cannot join group." });
  }
});

app.post("/api/study-plan", async (request, response) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return response.status(500).json({
      error: "GEMINI_API_KEY is missing. Create .env from .env.example and put your new key there."
    });
  }

  const goal = sanitizeGoal(request.body?.goal);

  try {
    const { data, usedModel } = await generateGeminiContent({
      apiKey,
      prompt: buildStudyPrompt(goal),
      generationConfig: {
        temperature: 0.45,
        responseMimeType: "application/json"
      }
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parsePlan(text);
    await saveAiEvent("study-plan", goal, parsed);

    response.json({ ...parsed, model: usedModel });
  } catch (error) {
    response.status(error.status || 500).json({ error: toClientGeminiError(error) });
  }
});

app.post("/api/mistake-analysis", async (request, response) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return response.status(500).json({
      error: "GEMINI_API_KEY is missing. Create .env from .env.example and put your new key there."
    });
  }

  const mistake = sanitizeMistake(request.body?.mistake);

  try {
    const { data, usedModel } = await generateGeminiContent({
      apiKey,
      prompt: buildMistakePrompt(mistake),
      generationConfig: {
        temperature: 0.35,
        responseMimeType: "application/json"
      }
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parseMistakeAnalysis(text);
    await saveAiEvent("mistake-analysis", mistake, parsed);

    response.json({ ...parsed, model: usedModel });
  } catch (error) {
    response.status(error.status || 500).json({ error: toClientGeminiError(error) });
  }
});

app.post("/api/tutor-chat", async (request, response) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return response.status(500).json({
      error: "GEMINI_API_KEY is missing. Create .env from .env.example and put your new key there."
    });
  }

  const tutorRequest = sanitizeTutorRequest(request.body);

  try {
    const { data, usedModel } = await generateGeminiContent({
      apiKey,
      prompt: buildTutorPrompt(tutorRequest),
      generationConfig: {
        temperature: 0.55,
        responseMimeType: "application/json"
      }
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parseTutorAnswer(text);
    await saveAiEvent("tutor-chat", tutorRequest, parsed);

    response.json({ ...parsed, model: usedModel });
  } catch (error) {
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
  return [429, 500, 502, 503, 504].includes(status) || /high demand|overloaded|try again/i.test(message);
}

function toClientGeminiError(error) {
  const message = error?.message || "Unexpected Gemini error.";

  if (/high demand|overloaded|try again/i.test(message)) {
    return `Gemini dang qua tai tam thoi. Server da thu cac model: ${geminiModels.join(", ")}. Bam lai sau 1-2 phut.`;
  }

  return message;
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
      created_at timestamptz not null default now()
    );

    alter table app_users add column if not exists proof_count integer not null default 0;

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

    create table if not exists social_posts (
      id bigserial primary key,
      user_id bigint references app_users(id) on delete set null,
      author text not null,
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
  const [goalResult, tasksResult, userResult] = await Promise.all([
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
    pool.query("select proof_count from app_users where id = $1", [userId])
  ]);

  return {
    goal: goalResult.rows[0] ? normalizeGoal(goalResult.rows[0]) : null,
    tasks: tasksResult.rows.map(normalizeTask),
    proofs: Number(userResult.rows[0]?.proof_count || 0)
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

async function listGroups() {
  const result = await pool.query(
    `select id, name, description, owner_name, members, streak, rank, created_at
     from study_groups
     order by rank asc, created_at desc
     limit 50`
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
    badge: "Server",
    type: row.type,
    content: row.content,
    proof: row.proof || "",
    image: row.image || "",
    studyMinutes: Number(row.study_minutes || 0),
    likes: Number(row.likes || 0),
    comments: Array.isArray(row.comments) ? row.comments.map(normalizeComment) : [],
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
    rank: Number(row.rank || 99)
  };
}

function normalizeUser(row) {
  return {
    id: Number(row.id),
    name: row.display_name,
    email: row.email,
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
Ban la gia su AI cho hoc sinh Viet Nam trong app Study Compass. Day la cong cu hoc tap, khong lam bai thay hoc sinh.

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
  "answer": "cau tra loi chinh bang tieng Viet co dau",
  "steps": ["buoc 1", "buoc 2", "buoc 3"],
  "hint": "goi y de hoc sinh tu lam tiep",
  "practice": "mot bai tap nho hoac viec can lam tiep"
}

Yeu cau:
- Giai thich ngan gon, de hieu, dung vai tro gia su.
- Neu la bai tap, huong dan tung buoc va hoi lai hoc sinh o buoc quan trong, khong chi dua dap an cuoi.
- Neu cau hoi mo hoac thieu de bai, hoi them thong tin can thiet.
- Moi field toi da 700 ky tu, steps toi da 4 muc.
`;
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
      answer: "Gemini khong tra ve noi dung.",
      steps: [],
      hint: "",
      practice: ""
    };
  }

  try {
    const value = JSON.parse(text);
    return {
      answer: String(value.answer || "").slice(0, 900),
      steps: Array.isArray(value.steps) ? value.steps.slice(0, 4).map((item) => String(item).slice(0, 240)) : [],
      hint: String(value.hint || "").slice(0, 500),
      practice: String(value.practice || "").slice(0, 500)
    };
  } catch {
    return {
      answer: text.slice(0, 900),
      steps: [],
      hint: "Neu van chua ro, hay gui them de bai hoac buoc em dang bi ket.",
      practice: ""
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
