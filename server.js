import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import cron from "node-cron";
import crypto from "crypto";
const { Pool } = pg;

// ── Auth helpers ──────────────────────────────────────────────────────────────
const SESSION_IDLE_MINUTES = 30;

function hashPass(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
}

async function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  if (pool) {
    await pool.query(
      `INSERT INTO sessions (token, username, role, employee_name, last_active)
       VALUES ($1, $2, $3, $4, NOW())`,
      [token, user.username, user.role, user.employee_name || null]
    );
  }
  return token;
}

async function getSession(token) {
  if (!token) return null;
  if (pool) {
    const r = await pool.query(
      `SELECT username, role, employee_name FROM sessions
       WHERE token=$1 AND last_active > NOW() - INTERVAL '${SESSION_IDLE_MINUTES} minutes'`,
      [token]
    );
    if (!r.rows[0]) return null;
    // Touch last_active (fire-and-forget)
    pool.query("UPDATE sessions SET last_active=NOW() WHERE token=$1", [token]).catch(() => {});
    return r.rows[0];
  }
  return null;
}

async function deleteSession(token) {
  if (pool && token) await pool.query("DELETE FROM sessions WHERE token=$1", [token]).catch(() => {});
}

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  getSession(token).then(sess => {
    if (!sess) return res.status(401).json({ error: "Not authenticated" });
    req.user = sess;
    req.sessionToken = token;
    next();
  }).catch(() => res.status(401).json({ error: "Not authenticated" }));
}
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const REVIEWS_FILE = path.join(__dirname, "reviews.json");

// PostgreSQL (Railway) or fallback to reviews.json
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query(`CREATE TABLE IF NOT EXISTS reviews (
    chat_id VARCHAR(255) PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
  )`).then(() => console.log("[db] reviews table ready")).catch(e => console.error("[db] init error:", e.message));
  pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    employee_name TEXT,
    last_active TIMESTAMP DEFAULT NOW()
  )`).then(() => {
    console.log("[db] sessions table ready");
    // Clean up expired sessions on startup
    pool.query(`DELETE FROM sessions WHERE last_active < NOW() - INTERVAL '${SESSION_IDLE_MINUTES} minutes'`).catch(() => {});
  }).catch(e => console.error("[db] sessions init error:", e.message));
  (async () => {
    try {
      // Migrate old JSON-blob schema to per-record schema if needed
      const oldCol = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='agent_shifts' AND column_name='data'`);
      if (oldCol.rows.length > 0) {
        console.log("[db] migrating agent_shifts from old schema");
        await pool.query("DROP TABLE agent_shifts");
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS agent_shifts (
        id SERIAL PRIMARY KEY,
        employee VARCHAR(255) NOT NULL,
        agent_key VARCHAR(255) NOT NULL,
        start_hour INTEGER NOT NULL,
        end_hour INTEGER NOT NULL,
        groups JSONB DEFAULT '[]',
        languages JSONB DEFAULT '[]'
      )`);
      // Migrate groups column type if it exists as TEXT[]
      await pool.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='agent_shifts' AND column_name='groups' AND data_type='ARRAY'
          ) THEN
            ALTER TABLE agent_shifts DROP COLUMN groups;
          END IF;
        END $$;
      `);
      await pool.query(`ALTER TABLE agent_shifts ADD COLUMN IF NOT EXISTS groups JSONB DEFAULT '[]'`);
      await pool.query(`ALTER TABLE agent_shifts ADD COLUMN IF NOT EXISTS languages JSONB DEFAULT '[]'`);
      console.log("[db] agent_shifts table ready");
      // Seed from file if empty
      const cnt = await pool.query("SELECT COUNT(*) FROM agent_shifts");
      if (parseInt(cnt.rows[0].count) === 0) {
        const raw = await fs.readFile(path.join(__dirname, "data", "agent_shifts.json"), "utf8");
        const shifts = JSON.parse(raw);
        for (const s of shifts) {
          await pool.query(
            `INSERT INTO agent_shifts (employee, agent_key, start_hour, end_hour) VALUES ($1,$2,$3,$4)`,
            [s.employee, s.agentKey, s.start, s.end]
          );
        }
        console.log("[db] agent_shifts seeded:", shifts.length, "rows");
      }
    } catch (e) { console.error("[db] shifts init error:", e.message); }
  })();

  // ── app_users table ──────────────────────────────────────────────────────
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        employee_name TEXT
      )`);
      // Migrate legacy 'employee' role to 'user'
      await pool.query(`UPDATE app_users SET role='user' WHERE role='employee'`);
      await pool.query(`ALTER TABLE app_users ALTER COLUMN role SET DEFAULT 'user'`);
      // Seed admin if not exists
      const exists = await pool.query("SELECT id FROM app_users WHERE username='admin'");
      if (exists.rows.length === 0) {
        const salt = crypto.randomBytes(16).toString("hex");
        await pool.query(
          "INSERT INTO app_users (username, password_hash, salt, role) VALUES ($1,$2,$3,'admin')",
          ["admin", hashPass("Admin@12893@@", salt), salt]
        );
        console.log("[db] admin user created");
      }
      console.log("[db] app_users table ready");
    } catch (e) { console.error("[db] app_users init error:", e.message); }
  })();

  // ── reports table ────────────────────────────────────────────────────────
  pool.query(`CREATE TABLE IF NOT EXISTS reports (
    employee TEXT NOT NULL,
    month TEXT NOT NULL,
    data JSONB,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (employee, month)
  )`).then(() => console.log("[db] reports table ready")).catch(e => console.error("[db] reports init:", e.message));
}
const LC_API = "https://api.livechatinc.com/v3.6/agent/action";
const LC_CONFIG_API = "https://api.livechatinc.com/v3.6/configuration/action";

const DATA_DIR = path.join(__dirname, "data");
const GDOC_KNOWLEDGE_URL = "https://docs.google.com/document/d/14iBZtfOXkPTb_ZYM4zSIAZOqdZ_VZeoKW0zJiNHXSIs/export?format=txt";
const GSHEET_CAMPAIGNS_URL = "https://docs.google.com/spreadsheets/d/1wp0FGyJe2LnMr2BMR42EiIQPrALrZcbNrN5qCg2q5X4/export?format=csv";
const GSHEET_MACROS_URL = "https://docs.google.com/spreadsheets/d/1CSAi2ltdxaidKTrLipZxKhW3zdbf5QERgcyqmu_k-sI/export?format=csv";
const GSHEET_TAGS_URL = "https://docs.google.com/spreadsheets/d/16zX__NdZBhRvx9Nq4mcR71reR8P5fplygcz75yGfOi4/export?format=csv";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const PROTOCOL_DOC_IDS = (process.env.PROTOCOL_DOC_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

let kb = { knowledge: "", campaigns: "", telegram: "", protocol: "", macros: "", tags: "", lastFetched: null };
let telegramOffset = 0;

app.use(express.json());
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/app.js", (req, res) => res.sendFile(path.join(__dirname, "app.js")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Missing credentials" });
    if (!pool) return res.status(503).json({ error: "DB not available" });
    const r = await pool.query("SELECT * FROM app_users WHERE username=$1", [username]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid username or password" });
    const hash = hashPass(password, user.salt);
    if (hash !== user.password_hash) return res.status(401).json({ error: "Invalid username or password" });
    const token = await createSession({ username: user.username, role: user.role, employee_name: user.employee_name });
    res.json({ token, role: user.role, username: user.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/logout", async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  await deleteSession(token);
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  const sess = await getSession(token);
  if (!sess) return res.status(401).json({ error: "Not authenticated" });
  res.json({ username: sess.username, role: sess.role, employee_name: sess.employee_name });
});

// ── App users (admin only) ───────────────────────────────────────────────────
app.get("/api/app-users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const r = await pool.query("SELECT username, role, employee_name FROM app_users ORDER BY id");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/app-users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username, password, employee_name } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPass(password, salt);
    await pool.query(
      `INSERT INTO app_users (username, password_hash, salt, role, employee_name)
       VALUES ($1,$2,$3,'user',$4)
       ON CONFLICT (username) DO UPDATE SET password_hash=$2, salt=$3, employee_name=$4`,
      [username, hash, salt, employee_name || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/app-users/:username/role", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username } = req.params;
    const { role } = req.body || {};
    if (!["admin", "user"].includes(role)) return res.status(400).json({ error: "Role must be admin or user" });
    if (username === "admin" && role !== "admin") return res.status(400).json({ error: "Cannot demote the main admin account" });
    await pool.query("UPDATE app_users SET role=$1 WHERE username=$2", [role, username]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/app-users/:username", authMiddleware, adminOnly, async (req, res) => {
  try {
    if (req.params.username === "admin") return res.status(400).json({ error: "Cannot delete admin" });
    await pool.query("DELETE FROM app_users WHERE username=$1", [req.params.username]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function lcAuth() {
  const raw = `${process.env.LIVECHAT_ACCOUNT_ID}:${process.env.LIVECHAT_PAT}`;
  return "Basic " + Buffer.from(raw).toString("base64");
}

async function lcPost(action, body, baseUrl = LC_API) {
  const res = await fetch(`${baseUrl}/${action}`, {
    method: "POST",
    headers: {
      Authorization: lcAuth(),
      "Content-Type": "application/json",
      "X-Region": "us-south1",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LiveChat ${action} failed: ${res.status} ${err}`);
  }
  return res.json();
}

let _reviewsCache = null;
let _reviewsCacheAt = 0;
async function loadReviews() {
  // 10 second cache to avoid hammering DB on paginated /api/chats background fetches
  if (_reviewsCache && Date.now() - _reviewsCacheAt < 10000) return _reviewsCache;
  if (pool) {
    const res = await pool.query("SELECT chat_id, data FROM reviews");
    const obj = {};
    res.rows.forEach(r => obj[r.chat_id] = r.data);
    _reviewsCache = obj;
    _reviewsCacheAt = Date.now();
    return obj;
  }
  try {
    const raw = await fs.readFile(REVIEWS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveReviews(reviews) {
  _reviewsCache = null; // invalidate cache on write
  if (pool) {
    for (const [chatId, data] of Object.entries(reviews)) {
      await pool.query(
        `INSERT INTO reviews (chat_id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (chat_id) DO UPDATE SET data = $2, updated_at = NOW()`,
        [chatId, data]
      );
    }
    return;
  }
  await fs.writeFile(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
}

async function loadKnowledge() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const headers = { "User-Agent": "Mozilla/5.0" };

  // Fetch Google Docs knowledge base
  try {
    const res = await fetch(GDOC_KNOWLEDGE_URL, { headers });
    if (res.ok) {
      kb.knowledge = await res.text();
      await fs.writeFile(path.join(DATA_DIR, "knowledge.txt"), kb.knowledge);
      console.log("[kb] knowledge base fetched from Google Docs");
    } else {
      kb.knowledge = await fs.readFile(path.join(DATA_DIR, "knowledge.txt"), "utf8").catch(() => "");
      console.log("[kb] Google Docs failed, using cached knowledge.txt");
    }
  } catch {
    kb.knowledge = await fs.readFile(path.join(DATA_DIR, "knowledge.txt"), "utf8").catch(() => "");
  }

  // Fetch Google Sheets campaigns
  try {
    const res = await fetch(GSHEET_CAMPAIGNS_URL, { headers });
    if (res.ok) {
      kb.campaigns = await res.text();
      await fs.writeFile(path.join(DATA_DIR, "campaigns.csv"), kb.campaigns);
      console.log("[kb] campaigns fetched from Google Sheets");
    } else {
      kb.campaigns = await fs.readFile(path.join(DATA_DIR, "campaigns.csv"), "utf8").catch(() => "");
      console.log("[kb] Google Sheets failed, using cached campaigns.csv");
    }
  } catch {
    kb.campaigns = await fs.readFile(path.join(DATA_DIR, "campaigns.csv"), "utf8").catch(() => "");
  }

  // Fetch macros sheet
  try {
    const res = await fetch(GSHEET_MACROS_URL, { headers });
    if (res.ok) {
      kb.macros = await res.text();
      await fs.writeFile(path.join(DATA_DIR, "macros.csv"), kb.macros);
      console.log("[kb] macros fetched from Google Sheets");
    } else {
      kb.macros = await fs.readFile(path.join(DATA_DIR, "macros.csv"), "utf8").catch(() => "");
      console.log("[kb] macros Google Sheets failed, using cache");
    }
  } catch {
    kb.macros = await fs.readFile(path.join(DATA_DIR, "macros.csv"), "utf8").catch(() => "");
  }

  // Fetch tags sheet
  try {
    const res = await fetch(GSHEET_TAGS_URL, { headers });
    if (res.ok) {
      kb.tags = await res.text();
      await fs.writeFile(path.join(DATA_DIR, "tags.csv"), kb.tags);
      console.log("[kb] tags fetched from Google Sheets");
    } else {
      kb.tags = await fs.readFile(path.join(DATA_DIR, "tags.csv"), "utf8").catch(() => "");
    }
  } catch {
    kb.tags = await fs.readFile(path.join(DATA_DIR, "tags.csv"), "utf8").catch(() => "");
  }

  // Import historical Telegram exports (JSON files from Telegram Desktop)
  await importTelegramExport();
  // Load Telegram updates from file (auto-updated by pollTelegram)
  kb.telegram = await fs.readFile(path.join(DATA_DIR, "telegram_updates.txt"), "utf8").catch(() => "");

  // Fetch protocol docs from Google Drive (by doc ID)
  await fetchProtocolDocs();

  kb.lastFetched = new Date().toISOString();
  console.log(`[kb] loaded — knowledge:${kb.knowledge.length}c campaigns:${kb.campaigns.length}c telegram:${kb.telegram.length}c protocol:${kb.protocol.length}c macros:${kb.macros.length}c tags:${kb.tags.length}c`);
}

async function fetchProtocolDocs() {
  if (!PROTOCOL_DOC_IDS.length) {
    kb.protocol = await fs.readFile(path.join(DATA_DIR, "protocol.txt"), "utf8").catch(() => "");
    return;
  }
  const parts = [];
  for (const docId of PROTOCOL_DOC_IDS) {
    try {
      const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) {
        parts.push(await res.text());
        console.log(`[protocol] fetched doc ${docId}`);
      } else {
        console.log(`[protocol] failed ${docId}: ${res.status}`);
      }
    } catch (e) {
      console.log(`[protocol] error ${docId}:`, e.message);
    }
  }
  if (parts.length) {
    kb.protocol = parts.join("\n\n---\n\n");
    await fs.writeFile(path.join(DATA_DIR, "protocol.txt"), kb.protocol);
  } else {
    kb.protocol = await fs.readFile(path.join(DATA_DIR, "protocol.txt"), "utf8").catch(() => "");
  }
}

async function importTelegramExport() {
  const exportDir = path.join(DATA_DIR, "telegram_exports");
  await fs.mkdir(exportDir, { recursive: true });

  let files;
  try {
    files = await fs.readdir(exportDir);
  } catch { return; }

  const jsonFiles = files.filter(f => f.endsWith(".json"));
  if (!jsonFiles.length) return;

  const existingLines = new Set(
    (await fs.readFile(path.join(DATA_DIR, "telegram_updates.txt"), "utf8").catch(() => ""))
      .split("\n").filter(Boolean)
  );

  const newLines = [];
  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(exportDir, file), "utf8");
      const data = JSON.parse(raw);
      const groupName = data.name || file.replace(".json", "");
      const messages = data.messages || [];
      for (const msg of messages) {
        if (msg.type !== "message") continue;
        const text = typeof msg.text === "string" ? msg.text
          : Array.isArray(msg.text) ? msg.text.map(t => typeof t === "string" ? t : t.text || "").join("") : "";
        if (!text.trim()) continue;
        const date = (msg.date || "").slice(0, 16).replace("T", " ");
        const from = msg.from || "unknown";
        const line = `[${date}] ${groupName} — ${from}: ${text}`;
        if (!existingLines.has(line)) {
          newLines.push(line);
          existingLines.add(line);
        }
      }
      console.log(`[telegram-import] processed ${file}: ${messages.length} messages`);
    } catch (e) {
      console.log(`[telegram-import] error in ${file}:`, e.message);
    }
  }

  if (newLines.length) {
    newLines.sort();
    await fs.appendFile(path.join(DATA_DIR, "telegram_updates.txt"), newLines.join("\n") + "\n");
    console.log(`[telegram-import] added ${newLines.length} new messages`);
  }
}

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset}&limit=100&timeout=0`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.result.length) return;

    const newLines = [];
    for (const update of data.result) {
      telegramOffset = update.update_id + 1;
      const msg = update.message || update.channel_post;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      if (TELEGRAM_CHAT_IDS.length && !TELEGRAM_CHAT_IDS.includes(chatId)) continue;
      const date = new Date(msg.date * 1000).toISOString().replace("T", " ").slice(0, 16);
      const group = msg.chat.title || msg.chat.username || chatId;
      newLines.push(`[${date}] ${group}: ${msg.text}`);
    }

    if (newLines.length) {
      await fs.appendFile(path.join(DATA_DIR, "telegram_updates.txt"), newLines.join("\n") + "\n");
      kb.telegram = await fs.readFile(path.join(DATA_DIR, "telegram_updates.txt"), "utf8").catch(() => "");
      console.log(`[telegram] saved ${newLines.length} new messages`);
    }
  } catch (e) {
    console.log("[telegram] poll error:", e.message);
  }
}

function detectPrechatLanguage(events) {
  const form = events.find(e => e.type === "filled_form" && Array.isArray(e.fields));
  if (!form) return null;

  // 1. Check for explicit language selector field first
  for (const f of form.fields) {
    const val = (f.answer?.label ?? f.answer?.value ?? f.answer ?? "").toString().trim().toLowerCase();
    if (!val) continue;
    if (val.includes("english") || val === "en") return "english";
    if (val.includes("arabic") || val.includes("عربي") || val.includes("عربى") || val === "ar") return "arabic";
    if (val.includes("farsi") || val.includes("persian") || val.includes("فارسی") || val.includes("فارسي") || val === "fa") return "farsi";
  }

  // 2. Fall back: detect language from customer's written text in question/text fields
  for (const f of form.fields) {
    if (["name","email","group_chooser","radio","checkbox"].includes(f.type)) continue;
    const text = (f.answer?.label ?? f.answer?.value ?? f.answer ?? "").toString().trim();
    if (text.length < 5) continue;
    const lang = detectTextLanguage(text);
    if (lang === "farsi_or_arabic") return "farsi_or_arabic";
    if (lang === "latin") return "english";
  }

  return null;
}

function detectTextLanguage(text) {
  if (!text) return null;
  const arabicFarsiChars = (text.match(/[؀-ۿ]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  const total = arabicFarsiChars + latinChars;
  if (total === 0) return null;
  if (arabicFarsiChars / total > 0.5) return "farsi_or_arabic";
  if (latinChars / total > 0.5) return "latin";
  return null;
}

function detectLanguageViolations(events, users) {
  // Returns: Map of agentName -> { prechatLang, agentUsedLang } for violating agents
  const prechatLang = detectPrechatLanguage(events);
  if (!prechatLang) return new Map();

  // If the customer themselves sent messages in a DIFFERENT language than pre-chat,
  // they changed their mind — use the language they actually wrote in as the effective language.
  // Also: if customer explicitly asked to switch language, no violation for any agent.
  const customerMessages = events.filter(e =>
    e.type === "message" && e.visibility !== "agents" && e.text
    && users.find(u => u.id === e.author_id)?.type === "customer"
  );
  const customerChatText = customerMessages.map(m => m.text).join(" ");
  const customerChatLang = detectTextLanguage(customerChatText);

  // If customer switched language during chat (pre-chat vs actual messages differ), no violation
  const prechatIsLatin = prechatLang === "english";
  const prechatIsFarsiAr = prechatLang === "farsi" || prechatLang === "arabic" || prechatLang === "farsi_or_arabic";
  const customerSwitchedToFarsiAr = prechatIsLatin && customerChatLang === "farsi_or_arabic";
  const customerSwitchedToLatin   = prechatIsFarsiAr && customerChatLang === "latin";
  if (customerSwitchedToFarsiAr || customerSwitchedToLatin) {
    console.log(`[lang] customer switched language during chat (prechat=${prechatLang}, chat=${customerChatLang}) — no violation`);
    return new Map();
  }

  // Effective language = what customer actually wrote in chat (if available), else prechat
  const effectiveLang = customerChatLang || prechatLang;

  const violations = new Map();
  const agentMessages = events.filter(e =>
    e.type === "message" && e.visibility !== "agents" && e.text
    && users.find(u => u.id === e.author_id)?.type === "agent"
  );

  // Group by agent, check first 5 messages per agent
  const byAgent = {};
  for (const msg of agentMessages) {
    const agent = users.find(u => u.id === msg.author_id);
    const name = agent?.name || msg.author_id;
    if (!byAgent[name]) byAgent[name] = [];
    if (byAgent[name].length < 5) byAgent[name].push(msg.text);
  }

  for (const [agentName, texts] of Object.entries(byAgent)) {
    const combined = texts.join(" ");
    const agentLang = detectTextLanguage(combined);
    const mismatch = (
      (effectiveLang === "english"         && agentLang === "farsi_or_arabic") ||
      (effectiveLang === "farsi"           && agentLang === "latin") ||
      (effectiveLang === "arabic"          && agentLang === "latin") ||
      (effectiveLang === "farsi_or_arabic" && agentLang === "latin")
    );
    if (mismatch) {
      violations.set(agentName.toLowerCase(), { prechatLang: effectiveLang, agentLang });
    }
  }
  return violations;
}

function applyLanguagePenalty(review, agentName, violation) {
  const penalized = {
    ...review,
    overall_score: 1,
    language_score: 1,
    compliance_score: 1,
    resolution_score: 1,
    tone_score: 1,
    language_notes: `CRITICAL VIOLATION: Customer communicated in ${violation.prechatLang} (detected from pre-chat form) but agent responded in a completely different language. Most severe violation.`,
    compliance_notes: `CRITICAL: Agent ignored customer's language (${violation.prechatLang} detected from pre-chat). Must respond in customer's language. Mandatory penalty applied.`,
    resolution_notes: `CRITICAL: Chat was ineffective — agent responded in wrong language, customer could not be properly assisted.`,
    issues: [`CRITICAL: Wrong language — customer wrote in ${violation.prechatLang} but agent responded in a different language`, ...(review.issues || []).slice(0, 2)],
    _language_penalty: true,
  };
  return penalized;
}

function buildLanguageViolationNote(events, users) {
  // Keep for transcript context hint (not relied on for scoring)
  const violations = detectLanguageViolations(events, users);
  if (violations.size === 0) return "";
  const prechatLang = detectPrechatLanguage(events);
  return `⚠ SYSTEM NOTE: Pre-Chat Form language = ${prechatLang?.toUpperCase()}. Language mismatch detected for some agents.\n\n`;
}

function buildTranscript(events, users) {
  const lines = [];
  for (const e of events) {
    const user = users.find((u) => u.id === e.author_id);
    const role = user?.type || "unknown";
    const name = user?.name || e.author_id;
    const ts = e.created_at || "";

    if (e.type === "filled_form" && Array.isArray(e.fields) && e.fields.length) {
      const fields = e.fields
        .map(f => `  ${f.label || f.id}: ${f.answer?.label ?? f.answer?.value ?? f.answer ?? ""}`)
        .join("\n");
      lines.push(`[${ts}] [PRE-CHAT FORM]\n${fields}`);
    } else if (e.type === "system_message" && e.text) {
      lines.push(`[${ts}] [SYSTEM] ${e.text}`);
    } else if (e.text && (e.type === "message" || e.type === "annotation")) {
      const isPrivate = e.visibility === "agents" || e.type === "annotation";
      const prefix = isPrivate ? "[SUPERVISOR NOTE] " : "";
      lines.push(`[${ts}] ${prefix}${name} (${role}): ${e.text}`);
    }
  }
  return lines.join("\n");
}

function extractSupervisorNotes(events, users) {
  return events
    .filter((e) => e.text && (e.visibility === "agents" || e.type === "annotation"))
    .map((e) => {
      const user = users.find((u) => u.id === e.author_id);
      return { author: user?.name || e.author_id, text: e.text, created_at: e.created_at };
    });
}

function buildAgentSegments(events, users, shifts, chatStartedAt) {
  const segments = {};
  const agentUsers = users.filter(u => u.type === "agent");

  // Pre-populate: only from agents who actually sent messages OR are named in system_messages.
  // Do NOT add all group-queue agents — a group transfer just means the chat went to a queue,
  // only the agent who actually picks it up (sends a message) should be reviewed.
  for (const e of events) {
    const isPrivate = e.visibility === "agents" || e.type === "annotation";
    if (!isPrivate) {
      const user = users.find(u => u.id === e.author_id);
      if (user?.type === "agent" && !segments[user.id]) {
        segments[user.id] = { id: user.id, name: user.name, events: [], supervisorNotes: [], responded: false };
      }
    }
    if (e.type === "system_message" && e.text) {
      const lower = e.text.toLowerCase();
      for (const a of agentUsers) {
        // Only add if the agent is explicitly named (e.g. "assigned to X", "X joined") — not a group transfer
        const isGroupTransfer = !!extractTransferGroup(e.text);
        if (!isGroupTransfer && !segments[a.id] && lower.includes(a.name.toLowerCase())) {
          segments[a.id] = { id: a.id, name: a.name, events: [], supervisorNotes: [], responded: false };
        }
      }
    }
  }

  let currentAgent = null;
  for (const e of events) {
    if (!e.text) continue;
    const isPrivate = e.visibility === "agents" || e.type === "annotation";

    if (!isPrivate) {
      const user = users.find(u => u.id === e.author_id);
      if (user?.type === "agent") {
        currentAgent = { id: user.id, name: user.name };
        segments[user.id].responded = true;
      }
      if (currentAgent) segments[currentAgent.id].events.push(e);
    } else if (currentAgent && segments[currentAgent.id]) {
      // Supervisor note during this agent's session — assign only to them
      const supervisorUser = users.find(u => u.id === e.author_id);
      segments[currentAgent.id].supervisorNotes.push({
        author: supervisorUser?.name || e.author_id,
        text: e.text,
        created_at: e.created_at,
      });
    }
  }
  return segments;
}

// Extract group name from "transferred to KYC (Farsi)" → "kyc"
function extractTransferGroup(text) {
  const m = text.match(/transferred\s+(?:the\s+chat\s+)?to\s+([A-Za-z][A-Za-z\s]*?)(?:\s*\(|$)/i);
  return m ? m[1].trim().toLowerCase() : null;
}

// Find agents in users list who belong to a group and were on shift at chatStartedAt
function groupAgentsOnShift(groupName, users, shifts, chatStartedAt) {
  if (!groupName || !shifts?.length) return [];
  const h = chatStartedAt ? getTehranHourFromIso(chatStartedAt) : -1;
  return shifts
    .filter(s => {
      const inGroup = (s.groups || []).some(g => g.toLowerCase() === groupName);
      const onShift = h < 0 || (h >= s.start && h < s.end);
      return inGroup && onShift;
    })
    .map(s => {
      // Match shift's agentKey to a user in this chat
      const user = users.find(u => {
        if (u.type !== "agent") return false;
        const k = u.name.toLowerCase().trim();
        return k === s.agentKey || k.split(" ")[0] === s.agentKey;
      });
      return user ? { id: user.id, name: user.name } : null;
    })
    .filter(Boolean);
}

function getTehranHourFromIso(iso) {
  try { return new Date(new Date(iso).toLocaleString("en-US", { timeZone: "Europe/Istanbul" })).getHours(); }
  catch { return -1; }
}

function allAgentsInThread(events, users, shifts, chatStartedAt) {
  const seen = {};
  const reasons = {};
  const agentUsers = users.filter(u => u.type === "agent");
  for (const e of events) {
    const isPrivate = e.visibility === "agents" || e.type === "annotation";
    if (!isPrivate) {
      const user = users.find(u => u.id === e.author_id);
      if (user?.type === "agent" && !seen[user.id]) {
        seen[user.id] = { id: user.id, name: user.name };
        reasons[user.name] = `sent message (type=${e.type})`;
      }
    }
    if (e.type === "system_message" && e.text) {
      const lower = e.text.toLowerCase();
      const isGroupTransfer = !!extractTransferGroup(e.text);
      if (!isGroupTransfer) {
        for (const a of agentUsers) {
          if (!seen[a.id] && lower.includes(a.name.toLowerCase())) {
            seen[a.id] = { id: a.id, name: a.name };
            reasons[a.name] = `named in system_message: "${e.text.slice(0,80)}"`;
          }
        }
      }
    }
  }
  const result = Object.values(seen);
  if (result.length) console.log(`[allAgents] found: ${result.map(a => `${a.name}(${reasons[a.name]})`).join(' | ')}`);
  return result;
}

async function reviewWithClaude(transcript, chatId, chatStartedAt, supervisorNotes = [], agentName = null, agentLanguages = [], agentGroups = [], attempt = 1) {
  try {
    return await _reviewWithClaude(transcript, chatId, chatStartedAt, supervisorNotes, agentName, agentLanguages, agentGroups);
  } catch (err) {
    if (attempt < 3) {
      console.warn(`[review] attempt ${attempt} failed for ${agentName || chatId}, retrying...`, err?.message);
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return reviewWithClaude(transcript, chatId, chatStartedAt, supervisorNotes, agentName, agentLanguages, agentGroups, attempt + 1);
    }
    throw err;
  }
}

async function _reviewWithClaude(transcript, chatId, chatStartedAt, supervisorNotes = [], agentName = null, agentLanguages = [], agentGroups = []) {
  const knowledgeSection = kb.knowledge
    ? `\nKNOWLEDGE BASE:\n${kb.knowledge.slice(0, 3000)}\n`
    : "";
  const campaignsSection = kb.campaigns
    ? `\nACTIVE CAMPAIGNS:\n${kb.campaigns.slice(0, 1500)}\n`
    : "";
  const telegramSection = kb.telegram
    ? `\nTELEGRAM UPDATES (only before chat date):\n${kb.telegram.slice(-1500)}\n`
    : "";
  const protocolSection = kb.protocol
    ? `\nRESPONSE PROTOCOL:\n${kb.protocol.slice(0, 1500)}\n`
    : "";
  const macrosSection = kb.macros
    ? `\nSTANDARD MACROS (pre-approved responses — check if agent used correct macro or deviated unnecessarily):\n${kb.macros.slice(0, 2000)}\n`
    : "";
  const tagsSection = kb.tags
    ? `\nAVAILABLE TAGS (assign ALL that apply — minimum 1 per chat. If referral was mentioned, always include "referred"):\n${kb.tags.slice(0, 2000)}\n
TAG CLARIFICATIONS (commonly confused tags — follow these exactly):
- AC-Delete: use when customer wants to DELETE or CLOSE their trading account.
- Prof-Change: use ONLY when customer wants to change personal/profile information (name, email, phone number, address, national ID, etc.). Do NOT use for account deletion.
- If customer asks to delete account → AC-Delete (not Prof-Change).
`
    : "";

  const isPerAgent = !!agentName;
  const langList = agentLanguages.length > 0 ? agentLanguages.join(", ") : null;
  const groupList = agentGroups.length > 0 ? agentGroups.join(", ") : null;
  const langRule = langList
    ? `AGENT LANGUAGES: This agent is designated to support: ${langList}. Apply the LANGUAGE ROUTING RULE accordingly. The language_score should reflect only whether the agent communicated well in their own supported language(s).`
    : "";
  const groupRule = groupList
    ? `AGENT DEPARTMENT: This agent belongs to the "${groupList}" department. Apply the DEPARTMENT ROUTING RULES accordingly — evaluate whether topics in this chat are in scope for this agent's department.`
    : "";
  const agentContext = isPerAgent
    ? `\nPER-AGENT REVIEW MODE: You are ONLY reviewing the performance of "${agentName}" based on their assigned portion of the chat below. Do NOT factor in what other agents did. Score ONLY what "${agentName}" did or failed to do.\n${groupRule}\n${langRule}\n`
    : "";

  const prompt = `You are a QA reviewer for a forex broker support team. Be concise.
CHAT DATE: ${chatStartedAt || "unknown"}
${agentContext}${knowledgeSection}${campaignsSection}${telegramSection}${protocolSection}${macrosSection}${tagsSection ? (isPerAgent ? "" : tagsSection) : ""}
Score the agent on 8 criteria. Write ALL notes, comments, issues, strengths, and summaries in ENGLISH only — regardless of what language the chat was in. Keep each note to 1 sentence max.

LOST CHAT RULE: If the agent's assigned portion shows customer messages but ZERO responses from the agent, it means the agent lost/abandoned the chat. In this case: response_time_score = 0, overall_score must reflect this failure heavily, and notes must clearly state the agent did not respond and lost the chat.

CUSTOMER NO-RESPONSE RULE: If at ANY point the customer stops replying — whether after the agent asked a question, requested info/screenshot/link, sent a follow-up, or simply waited — and the chat ends with the customer silent (visible as: no further customer message, "X left the chat", "Chat is idle due to inactivity", or the agent sending a closing/follow-up message with no customer reply), then:
- The unresolved outcome is the CUSTOMER's fault — NOT the agent's.
- YOU MUST NOT deduct from resolution_score for the issue being unresolved. Give resolution_score based on how correctly the agent handled the chat up to the point the customer went silent — if the agent did their job correctly, resolution_score should be 8–10.
- Do NOT deduct from compliance_score for not closing properly (customer left before agent could close).
- Set "resolved": false (issue wasn't technically resolved) but make clear in notes it was due to customer inactivity/departure.
- CRITICAL — BLOCKED BY MISSING CUSTOMER DATA: Whenever an agent requests ANY information from the customer — screenshot, photo, link, provider name, IB code, account number, transaction ID, error message, or ANY other data — and the customer does not provide it, the agent is completely blocked from investigating further. This rule applies to ALL chats. When this happens, you are FORBIDDEN from flagging any of the following as issues:
    • "agent did not escalate"
    • "agent did not offer alternative support"
    • "agent did not troubleshoot further" or "proactively"
    • "agent did not follow up"
    • "issue remains unresolved" (as a fault of the agent)
    • "no closing message" (if customer left before agent could close)
    • "chat ended abruptly" (if customer left)
  The resolution_score must reflect what the agent was ABLE to do — if they correctly asked for the needed data, that IS the correct next step. Give a HIGH resolution score for correctly identifying what was needed and requesting it. The unresolved outcome belongs to the customer, not the agent.

BROKER CONTEXT:
This broker offers 4 trading platforms: MetaTrader 4 (MT4), MetaTrader 5 (MT5), cTrader, OpoTrade, and TradingView. Each platform has its own account types (Standard, Pro, Black, etc.) with DIFFERENT specifications — same account name on different platforms is intentional and NOT a contradiction. Always consider the platform context when evaluating specs.

IMPORTANT RULES FOR ACCURACY SCORING:
- If the agent's response matches or is consistent with ANYTHING in the knowledge base OR standard macros, consider it CORRECT — do not penalize.
- Only flag accuracy errors when the agent's response clearly contradicts BOTH the knowledge base AND the macros, or contains information found in neither.
- Do NOT flag contradictions between different parts of the KB or between different macros — these are data issues, not agent errors.
- Do NOT flag different specs for same-named accounts across different platforms — this is expected.
- TRANSACTION TRACKING: Agents are fully authorized to share transaction hashes, TXIDs, blockchain scan links (e.g. tronscan, etherscan, bscscan), or any payment/transaction tracking link with customers. This is standard practice for verifying deposits and withdrawals. Do NOT penalize for sharing these links or references — never flag it as an accuracy, compliance, or policy issue.

SPECIAL RULE — ACCOUNT TYPES:
- Whenever a customer asks about account types, account options, or account comparison, the agent MUST send BOTH: (1) the general account types macro (covering MT4/MT5/cTrader/OpoTrade) AND (2) the TradingView account types macro. If either one is missing, flag it as an issue in the resolution or accuracy notes.

DEPARTMENT ROUTING RULES:

Step 1 — Understand the customer's actual question:
  Read the [PRE-CHAT FORM] block first. The form shows which department the customer chose AND what they wrote as their question. The department selection in the form is made by the customer and does NOT always match their real question. Always combine the form question + in-chat messages to determine what the customer truly needs. Short in-chat messages ("why?", "دلیلش چیه", "what's the reason?") are follow-ups to what the customer already wrote in the form — never treat them as ambiguous when the form question is clear.

Step 2 — Determine if the question is in scope for this agent's department:

  • KYC department: handles ONLY these topics:
      - Identity verification (احراز هویت)
      - Submitting or reviewing personal documents (ID card, passport, selfie)
      - Proof of residence documents (utility bills, bank statements for address)
      - Changing or correcting profile/personal information (name, national code, birthdate, address, phone, email)
      Nothing else belongs to KYC.

  • Social Trade / CopyTrade department: handles ONLY questions specifically about the Social Trade or CopyTrade platform:
      - Copy trading: providers, followers, copy strategies, copy performance, following/unfollowing a provider
      - Social Trade platform features and problems
      Nothing else belongs to Social Trade — even if the customer selected "Social Trade" in the pre-chat form.

  • General department: handles ALL other topics, including:
      - Trading platform issues (MetaTrader 4, MetaTrader 5, cTrader, OpoTrade, TradingView)
      - Account issues: account activation, login problems, account types, upgrade/downgrade
      - Trading: positions, buy/sell orders, open/close positions, greyed-out buttons, chart issues, spread, leverage
      - Financial: deposits, withdrawals, money transfers between accounts, IB (introducing broker) commissions
      - Promotions, bonuses, campaigns
      - Any other topic not explicitly in KYC or Social Trade scope

  If a customer's actual question does not belong to the agent's department, it is out of scope — regardless of which department the customer selected in the pre-chat form.

LANGUAGE MATCHING RULE — HIGHEST PRIORITY:
  The agent MUST respond in the same language the customer is communicating in, OR the language the customer selected in the pre-chat form. This rule has NO exceptions and NO conditions.

  Step 1 — Determine the customer's EFFECTIVE language (priority order):
    a) Look at the actual language the customer used in their chat messages — this overrides the pre-chat form if different.
    b) If the customer wrote in Farsi during the chat, the effective language is Farsi — even if the pre-chat form was in English. The customer chose to switch.
    c) If the customer explicitly requested a language switch (e.g. "can we speak Farsi?", "لطفاً فارسی صحبت کنید") — that request is the effective language from that point forward.
    d) If customer chat messages are in the same language as the pre-chat form, use that language.
    e) NEVER assume a customer knows Farsi/Persian unless: (1) the customer explicitly wrote in Farsi, OR (2) the pre-chat form shows Farsi.

  Step 2 — Check what language the agent used.

  Step 3 — If the agent responded in a DIFFERENT language than the customer's determined language (from Step 1):
    THIS IS THE MOST CRITICAL VIOLATION IN THE ENTIRE REVIEW. Apply ALL of the following:
      • language_score = 1
      • compliance_score = 1
      • resolution_score = 1
      • tone_score = 1
      • overall_score = 1 — MANDATORY. No other positive factor can raise this. Set overall_score to 1.
      • In issues: first bullet must be "CRITICAL: Agent responded in [language used] despite customer communicating in / selecting [customer's language]."
      • Do NOT soften this penalty under any circumstances. Do NOT say "agent was otherwise helpful" as a mitigating factor.

  If the agent's designated languages do not include the customer's language, the ONLY correct action is to inform the customer and transfer the chat. Responding in a third wrong language instead of transferring = same CRITICAL VIOLATION above.

LANGUAGE ROUTING RULE:
  The agent's designated language(s) are specified at the top of the review context (e.g. "AGENT LANGUAGES: This agent is designated to support: English, Arabic").

  If the customer writes primarily in a language the agent does NOT support:

    CORRECT handling — award full marks in all affected areas:
      - Agent recognizes the language barrier, informs the customer briefly (any language), and transfers the chat.
      - This is a complete and successful handling. The issue is now the receiving agent's responsibility.
      - Do NOT penalize resolution_score, compliance_score, or product_knowledge_score for the customer's issue being unresolved.
      - Do NOT penalize for "no follow-up", "no solution given", "incomplete answer", or "customer issue unresolved" in this scenario.
      - The ONLY thing to evaluate is: did the agent correctly recognize and route the language mismatch?

    INCORRECT handling — penalize compliance_score and overall_score:
      - Agent ignores the language barrier and attempts to respond in the wrong language.
      - Agent stays in the chat without transferring or informing the customer.
      - Agent closes the chat without transferring or explaining the reason.

  If the customer writes in a language the agent DOES support, apply normal scoring.
  If the agent's languages are not specified in the review context, skip this rule.

Step 3 — Evaluate the agent's routing decision:
  CORRECT (full marks for resolution and compliance):
    - Agent recognized the question is out of scope → informed the customer → transferred to the correct department. This is a complete and successful handling. Do NOT deduct for the customer's issue being "unresolved" — it is now the receiving department's responsibility.
  INCORRECT (penalize resolution and compliance):
    - Agent transferred WITHOUT informing the customer first.
    - Agent kept an out-of-scope question and tried to answer it themselves.
    - Agent ignored the question without routing.

NEVER do the following — these are always wrong:
  - Penalizing an agent for "not clarifying before transfer" when the customer's question is clearly outside the agent's department scope. If the topic is obviously out of scope, the agent does not need to investigate further before routing.
  - Flagging "unresolved issue" against an agent who correctly transferred an out-of-scope question.
  - Counting the receiving department's unresolved work as a failure of the transferring agent.

SUPERVISOR NOTES RULE:
- Lines marked [SUPERVISOR NOTE] in the transcript are private internal messages from supervisors (not visible to customer).
- If a supervisor note contains a correction, warning, or instruction directed at the agent's behavior in this chat, set "supervisor_warning" to true and quote the note in "supervisor_warning_text".
- Supervisor warnings must be factored into the overall assessment and flagged clearly in issues.

RESPONSE TIME SCORING:
- IMPORTANT: The very first agent message in every chat is an AUTOMATIC greeting sent by the system (not typed by the agent). Do NOT evaluate this message — ignore it completely for response time, tone, and compliance scoring. The agent's real first message is the SECOND agent message in the transcript.
- Measure the gap between each CUSTOMER message and the AGENT's next MANUAL reply (starting from the second agent message onward). Do NOT measure total conversation duration.
- First response (from customer's first message to agent's SECOND message): must be ≤15s. Score: ≤15s=10, 16-30s=8, 31-60s=6, >60s=4.
- Mid-chat replies (gap between customer message and agent reply):
    • Standard: must be ≤60s. Penalty if >60s.
    • If the agent explicitly said something like "let me check", "بررسی میکنم", "صبر کنید", "یه لحظه" before going silent, the allowed gap extends to 120s — do NOT penalize a delay up to 2 minutes after such a statement.
- A long conversation with fast per-message replies = HIGH response time score. Do NOT penalize for total conversation length.
- NEVER say an agent "handled late" or "took too long" based on total conversation time — only base this on per-reply gaps.

CHAT MANAGEMENT RULES (check these in compliance scoring):
1. Follow-up check: After the agent sends a response and the customer does NOT write anything for ~60 seconds (visible as a long gap before the next customer message, or the chat ends without the customer responding), the agent SHOULD send a follow-up such as "سوال دیگه‌ای دارید؟" or "آیا مشکل دیگه‌ای هست؟". If the agent skips this and closes without asking, flag it as a minor compliance issue.
2. Chat closing: At the end of the conversation the agent must send a proper closing message — either the standard closing macro OR a message explaining the chat is being closed due to customer inactivity. If the agent closes abruptly without a farewell or closing reason, flag it as a compliance issue.
3. IDLE PENALTY: If you see a system message containing "Chat is idle due to" or "inactivity" in the transcript, this means the agent left the chat unattended. Maximum allowed idle time is 2 minutes. Any idle event = deduct 2 points from compliance_score (this is a significant violation — do not treat it as minor). Mention it explicitly in compliance_notes.
4. These other rules are MINOR issues — deduct at most 1 point from compliance per missing item. Do not heavily penalize if the conversation was otherwise resolved well.
overall_score = weighted avg: accuracy 20%, resolution 20%, compliance 15%, tone 15%, response_time 15%, product_knowledge 10%, satisfaction 3%, language 2%

Return ONLY valid JSON:
{"overall_score":<1-10>,"response_time_score":<1-10>,"response_time_notes":"<1 sentence>","tone_score":<1-10>,"tone_notes":"<1 sentence>","accuracy_score":<1-10>,"accuracy_notes":"<1 sentence>","resolution_score":<1-10>,"resolution_notes":"<1 sentence>","compliance_score":<1-10>,"compliance_notes":"<1 sentence>","product_knowledge_score":<1-10>,"product_knowledge_notes":"<1 sentence>","satisfaction_score":<1-10>,"satisfaction_notes":"<1 sentence>","language_score":<1-10>,"language_notes":"<1 sentence>","resolved":<true/false>,"escalated":<true/false>,"language_detected":"<fa/en/ar/mixed>","supervisor_warning":<true/false>,"supervisor_warning_text":"<quote or null>","suggested_tags":["<tag1>","<tag2>"],"issues":"<max 3 bullet points or null>","strengths":"<max 2 bullet points>","summary":"<1 sentence>"}

TRANSCRIPT:
${transcript}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      system: "You are a JSON-only output assistant. You must ALWAYS respond with a single valid JSON object and nothing else. No preamble, no explanation, no markdown — just the raw JSON starting with { and ending with }.",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.log(`[claude] error body:`, errBody);
    throw new Error(`Claude API error: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  let text = data.content[0].text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/```json?\n?/, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    // Fallback: extract the first {...} block from the response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    console.error("[claude] non-JSON response:", text.slice(0, 300));
    throw new Error("Claude returned non-JSON response");
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/api/debug-chat/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { thread_id } = req.query;
    const data = await lcPost("get_chat", { chat_id: chatId });
    let thread = data.thread || (data.threads || [])[0] || {};
    if (thread_id && Array.isArray(data.threads)) {
      thread = data.threads.find(t => t.id === thread_id) || thread;
    }
    const events = thread.events || [];
    res.json({
      container_chat_id: chatId,
      thread_id: thread.id,
      assignee: thread.assignee,
      all_threads: (data.threads || [data.thread]).filter(Boolean).map(t => ({ id: t.id, created_at: t.created_at, assignee: t.assignee })),
      users: (data.users || []).map(u => ({ id: u.id, name: u.name, type: u.type })),
      event_types: [...new Set(events.map(e => e.type))],
      filled_forms: events.filter(e => e.type === "filled_form").map(e => ({
        created_at: e.created_at,
        fields: e.fields || null,
        properties: e.properties || null,
        raw_keys: Object.keys(e),
      })),
      events_summary: events.map(e => ({
        type: e.type,
        author_id: e.author_id,
        visibility: e.visibility,
        has_text: !!e.text,
        text_preview: (e.type === "system_message" && e.text) ? e.text.slice(0, 120) : undefined,
        created_at: e.created_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/debug-env", (req, res) => {
  res.json({
    account_id: process.env.LIVECHAT_ACCOUNT_ID || "NOT SET",
    pat_length: (process.env.LIVECHAT_PAT || "").length,
    pat_preview: (process.env.LIVECHAT_PAT || "").slice(0, 15) + "...",
    database_url: process.env.DATABASE_URL ? "SET (length " + process.env.DATABASE_URL.length + ")" : "NOT SET",
    db_pool: pool ? "active" : "null (file fallback)",
  });
});

// Get all agents
app.get("/api/agents", authMiddleware, async (req, res) => {
  try {
    console.log("calling list_agents...");
    const data = await lcPost("list_agents", {}, LC_CONFIG_API);
    console.log("list_agents raw:", JSON.stringify(data).slice(0, 300));
    let agentList = [];
    if (Array.isArray(data)) agentList = data;
    else if (Array.isArray(data?.agents)) agentList = data.agents;
    else if (typeof data === "object") agentList = Object.values(data).find(v => Array.isArray(v)) || [];
    res.json(agentList.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      avatar: a.avatar?.url || null,
    })));
  } catch (e) {
    console.log("list_agents error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fetch archived chats from LiveChat
app.get("/api/chats", authMiddleware, async (req, res) => {
  try {
    const { date_from, date_to, agent_id, page_id } = req.query;
    const filters = {};
    if (date_from) filters.from = date_from;
    if (date_to) filters.to = date_to;
    if (agent_id) filters.agents = { values: [agent_id] };

    const body = page_id ? { page_id } : { filters, limit: 100 };

    console.log('[chats] sending body:', JSON.stringify(body));
    const data = await lcPost("list_archives", body);
    console.log('[chats] found_chats:', data.found_chats, '| chats count:', (data.chats||[]).length);
    const sample = (data.chats||[]).slice(0,3).map(c => {
      const t = c.thread || (Array.isArray(c.threads) ? c.threads[0] : null) || {};
      return t.created_at || c.id;
    });
    console.log('[chats] sample dates:', sample);
    // Debug: check assignee & events in first chat
    const first = (data.chats||[])[0];
    if (first) {
      const ft = first.thread || (Array.isArray(first.threads) ? first.threads[0] : null) || {};
      console.log('[chats] first chat assignee:', ft.assignee, '| events count:', (ft.events||[]).length);
    }
    const [reviews, shifts] = await Promise.all([loadReviews(), loadShifts()]);

    const chats = (data.chats || []).map((c) => {
      const thread = c.thread || (Array.isArray(c.threads) ? c.threads[0] : null) || {};
      const users = c.users || [];
      const assigneeId = thread?.assignee?.id;
      // Find agent who actually sent messages in THIS thread (not historical users)
      const events = thread.events || [];
      const activeAgentId = events.find(e => {
        const u = users.find(u2 => u2.id === e.author_id);
        return u && u.type === "agent";
      })?.author_id;
      const agentUser = (assigneeId ? users.find(u => u.id === assigneeId) : null)
        || (activeAgentId ? users.find(u => u.id === activeAgentId) : null)
        || null;
      const customerUser = users.find((u) => u.type === "customer");
      const chatStartedAt = thread.created_at || null;
      const allAgents = allAgentsInThread(events, users, shifts, chatStartedAt);
      return {
        id: c.id,
        thread_id: thread.id || null,
        agent: agentUser ? { id: agentUser.id, name: agentUser.name } : null,
        agents: allAgents,
        customer_name: customerUser?.name || null,
        started_at: thread.created_at || null,
        ended_at: thread.ended_at || null,
        applied_tags: thread.tags || [],
        review: reviews[thread.id] || reviews[c.id] || null,
      };
    });

    res.json({ chats, next_page_id: data.next_page_id || null, total_chats: data.found_chats || data.total_chats || chats.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single chat with full transcript
app.get("/api/chats/:chatId", authMiddleware, async (req, res) => {
  try {
    const { thread_id } = req.query;
    const gcBody = { chat_id: req.params.chatId };
    if (thread_id) gcBody.thread_id = thread_id;
    const data = await lcPost("get_chat", gcBody);

    // If thread_id specified, find that specific thread
    let thread;
    if (thread_id && Array.isArray(data.threads)) {
      thread = data.threads.find(t => t.id === thread_id) || data.threads[0] || {};
    } else {
      thread = data.thread || (data.threads || [])[0] || {};
    }

    const users = data.users || [];
    const events = thread.events || [];
    const chatStartedAt2 = thread.created_at || null;
    const [reviews, shifts2] = await Promise.all([loadReviews(), loadShifts()]);

    // Build segment map: event created_at -> agent responsible at that moment
    const agentSegments = buildAgentSegments(events, users, shifts2, chatStartedAt2);
    const eventSegmentMap = {};
    for (const [, seg] of Object.entries(agentSegments)) {
      for (const ev of seg.events) {
        if (!eventSegmentMap[ev.created_at]) {
          eventSegmentMap[ev.created_at] = { id: seg.id, name: seg.name };
        }
      }
    }

    const messages = events
      .filter((e) => {
        if (e.type === "filled_form") return Array.isArray(e.fields) && e.fields.length > 0;
        if (e.type === "system_message") return !!e.text;
        return e.text && (e.type === "message" || e.type === "annotation");
      })
      .map((e) => {
        const user = users.find((u) => u.id === e.author_id);
        const isPrivate = e.visibility === "agents" || e.type === "annotation";
        if (e.type === "filled_form") {
          const fields = e.fields.map(f => `${f.label || f.id}: ${f.answer?.label ?? f.answer?.value ?? f.answer ?? ""}`).join("\n");
          return { author_type: "system", author_name: "Pre-Chat Form", content: fields, created_at: e.created_at, is_private: false, segment_agent: null, event_type: "filled_form" };
        }
        if (e.type === "system_message") {
          return { author_type: "system", author_name: "System", content: e.text, created_at: e.created_at, is_private: false, segment_agent: null, event_type: "system_message" };
        }
        return {
          author_type: isPrivate ? "supervisor" : (user?.type || "unknown"),
          author_name: user?.name || e.author_id,
          content: e.text,
          created_at: e.created_at || null,
          is_private: isPrivate,
          segment_agent: isPrivate ? null : (eventSegmentMap[e.created_at] || null),
          event_type: "message",
        };
      });

    const allAgents = allAgentsInThread(events, users, shifts2, chatStartedAt2);
    const assigneeId = thread?.assignee?.id;
    const activeAgentId = events.find(e => {
      const u = users.find(u2 => u2.id === e.author_id);
      return u && u.type === "agent";
    })?.author_id;
    const agentUser = (assigneeId ? users.find(u => u.id === assigneeId) : null)
      || (activeAgentId ? users.find(u => u.id === activeAgentId) : null)
      || null;
    const customerUser = users.find((u) => u.type === "customer");

    res.json({
      id: data.id,
      thread_id: thread.id || null,
      agent: agentUser ? { id: agentUser.id, name: agentUser.name, email: agentUser.email } : null,
      agents: allAgents,
      customer_name: customerUser?.name || null,
      started_at: thread.created_at || null,
      ended_at: thread.ended_at || null,
      applied_tags: thread.tags || [],
      messages,
      review: reviews[thread.id] || reviews[data.id] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Review a chat with Claude AI
app.post("/api/review/:chatId", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params;
    console.log(`[review] fetching chat ${chatId}`);

    const { thread_id } = req.query;
    const gcBody = { chat_id: chatId };
    if (thread_id) gcBody.thread_id = thread_id;
    const data = await lcPost("get_chat", gcBody);
    console.log(`[review] get_chat keys:`, Object.keys(data));

    let thread;
    if (thread_id && Array.isArray(data.threads)) {
      thread = data.threads.find(t => t.id === thread_id) || data.threads[0] || {};
    } else {
      thread = data.thread || (data.threads || [])[0] || {};
    }
    const users = data.users || [];
    const events = thread.events || [];
    console.log(`[review] thread keys:`, Object.keys(thread));
    console.log(`[review] events: ${events.length}, users: ${users.length}`);

    const chatStartedAt3 = thread.created_at || null;
    const shifts3 = await loadShifts();

    // If the customer never sent a single message, there is nothing to review
    const customerMessages = events.filter(e => {
      const u = users.find(u2 => u2.id === e.author_id);
      return e.type === "message" && u?.type === "customer" && e.text;
    });
    if (customerMessages.length === 0) {
      const skippedReview = { skipped: true, reason: "Customer left without sending any message" };
      await saveReviews({ [thread.id || chatId]: skippedReview });
      return res.json(skippedReview);
    }

    const langViolations = detectLanguageViolations(events, users);
    const langViolationNote = buildLanguageViolationNote(events, users);
    const transcript = langViolationNote + buildTranscript(events, users);
    const supervisorNotes = extractSupervisorNotes(events, users);
    const agentSegments = buildAgentSegments(events, users, shifts3, chatStartedAt3);
    const agentCount = Object.keys(agentSegments).length;
    console.log(`[review] transcript: ${transcript.length}c, agents: ${agentCount}, supervisor notes: ${supervisorNotes.length}`);

    if (!transcript) {
      return res.status(400).json({ error: "No messages in this chat" });
    }

    const chatStartedAt = thread.created_at || null;

    // Overall review + per-agent reviews in parallel
    const overallPromise = reviewWithClaude(transcript, chatId, chatStartedAt, supervisorNotes);
    const agentPromises = agentCount > 1
      ? Object.fromEntries(
          Object.entries(agentSegments).map(([agentId, seg]) => {
            // Agent was assigned but never sent a message — instant 0, no Claude call needed
            if (!seg.responded) {
              const result = Promise.resolve({
                agent_name: seg.name,
                overall_score: 0,
                response_time_score: 0,
                accuracy_score: 0,
                tone_score: 0,
                resolution_score: 0,
                notes: `${seg.name} hich javabi be customer naferestade va chat ro az dast dad.`,
                issues: ["Chat az dast raft — agent hich pasokhi naferestade"],
                suggested_tags: [],
              });
              return [agentId, result];
            }
            // Prepend pre-chat form + system_messages from full event list so Claude has routing context
            const contextEvents = events.filter(e =>
              e.type === "filled_form" || e.type === "system_message"
            );
            const agentOnlyEvents = seg.events.filter(e =>
              e.type !== "filled_form" && e.type !== "system_message"
            );
            const agentTranscript = buildTranscript([...contextEvents, ...agentOnlyEvents], users);
            // Find this agent's shift entry for languages + groups
            const agentShiftEntry = shifts3.find(s => {
              const k = seg.name.toLowerCase().trim();
              return k === s.agentKey || k.split(" ")[0] === s.agentKey;
            });
            const agentLangs = agentShiftEntry?.languages || [];
            const agentGroups = agentShiftEntry?.groups || [];
            return [
              agentId,
              reviewWithClaude(agentTranscript, chatId, chatStartedAt, seg.supervisorNotes || [], seg.name, agentLangs, agentGroups)
                .then(r => ({ ...r, agent_name: seg.name }))
                .catch(err => {
                  console.error(`[per-agent review] FAILED for ${seg.name}:`, err?.message || err);
                  return {
                    agent_name: seg.name,
                    overall_score: null,
                    notes: `Review failed: ${err?.message || "unknown error"}`,
                    issues: [],
                    suggested_tags: [],
                    _error: true,
                  };
                })
            ];
          })
        )
      : {};

    let review = await overallPromise;
    review.reviewed_at = new Date().toISOString();

    // Server-side language penalty override — do not rely on Claude to apply it
    console.log(`[lang] prechatLang=${detectPrechatLanguage(events)} violations=${[...langViolations.entries()].map(([k,v])=>`${k}:${v.prechatLang}->${v.agentLang}`).join(',') || 'none'} agentCount=${agentCount}`);
    if (agentCount > 1) {
      const perAgent = {};
      for (const [agentId, promise] of Object.entries(agentPromises)) {
        let ar = await promise;
        // Try exact name, then first-word match
        const nameKey = (ar.agent_name || "").toLowerCase();
        const v = langViolations.get(nameKey) || [...langViolations.entries()].find(([k]) => nameKey.startsWith(k) || k.startsWith(nameKey.split(" ")[0]))?.[1];
        if (v) { ar = applyLanguagePenalty(ar, ar.agent_name, v); console.log(`[lang] penalty applied to ${ar.agent_name}`); }
        perAgent[agentId] = ar;
      }
      review.per_agent_reviews = perAgent;
    } else {
      // Single-agent: if ANY violation detected, apply to overall review
      if (langViolations.size > 0) {
        const [firstKey, firstV] = [...langViolations.entries()][0];
        review = applyLanguagePenalty(review, firstKey, firstV);
        console.log(`[lang] single-agent penalty applied, prechat=${firstV.prechatLang} agentLang=${firstV.agentLang}`);
      }
    }

    // Enrich review with agent + date metadata for dashboard queries
    const assigneeId2 = thread?.assignee?.id;
    const activeAgentId2 = events.find(e => {
      const u = users.find(u2 => u2.id === e.author_id);
      return u && u.type === "agent";
    })?.author_id;
    const primaryAgent = (assigneeId2 ? users.find(u => u.id === assigneeId2) : null)
      || (activeAgentId2 ? users.find(u => u.id === activeAgentId2) : null);
    if (primaryAgent) {
      review._agent_name = primaryAgent.name;
      review._agent_id   = primaryAgent.id;
    }
    review._chat_date = thread.created_at || null;

    const reviews = await loadReviews();
    const reviewKey = thread_id || chatId;
    reviews[reviewKey] = review;
    await saveReviews(reviews);

    console.log(`[review] done for ${reviewKey}, overall: ${review.overall_score}, agents: ${agentCount}`);
    res.json(review);
  } catch (e) {
    console.log(`[review] ERROR:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get all saved reviews
app.get("/api/reviews", async (req, res) => {
  const reviews = await loadReviews();
  res.json(reviews);
});

// Stats per agent
app.get("/api/stats", async (req, res) => {
  const reviews = await loadReviews();
  const { date_from, date_to, agent_id } = req.query;

  // Aggregate reviews by agent from the reviews file + agent data
  const entries = Object.entries(reviews);
  const byAgent = {};

  for (const [, r] of entries) {
    const aId = r._agent_id;
    if (!aId) continue;
    if (agent_id && aId !== agent_id) continue;
    if (!byAgent[aId]) {
      byAgent[aId] = { name: r._agent_name || aId, scores: [], resolved: 0, total: 0 };
    }
    byAgent[aId].scores.push(r.overall_score || 0);
    if (r.resolved) byAgent[aId].resolved++;
    byAgent[aId].total++;
  }

  const result = Object.entries(byAgent).map(([id, d]) => ({
    id,
    name: d.name,
    total_chats: d.total,
    avg_score: d.scores.length ? +(d.scores.reduce((a, b) => a + b, 0) / d.scores.length).toFixed(2) : 0,
    resolved_count: d.resolved,
    resolution_rate: d.total ? +((d.resolved / d.total) * 100).toFixed(1) : 0,
  }));

  res.json(result);
});

// Dashboard stats for current month — independent of Chat Review page
app.get("/api/dashboard-stats", authMiddleware, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const lcFrom = `${month}-01T00:00:00.000000+00:00`;
    const lcTo   = `${month}-${String(lastDay).padStart(2,"0")}T23:59:59.999999+00:00`;

    const [reviews, shifts, agentsRaw] = await Promise.all([
      loadReviews(),
      loadShifts(),
      lcPost("list_agents", {}, LC_CONFIG_API),
    ]);

    // name → employee display name via shifts
    function toEmp(agentName) {
      if (!agentName) return null;
      const low = agentName.toLowerCase().trim();
      const fst = low.split(" ")[0];
      const s = shifts.find(s => s.agentKey === low || s.agentKey === fst);
      return s ? s.employee : null;
    }

    // Build employeeName → LiveChat agentId map from list_agents
    const rawAgentList = Array.isArray(agentsRaw) ? agentsRaw
      : Array.isArray(agentsRaw?.agents) ? agentsRaw.agents
      : Object.values(agentsRaw || {}).find(v => Array.isArray(v)) || [];

    const empToAgentId = {};
    for (const a of rawAgentList) {
      const n = toEmp(a.name);
      if (n && !empToAgentId[n]) empToAgentId[n] = a.id;
    }
    console.log("[dashboard] empToAgentId:", JSON.stringify(empToAgentId));

    // Unique employees from shifts
    const uniqueEmps = [...new Set(shifts.map(s => s.employee))];

    // Total chats + per-employee counts sequentially to avoid rate limiting
    const firstPage = await lcPost("list_archives", { filters: { from: lcFrom, to: lcTo }, limit: 1 });
    const totalChats = firstPage.found_chats ?? firstPage.total_chats ?? 0;

    const empTotals = [];
    for (const empName of uniqueEmps) {
      const agentId = empToAgentId[empName];
      if (!agentId) {
        console.log(`[dashboard] no agentId for: ${empName}`);
        empTotals.push({ empName, total: 0 });
        continue;
      }
      try {
        const d = await lcPost("list_archives", {
          filters: { from: lcFrom, to: lcTo, agents: [{ id: agentId }] },
          limit: 1,
        });
        const total = d.found_chats ?? d.total_chats ?? 0;
        console.log(`[dashboard] ${empName} (${agentId}): ${total}`);
        empTotals.push({ empName, total });
      } catch(e) {
        console.log(`[dashboard] error for ${empName}:`, e.message);
        empTotals.push({ empName, total: 0 });
      }
    }

    // Build emp map — only include employees who had at least 1 chat
    const emp = {};
    for (const { empName, total } of empTotals) {
      if (total > 0) emp[empName] = { total, reviewed: 0, scores: [], resolved: 0 };
    }
    console.log("[dashboard] employee totals:", Object.entries(emp).map(([n,d])=>`${n}:${d.total}`).join(", "));
    console.log("[dashboard] no agentId for:", uniqueEmps.filter(e => !empToAgentId[e]).join(", "));

    // Scores/reviews: from our database filtered by month
    for (const rv of Object.values(reviews)) {
      if (!rv || rv.skipped) continue;
      const chatMonth = (rv._chat_date || "").slice(0, 7);
      if (chatMonth !== month) continue;

      const agentName = rv._agent_name || "";
      const empName = toEmp(agentName);
      if (!empName || !emp[empName]) continue;

      emp[empName].reviewed++;
      if (rv.per_agent_reviews) {
        const fst = agentName.toLowerCase().trim().split(" ")[0];
        const pr = Object.values(rv.per_agent_reviews).find(r =>
          r?.agent_name && r.agent_name.toLowerCase().trim().startsWith(fst)
        );
        if (pr?.overall_score > 0) emp[empName].scores.push(pr.overall_score);
        if (pr?.resolved) emp[empName].resolved++;
      } else {
        if (rv.overall_score > 0) emp[empName].scores.push(rv.overall_score);
        if (rv.resolved) emp[empName].resolved++;
      }
    }

    const allScores = Object.values(emp).flatMap(e => e.scores);
    const totalReviewed = Object.values(emp).reduce((s, e) => s + e.reviewed, 0);
    const totalResolved = Object.values(emp).reduce((s, e) => s + e.resolved, 0);
    const avgScore = allScores.length ? +(allScores.reduce((a,b)=>a+b,0)/allScores.length).toFixed(1) : null;

    const employees = Object.entries(emp)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([name, d]) => ({
        name,
        total: d.total,
        reviewed: d.reviewed,
        avg_score: d.scores.length ? +(d.scores.reduce((a,b)=>a+b,0)/d.scores.length).toFixed(2) : null,
        resolved: d.resolved,
      }));

    res.json({ month, total_chats: totalChats, total_reviewed: totalReviewed, total_resolved: totalResolved, avg_score: avgScore, employees });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backfill _agent_name + _chat_date into existing reviews without calling Claude
app.post("/api/backfill-agent-names", authMiddleware, adminOnly, async (req, res) => {
  try {
    // Load all reviews that are missing _agent_name
    let toFix = {};
    if (pool) {
      const r = await pool.query(`SELECT chat_id, data FROM reviews WHERE data->>'_agent_name' IS NULL`);
      r.rows.forEach(row => { toFix[row.chat_id] = row.data; });
    } else {
      const all = await loadReviews();
      Object.entries(all).forEach(([k, v]) => { if (v && !v._agent_name) toFix[k] = v; });
    }

    const missingIds = Object.keys(toFix);
    if (missingIds.length === 0) return res.json({ updated: 0, message: "All reviews already have agent info" });

    console.log(`[backfill] ${missingIds.length} reviews missing _agent_name — scanning LiveChat...`);

    // Paginate through LiveChat archives to find matching chats
    let updated = 0;
    let pageId = null;
    const remaining = new Set(missingIds);

    do {
      const body = pageId ? { page_id: pageId } : { limit: 100 };
      const data = await lcPost("list_archives", body);
      const chats = data.chats || [];
      pageId = data.next_page_id || null;

      for (const c of chats) {
        const thread = c.thread || (Array.isArray(c.threads) ? c.threads[0] : null) || {};
        const users  = c.users || [];
        const events = thread.events || [];
        const chatKey = thread.id || c.id;

        if (!remaining.has(chatKey) && !remaining.has(c.id)) continue;
        const matchKey = remaining.has(chatKey) ? chatKey : c.id;

        const assigneeId = thread?.assignee?.id;
        const activeAgentId = events.find(e => {
          const u = users.find(u2 => u2.id === e.author_id);
          return u && u.type === "agent";
        })?.author_id;
        const agentUser = (assigneeId ? users.find(u => u.id === assigneeId) : null)
          || (activeAgentId ? users.find(u => u.id === activeAgentId) : null);

        if (!agentUser) continue;

        const review = toFix[matchKey];
        review._agent_name = agentUser.name;
        review._agent_id   = agentUser.id;
        review._chat_date  = thread.created_at || null;

        if (pool) {
          await pool.query(
            `UPDATE reviews SET data = $1, updated_at = updated_at WHERE chat_id = $2`,
            [review, matchKey]
          );
        }
        remaining.delete(matchKey);
        updated++;
        if (remaining.size === 0) break;
      }

      if (remaining.size === 0) break;
    } while (pageId);

    if (!pool) await saveReviews({ ...await loadReviews(), ...toFix });

    console.log(`[backfill] done — updated ${updated}/${missingIds.length}`);
    res.json({ updated, total: missingIds.length, still_missing: remaining.size });
  } catch (e) {
    console.error("[backfill] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Debug: show exact agent names from LiveChat
app.get("/api/agent-names", async (req, res) => {
  try {
    const data = await lcPost("list_agents", {}, LC_CONFIG_API);
    let list = Array.isArray(data) ? data : data?.agents || Object.values(data).find(v => Array.isArray(v)) || [];
    res.json(list.map(a => ({ id: a.id, name: a.name, name_lower: (a.name||"").toLowerCase().trim() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agent shift mapping
async function loadShifts() {
  if (pool) {
    try {
      const r = await pool.query("SELECT employee, agent_key, start_hour, end_hour, groups, languages FROM agent_shifts ORDER BY id");
      if (r.rows.length > 0) return r.rows.map(row => ({
        employee: row.employee,
        agentKey: row.agent_key,
        start: row.start_hour,
        end: row.end_hour,
        groups: Array.isArray(row.groups) ? row.groups : [],
        languages: Array.isArray(row.languages) ? row.languages : [],
      }));
    } catch {}
  }
  try {
    const data = await fs.readFile(path.join(DATA_DIR, "agent_shifts.json"), "utf8");
    return JSON.parse(data);
  } catch { return []; }
}

async function saveShifts(shifts) {
  if (pool) {
    await pool.query("TRUNCATE agent_shifts RESTART IDENTITY");
    for (const s of shifts) {
      await pool.query(
        `INSERT INTO agent_shifts (employee, agent_key, start_hour, end_hour, groups, languages) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [s.employee, s.agentKey, s.start, s.end, JSON.stringify(Array.isArray(s.groups) ? s.groups : []), JSON.stringify(Array.isArray(s.languages) ? s.languages : [])]
      );
    }
    return;
  }
  await fs.writeFile(path.join(DATA_DIR, "agent_shifts.json"), JSON.stringify(shifts, null, 2));
}

app.get("/api/agent-shifts", authMiddleware, async (req, res) => {
  try {
    res.json(await loadShifts());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/agent-shifts", authMiddleware, adminOnly, async (req, res) => {
  try {
    await saveShifts(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Discover Telegram group IDs (call after adding bot to groups)
app.get("/api/telegram-setup", async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.json({ error: "TELEGRAM_BOT_TOKEN not set in .env" });
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`);
    const data = await r.json();
    if (!data.ok) return res.json({ error: data.description });
    const groups = {};
    for (const upd of data.result) {
      const msg = upd.message || upd.channel_post;
      if (msg?.chat) groups[msg.chat.id] = { title: msg.chat.title || msg.chat.username, type: msg.chat.type };
    }
    res.json({ groups, tip: "Copy the chat IDs (negative numbers) into TELEGRAM_CHAT_IDS in .env" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Refresh knowledge base from Google Docs/Sheets
app.post("/api/refresh-knowledge", authMiddleware, async (req, res) => {
  try {
    await loadKnowledge();
    res.json({ ok: true, lastFetched: kb.lastFetched, knowledge: kb.knowledge.length, campaigns: kb.campaigns.length, telegram: kb.telegram.length, protocol: kb.protocol.length, macros: kb.macros.length, tags: kb.tags.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Knowledge status
app.get("/api/knowledge-status", (req, res) => {
  res.json({ lastFetched: kb.lastFetched, knowledge: kb.knowledge.length, campaigns: kb.campaigns.length, telegram: kb.telegram.length, protocol: kb.protocol.length, macros: kb.macros.length, tags: kb.tags.length });
});

// Start
await loadKnowledge();
if (TELEGRAM_BOT_TOKEN) {
  await pollTelegram();
  setInterval(pollTelegram, 5 * 60 * 1000); // poll every 5 minutes
  console.log("[telegram] polling started");
} else {
  console.log("[telegram] TELEGRAM_BOT_TOKEN not set — polling disabled");
}

// Auto-refresh knowledge base every 6 hours
setInterval(loadKnowledge, 6 * 60 * 60 * 1000);
console.log("[kb] auto-refresh every 6 hours");

// Nightly auto-review: every day at 00:00 Tehran time (UTC+3:30 → 20:30 UTC)
async function runNightlyReview() {
  console.log("[nightly] Starting nightly auto-review...");
  try {
    const tehranNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tehran" }));
    const today = tehranNow.toISOString().slice(0, 10);
    const from = today + "T00:00:00.000000+00:00";
    const to   = today + "T23:59:59.999999+00:00";

    const [reviews, shifts] = await Promise.all([loadReviews(), loadShifts()]);
    let done = 0, skipped = 0, failed = 0;
    let pageId = null;

    do {
      const params = new URLSearchParams({ date_from: from, date_to: to });
      if (pageId) params.set("page_id", pageId);

      const res = await fetch(`https://api.livechatinc.com/v3.6/agent/action/list_archives`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${process.env.LIVECHAT_ACCOUNT_ID}:${process.env.LIVECHAT_PAT}`).toString("base64")}`,
        },
        body: JSON.stringify({
          filters: { from, to },
          ...(pageId ? { page_id: pageId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { console.error("[nightly] list_archives error:", data); break; }

      pageId = data.next_page_id || null;
      const chats = data.chats || [];

      for (const c of chats) {
        const thread = c.thread || (Array.isArray(c.threads) ? c.threads[0] : null) || {};
        const chatId = c.id;
        const thread_id = thread.id || null;
        const reviewKey = thread_id || chatId;
        const existing = reviews[reviewKey];

        // Skip if already reviewed successfully (no errors)
        const hasError = existing?.per_agent_reviews &&
          Object.values(existing.per_agent_reviews).some(r => r && r._error);
        if (existing && !hasError) { skipped++; continue; }

        try {
          // Re-use review endpoint logic by calling our own API
          const qs = thread_id ? `?thread_id=${thread_id}` : "";
          const reviewRes = await fetch(`http://localhost:${PORT}/api/review/${chatId}${qs}`, {
            method: "POST",
          });
          if (reviewRes.ok) { done++; }
          else { failed++; console.warn("[nightly] review failed for", chatId); }
          // Small pause to avoid Claude rate limits
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
          failed++;
          console.error("[nightly] error reviewing", chatId, e.message);
        }
      }
    } while (pageId);

    console.log(`[nightly] Done — reviewed: ${done}, skipped: ${skipped}, failed: ${failed}`);
  } catch (e) {
    console.error("[nightly] Fatal error:", e.message);
  }
}

// Nightly auto-review disabled — enable by uncommenting below
// ── Reports ───────────────────────────────────────────────────────────────────

// Delete all reports (admin only)
app.delete("/api/reports", authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query("DELETE FROM reports");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/reports/:employee/:month", authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query("DELETE FROM reports WHERE employee=$1 AND month=$2", [req.params.employee, req.params.month]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List reports (admin: all; employee: own)
app.get("/api/reports", authMiddleware, async (req, res) => {
  try {
    if (!pool) return res.json([]);
    let rows;
    if (req.user.role === "admin") {
      rows = await pool.query("SELECT employee, month, generated_at FROM reports ORDER BY month DESC, employee ASC");
    } else {
      rows = await pool.query("SELECT employee, month, generated_at FROM reports WHERE employee=$1 ORDER BY month DESC", [req.user.employee_name]);
    }
    res.json(rows.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get specific report
app.get("/api/reports/:employee/:month", authMiddleware, async (req, res) => {
  try {
    if (!pool) return res.status(404).json({ error: "No DB" });
    const { employee, month } = req.params;
    if (req.user.role !== "admin" && req.user.employee_name !== employee)
      return res.status(403).json({ error: "Forbidden" });
    const r = await pool.query("SELECT data FROM reports WHERE employee=$1 AND month=$2", [employee, month]);
    if (!r.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0].data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save admin notes on a report
app.patch("/api/reports/:employee/:month", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { employee, month } = req.params;
    const { admin_notes } = req.body;
    await pool.query(
      "UPDATE reports SET data = jsonb_set(data, '{admin_notes}', $3::jsonb) WHERE employee=$1 AND month=$2",
      [employee, month, JSON.stringify(admin_notes)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate monthly report (admin only)
app.post("/api/reports/generate", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { employee, month } = req.body; // month = "2026-07"
    if (!employee || !month) return res.status(400).json({ error: "employee and month required" });

    const shifts = await loadShifts();
    const shift = shifts.find(s => s.employee === employee);
    if (!shift) return res.status(404).json({ error: "Employee not found in shifts" });

    // Date range
    const [year, mon] = month.split("-").map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    const dateFrom = `${month}-01T00:00:00.000000+00:00`;
    const dateTo   = `${month}-${String(lastDay).padStart(2,"0")}T23:59:59.999999+00:00`;

    // Find LiveChat agent
    const agentsData = await lcPost("list_agents", {}, LC_CONFIG_API);
    const agentList = Array.isArray(agentsData) ? agentsData : (agentsData?.agents || []);
    const agentUser = agentList.find(a => {
      const k = a.name.toLowerCase().trim();
      return k === shift.agentKey || k.split(" ")[0] === shift.agentKey;
    });

    // Fetch all chats for this agent in this month (paginated)
    let allMonthChats = [];
    let pageId = null;
    let totalChats = 0;
    do {
      const body = pageId
        ? { page_id: pageId }
        : { filters: { from: dateFrom, to: dateTo, ...(agentUser ? { agents: { values: [agentUser.id] } } : {}) }, limit: 100 };
      const data = await lcPost("list_archives", body);
      if (!pageId) totalChats = data.found_chats || 0;
      allMonthChats.push(...(data.chats || []));
      pageId = data.next_page_id || null;
    } while (pageId);

    const reviews = await loadReviews();

    const scoreFields = ["overall","response_time","tone","accuracy","resolution","compliance","product_knowledge","satisfaction","language"];
    const sums = Object.fromEntries(scoreFields.map(f => [f, 0]));
    const cnts = Object.fromEntries(scoreFields.map(f => [f, 0]));
    let reviewedChats = 0, missedChats = 0, resolvedCount = 0;
    let totalDurSec = 0, durCount = 0, totalFirstResSec = 0, firstResCount = 0;
    const weekData = {};
    const allNotes = [];
    let chatsInShift = 0;

    for (const chat of allMonthChats) {
      const thread = chat.thread || (Array.isArray(chat.threads) ? chat.threads[0] : null) || {};
      const startedAt = thread.created_at || null;
      const endedAt   = thread.ended_at   || null;
      if (!startedAt) continue;

      // Filter by shift hours
      const h = getTehranHourFromIso(startedAt);
      if (h < shift.start || h >= shift.end) continue;
      chatsInShift++;

      // Chat duration
      if (endedAt) {
        const dur = (new Date(endedAt) - new Date(startedAt)) / 1000;
        if (dur > 0 && dur < 10800) { totalDurSec += dur; durCount++; }
      }

      // First response time from events
      const events = thread.events || [];
      const users = chat.users || [];
      const custMsgs = events.filter(e => e.type === "message" && users.find(u => u.id === e.author_id)?.type === "customer");
      const agentMsgs = events.filter(e => e.type === "message" && users.find(u => u.id === e.author_id)?.type === "agent" && e.visibility !== "agents");
      if (custMsgs[0] && agentMsgs[1]) { // skip auto-greeting (first agent msg)
        const rt = (new Date(agentMsgs[1].created_at) - new Date(custMsgs[0].created_at)) / 1000;
        if (rt >= 0 && rt < 300) { totalFirstResSec += rt; firstResCount++; }
      }

      // Real missed chat: agent was present but sent 0 visible messages while customer had messages
      const agentKeyFirst = shift.agentKey.split(" ")[0].toLowerCase();
      const thisAgentUsers = users.filter(u => u.type === "agent" &&
        (u.name || "").toLowerCase().trim().startsWith(agentKeyFirst));
      const thisAgentMsgs = events.filter(e =>
        e.type === "message" && e.visibility !== "agents" &&
        thisAgentUsers.some(u => u.id === e.author_id));
      if (custMsgs.length > 0 && thisAgentUsers.length > 0 && thisAgentMsgs.length === 0) {
        missedChats++;
      }

      // Find review — try thread.id first, fallback to chat.id
      const review = reviews[thread.id] || reviews[chat.id];
      if (!review || review.skipped) continue;
      reviewedChats++;
      if (review.resolved) resolvedCount++;

      // Get agent-specific score: prefer per_agent match, fall back to overall
      let ar = review;
      if (review.per_agent_reviews) {
        const pr = Object.values(review.per_agent_reviews).find(r =>
          r && r.agent_name && r.agent_name.toLowerCase().trim().startsWith(agentKeyFirst)
        );
        if (pr) ar = pr;
      }

      const scoreMap = {
        overall: ar.overall_score, response_time: ar.response_time_score, tone: ar.tone_score,
        accuracy: ar.accuracy_score, resolution: ar.resolution_score, compliance: ar.compliance_score,
        product_knowledge: ar.product_knowledge_score, satisfaction: ar.satisfaction_score, language: ar.language_score
      };
      for (const [k, v] of Object.entries(scoreMap)) {
        if (v != null && v > 0) { sums[k] += v; cnts[k]++; }
      }

      // Weekly trend
      const dayOfMonth = new Date(startedAt).getDate();
      const weekLabel = `Week ${Math.ceil(dayOfMonth / 7)}`;
      if (!weekData[weekLabel]) weekData[weekLabel] = { sum: 0, cnt: 0 };
      if (ar.overall_score != null && ar.overall_score > 0) {
        weekData[weekLabel].sum += ar.overall_score; weekData[weekLabel].cnt++;
      }

      // Collect notes for summary analysis
      const noteParts = [ar.summary, ar.issues, ar.strengths].filter(Boolean);
      if (noteParts.length > 0) allNotes.push(noteParts.join(" | "));
    }

    const avgScores = Object.fromEntries(scoreFields.map(f => [f, cnts[f] > 0 ? +(sums[f]/cnts[f]).toFixed(2) : null]));

    const scoreTrend = Object.entries(weekData).sort(([a],[b]) => a.localeCompare(b))
      .map(([label, d]) => ({ label, avg: d.cnt > 0 ? +(d.sum/d.cnt).toFixed(2) : null, count: d.cnt }));

    // Claude analysis: strengths, weaknesses, progress narrative
    let strengths = [], weaknesses = [], progress_narrative = "";
    if (allNotes.length > 0) {
      try {
        const notesText = allNotes.slice(0, 40).map((n, i) => `Chat ${i+1}: ${n}`).join("\n\n");
        const trendText = scoreTrend.map(w => `${w.label}: avg ${w.avg ?? "n/a"} (${w.count} chats)`).join(", ");
        const analysisPrompt = `You are analyzing AI-generated review notes for a customer support agent named "${employee}" for the period ${month}.

Weekly score trend: ${trendText || "not available"}

Review notes from ${allNotes.length} chat sessions:
${notesText}

Analyze these notes and respond ONLY with a valid JSON object in this exact format:
{
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "weaknesses": ["specific area for improvement 1", "specific area for improvement 2", "specific area for improvement 3"],
  "progress_narrative": "2-3 sentences describing the agent's performance trend and development over this period based on the notes."
}

- strengths: 3-5 concrete recurring positive behaviors observed across chats
- weaknesses: 3-5 concrete recurring issues that need improvement
- progress_narrative: describe whether performance improved, declined, or stayed stable, and any notable patterns
- Be specific, not generic. Reference actual issues seen in the notes.`;

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1000,
            system: "You are a JSON-only output assistant. Respond with a single valid JSON object, nothing else.",
            messages: [{ role: "user", content: analysisPrompt }],
          }),
        });
        const data = await res.json();
        const raw = data?.content?.[0]?.text || "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          strengths  = Array.isArray(parsed.strengths)  ? parsed.strengths  : [];
          weaknesses = Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [];
          progress_narrative = parsed.progress_narrative || "";
        }
      } catch (e) {
        console.error("[report] analysis error:", e.message);
      }
    }

    const report = {
      employee, agent_key: shift.agentKey, month,
      generated_at: new Date().toISOString(),
      generated_by: req.user.username,
      total_chats: totalChats,
      chats_in_shift: chatsInShift,
      reviewed_chats: reviewedChats,
      missed_chats: missedChats,
      resolved_count: resolvedCount,
      resolved_rate: reviewedChats > 0 ? Math.round(resolvedCount/reviewedChats*100) : 0,
      avg_scores: avgScores,
      score_trend: scoreTrend,
      avg_chat_duration_sec: durCount > 0 ? Math.round(totalDurSec/durCount) : null,
      avg_first_response_sec: firstResCount > 0 ? Math.round(totalFirstResSec/firstResCount) : null,
      review_notes: allNotes,
      strengths,
      weaknesses,
      progress_narrative,
      admin_notes: "",
    };

    if (pool) {
      await pool.query(
        `INSERT INTO reports (employee, month, data, generated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (employee, month) DO UPDATE SET data=$3, generated_at=NOW()`,
        [employee, month, report]
      );
    }
    res.json(report);
  } catch (e) {
    console.error("[report] generate error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// cron.schedule("30 20 * * *", runNightlyReview, { timezone: "UTC" });
// console.log("[nightly] Scheduled auto-review at 00:00 Tehran time (20:30 UTC)");

app.listen(PORT, () => {
  console.log(`\n✓ Chat Review running at http://localhost:${PORT}\n`);
});
