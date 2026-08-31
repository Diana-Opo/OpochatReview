import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import cron from "node-cron";
import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
const { Pool } = pg;

// ── Auth helpers ──────────────────────────────────────────────────────────────
const SESSION_IDLE_MINUTES = 30;

// Single source of truth for what a group can be granted access to. "page:*" keys gate
// nav/page visibility; "action:*" keys gate specific operations. Exposed as-is via
// GET /api/permissions/catalog so the Groups UI never hardcodes labels separately from
// enforcement (requirePermission() below reads the same keys directly from a group's
// `permissions` JSONB).
const PERMISSION_CATALOG = [
  { key: "page:dashboard", label: "Dashboard", kind: "page" },
  { key: "page:chats", label: "Chat Review", kind: "page" },
  { key: "page:report-supervised-chats", label: "Supervised Chats", kind: "page" },
  { key: "page:reports", label: "Employee Report", kind: "page" },
  { key: "page:report-monthly", label: "Monthly Overview", kind: "page" },
  { key: "page:report-total-chats", label: "Total Chats", kind: "page" },
  { key: "page:report-campaign", label: "Campaign Impact", kind: "page" },
  { key: "page:report-platform-status", label: "Platform Status", kind: "page" },
  { key: "page:report-platform-costs", label: "Platform Costs", kind: "page" },
  { key: "page:report-agent-activity", label: "Agent Activity", kind: "page" },
  { key: "page:report-chat-transfers", label: "Chat Transfers", kind: "page" },
  { key: "page:report-monthly-summary", label: "Monthly Summary", kind: "page" },
  { key: "page:employees", label: "Employees", kind: "page" },
  { key: "page:config", label: "Config", kind: "page" },
  { key: "page:groups", label: "Groups", kind: "page" },
  { key: "action:review_chats", label: "Review chats with AI", kind: "action" },
  { key: "action:manage_users", label: "Manage user accounts", kind: "action" },
  { key: "action:manage_shifts", label: "Manage employee shifts", kind: "action" },
  { key: "action:manage_reports", label: "Generate / delete reports", kind: "action" },
  { key: "action:backfill", label: "Run report backfills", kind: "action" },
  { key: "action:debug_tools", label: "Debug tools", kind: "action" },
];

const DEFAULT_USER_PERMISSIONS = Object.fromEntries(
  PERMISSION_CATALOG.map(p => [p.key, p.kind === "page" && !["page:employees", "page:config", "page:groups"].includes(p.key)])
);
const ALL_TRUE_PERMISSIONS = Object.fromEntries(PERMISSION_CATALOG.map(p => [p.key, true]));

function hashPass(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
}

async function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  if (pool) {
    await pool.query(
      `INSERT INTO sessions (token, username, role, employee_name, group_id, permissions, last_active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [token, user.username, user.role, user.employee_name || null, user.group_id || null, JSON.stringify(user.permissions || {})]
    );
  }
  return token;
}

async function getSession(token) {
  if (!token) return null;
  if (pool) {
    const r = await pool.query(
      `SELECT username, role, employee_name, group_id, permissions FROM sessions
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

// Force a user's (or a whole group's) active sessions to expire immediately, so a group
// reassignment or a permissions edit takes effect on their very next request instead of
// waiting for the session to naturally age out. exceptToken keeps the CALLER's own current
// session alive — without this, an admin editing their own account's group (e.g. as one of
// several rows saved together) invalidates the very token the rest of that in-flight batch
// of requests is using, so any of those requests processed after this one 401s, which makes
// authFetch() throw and the whole Promise.all in saveSettings() reject — the batch reports
// as a total failure even though most of the underlying updates already committed.
async function invalidateSessionsForUser(username, exceptToken) {
  if (!pool) return;
  const q = exceptToken
    ? pool.query("DELETE FROM sessions WHERE username=$1 AND token != $2", [username, exceptToken])
    : pool.query("DELETE FROM sessions WHERE username=$1", [username]);
  await q.catch(() => {});
}
async function invalidateSessionsForGroup(groupId, exceptToken) {
  if (!pool) return;
  const q = exceptToken
    ? pool.query("DELETE FROM sessions WHERE group_id=$1 AND token != $2", [groupId, exceptToken])
    : pool.query("DELETE FROM sessions WHERE group_id=$1", [groupId]);
  await q.catch(() => {});
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
// role==='admin' always bypasses (the is_super group derives that role — see groups
// table below); otherwise the caller's group must explicitly carry this permission key.
function requirePermission(key) {
  return (req, res, next) => {
    if (req.user?.role === "admin" || req.user?.permissions?.[key] === true) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
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
  )`).then(async () => {
    // Denormalized snapshot (no FK, same staleness model as role/employee_name above) —
    // refreshed at login and force-cleared via invalidateSessionsFor{User,Group}().
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS group_id INTEGER`);
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'`);
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
      await pool.query(`ALTER TABLE agent_shifts ADD COLUMN IF NOT EXISTS chatwoot_agent_id VARCHAR(255) DEFAULT ''`);
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
      await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false`);
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

      // ── groups table ─────────────────────────────────────────────────────
      // Created here (not as its own top-level block) so it's guaranteed to exist and be
      // seeded before the app_users.group_id backfill below runs — both are in this same
      // sequential async function, unlike the other top-level `pool.query(...).then()` /
      // `(async()=>{})()` blocks in this file which all run concurrently with each other.
      await pool.query(`CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        is_super BOOLEAN NOT NULL DEFAULT false,
        permissions JSONB NOT NULL DEFAULT '{}'
      )`);
      await pool.query(
        `INSERT INTO groups (name, is_super, permissions) VALUES ($1, true, $2) ON CONFLICT (name) DO NOTHING`,
        ["Admin", JSON.stringify(ALL_TRUE_PERMISSIONS)]
      );
      await pool.query(
        `INSERT INTO groups (name, is_super, permissions) VALUES ($1, false, $2) ON CONFLICT (name) DO NOTHING`,
        ["User", JSON.stringify(DEFAULT_USER_PERMISSIONS)]
      );
      await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id)`);
      // Backfill: anyone without a group yet gets mapped from their existing role, so
      // upgrading an existing deployment doesn't strand any account without a group.
      await pool.query(`UPDATE app_users SET group_id = (SELECT id FROM groups WHERE name='Admin') WHERE group_id IS NULL AND role='admin'`);
      await pool.query(`UPDATE app_users SET group_id = (SELECT id FROM groups WHERE name='User')  WHERE group_id IS NULL AND role='user'`);
      console.log("[db] groups table ready");
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

  // ── saved_reports table (Total Chats / Campaign Impact snapshots) ──────────
  pool.query(`CREATE TABLE IF NOT EXISTS saved_reports (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    params JSONB,
    data JSONB NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log("[db] saved_reports table ready")).catch(e => console.error("[db] saved_reports init:", e.message));

  // ── claude_usage table (per-call token usage, for cost reporting) ──────────
  pool.query(`CREATE TABLE IF NOT EXISTS claude_usage (
    id SERIAL PRIMARY KEY,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    chat_id TEXT,
    employee TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log("[db] claude_usage table ready")).catch(e => console.error("[db] claude_usage init:", e.message));

  // ── agent_activity_daily table (cached per-employee, per-day online/closed hours) ──
  pool.query(`CREATE TABLE IF NOT EXISTS agent_activity_daily (
    employee TEXT NOT NULL,
    date TEXT NOT NULL,
    online_hours REAL NOT NULL,
    closed_hours REAL NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (employee, date)
  )`).then(() => console.log("[db] agent_activity_daily table ready")).catch(e => console.error("[db] agent_activity_daily init:", e.message));

  // Marks a day as "fully computed" independent of per-employee rows — an employee
  // with zero chats/hours that day has no row in the *_daily tables, so without this
  // marker there'd be no way to tell "never computed" apart from "genuinely zero".
  pool.query(`CREATE TABLE IF NOT EXISTS agent_activity_cached_days (
    date TEXT PRIMARY KEY,
    computed_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log("[db] agent_activity_cached_days table ready")).catch(e => console.error("[db] agent_activity_cached_days init:", e.message));

  // ── chat_totals_daily table (cached per-employee, per-day chat counts) ──────
  pool.query(`CREATE TABLE IF NOT EXISTS chat_totals_daily (
    employee TEXT NOT NULL,
    date TEXT NOT NULL,
    livechat INTEGER NOT NULL DEFAULT 0,
    chatwoot INTEGER NOT NULL DEFAULT 0,
    supervised INTEGER NOT NULL DEFAULT 0,
    mobile INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    transferred INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (employee, date)
  )`).then(() => console.log("[db] chat_totals_daily table ready")).catch(e => console.error("[db] chat_totals_daily init:", e.message));
  pool.query(`ALTER TABLE chat_totals_daily ADD COLUMN IF NOT EXISTS answered INTEGER NOT NULL DEFAULT 0`).catch(e => console.error("[db] chat_totals_daily add answered:", e.message));
  pool.query(`ALTER TABLE chat_totals_daily ADD COLUMN IF NOT EXISTS transferred INTEGER NOT NULL DEFAULT 0`).catch(e => console.error("[db] chat_totals_daily add transferred:", e.message));
  pool.query(`ALTER TABLE chat_totals_daily ADD COLUMN IF NOT EXISTS transferred_dept INTEGER NOT NULL DEFAULT 0`).catch(e => console.error("[db] chat_totals_daily add transferred_dept:", e.message));
  pool.query(`ALTER TABLE chat_totals_daily ADD COLUMN IF NOT EXISTS transferred_no_response INTEGER NOT NULL DEFAULT 0`).catch(e => console.error("[db] chat_totals_daily add transferred_no_response:", e.message));
  pool.query(`ALTER TABLE chat_totals_daily ADD COLUMN IF NOT EXISTS duration_sec REAL NOT NULL DEFAULT 0`).catch(e => console.error("[db] chat_totals_daily add duration_sec:", e.message));

  pool.query(`CREATE TABLE IF NOT EXISTS chat_totals_cached_days (
    date TEXT PRIMARY KEY,
    computed_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log("[db] chat_totals_cached_days table ready")).catch(e => console.error("[db] chat_totals_cached_days init:", e.message));

  // ── weekend_overrides table (date-specific shift assignments, overrides the
  // static recurring agent_shifts hour windows — needed because weekend duty
  // rotates day-to-day among employees who may share a LiveChat/Chatwoot login
  // with someone else's differently-timed weekday shift) ──────────────────────
  pool.query(`CREATE TABLE IF NOT EXISTS weekend_overrides (
    id SERIAL PRIMARY KEY,
    shift_date TEXT NOT NULL,
    employee TEXT NOT NULL,
    platform TEXT NOT NULL,
    start_hour INTEGER NOT NULL,
    end_hour INTEGER NOT NULL
  )`).then(() => console.log("[db] weekend_overrides table ready")).catch(e => console.error("[db] weekend_overrides init:", e.message));
  pool.query(`CREATE INDEX IF NOT EXISTS weekend_overrides_date_platform_idx ON weekend_overrides (shift_date, platform)`).catch(() => {});

  // ── app_settings table (simple key/value store, e.g. the Leave sheet URL) ──
  pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log("[db] app_settings table ready")).catch(e => console.error("[db] app_settings init:", e.message));

  // ── department_totals_daily table (cached per-day dedup'd chat count by
  // department — see computeGroupChatTotals()) ───────────────────────────────
  pool.query(`CREATE TABLE IF NOT EXISTS department_totals_daily (
    date TEXT PRIMARY KEY,
    grand_total INTEGER NOT NULL DEFAULT 0,
    departments JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log("[db] department_totals_daily table ready")).catch(e => console.error("[db] department_totals_daily init:", e.message));
  pool.query(`CREATE TABLE IF NOT EXISTS department_totals_cached_days (
    date TEXT PRIMARY KEY,
    computed_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log("[db] department_totals_cached_days table ready")).catch(e => console.error("[db] department_totals_cached_days init:", e.message));
}
const LC_API = "https://api.livechatinc.com/v3.6/agent/action";
const LC_CONFIG_API = "https://api.livechatinc.com/v3.6/configuration/action";
const LC_REPORTS_AGENTS_API = "https://api.livechatinc.com/v3.6/reports/agents";

// ── Chatwoot config ───────────────────────────────────────────────────────────
const CHATWOOT_BASE_URL = (process.env.CHATWOOT_BASE_URL || "").replace(/\/$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";
const CHATWOOT_EMAIL = process.env.CHATWOOT_EMAIL || "";
const CHATWOOT_PASSWORD = process.env.CHATWOOT_PASSWORD || "";
function chatwootEnabled() { return !!(CHATWOOT_BASE_URL && CHATWOOT_ACCOUNT_ID && CHATWOOT_EMAIL && CHATWOOT_PASSWORD); }

// Devise token auth session (refreshed automatically on 401)
let cwSession = null; // { accessToken, client, uid }
let cwLastSignInError = null;

async function cwSignIn() {
  if (!CHATWOOT_EMAIL || !CHATWOOT_PASSWORD) { cwLastSignInError = "CHATWOOT_EMAIL/CHATWOOT_PASSWORD not set"; return false; }
  try {
    const r = await fetch(`${CHATWOOT_BASE_URL}/auth/sign_in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: CHATWOOT_EMAIL, password: CHATWOOT_PASSWORD }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      cwLastSignInError = `sign_in HTTP ${r.status}: ${body.slice(0, 200)}`;
      console.error("[chatwoot] sign_in failed:", cwLastSignInError);
      return false;
    }
    const accessToken = r.headers.get("access-token");
    const client = r.headers.get("client");
    const uid = r.headers.get("uid");
    if (accessToken && client && uid) {
      cwSession = { accessToken, client, uid };
      cwLastSignInError = null;
      console.log("[chatwoot] signed in as", uid);
      return true;
    }
    cwLastSignInError = "sign_in ok but missing access-token/client/uid response headers";
    console.error("[chatwoot]", cwLastSignInError);
    return false;
  } catch (e) {
    cwLastSignInError = `sign_in request threw: ${e.message}`;
    console.error("[chatwoot] sign_in error:", e.message);
    return false;
  }
}

function cwHeaders() {
  if (cwSession) {
    return {
      "access-token": cwSession.accessToken,
      "client": cwSession.client,
      "uid": cwSession.uid,
      "token-type": "Bearer",
      "Content-Type": "application/json",
    };
  }
  return { "Content-Type": "application/json" };
}

// Cap concurrent Chatwoot requests — checking each conversation for private notes
// fires one request per conversation, which can otherwise fan out to dozens at once.
const CW_MAX_CONCURRENT = 10;
let cwActive = 0;
const cwQueue = [];

function cwAcquire() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (cwActive < CW_MAX_CONCURRENT) {
        cwActive++;
        resolve(() => { cwActive--; const next = cwQueue.shift(); if (next) next(); });
      } else {
        cwQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

async function cwGet(path, params = {}, _retried = false) {
  if (!cwSession && !_retried) { await cwSignIn(); }
  const url = new URL(`${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const r = await fetch(url.toString(), { headers: cwHeaders() });
  if (r.status === 401 && !_retried) {
    const ok = await cwSignIn();
    if (ok) return cwGet(path, params, true);
  }
  if (!r.ok) {
    const e = await r.text();
    const hint = cwLastSignInError ? ` (sign-in issue: ${cwLastSignInError})` : "";
    throw new Error(`Chatwoot GET ${path} ${r.status}: ${e.slice(0, 200)}${hint}`);
  }
  return r.json();
}

async function cwPost(path, body, params = {}, _retried = false) {
  if (!cwSession && !_retried) { await cwSignIn(); }
  const url = new URL(`${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: cwHeaders(),
    body: JSON.stringify(body),
  });
  if (r.status === 401 && !_retried) {
    const ok = await cwSignIn();
    if (ok) return cwPost(path, body, params, true);
  }
  if (!r.ok) {
    const e = await r.text();
    const hint = cwLastSignInError ? ` (sign-in issue: ${cwLastSignInError})` : "";
    throw new Error(`Chatwoot POST ${path} ${r.status}: ${e.slice(0, 200)}${hint}`);
  }
  return r.json();
}

function cwTimestamp(val) {
  if (!val) return null;
  return typeof val === "number" ? new Date(val * 1000).toISOString() : val;
}

// Chatwoot filter only accepts YYYY-MM-DD (not full ISO).
// We fetch 1 day wider on each side to cover timezone boundary (Iran is UTC+3:30),
// then fine-filter by exact UTC timestamp server-side.
function cwFilterDateFrom(isoStr) {
  const d = new Date(isoStr.split("T")[0] + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);  // 1 day earlier to catch midnight-boundary convs
  return d.toISOString().split("T")[0];
}
function cwFilterDateTo(isoStr) {
  const d = new Date(isoStr.split("T")[0] + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 2);  // 2 days later for safety
  return d.toISOString().split("T")[0];
}

const DATA_DIR = path.join(__dirname, "data");
const GDOC_KNOWLEDGE_URL = "https://docs.google.com/document/d/14iBZtfOXkPTb_ZYM4zSIAZOqdZ_VZeoKW0zJiNHXSIs/export?format=txt";
const GSHEET_CAMPAIGNS_URL = "https://docs.google.com/spreadsheets/d/1wp0FGyJe2LnMr2BMR42EiIQPrALrZcbNrN5qCg2q5X4/export?format=csv";
const GSHEET_MACROS_URL = "https://docs.google.com/spreadsheets/d/1CSAi2ltdxaidKTrLipZxKhW3zdbf5QERgcyqmu_k-sI/export?format=csv";
const GSHEET_TAGS_URL = "https://docs.google.com/spreadsheets/d/16zX__NdZBhRvx9Nq4mcR71reR8P5fplygcz75yGfOi4/export?format=csv";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const PROTOCOL_DOC_IDS = (process.env.PROTOCOL_DOC_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

let kb = { knowledge: "", campaigns: "", telegram: "", protocol: "", macros: "", tags: "", customRules: "", lastFetched: null };
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
    const r = await pool.query(
      `SELECT au.*, g.permissions AS group_permissions FROM app_users au
       LEFT JOIN groups g ON g.id = au.group_id
       WHERE LOWER(au.username)=LOWER($1)`,
      [username]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid username or password" });
    const hash = hashPass(password, user.salt);
    if (hash !== user.password_hash) return res.status(401).json({ error: "Invalid username or password" });
    const permissions = user.group_permissions || {};
    const token = await createSession({ username: user.username, role: user.role, employee_name: user.employee_name, group_id: user.group_id, permissions });
    res.json({ token, role: user.role, username: user.username, must_change_password: !!user.must_change_password });
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
  res.json({ username: sess.username, role: sess.role, employee_name: sess.employee_name, permissions: sess.permissions || {} });
});

// ── App users ─────────────────────────────────────────────────────────────────
app.get("/api/app-users", authMiddleware, requirePermission("action:manage_users"), async (req, res) => {
  try {
    const r = await pool.query("SELECT username, role, employee_name, group_id FROM app_users ORDER BY id");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/app-users", authMiddleware, requirePermission("action:manage_users"), async (req, res) => {
  try {
    const { username, password, employee_name } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPass(password, salt);
    await pool.query(
      `INSERT INTO app_users (username, password_hash, salt, role, employee_name, must_change_password, group_id)
       VALUES ($1,$2,$3,'user',$4,true, (SELECT id FROM groups WHERE name='User'))
       ON CONFLICT (username) DO UPDATE SET password_hash=$2, salt=$3, employee_name=$4, must_change_password=true`,
      [username, hash, salt, employee_name || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Replaces the old role-only PATCH — assigning a group now drives role, since role is
// derived from the target group's is_super flag (see groups table). Only a literal
// role==='admin' caller (not merely someone delegated action:manage_users) may grant
// membership in an is_super group, so a delegated user-manager can't self-escalate.
app.patch("/api/app-users/:username/group", authMiddleware, requirePermission("action:manage_users"), async (req, res) => {
  try {
    const { username } = req.params;
    const { group_id } = req.body || {};
    const g = await pool.query("SELECT id, is_super FROM groups WHERE id=$1", [group_id]);
    if (!g.rows[0]) return res.status(400).json({ error: "Invalid group" });
    if (g.rows[0].is_super && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can grant admin-group membership" });
    }
    if (username === "admin" && !g.rows[0].is_super) {
      return res.status(400).json({ error: "Cannot demote the main admin account" });
    }
    const newRole = g.rows[0].is_super ? "admin" : "user";
    // Case-insensitive, matching how /api/login looks users up — otherwise a stored
    // username that differs only in case from what's sent here silently matches zero
    // rows: the UPDATE affects nothing, no error is thrown, and this still returned
    // {ok:true}, so the UI reported success even though nothing actually changed.
    const result = await pool.query(
      "UPDATE app_users SET group_id=$1, role=$2 WHERE LOWER(username)=LOWER($3)",
      [group_id, newRole, username]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: `No user found with username "${username}"` });
    await invalidateSessionsForUser(username, req.sessionToken);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/app-users/:username", authMiddleware, requirePermission("action:manage_users"), async (req, res) => {
  try {
    if (req.params.username === "admin") return res.status(400).json({ error: "Cannot delete admin" });
    await pool.query("DELETE FROM app_users WHERE username=$1", [req.params.username]);
    await invalidateSessionsForUser(req.params.username);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Groups (access management) ───────────────────────────────────────────────
// Read is available to any authenticated user (the Employees page needs the list to
// populate its Group dropdown); writes are hardcoded to literal role==='admin' — not
// delegable via a permission, since a group that could edit its own permissions could
// grant itself anything (same reasoning as why role='admin' itself can't be self-granted).
app.get("/api/groups", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query("SELECT id, name, is_super, permissions FROM groups ORDER BY is_super DESC, name ASC");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/permissions/catalog", authMiddleware, (req, res) => {
  res.json(PERMISSION_CATALOG);
});

app.post("/api/groups", authMiddleware, adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });
    const permissions = req.body?.permissions && typeof req.body.permissions === "object" ? req.body.permissions : {};
    const r = await pool.query(
      "INSERT INTO groups (name, is_super, permissions) VALUES ($1, false, $2) RETURNING id, name, is_super, permissions",
      [name, JSON.stringify(permissions)]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "A group with that name already exists" });
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/groups/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    // Whitelisted on purpose — is_super is never accepted from the client, so a raw PATCH
    // can't flip the seeded Admin group's bypass flag or desync it from role='admin'.
    const { name, permissions } = req.body || {};
    const existing = await pool.query("SELECT * FROM groups WHERE id=$1", [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: "Not found" });
    const newName = name != null ? String(name).trim() : existing.rows[0].name;
    const newPerms = permissions != null ? permissions : existing.rows[0].permissions;
    if (!newName) return res.status(400).json({ error: "Name required" });
    await pool.query("UPDATE groups SET name=$1, permissions=$2 WHERE id=$3", [newName, JSON.stringify(newPerms), id]);
    await invalidateSessionsForGroup(id, req.sessionToken);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "A group with that name already exists" });
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/groups/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const g = await pool.query("SELECT is_super FROM groups WHERE id=$1", [id]);
    if (!g.rows[0]) return res.status(404).json({ error: "Not found" });
    if (g.rows[0].is_super) return res.status(400).json({ error: "Cannot delete the built-in admin group" });
    const members = await pool.query("SELECT COUNT(*) FROM app_users WHERE group_id=$1", [id]);
    const count = parseInt(members.rows[0].count);
    if (count > 0) return res.status(400).json({ error: `Reassign ${count} member(s) to another group before deleting this one` });
    await pool.query("DELETE FROM groups WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/change-password", authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password) return res.status(400).json({ error: "Current password is required" });
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
    const username = req.user.username;
    const r = await pool.query("SELECT * FROM app_users WHERE username=$1", [username]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    if (hashPass(current_password, user.salt) !== user.password_hash)
      return res.status(401).json({ error: "Current password is incorrect" });
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPass(new_password, salt);
    await pool.query(
      "UPDATE app_users SET password_hash=$1, salt=$2, must_change_password=false WHERE username=$3",
      [hash, salt, username]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

// $ per 1M tokens. Add an entry here if a different Claude model is ever used for review.
const CLAUDE_PRICING = {
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
};

function calcClaudeCost(model, inputTokens, outputTokens) {
  const p = CLAUDE_PRICING[model] || CLAUDE_PRICING["claude-sonnet-4-6"];
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

// Fire-and-forget usage logging — never blocks or fails the review flow.
async function logClaudeUsage(purpose, model, inputTokens, outputTokens, meta = {}) {
  if (!pool) return;
  try {
    await pool.query(
      "INSERT INTO claude_usage (purpose, model, input_tokens, output_tokens, chat_id, employee) VALUES ($1,$2,$3,$4,$5,$6)",
      [purpose, model, inputTokens || 0, outputTokens || 0, meta.chatId || null, meta.employee || null]
    );
  } catch (e) { console.error("[claude_usage] log failed:", e.message); }
}

function lcAuth() {
  const raw = `${process.env.LIVECHAT_ACCOUNT_ID}:${process.env.LIVECHAT_PAT}`;
  return "Basic " + Buffer.from(raw).toString("base64");
}

// Cap concurrent LiveChat requests — parallel report fetches (e.g. per-agent loops
// across a 2-period campaign comparison) can otherwise fire dozens at once and trip
// LiveChat's rate limit.
const LC_MAX_CONCURRENT = 3;
let lcActive = 0;
const lcQueue = [];

// Background jobs (backfills, nightly cron finalize) run through a SEPARATE, smaller
// pool so a big backfill can never starve interactive requests (e.g. the Employees
// page's agent list, or a live report search) behind hundreds of queued slots.
// lcBackgroundContext tags the current async call chain so lcAcquire() can route it
// to the right pool without threading a flag through every function signature.
const LC_MAX_CONCURRENT_BG = 2;
let lcActiveBg = 0;
const lcQueueBg = [];
const lcBackgroundContext = new AsyncLocalStorage();

function runLcBackground(fn) {
  return lcBackgroundContext.run({ background: true }, fn);
}

function lcAcquire() {
  const isBackground = lcBackgroundContext.getStore()?.background;
  const max = isBackground ? LC_MAX_CONCURRENT_BG : LC_MAX_CONCURRENT;
  const queue = isBackground ? lcQueueBg : lcQueue;
  return new Promise((resolve) => {
    const tryAcquire = () => {
      const nowActive = isBackground ? lcActiveBg : lcActive;
      if (nowActive < max) {
        if (isBackground) lcActiveBg++; else lcActive++;
        resolve(() => {
          if (isBackground) { lcActiveBg--; const next = lcQueueBg.shift(); if (next) next(); }
          else { lcActive--; const next = lcQueue.shift(); if (next) next(); }
        });
      } else {
        queue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

async function lcPost(action, body, baseUrl = LC_API, _retry = 0) {
  const release = await lcAcquire();
  let res;
  try {
    res = await fetch(`${baseUrl}/${action}`, {
      method: "POST",
      headers: {
        Authorization: lcAuth(),
        "Content-Type": "application/json",
        "X-Region": "us-south1",
      },
      body: JSON.stringify(body),
    });
  } finally {
    release();
  }

  if (res.status === 429 && _retry < 8) {
    const retryAfterSec = Number(res.headers.get("retry-after")) || 0;
    const jitter = Math.random() * 300;
    const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 + jitter : Math.min(500 * 2 ** _retry, 15000) + jitter;
    await new Promise((r) => setTimeout(r, waitMs));
    return lcPost(action, body, baseUrl, _retry + 1);
  }

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

  // Load permanent custom rules (git-tracked, never overwritten)
  kb.customRules = await fs.readFile(path.join(DATA_DIR, "custom_rules.txt"), "utf8").catch(() => "");
  if (kb.customRules) console.log("[kb] custom_rules.txt loaded");

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

// Like detectPrechatLanguage but also falls back to customer's actual messages
// when no prechat form was submitted.
function detectCustomerLanguage(events, users) {
  const fromForm = detectPrechatLanguage(events);
  if (fromForm) return fromForm;

  const custMsgs = events
    .filter(e => e.type === "message" && e.visibility !== "agents" && e.text
      && users.find(u => u.id === e.author_id)?.type === "customer")
    .slice(0, 5)
    .map(e => e.text)
    .join(" ");
  const detected = detectTextLanguage(custMsgs);
  if (detected === "farsi_or_arabic") return "farsi_or_arabic";
  if (detected === "latin") return "english";
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
  const prechatLang = detectCustomerLanguage(events, users);
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

// Detects when an agent abandoned the chat: customer sent a message and agent never replied.
// Returns { idleMinutes, lastCustomerText } if abandoned, or null.
function detectAgentAbandonment(events, users) {
  const pubMsgs = events
    .filter(e => e.type === "message" && e.visibility !== "agents" && e.text && e.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (pubMsgs.length === 0) return null;

  const lastMsg = pubMsgs[pubMsgs.length - 1];
  const lastAuthor = users.find(u => u.id === lastMsg.author_id);
  if (lastAuthor?.type !== "customer") return null; // last msg was from agent — not abandoned

  // Find last agent message that came BEFORE the customer's final unanswered message
  const agentMsgsBefore = pubMsgs.filter(e => {
    const u = users.find(u2 => u2.id === e.author_id);
    return u?.type === "agent" && new Date(e.created_at) < new Date(lastMsg.created_at);
  });
  if (agentMsgsBefore.length === 0) return null; // LOST CHAT RULE handles zero-reply agents

  const lastAgentMsg = agentMsgsBefore[agentMsgsBefore.length - 1];
  // Measure how long the customer was waiting since the agent's last response
  const waitMinutes = (new Date(lastMsg.created_at) - new Date(lastAgentMsg.created_at)) / 60000;

  if (waitMinutes >= 2) {
    return { idleMinutes: Math.round(waitMinutes * 10) / 10, lastCustomerText: lastMsg.text?.slice(0, 100) };
  }
  // Even if wait < 2 min, if the chat simply ended with unanswered customer message, flag it
  return { idleMinutes: Math.round(waitMinutes * 10) / 10, lastCustomerText: lastMsg.text?.slice(0, 100), shortWait: true };
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

function buildLanguageViolationNote(filteredViolations, events) {
  if (!filteredViolations || filteredViolations.size === 0) return "";
  const prechatLang = detectPrechatLanguage(events);
  return `⚠ SYSTEM NOTE: Pre-Chat Form language = ${prechatLang?.toUpperCase()}. Language mismatch detected for some agents.\n\n`;
}

function toIstanbulTime(iso) {
  if (!iso) return "";
  const ist = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  return ist.toISOString().replace("T", " ").slice(0, 16);
}

function buildTranscript(events, users) {
  const lines = [];
  for (const e of events) {
    const user = users.find((u) => u.id === e.author_id);
    const role = user?.type || "unknown";
    const name = user?.name || e.author_id;
    const ts = e.created_at ? toIstanbulTime(e.created_at) : "";

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

  // Pre-populate: ONLY agents who actually sent at least one public message.
  // Do NOT add agents just because their name appears in a system_message — they may have
  // been assigned or mentioned but never engaged with the customer.
  for (const e of events) {
    const isPrivate = e.visibility === "agents" || e.type === "annotation";
    if (!isPrivate && e.type === "message") {
      const user = users.find(u => u.id === e.author_id);
      if (user?.type === "agent" && !segments[user.id]) {
        segments[user.id] = { id: user.id, name: user.name, events: [], supervisorNotes: [], responded: false };
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

// LiveChat logs an explicit system_message for a no-reply hand-off, e.g.
// "Transferred - to Leo Zirak due to no reply from Stark for 5 min" — note this ALSO
// matches extractTransferGroup's "transferred...to X" shape (X being the receiving
// AGENT's name here, not a department), so this check must run first and take priority:
// a message can't be both a no-reply hand-off and a deliberate department transfer.
function isNoReplyTransferMessage(text) {
  return /no\s+repl(y|ies)|no\s+response/i.test(text);
}

// A multi-agent chat is a "department transfer" only if some system_message names an
// explicit hand-off target (extractTransferGroup) AND isn't actually a no-reply message
// naming the receiving AGENT instead of a department (see isNoReplyTransferMessage).
// Anything else is treated as the original agent going unanswered long enough that
// someone else in the same queue picked it up instead.
function hasExplicitDeptTransfer(events) {
  return events.some(e =>
    e.type === "system_message" && e.text && !isNoReplyTransferMessage(e.text) && extractTransferGroup(e.text)
  );
}

function hasExplicitNoReplyTransfer(events) {
  return events.some(e => e.type === "system_message" && e.text && isNoReplyTransferMessage(e.text));
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

// Istanbul-local "YYYY-MM-DD" for a chat timestamp — used to look up weekend_overrides,
// which are keyed by the same date the shift sheet uses.
const IST_OFFSET_MS = 3 * 60 * 60 * 1000;
function istDayKeyFromIso(iso) {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Known LiveChat client IDs (confirmed from agent session data)
const LC_CLIENT_MOBILE  = "c85439c4e0c1927e69c317d300c610aa"; // LiveChat mobile app
const LC_CLIENT_DESKTOP = "bb9e5b2f1ab480e4a715977b7b1b4279"; // LiveChat web/desktop app

function detectAgentDeviceFromLC(events, users) {
  // Find the dominant client_id used by agents in this chat
  const counts = {};
  for (const e of events) {
    if (e.type !== "message") continue;
    const author = users.find(u => u.id === e.author_id);
    if (author?.type !== "agent") continue;
    const cid = e.properties?.source?.client_id;
    if (cid) counts[cid] = (counts[cid] || 0) + 1;
  }
  if (!Object.keys(counts).length) return null;
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  if (dominant === LC_CLIENT_MOBILE) return "mobile";
  if (dominant === LC_CLIENT_DESKTOP) return "desktop";
  return null;
}

function detectDeviceFromCW(conv) {
  // Chatwoot API doesn't expose agent session device — return null
  return null;
}

function allAgentsInThread(events, users, shifts, chatStartedAt) {
  const seen = {};
  for (const e of events) {
    const isPrivate = e.visibility === "agents" || e.type === "annotation";
    if (!isPrivate && e.type === "message") {
      const user = users.find(u => u.id === e.author_id);
      if (user?.type === "agent" && !seen[user.id]) {
        seen[user.id] = { id: user.id, name: user.name };
      }
    }
  }
  return Object.values(seen);
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
  const customRulesSection = kb.customRules
    ? `\nCUSTOM REVIEW RULES — HIGH PRIORITY (apply these BEFORE any other rule; do NOT penalize agents for following them correctly):\n${kb.customRules}\n`
    : "";
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
    ? `AGENT LANGUAGES: This agent is designated to support: ${langList}. Before scoring anything language-related, check whether the customer's language is in this list. If NOT in this list → the agent must transfer, not respond → award full marks for correctly transferring. If IN this list → the agent must respond in that language → penalize if they did not.`
    : `AGENT LANGUAGES: Not specified. Do NOT apply any language penalties — skip all language-related deductions entirely.`;
  const groupRule = groupList
    ? `AGENT DEPARTMENT: This agent belongs to the "${groupList}" department. Apply the DEPARTMENT ROUTING RULES accordingly — evaluate whether topics in this chat are in scope for this agent's department.`
    : "";
  const agentContext = isPerAgent
    ? `\nPER-AGENT REVIEW MODE: You are ONLY reviewing the performance of "${agentName}" based on their assigned portion of the chat below. Do NOT factor in what other agents did. Score ONLY what "${agentName}" did or failed to do.\n${groupRule}\n${langRule}\n`
    : "";

  const prompt = `You are a QA reviewer for a forex broker support team. Be concise.

OPO BROKER COMMISSION RULE (mandatory — ignore your general knowledge about ECN accounts):
At OPO, commission is charged ONLY when a position is OPENED. Closing a position costs ZERO commission.
This is different from other brokers. Do NOT compare to industry standard or other brokers.
If an agent says "commission is only on entry" or gives a one-sided commission amount — that is CORRECT OPO policy. Do NOT penalize it.

CHAT DATE: ${chatStartedAt || "unknown"}
${agentContext}${customRulesSection}${knowledgeSection}${campaignsSection}${telegramSection}${protocolSection}${macrosSection}${tagsSection ? (isPerAgent ? "" : tagsSection) : ""}
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
- OTHER BROKERS ARE IRRELEVANT TO ACCURACY: If a customer mentions what another broker offers or does not offer (e.g. "broker X doesn't have a cent account"), this has no bearing on this broker's accuracy. The agent is only responsible for correctly describing THIS broker's products and policies. Do NOT deduct accuracy_score based on comparisons the customer makes with other brokers.
- REGULATORY RESTRICTIONS ARE ACCURATE: If the agent tells the customer that a certain action is not allowed due to policy or regulation — for example, that deposits from Iranian exchanges (sarafi irani) are not accepted — this IS an accurate and correct answer. Do NOT deduct from accuracy_score for this. The agent is correctly communicating a real policy; it is not misinformation.
- ONLY EVALUATE WHAT WAS ASKED: Score the agent ONLY on what the customer actually asked. Do NOT deduct from accuracy_score, resolution_score, or product_knowledge_score for information the agent did not volunteer but that was never requested. For example: if the customer did not ask about deposit or withdrawal methods, the agent is NOT required to send deposit/withdrawal information — do not penalize for omitting it.
- STATUS UPDATES — "UNDER REVIEW / TAKES TIME": If the agent tells the customer that their issue is under review, being investigated, has been escalated to the back office, or that the process takes time — this IS a complete and accurate answer when that is the actual status. Do NOT deduct from accuracy_score for this. Do NOT deduct from resolution_score — communicating the correct current status IS the resolution. The agent cannot invent a faster outcome. Customer dissatisfaction about the wait time does not make the answer inaccurate or unresolved.

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

LANGUAGE EVALUATION — DO THIS BEFORE SCORING ANYTHING:

  STEP 1: What language did the customer use?
    - Look at the customer's actual chat messages (not just the pre-chat form).
    - If the customer wrote in Farsi during the chat → effective language = Farsi.
    - If the customer explicitly requested a language switch → use that language from that point.
    - NEVER assume Farsi unless the customer actually wrote in Farsi or selected it in the pre-chat form.

  STEP 2: Is that language in the agent's assigned language list?
    - The agent's languages are listed at the top of the review as "AGENT LANGUAGES: ...".
    - If the agent's language list is not provided → skip all language penalties entirely.

  ── IF THE CUSTOMER'S LANGUAGE IS NOT IN THE AGENT'S LIST ──────────────────
  STOP. The agent cannot read or understand what the customer wrote.
  Do NOT evaluate content, issue, product knowledge, or anything the customer said.
  The agent has exactly ONE job: transfer the chat to the correct department.

  IF the agent transferred the chat:
    → accuracy_score = 10
    → resolution_score = 10 (transfer IS the resolution)
    → compliance_score = 10 (transfer was the only correct action)
    → product_knowledge_score = 10 (agent cannot understand customer's language — not evaluable)
    → satisfaction_score = 10
    → language_score = 10
    → tone_score = 10
    → response_time_score: evaluate normally (was the transfer done quickly?)
    → overall_score: 8 or higher — the ONLY possible deduction is slow response time
    → issues: null — do NOT list any issues about content, resolution, knowledge, or language

  IF the agent did NOT transfer (ignored the barrier, responded in wrong language, or closed without transferring):
    → penalize compliance_score and overall_score.

  ── IF THE CUSTOMER'S LANGUAGE IS IN THE AGENT'S LIST ──────────────────────
  The agent MUST respond in that language. If they responded in a different language:
    THIS IS THE MOST CRITICAL VIOLATION IN THE ENTIRE REVIEW:
      • language_score = 1
      • compliance_score = 1
      • resolution_score = 1
      • tone_score = 1
      • overall_score = 1 — MANDATORY. Nothing can raise this.
      • First issue bullet: "CRITICAL: Agent responded in [language used] despite customer communicating in [customer's language]."
      • Do NOT soften under any circumstances.

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
  - Penalizing the wording, length, or format of a department transfer message. Transfer messages to other departments are standard pre-written macros — the agent has no control over their content. NEVER deduct points from any score (tone, compliance, resolution, satisfaction, accuracy) for how a transfer message is worded.

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

SATISFACTION SCORE DEFINITION — READ THIS CAREFULLY:
satisfaction_score does NOT measure whether the customer was emotionally happy or got the answer they wanted.
satisfaction_score measures whether the AGENT performed their job correctly and professionally.

Score based on:
  - Did the agent give a clear, accurate, and complete answer?
  - Did the agent communicate politely and professionally?
  - Did the agent correctly apply policy/regulations when required?
  - Did the agent do everything within their power to help the customer?

DO NOT deduct from satisfaction_score when:
  - The customer is unhappy because the agent correctly applied a restriction or policy (e.g. no transfers from Iranian exchanges, a blocked deposit method, a country restriction, a compliance rule).
  - The customer did not receive the answer they wanted, but the agent's answer was correct and complete.
  - The outcome was outside the agent's control (regulatory, technical, or policy limitation).
  - The agent explained the steps clearly but the customer did not follow through, did not cooperate, or stopped responding before completing the process. The incomplete outcome is the customer's responsibility, not the agent's.
  - The agent correctly stated that an investigation or process takes time (e.g. "this requires time to investigate", "we will follow up"). If this is an accurate statement and the customer is unhappy about the timeline, that is the customer's reaction to reality — not the agent's failure.
  - The agent closed the chat after the customer stopped responding (no reply after follow-up). Closing an inactive chat is correct procedure — do not deduct satisfaction for the customer's non-response.
  - The customer left the chat or was disconnected. A customer leaving does NOT indicate dissatisfaction — their connection may have been lost (network issue, browser closed, etc.). Do NOT treat "customer left the chat" as a signal of poor satisfaction. Evaluate satisfaction only on the quality of the agent's responses, not on how the chat ended.

In all of these cases: if the agent handled it correctly and communicated clearly → satisfaction_score = 8–10.
Only deduct from satisfaction_score if the agent made an error, was unclear, was rude, or failed to do something they could have done.

CHAT MANAGEMENT RULES (check these in compliance scoring):
1. Follow-up check: After the agent sends a response and the customer does NOT write anything for ~60 seconds (visible as a long gap before the next customer message, or the chat ends without the customer responding), the agent SHOULD send a follow-up such as "سوال دیگه‌ای دارید؟" or "آیا مشکل دیگه‌ای هست؟". If the agent skips this and closes without asking, flag it as a minor compliance issue.
2. Chat closing: At the end of the conversation the agent must send a proper closing message — either the standard closing macro OR a message explaining the chat is being closed due to customer inactivity. If the agent closes abruptly without a farewell or closing reason, flag it as a compliance issue.
3. ABANDONED / IDLE CHAT: If the transcript contains a SYSTEM NOTE saying "AGENT ABANDONED CHAT", OR a system message containing "idle due to inactivity" or "Chat is idle":
   - The AGENT left the customer waiting beyond the 2-minute maximum. This is a serious failure.
   - response_time_score: 1–3 (agent did not respond — severe violation)
   - compliance_score: deduct at least 3 points (critical — abandoning a chat is not minor)
   - resolution_score: deduct (chat was not resolved — agent left)
   - Do NOT apply CUSTOMER NO-RESPONSE RULE here — it is the AGENT who went silent, not the customer.
   - Mention the abandonment explicitly in response_time_notes, compliance_notes, and resolution_notes.
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
  logClaudeUsage("chat_review", "claude-sonnet-4-6", data.usage?.input_tokens, data.usage?.output_tokens, { chatId, employee: agentName });
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

app.get("/api/debug-cw-reviews", authMiddleware, requirePermission("action:debug_tools"), async (req, res) => {
  const reviews = await loadReviews();
  const cw = Object.entries(reviews)
    .filter(([k]) => k.startsWith("cw:"))
    .map(([k, v]) => ({
      key: k,
      _employee: v?._employee,
      _agent_name: v?._agent_name,
      _agent_id: v?._agent_id,
      _chat_date: v?._chat_date,
      _platform: v?._platform,
      skipped: v?.skipped,
      overall_score: v?.overall_score,
    }));
  res.json({ total_cw_reviews: cw.length, reviews: cw });
});

app.get("/api/debug-chat/:chatId", authMiddleware, requirePermission("action:debug_tools"), async (req, res) => {
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
app.get("/api/chats", authMiddleware, requirePermission("page:chats"), async (req, res) => {
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
        platform: "livechat",
        agent: agentUser ? { id: agentUser.id, name: agentUser.name } : null,
        agents: allAgents,
        customer_name: customerUser?.name || null,
        started_at: thread.created_at || null,
        ended_at: thread.ended_at || null,
        applied_tags: thread.tags || [],
        review: reviews[thread.id] || reviews[c.id] || null,
        device: detectAgentDeviceFromLC(events, users),
      };
    });

    res.json({ chats, next_page_id: data.next_page_id || null, total_chats: data.found_chats || data.total_chats || chats.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single chat with full transcript
app.get("/api/chats/:chatId", authMiddleware, requirePermission("page:chats"), async (req, res) => {
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

// ── Chatwoot endpoints ────────────────────────────────────────────────────────

// List Chatwoot conversations with date filter
app.get("/api/chatwoot-agents", authMiddleware, async (req, res) => {
  if (!chatwootEnabled()) return res.json([]);
  try {
    const agents = await cwGet("/agents");
    const list = Array.isArray(agents) ? agents.map(a => ({ id: a.id, name: a.name, email: a.email })) : [];
    res.json(list);
  } catch (e) {
    console.error("[chatwoot-agents]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/chatwoot-chats", authMiddleware, requirePermission("page:chats"), async (req, res) => {
  if (!chatwootEnabled()) return res.json({ chats: [], total_chats: 0, enabled: false });
  try {
    const { date_from, date_to } = req.query;
    const [reviews, shifts] = await Promise.all([loadReviews(), loadShifts()]);

    const filterPayload = [
      { attribute_key: "status", filter_operator: "equal_to", values: ["resolved"], query_operator: date_from || date_to ? "AND" : null },
    ];
    if (date_from) filterPayload.push({ attribute_key: "created_at", filter_operator: "is_greater_than", values: [cwFilterDateFrom(date_from)], query_operator: date_to ? "AND" : null });
    if (date_to)   filterPayload.push({ attribute_key: "created_at", filter_operator: "is_less_than", values: [cwFilterDateTo(date_to)], query_operator: null });

    let allConvs = [];
    let page = 1;
    let totalCount = 0;
    while (true) {
      const data = await cwPost("/conversations/filter", { payload: filterPayload }, { page });
      const inner = data.data || data;
      const convs = inner.payload || inner.conversations || [];
      if (page === 1) totalCount = inner.meta?.all_count ?? inner.meta?.total_count ?? convs.length;
      if (!convs.length) break;
      allConvs = allConvs.concat(convs);
      if (convs.length < 25 || allConvs.length >= totalCount) break;
      page++;
    }

    // Fine-filter by exact UTC timestamp (Chatwoot only supports date-level filtering)
    if (date_from || date_to) {
      const fromMs = date_from ? new Date(date_from).getTime() : 0;
      const toMs   = date_to   ? new Date(date_to).getTime()   : Infinity;
      allConvs = allConvs.filter(c => {
        const ms = (c.created_at || 0) * 1000;
        return ms >= fromMs && ms <= toMs;
      });
    }

    const chats = allConvs.map(conv => {
      const convId = String(conv.id);
      const assignee = conv.meta?.assignee || null;
      const sender = conv.meta?.sender || null;
      const cwKey = `cw:${convId}`;
      return {
        id: convId,
        thread_id: convId,
        platform: "chatwoot",
        agent: assignee ? { id: String(assignee.id), name: assignee.name, email: assignee.email || "" } : null,
        agents: assignee ? [{ id: String(assignee.id), name: assignee.name, email: assignee.email || "" }] : [],
        customer_name: sender?.name || null,
        started_at: cwTimestamp(conv.created_at),
        ended_at: cwTimestamp(conv.resolved_at),
        applied_tags: conv.labels || [],
        review: reviews[cwKey] || null,
        device: detectDeviceFromCW(conv),
      };
    });

    res.json({ chats, total_chats: totalCount, enabled: true });
  } catch (e) {
    console.error("[chatwoot-chats]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Single Chatwoot conversation with messages
app.get("/api/chatwoot-chats/:convId", authMiddleware, requirePermission("page:chats"), async (req, res) => {
  if (!chatwootEnabled()) return res.status(404).json({ error: "Chatwoot not configured" });
  try {
    const { convId } = req.params;
    const [convData, messagesData, reviews] = await Promise.all([
      cwGet(`/conversations/${convId}`),
      cwGet(`/conversations/${convId}/messages`),
      loadReviews(),
    ]);

    const assignee = convData.meta?.assignee || null;
    const sender = convData.meta?.sender || null;

    const rawMessages = (messagesData.payload || []).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    // Determine primary agent from actual message senders, not just current assignee
    // (assignee can change after chat ends via transfer/reassign)
    const agentMsgSenders = {};
    rawMessages.filter(m => m.message_type === 1 && !m.private && m.sender?.id).forEach(m => {
      const id = String(m.sender.id);
      if (!agentMsgSenders[id]) agentMsgSenders[id] = { id, name: m.sender.name, email: m.sender.email || "", count: 0 };
      agentMsgSenders[id].count++;
    });
    const actualAgentList = Object.values(agentMsgSenders).sort((a, b) => b.count - a.count);
    const primaryAgent = actualAgentList[0] || assignee;

    const messages = rawMessages
      .filter(m => m.content)
      .map(msg => {
        const msgTime = cwTimestamp(msg.created_at);
        if (msg.message_type === 2 || msg.message_type === 3) {
          // type 2 = activity, type 3 = template/automated (not a real customer message)
          return { author_type: "system", author_name: "System", content: msg.content, created_at: msgTime, is_private: false, event_type: "system_message" };
        }
        const isPrivate = msg.private === true;
        const isAgent = msg.message_type === 1;
        const senderName = msg.sender?.name || (isAgent ? (primaryAgent?.name || "Agent") : (sender?.name || "Customer"));
        const segAgent = isAgent && !isPrivate && msg.sender?.id
          ? { id: String(msg.sender.id), name: msg.sender.name }
          : null;
        return {
          author_type: isPrivate ? "supervisor" : (isAgent ? "agent" : "customer"),
          author_name: senderName,
          content: msg.content,
          created_at: msgTime,
          is_private: isPrivate,
          segment_agent: segAgent,
          event_type: "message",
        };
      });

    res.json({
      id: convId,
      thread_id: convId,
      platform: "chatwoot",
      agent: primaryAgent ? { id: String(primaryAgent.id), name: primaryAgent.name, email: primaryAgent.email || "" } : null,
      agents: actualAgentList.length > 0
        ? actualAgentList.map(a => ({ id: String(a.id), name: a.name, email: a.email }))
        : (assignee ? [{ id: String(assignee.id), name: assignee.name, email: assignee.email || "" }] : []),
      customer_name: sender?.name || null,
      started_at: cwTimestamp(convData.created_at),
      ended_at: cwTimestamp(convData.resolved_at),
      applied_tags: convData.labels || [],
      messages,
      review: reviews[`cw:${convId}`] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Review a Chatwoot conversation with Claude AI
app.post("/api/review/cw/:convId", authMiddleware, requirePermission("action:review_chats"), async (req, res) => {
  if (!chatwootEnabled()) return res.status(404).json({ error: "Chatwoot not configured" });
  try {
    const { convId } = req.params;
    console.log(`[review-cw] fetching conversation ${convId}`);

    const [convData, messagesData, shifts] = await Promise.all([
      cwGet(`/conversations/${convId}`),
      cwGet(`/conversations/${convId}/messages`),
      loadShifts(),
    ]);

    const assignee = convData.meta?.assignee || null;
    const sender = convData.meta?.sender || null;
    const createdAt = cwTimestamp(convData.created_at);

    const rawMessages = (messagesData.payload || [])
      .filter(m => m.content && m.message_type !== 2 && m.message_type !== 3)
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    const customerMessages = rawMessages.filter(m => m.message_type === 0 && !m.private);
    if (customerMessages.length === 0) {
      const skipped = { skipped: true, reason: "Customer left without sending any message" };
      const reviews = await loadReviews();
      reviews[`cw:${convId}`] = skipped;
      await saveReviews(reviews);
      return res.json(skipped);
    }

    // Determine primary agent from actual message senders (not current assignee which may have changed)
    const agentMsgMap = {};
    rawMessages.filter(m => m.message_type === 1 && !m.private && m.sender?.id).forEach(m => {
      const id = String(m.sender.id);
      if (!agentMsgMap[id]) agentMsgMap[id] = { id, name: m.sender.name, email: m.sender.email || "", count: 0 };
      agentMsgMap[id].count++;
    });
    const actualAgents = Object.values(agentMsgMap).sort((a, b) => b.count - a.count);
    const primaryAgent = actualAgents[0] || assignee;

    const supervisorNotes = rawMessages
      .filter(m => m.private === true)
      .map(m => ({ author: m.sender?.name || "Supervisor", text: m.content, created_at: cwTimestamp(m.created_at) }));

    const transcript = rawMessages
      .filter(m => !m.private)
      .map(msg => {
        const isAgent = msg.message_type === 1;
        const who = isAgent
          ? `Agent (${msg.sender?.name || primaryAgent?.name || "Agent"})`
          : `Customer (${msg.sender?.name || sender?.name || "Customer"})`;
        return `${who}: ${msg.content}`;
      })
      .join("\n");

    // Match agent to employee via chatwootAgentId (use primary agent who actually sent messages)
    const agentEmail = (primaryAgent?.email || "").toLowerCase().trim();
    const agentNameLow = (primaryAgent?.name || "").toLowerCase().trim();
    const matchShift = shifts.find(s => {
      if (!s.chatwootAgentId) return false;
      const cwId = s.chatwootAgentId.toLowerCase().trim();
      return cwId === agentEmail || cwId === agentNameLow || cwId.split("@")[0] === agentNameLow;
    });

    const review = await reviewWithClaude(
      transcript, `cw:${convId}`, createdAt, supervisorNotes,
      primaryAgent?.name || null, matchShift?.languages || [], matchShift?.groups || []
    );

    review.reviewed_at = new Date().toISOString();
    review._agent_name = primaryAgent?.name || null;
    review._agent_id   = String(primaryAgent?.id || "");
    review._chat_date  = createdAt;
    review._platform   = "chatwoot";
    review._employee   = matchShift?.employee || null;

    const cwKey = `cw:${convId}`;
    const reviews = await loadReviews();
    reviews[cwKey] = review;
    await saveReviews(reviews);

    console.log(`[review-cw] done for ${cwKey}, overall: ${review.overall_score}`);
    res.json(review);
  } catch (e) {
    console.log(`[review-cw] ERROR:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Review a chat with Claude AI
app.post("/api/review/:chatId", authMiddleware, requirePermission("action:review_chats"), async (req, res) => {
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

    const langViolationsRaw = detectLanguageViolations(events, users);
    // Remove violations for agents whose language list does not include the customer's language.
    const langViolations = new Map();
    for (const [agentNameKey, violation] of langViolationsRaw.entries()) {
      const k = agentNameKey.toLowerCase().trim();
      const shiftEntry = shifts3.find(s =>
        k === s.agentKey ||
        k === s.employee.toLowerCase() ||
        k.split(" ")[0] === s.agentKey ||
        s.agentKey.split(" ")[0] === k.split(" ")[0]
      );
      const agentLangs = (shiftEntry?.languages || []).map(l => l.toLowerCase());
      const custLang = violation.prechatLang;
      console.log(`[lang-filter] agent="${agentNameKey}" shiftFound=${!!shiftEntry} agentLangs=${JSON.stringify(agentLangs)} custLang=${custLang}`);
      // If agent has no language list → cannot determine → do NOT penalize
      if (agentLangs.length === 0) {
        console.log(`[lang-filter] SKIP penalty for "${agentNameKey}" — no language list configured`);
        continue;
      }
      const speaksFarsi   = agentLangs.some(l => l.includes("farsi") || l.includes("persian"));
      const speaksArabic  = agentLangs.some(l => l.includes("arabic"));
      const speaksEnglish = agentLangs.some(l => l.includes("english"));
      // For "farsi_or_arabic": only penalize if agent speaks BOTH — if agent only speaks one
      // of the two, customer might be the other language and transfer was correct.
      const agentCanSpeak =
        (custLang === "farsi"           && speaksFarsi) ||
        (custLang === "arabic"          && speaksArabic) ||
        (custLang === "english"         && speaksEnglish) ||
        (custLang === "farsi_or_arabic" && speaksFarsi && speaksArabic);
      if (agentCanSpeak) {
        console.log(`[lang-filter] KEEP violation for "${agentNameKey}" — can speak ${custLang}`);
        langViolations.set(agentNameKey, violation);
      } else {
        console.log(`[lang-filter] SKIP penalty for "${agentNameKey}" — cannot speak ${custLang}, transfer was correct`);
      }
    }
    const langViolationNote = buildLanguageViolationNote(langViolations, events);
    const abandonmentInfo = detectAgentAbandonment(events, users);
    console.log(`[abandon] detected=${!!abandonmentInfo} idleMin=${abandonmentInfo?.idleMinutes} shortWait=${abandonmentInfo?.shortWait}`);
    const abandonmentNote = abandonmentInfo && !abandonmentInfo.shortWait
      ? `⚠ SYSTEM NOTE: AGENT ABANDONED CHAT — Customer's last message was left unanswered for ${abandonmentInfo.idleMinutes} minutes (max allowed: 2 min). Unanswered: "${abandonmentInfo.lastCustomerText}". Apply ABANDONED CHAT penalties.\n\n`
      : "";
    const transcript = langViolationNote + abandonmentNote + buildTranscript(events, users);
    const supervisorNotes = extractSupervisorNotes(events, users);
    const agentSegments = buildAgentSegments(events, users, shifts3, chatStartedAt3);
    const agentCount = Object.keys(agentSegments).length;
    console.log(`[review] transcript: ${transcript.length}c, agents: ${agentCount}, supervisor notes: ${supervisorNotes.length}`);

    if (!transcript) {
      return res.status(400).json({ error: "No messages in this chat" });
    }

    const chatStartedAt = thread.created_at || null;
    console.log(`[lang] prechatLang=${detectPrechatLanguage(events)} violations=${[...langViolations.entries()].map(([k,v])=>`${k}:${v.prechatLang}->${v.agentLang}`).join(',') || 'none'} agentCount=${agentCount}`);
    const langCannotSpeak = new Set([...langViolationsRaw.keys()].filter(k => !langViolations.has(k)));

    // Proactive check: if an agent's language list does NOT include the customer's language,
    // they MUST transfer regardless — add to cannotSpeak even if no violation was detected
    // (e.g. agent transferred silently and detectLanguageViolations never flagged them)
    const custLangGlobal = detectCustomerLanguage(events, users);
    if (custLangGlobal) {
      for (const [, seg] of Object.entries(agentSegments)) {
        const nk = seg.name.toLowerCase().trim();
        if (langCannotSpeak.has(nk)) continue;
        if ([...langViolations.keys()].some(k => nk === k || nk.split(" ")[0] === k.split(" ")[0])) continue;
        const se = shifts3.find(s => nk === s.agentKey || nk.split(" ")[0] === s.agentKey || s.agentKey.split(" ")[0] === nk.split(" ")[0]);
        const al = (se?.languages || []).map(l => l.toLowerCase());
        if (al.length === 0) continue;
        const sf = al.some(l => l.includes("farsi") || l.includes("persian"));
        const sa = al.some(l => l.includes("arabic"));
        const sen = al.some(l => l.includes("english"));
        // For "farsi_or_arabic" detected from message text (ambiguous — can't tell Farsi from Arabic),
        // treat agent as able to speak if they know EITHER — don't override scores for ambiguous language.
        // Only override when prechat form explicitly says "farsi" and agent doesn't know it.
        const canSpeak =
          (custLangGlobal === "farsi"           && sf)  ||
          (custLangGlobal === "arabic"          && sa)  ||
          (custLangGlobal === "english"         && sen) ||
          (custLangGlobal === "farsi_or_arabic" && (sf || sa));
        if (!canSpeak) {
          langCannotSpeak.add(nk);
          console.log(`[lang] proactive cannotSpeak: ${seg.name} langs=${JSON.stringify(al)} custLang=${custLangGlobal}`);
        }
      }
    }

    let review;

    if (agentCount <= 1) {
      // Single-agent: one overall Claude call
      review = await reviewWithClaude(transcript, chatId, chatStartedAt, supervisorNotes);
      if (langCannotSpeak.size > 0) {
        // Agent cannot speak customer's language → transfer was correct → override all scores
        review = {
          ...review,
          accuracy_score: 10, resolution_score: 10, compliance_score: 10,
          product_knowledge_score: 10, satisfaction_score: 10, language_score: 10, tone_score: 10,
          overall_score: Math.max(review.overall_score || 0, 8),
          issues: null, _lang_transfer_override: true,
        };
        console.log(`[lang] single-agent transfer override applied`);
      } else if (langViolations.size > 0) {
        const [firstKey, firstV] = [...langViolations.entries()][0];
        review = applyLanguagePenalty(review, firstKey, firstV);
        console.log(`[lang] single-agent penalty applied`);
      }
    } else {
      // Multi-agent: per-agent Claude calls only — no overall call, saves 1 token spend per chat
      const agentPromises = Object.fromEntries(
        Object.entries(agentSegments).map(([agentId, seg]) => {
          if (!seg.responded) {
            return [agentId, Promise.resolve({
              agent_name: seg.name,
              overall_score: 0,
              response_time_score: 0,
              accuracy_score: 0,
              tone_score: 0,
              resolution_score: 0,
              compliance_score: 0,
              product_knowledge_score: 0,
              satisfaction_score: 0,
              language_score: 0,
              issues: ["Chat az dast raft — agent hich pasokhi naferestade"],
              suggested_tags: [],
              resolved: false,
            })];
          }
          const contextEvents = events.filter(e => e.type === "filled_form" || e.type === "system_message");
          const agentOnlyEvents = seg.events.filter(e => e.type !== "filled_form" && e.type !== "system_message");
          const agentTranscript = abandonmentNote + buildTranscript([...contextEvents, ...agentOnlyEvents], users);
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
                return { agent_name: seg.name, overall_score: null, issues: [], suggested_tags: [], _error: true };
              })
          ];
        })
      );

      const perAgent = {};
      for (const [agentId, promise] of Object.entries(agentPromises)) {
        let ar = await promise;
        const nameKey = (ar.agent_name || "").toLowerCase();
        const cannotSpeak = langCannotSpeak.has(nameKey) ||
          [...langCannotSpeak].some(k => nameKey.startsWith(k) || k.startsWith(nameKey.split(" ")[0]));
        if (cannotSpeak) {
          ar = {
            ...ar,
            accuracy_score: 10, resolution_score: 10, compliance_score: 10,
            product_knowledge_score: 10, satisfaction_score: 10, language_score: 10, tone_score: 10,
            overall_score: Math.max(ar.overall_score || 0, 8),
            accuracy_notes: "Agent correctly transferred chat — cannot evaluate content in unsupported language.",
            resolution_notes: "Transfer to correct department is the complete resolution.",
            compliance_notes: "Transferring was the only and correct action.",
            product_knowledge_notes: "Cannot evaluate — agent does not support customer's language.",
            satisfaction_notes: "Agent did the only thing they could do — transfer was correct.",
            language_notes: "Agent correctly identified language barrier and transferred.",
            issues: null, _lang_transfer_override: true,
          };
          console.log(`[lang] transfer override applied to ${ar.agent_name}`);
        } else {
          const v = langViolations.get(nameKey) || [...langViolations.entries()].find(([k]) => nameKey.startsWith(k) || k.startsWith(nameKey.split(" ")[0]))?.[1];
          if (v) { ar = applyLanguagePenalty(ar, ar.agent_name, v); console.log(`[lang] penalty applied to ${ar.agent_name}`); }
        }
        perAgent[agentId] = ar;
      }

      // Build overall review from per-agent averages — no separate Claude call needed
      const validScores = Object.values(perAgent).map(r => r.overall_score).filter(s => s != null && s > 0);
      const avgOverall = validScores.length ? +(validScores.reduce((a,b) => a+b, 0) / validScores.length).toFixed(1) : null;
      const allResolved = Object.values(perAgent).some(r => r.resolved);
      const allTags = [...new Set(Object.values(perAgent).flatMap(r => r.suggested_tags || []))];
      const allIssues = Object.values(perAgent).flatMap(r => {
        if (!r.issues) return [];
        return Array.isArray(r.issues) ? r.issues : [r.issues];
      }).slice(0, 3);

      review = {
        overall_score: avgOverall,
        resolved: allResolved,
        escalated: Object.values(perAgent).some(r => r.escalated),
        language_detected: Object.values(perAgent)[0]?.language_detected || null,
        supervisor_warning: Object.values(perAgent).some(r => r.supervisor_warning),
        supervisor_warning_text: Object.values(perAgent).find(r => r.supervisor_warning_text)?.supervisor_warning_text || null,
        suggested_tags: allTags,
        issues: allIssues.length ? allIssues : null,
        summary: `Multi-agent chat (${Object.values(perAgent).map(r => r.agent_name).join(", ")}). Avg score: ${avgOverall ?? "N/A"}.`,
        per_agent_reviews: perAgent,
      };
    }

    review.reviewed_at = new Date().toISOString();

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
app.get("/api/reviews", authMiddleware, async (req, res) => {
  const reviews = await loadReviews();
  res.json(reviews);
});

// Stats per agent
app.get("/api/stats", authMiddleware, async (req, res) => {
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

// Shared: count all chats (reviewed or not) per employee over an arbitrary date range.
// This is the "live" implementation that always hits LiveChat/Chatwoot directly — used
// to refresh a single day (today, or during a backfill), never called with a wide range
// directly by routes anymore. See computeChatTotals() below for the cached entry point.
async function computeChatTotalsLive({ dateFrom, dateTo, employeeFilter, includeSupervised = true }) {
  const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
  const fromDate = new Date(new Date(`${dateFrom}T00:00:00.000Z`).getTime() - ISTANBUL_OFFSET_MS);
  const toDate   = new Date(new Date(`${dateTo}T23:59:59.999Z`).getTime() - ISTANBUL_OFFSET_MS);
  const lcFrom = fromDate.toISOString().replace(/\.\d{3}Z$/, ".000000+00:00");
  const lcTo   = toDate.toISOString().replace(/\.\d{3}Z$/, ".999999+00:00");

  const [allShifts, agentsRaw, weekendOverrides] = await Promise.all([
    loadShifts(),
    lcPost("list_agents", {}, LC_CONFIG_API),
    loadWeekendOverrides(),
  ]);
  const shifts = visibleShifts(allShifts);

  const agentKeyShifts = {};
  for (const s of shifts) {
    if (employeeFilter && s.employee !== employeeFilter) continue;
    const key = s.agentKey.toLowerCase().trim();
    if (!agentKeyShifts[key]) agentKeyShifts[key] = [];
    agentKeyShifts[key].push(s);
  }

  const rawAgentList = Array.isArray(agentsRaw) ? agentsRaw
    : Array.isArray(agentsRaw?.agents) ? agentsRaw.agents
    : Object.values(agentsRaw || {}).find(v => Array.isArray(v)) || [];

  const agentKeyToEmail = {};
  for (const a of rawAgentList) {
    const low = a.name.toLowerCase().trim();
    const fst = low.split(" ")[0];
    for (const key of Object.keys(agentKeyShifts)) {
      if ((low === key || fst === key) && !agentKeyToEmail[key]) {
        agentKeyToEmail[key] = a.id;
      }
    }
  }

  function getIstHour(chatTime) {
    if (!chatTime) return 0;
    return ((new Date(chatTime).getTime() + ISTANBUL_OFFSET_MS) / 3600000) % 24;
  }

  function istDayKey(ms) {
    return new Date(ms + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
  }

  const emp = {};
  const daily = {};           // { "YYYY-MM-DD": { livechat, chatwoot } } — company-wide
  const dailyByEmployee = {}; // { employee: { "YYYY-MM-DD": { livechat, chatwoot } } }
  let cwCount = 0;

  function bumpDaily(empName, dayKey, platform) {
    if (!daily[dayKey]) daily[dayKey] = { livechat: 0, chatwoot: 0 };
    daily[dayKey][platform]++;
    if (!dailyByEmployee[empName]) dailyByEmployee[empName] = {};
    if (!dailyByEmployee[empName][dayKey]) dailyByEmployee[empName][dayKey] = { livechat: 0, chatwoot: 0 };
    dailyByEmployee[empName][dayKey][platform]++;
  }

  // Only counts as "needed help" if the private note/annotation was left by a DIFFERENT
  // agent account than the one handling the chat — excludes an agent's own self-notes
  // (e.g. "are you there?" idle reminders), which don't indicate anyone else stepped in.
  function hasSupervisorNote(events, users, key) {
    return events.some(e => {
      if (!e.text || !(e.visibility === "agents" || e.type === "annotation")) return false;
      const author = users.find(u => u.id === e.author_id);
      const authorName = (author?.name || "").toLowerCase().trim();
      if (!authorName) return false;
      return authorName !== key && authorName.split(" ")[0] !== key;
    });
  }

  async function fetchAgentChats(key, shiftList) {
    const agentEmail = agentKeyToEmail[key];
    if (!agentEmail) return;

    const uniqueEmpsForKey = [...new Set(shiftList.map(s => s.employee))];
    uniqueEmpsForKey.forEach(n => { if (!emp[n]) emp[n] = { livechat: 0, chatwoot: 0, supervised: 0, mobile: 0, answered: 0, transferred: 0, transferredDept: 0, transferredNoResponse: 0, durationSec: 0 }; });
    const isShared = uniqueEmpsForKey.length > 1;

    let pid = null;
    do {
      const body = pid
        ? { page_id: pid }
        : { filters: { from: lcFrom, to: lcTo, agents: { values: [agentEmail] } }, limit: 100 };
      const data = await lcPost("list_archives", body);
      pid = data.next_page_id || null;

      for (const c of data.chats || []) {
        const thread = c.thread || (c.threads?.[0]) || {};
        const users = c.users || [];
        const events = thread.events || [];
        const chatTime = thread.created_at || null;
        const istHour = getIstHour(chatTime);

        const chatAgents = allAgentsInThread(events, users, shifts, chatTime);
        const agentInChat = chatAgents.some(a => {
          const n = (a.name || "").toLowerCase().trim();
          return n === key || n.split(" ")[0] === key;
        });
        if (!agentInChat) continue;

        const dayKey = istDayKey(new Date(chatTime).getTime());
        const overrideEmp = findOverrideEmployee(weekendOverrides, "livechat", dayKey, istHour, uniqueEmpsForKey);

        let empName = null;
        if (overrideEmp) {
          empName = overrideEmp;
        } else if (isShared) {
          const matched = shiftList.find(s => istHour >= s.start && istHour < s.end);
          empName = (matched || shiftList[0]).employee;
        } else {
          const inShift = shiftList.some(s => istHour >= s.start && istHour < s.end);
          if (!inShift) continue;
          empName = uniqueEmpsForKey[0];
        }
        emp[empName].livechat++;
        if (hasSupervisorNote(events, users, key)) emp[empName].supervised++;
        if (detectAgentDeviceFromLC(events, users) === "mobile") emp[empName].mobile++;
        // LiveChat's list_archives response has no "ended_at" field on the thread —
        // use the last event's timestamp as the chat's actual end time instead.
        const lastEventAt = events.length ? events[events.length - 1].created_at : null;
        if (lastEventAt) {
          const dur = (new Date(lastEventAt) - new Date(chatTime)) / 1000;
          if (dur > 0 && dur < 10800) emp[empName].durationSec += dur;
        }
        // More than one distinct agent sent a public message in this thread → the chat
        // moved between agents (transferred) at some point, from this employee's side.
        // Split by reason: an explicit "transferred to X" banner means a deliberate
        // department hand-off; otherwise the original agent went unanswered and someone
        // else in the same queue stepped in.
        if (chatAgents.length > 1) {
          emp[empName].transferred++;
          // Check no-reply first — it's the more specific, more reliable signal, and its
          // message text can otherwise look like a department-transfer banner (see
          // isNoReplyTransferMessage's comment).
          if (hasExplicitNoReplyTransfer(events)) emp[empName].transferredNoResponse++;
          else if (hasExplicitDeptTransfer(events)) emp[empName].transferredDept++;
          else emp[empName].transferredNoResponse++;
        } else {
          emp[empName].answered++;
        }
        bumpDaily(empName, dayKey, "livechat");
      }
    } while (pid);
  }

  async function fetchChatwoot() {
    if (!chatwootEnabled()) return;
    try {
      const cwFilter = [
        { attribute_key: "status", filter_operator: "equal_to", values: ["resolved"], query_operator: "AND" },
        { attribute_key: "created_at", filter_operator: "is_greater_than", values: [cwFilterDateFrom(lcFrom)], query_operator: "AND" },
        { attribute_key: "created_at", filter_operator: "is_less_than", values: [cwFilterDateTo(lcTo)], query_operator: null },
      ];
      let cwPage = 1, cwAll = [], cwTotal = 0;
      while (true) {
        const d = await cwPost("/conversations/filter", { payload: cwFilter }, { page: cwPage });
        const inner = d.data || d;
        const convs = inner.payload || inner.conversations || [];
        if (cwPage === 1) cwTotal = inner.meta?.all_count ?? inner.meta?.total_count ?? convs.length;
        if (!convs.length) break;
        cwAll = cwAll.concat(convs);
        if (convs.length < 25 || cwAll.length >= cwTotal) break;
        cwPage++;
      }
      const fromMs = new Date(lcFrom).getTime();
      const toMs   = new Date(lcTo).getTime();
      cwAll = cwAll.filter(c => {
        const ms = (c.created_at || 0) * 1000;
        return ms >= fromMs && ms <= toMs;
      });
      cwCount = cwAll.length;
      const matched = [];
      for (const conv of cwAll) {
        const assignee = conv.meta?.assignee || null;
        if (!assignee) continue;
        const aEmail = (assignee.email || "").toLowerCase().trim();
        const aName  = (assignee.name  || "").toLowerCase().trim();
        const ms = shifts.find(s => {
          if (employeeFilter && s.employee !== employeeFilter) return false;
          if (!s.chatwootAgentId) return false;
          const cwId = s.chatwootAgentId.toLowerCase().trim();
          return cwId === aEmail || cwId === aName || cwId.split("@")[0] === aName;
        });
        if (!ms) continue;
        const n = ms.employee;
        if (!emp[n]) emp[n] = { livechat: 0, chatwoot: 0, supervised: 0, mobile: 0, answered: 0, transferred: 0, durationSec: 0 };
        emp[n].chatwoot++;
        bumpDaily(n, istDayKey((conv.created_at || 0) * 1000), "chatwoot");
        matched.push({ id: conv.id, employee: n, assigneeId: assignee.id, createdAt: conv.created_at || 0 });
      }

      // Check each matched conversation for a private/internal note left by a DIFFERENT
      // agent than the one assigned — excludes an agent's own self-notes. Bounded
      // concurrency — this is one extra request per conversation, so skip entirely
      // when the caller doesn't need it (e.g. a baseline period used only for totals).
      // The conversation list has no "resolved_at"/duration field, so this same
      // per-conversation messages fetch also doubles as the only way to get a real
      // chat duration — the gap between the conversation's start and its last message.
      if (includeSupervised) {
        await Promise.all(matched.map(async ({ id, employee, assigneeId, createdAt }) => {
          try {
            const release = await cwAcquire();
            let msgData;
            try { msgData = await cwGet(`/conversations/${id}/messages`); } finally { release(); }
            const msgs = msgData.payload || msgData || [];
            const hasNote = Array.isArray(msgs) && msgs.some(m => m.private === true && String(m.sender?.id) !== String(assigneeId));
            if (hasNote) emp[employee].supervised++;
            if (Array.isArray(msgs) && msgs.length && createdAt) {
              const lastMsgAt = Math.max(...msgs.map(m => m.created_at || 0));
              const dur = lastMsgAt - createdAt;
              if (dur > 0 && dur < 10800) emp[employee].durationSec += dur;
            }
          } catch (e) { console.error(`[total-chats] cw private-note check failed for ${id}:`, e.message); }
        }));
      }
    } catch (e) { console.error("[total-chats] Chatwoot error:", e.message); }
  }

  const [firstPageResult] = await Promise.all([
    employeeFilter ? Promise.resolve(null) : lcPost("list_archives", { filters: { from: lcFrom, to: lcTo }, limit: 1 }),
    Promise.all(Object.entries(agentKeyShifts).map(([key, shiftList]) => fetchAgentChats(key, shiftList))),
    fetchChatwoot(),
  ]);

  let totalChats = employeeFilter ? null : (firstPageResult?.found_chats ?? firstPageResult?.total_chats ?? 0);
  if (!employeeFilter && totalChats != null) totalChats += cwCount;

  const employees = Object.entries(emp)
    .map(([name, d]) => ({
      name, livechat: d.livechat, chatwoot: d.chatwoot, total: d.livechat + d.chatwoot,
      supervised: d.supervised || 0, mobile: d.mobile || 0, answered: d.answered || 0, transferred: d.transferred || 0,
      transferredDept: d.transferredDept || 0, transferredNoResponse: d.transferredNoResponse || 0,
      durationSec: d.durationSec || 0,
    }))
    .sort((a, b) => b.total - a.total);

  const grandTotal = employees.reduce((s, e) => s + e.total, 0);
  return { date_from: dateFrom, date_to: dateTo, total_chats: totalChats ?? grandTotal, employees, daily, dailyByEmployee };
}

// ── Chat Totals cache (chat_totals_daily) ─────────────────────────────────────
// Same strategy as Agent Activity: past days are cache-only, "today" is always
// re-fetched live and upserted. Used by both Total Chats and Campaign Impact
// (both call computeChatTotals()), so both benefit from the same cache.

function istTodayKeyChats() {
  const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
  return new Date(Date.now() + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

async function upsertChatTotalsDay(employee, date, livechat, chatwoot, supervised, mobile, answered, transferred, transferredDept, transferredNoResponse, durationSec) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO chat_totals_daily (employee, date, livechat, chatwoot, supervised, mobile, answered, transferred, transferred_dept, transferred_no_response, duration_sec, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (employee, date) DO UPDATE SET livechat=$3, chatwoot=$4, supervised=$5, mobile=$6, answered=$7, transferred=$8, transferred_dept=$9, transferred_no_response=$10, duration_sec=$11, updated_at=NOW()`,
      [employee, date, livechat, chatwoot, supervised, mobile, answered, transferred, transferredDept, transferredNoResponse, durationSec || 0]
    );
  } catch (e) { console.error(`[chat_totals_daily] upsert failed for ${employee} ${date}:`, e.message); }
}

async function loadChatTotalsRangeFromDB(dateFrom, dateTo, employeeFilter) {
  if (!pool) return {};
  try {
    const params = [dateFrom, dateTo];
    let q = "SELECT employee, date, livechat, chatwoot, supervised, mobile, answered, transferred, transferred_dept, transferred_no_response, duration_sec FROM chat_totals_daily WHERE date >= $1 AND date <= $2";
    if (employeeFilter) { params.push(employeeFilter); q += " AND employee = $3"; }
    const r = await pool.query(q, params);
    const out = {}; // employee -> date -> {livechat, chatwoot, supervised, mobile, answered, transferred, transferredDept, transferredNoResponse, durationSec}
    for (const row of r.rows) {
      if (!out[row.employee]) out[row.employee] = {};
      out[row.employee][row.date] = {
        livechat: row.livechat, chatwoot: row.chatwoot, supervised: row.supervised, mobile: row.mobile,
        answered: row.answered, transferred: row.transferred,
        transferredDept: row.transferred_dept, transferredNoResponse: row.transferred_no_response,
        durationSec: row.duration_sec || 0,
      };
    }
    return out;
  } catch (e) { console.error("[chat_totals_daily] load failed:", e.message); return {}; }
}

async function markChatTotalsDayCached(dateKey) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO chat_totals_cached_days (date, computed_at) VALUES ($1, NOW())
       ON CONFLICT (date) DO UPDATE SET computed_at = NOW()`,
      [dateKey]
    );
  } catch (e) { console.error(`[chat_totals_cached_days] mark failed for ${dateKey}:`, e.message); }
}

async function getChatTotalsCachedDays(dateFrom, dateTo) {
  if (!pool) return new Set();
  try {
    const r = await pool.query("SELECT date FROM chat_totals_cached_days WHERE date >= $1 AND date <= $2", [dateFrom, dateTo]);
    return new Set(r.rows.map((row) => row.date));
  } catch (e) { console.error("[chat_totals_cached_days] load failed:", e.message); return new Set(); }
}

// Live-fetch one day (all visible employees, full supervised check), upsert into the
// DB, and mark the day as cached (even if some/all employees had zero chats that day).
async function computeAndStoreChatTotalsDay(dateKey) {
  const result = await computeChatTotalsLive({ dateFrom: dateKey, dateTo: dateKey, employeeFilter: null, includeSupervised: true });
  await Promise.all(result.employees.map((e) =>
    upsertChatTotalsDay(e.name, dateKey, e.livechat, e.chatwoot, e.supervised, e.mobile, e.answered, e.transferred, e.transferredDept, e.transferredNoResponse, e.durationSec)
  ));
  await markChatTotalsDayCached(dateKey);
  return result;
}

// Cached entry point — same signature/shape as before, so existing callers
// (Total Chats, Campaign Impact) don't need to change at all.
async function computeChatTotals({ dateFrom, dateTo, employeeFilter }) {
  const todayKey = istTodayKeyChats();

  const days = [];
  for (let d = new Date(`${dateFrom}T00:00:00Z`); d <= new Date(`${dateTo}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  // Any day that isn't cached yet (never computed, e.g. a historical range no one has
  // viewed before) gets live-fetched on this request, same as "today" always does —
  // no manual backfill required for a report to just work the first time it's viewed.
  const cachedDays = await getChatTotalsCachedDays(dateFrom, dateTo);
  const daysToFetch = days.filter((d) => d === todayKey || !cachedDays.has(d));
  if (daysToFetch.length) {
    // A persistent failure fetching one day (e.g. LiveChat rate-limiting even after
    // retries) must not take down the whole report — other days still get cached and
    // returned; the failed day just stays uncached and gets retried on the next search.
    await Promise.all(daysToFetch.map((d) =>
      computeAndStoreChatTotalsDay(d).catch((e) => console.error(`[chat-totals] failed to fetch ${d}:`, e.message))
    ));
  }

  const dbData = await loadChatTotalsRangeFromDB(dateFrom, dateTo, employeeFilter);

  // dbData reflects whatever was ever computed/cached for a given employee name,
  // which can include employees since unchecked from "Chart" (or removed). Restrict
  // to currently-visible employees so hidden ones don't reappear here even though
  // their historical rows are still sitting in chat_totals_daily.
  const visibleEmployees = new Set(visibleShifts(await loadShifts()).map((s) => s.employee));

  const daily = {};           // company-wide per day
  const dailyByEmployee = {}; // per employee per day
  const empTotals = {};       // employee -> summed { livechat, chatwoot, supervised, mobile }

  for (const [employee, byDay] of Object.entries(dbData)) {
    if (!visibleEmployees.has(employee)) continue;
    dailyByEmployee[employee] = {};
    for (const [date, d] of Object.entries(byDay)) {
      dailyByEmployee[employee][date] = { livechat: d.livechat, chatwoot: d.chatwoot };
      if (!daily[date]) daily[date] = { livechat: 0, chatwoot: 0 };
      daily[date].livechat += d.livechat;
      daily[date].chatwoot += d.chatwoot;
      if (!empTotals[employee]) empTotals[employee] = { livechat: 0, chatwoot: 0, supervised: 0, mobile: 0, answered: 0, transferred: 0, transferredDept: 0, transferredNoResponse: 0, durationSec: 0 };
      empTotals[employee].livechat += d.livechat;
      empTotals[employee].chatwoot += d.chatwoot;
      empTotals[employee].supervised += d.supervised;
      empTotals[employee].mobile += d.mobile;
      empTotals[employee].answered += d.answered || 0;
      empTotals[employee].transferred += d.transferred || 0;
      empTotals[employee].transferredDept += d.transferredDept || 0;
      empTotals[employee].transferredNoResponse += d.transferredNoResponse || 0;
      empTotals[employee].durationSec += d.durationSec || 0;
    }
  }

  const employees = Object.entries(empTotals)
    .map(([name, d]) => ({
      name, livechat: d.livechat, chatwoot: d.chatwoot, total: d.livechat + d.chatwoot,
      supervised: d.supervised, mobile: d.mobile, answered: d.answered, transferred: d.transferred,
      transferredDept: d.transferredDept, transferredNoResponse: d.transferredNoResponse,
      durationSec: d.durationSec,
    }))
    .sort((a, b) => b.total - a.total);

  const totalChats = employees.reduce((s, e) => s + e.total, 0);
  return { date_from: dateFrom, date_to: dateTo, total_chats: totalChats, employees, daily, dailyByEmployee };
}

// Total chats per employee over an arbitrary date range, optionally filtered to one employee
app.get("/api/reports/total-chats", authMiddleware, requirePermission("page:report-total-chats"), async (req, res) => {
  try {
    const { date_from, date_to, employee } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    const result = await computeChatTotals({ dateFrom: date_from, dateTo: date_to, employeeFilter: employee || null });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-employee breakdown of LiveChat chats into "answered solo" (only that agent ever
// sent a message in the thread) vs "transferred" (more than one agent's messages appear
// in the thread) — shares the same cache/backfill/cron as Total Chats since it's
// computed in the very same LiveChat pass. Chatwoot isn't included: this app has no
// reliable way to detect a Chatwoot conversation being handed to another agent.
app.get("/api/reports/chat-transfers", authMiddleware, requirePermission("page:report-chat-transfers"), async (req, res) => {
  try {
    const { date_from, date_to, employee } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    const result = await computeChatTotals({ dateFrom: date_from, dateTo: date_to, employeeFilter: employee || null });
    const employees = result.employees
      .map((e) => ({
        name: e.name, total: e.answered + e.transferred, answered: e.answered, transferred: e.transferred,
        transferredDept: e.transferredDept || 0, transferredNoResponse: e.transferredNoResponse || 0,
      }))
      .filter((e) => e.total > 0)
      .sort((a, b) => b.transferred - a.transferred);
    res.json({ date_from: result.date_from, date_to: result.date_to, employees });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Individual chats where someone other than the assigned agent left a private note or
// annotation — i.e. a supervisor had to step in and guide them. Unlike computeChatTotals()'s
// aggregate `supervised` count, this returns per-chat detail (who reviewed, what the note
// said) for the "Supervised Chats" page. Always live — this detail isn't in the
// chat_totals_daily cache, only the count is.
async function computeSupervisedChatsLive({ dateFrom, dateTo, employeeFilter }) {
  const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
  const fromDate = new Date(new Date(`${dateFrom}T00:00:00.000Z`).getTime() - ISTANBUL_OFFSET_MS);
  const toDate   = new Date(new Date(`${dateTo}T23:59:59.999Z`).getTime() - ISTANBUL_OFFSET_MS);
  const lcFrom = fromDate.toISOString().replace(/\.\d{3}Z$/, ".000000+00:00");
  const lcTo   = toDate.toISOString().replace(/\.\d{3}Z$/, ".999999+00:00");

  const [allShifts, agentsRaw, weekendOverrides] = await Promise.all([
    loadShifts(),
    lcPost("list_agents", {}, LC_CONFIG_API),
    loadWeekendOverrides(),
  ]);
  const shifts = visibleShifts(allShifts);

  const agentKeyShifts = {};
  for (const s of shifts) {
    if (employeeFilter && s.employee !== employeeFilter) continue;
    const key = s.agentKey.toLowerCase().trim();
    if (!agentKeyShifts[key]) agentKeyShifts[key] = [];
    agentKeyShifts[key].push(s);
  }

  const rawAgentList = Array.isArray(agentsRaw) ? agentsRaw
    : Array.isArray(agentsRaw?.agents) ? agentsRaw.agents
    : Object.values(agentsRaw || {}).find(v => Array.isArray(v)) || [];

  const agentKeyToEmail = {};
  for (const a of rawAgentList) {
    const low = a.name.toLowerCase().trim();
    const fst = low.split(" ")[0];
    for (const key of Object.keys(agentKeyShifts)) {
      if ((low === key || fst === key) && !agentKeyToEmail[key]) {
        agentKeyToEmail[key] = a.id;
      }
    }
  }

  function getIstHour(chatTime) {
    if (!chatTime) return 0;
    return ((new Date(chatTime).getTime() + ISTANBUL_OFFSET_MS) / 3600000) % 24;
  }
  function istDayKey(ms) {
    return new Date(ms + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
  }

  // First note left by someone other than the chat's own agent — same "someone else
  // stepped in" rule as computeChatTotals()'s hasSupervisorNote.
  function findSupervisorNote(events, users, key) {
    const note = events.find(e => {
      if (!e.text || !(e.visibility === "agents" || e.type === "annotation")) return false;
      const author = users.find(u => u.id === e.author_id);
      const authorName = (author?.name || "").toLowerCase().trim();
      if (!authorName) return false;
      return authorName !== key && authorName.split(" ")[0] !== key;
    });
    if (!note) return null;
    const author = users.find(u => u.id === note.author_id);
    return { author: author?.name || "Supervisor", text: note.text };
  }

  const results = [];

  async function fetchAgentChats(key, shiftList) {
    const agentEmail = agentKeyToEmail[key];
    if (!agentEmail) return;

    const uniqueEmpsForKey = [...new Set(shiftList.map(s => s.employee))];
    const isShared = uniqueEmpsForKey.length > 1;

    let pid = null;
    do {
      const body = pid
        ? { page_id: pid }
        : { filters: { from: lcFrom, to: lcTo, agents: { values: [agentEmail] } }, limit: 100 };
      const data = await lcPost("list_archives", body);
      pid = data.next_page_id || null;

      for (const c of data.chats || []) {
        const thread = c.thread || (c.threads?.[0]) || {};
        const users = c.users || [];
        const events = thread.events || [];
        const chatTime = thread.created_at || null;
        const istHour = getIstHour(chatTime);

        const chatAgents = allAgentsInThread(events, users, shifts, chatTime);
        const agentInChat = chatAgents.some(a => {
          const n = (a.name || "").toLowerCase().trim();
          return n === key || n.split(" ")[0] === key;
        });
        if (!agentInChat) continue;

        const note = findSupervisorNote(events, users, key);
        if (!note) continue;

        const dayKey = istDayKey(new Date(chatTime).getTime());
        const overrideEmp = findOverrideEmployee(weekendOverrides, "livechat", dayKey, istHour, uniqueEmpsForKey);

        let empName = null;
        if (overrideEmp) {
          empName = overrideEmp;
        } else if (isShared) {
          const matched = shiftList.find(s => istHour >= s.start && istHour < s.end);
          empName = (matched || shiftList[0]).employee;
        } else {
          const inShift = shiftList.some(s => istHour >= s.start && istHour < s.end);
          if (!inShift) continue;
          empName = uniqueEmpsForKey[0];
        }

        const agentInfo = chatAgents.find(a => {
          const n = (a.name || "").toLowerCase().trim();
          return n === key || n.split(" ")[0] === key;
        });
        results.push({
          platform: "livechat",
          chat_id: c.id,
          thread_id: thread.id || null,
          employee: empName,
          agent_name: agentInfo?.name || key,
          date: chatTime,
          reviewed_by: note.author,
          note: note.text,
        });
      }
    } while (pid);
  }

  async function fetchChatwoot() {
    if (!chatwootEnabled()) return;
    try {
      const cwFilter = [
        { attribute_key: "status", filter_operator: "equal_to", values: ["resolved"], query_operator: "AND" },
        { attribute_key: "created_at", filter_operator: "is_greater_than", values: [cwFilterDateFrom(lcFrom)], query_operator: "AND" },
        { attribute_key: "created_at", filter_operator: "is_less_than", values: [cwFilterDateTo(lcTo)], query_operator: null },
      ];
      let cwPage = 1, cwAll = [], cwTotal = 0;
      while (true) {
        const d = await cwPost("/conversations/filter", { payload: cwFilter }, { page: cwPage });
        const inner = d.data || d;
        const convs = inner.payload || inner.conversations || [];
        if (cwPage === 1) cwTotal = inner.meta?.all_count ?? inner.meta?.total_count ?? convs.length;
        if (!convs.length) break;
        cwAll = cwAll.concat(convs);
        if (convs.length < 25 || cwAll.length >= cwTotal) break;
        cwPage++;
      }
      const fromMs = new Date(lcFrom).getTime();
      const toMs   = new Date(lcTo).getTime();
      cwAll = cwAll.filter(c => {
        const ms = (c.created_at || 0) * 1000;
        return ms >= fromMs && ms <= toMs;
      });

      const matched = [];
      for (const conv of cwAll) {
        const assignee = conv.meta?.assignee || null;
        if (!assignee) continue;
        const aEmail = (assignee.email || "").toLowerCase().trim();
        const aName  = (assignee.name  || "").toLowerCase().trim();
        const ms = shifts.find(s => {
          if (employeeFilter && s.employee !== employeeFilter) return false;
          if (!s.chatwootAgentId) return false;
          const cwId = s.chatwootAgentId.toLowerCase().trim();
          return cwId === aEmail || cwId === aName || cwId.split("@")[0] === aName;
        });
        if (!ms) continue;
        matched.push({ id: conv.id, employee: ms.employee, assigneeId: assignee.id, assigneeName: assignee.name, createdAt: conv.created_at });
      }

      await Promise.all(matched.map(async ({ id, employee, assigneeId, assigneeName, createdAt }) => {
        try {
          const release = await cwAcquire();
          let msgData;
          try { msgData = await cwGet(`/conversations/${id}/messages`); } finally { release(); }
          const msgs = msgData.payload || msgData || [];
          const note = Array.isArray(msgs) ? msgs.find(m => m.private === true && String(m.sender?.id) !== String(assigneeId)) : null;
          if (note) {
            results.push({
              platform: "chatwoot",
              chat_id: id,
              thread_id: id,
              employee,
              agent_name: assigneeName,
              date: createdAt ? new Date(createdAt * 1000).toISOString() : null,
              reviewed_by: note.sender?.name || "Supervisor",
              note: note.content || "",
            });
          }
        } catch (e) { console.error(`[supervised-chats] cw private-note check failed for ${id}:`, e.message); }
      }));
    } catch (e) { console.error("[supervised-chats] Chatwoot error:", e.message); }
  }

  await Promise.all([
    Promise.all(Object.entries(agentKeyShifts).map(([key, shiftList]) => fetchAgentChats(key, shiftList))),
    fetchChatwoot(),
  ]);

  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { date_from: dateFrom, date_to: dateTo, chats: results };
}

app.get("/api/reports/supervised-chats", authMiddleware, requirePermission("page:report-supervised-chats"), async (req, res) => {
  try {
    const { date_from, date_to, employee } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    const result = await computeSupervisedChatsLive({ dateFrom: date_from, dateTo: date_to, employeeFilter: employee || null });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Saved report snapshots — lets Total Chats / Campaign Impact results be saved and
// re-downloaded later without re-running the (slow) live LiveChat/Chatwoot fetch.
app.post("/api/saved-reports", authMiddleware, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured" });
    const { type, label, params, data } = req.body || {};
    if (!type || !label || !data) return res.status(400).json({ error: "type, label and data are required" });
    const r = await pool.query(
      "INSERT INTO saved_reports (type, label, params, data, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, type, label, params, created_by, created_at",
      [type, label, JSON.stringify(params || {}), JSON.stringify(data), req.user.username]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/saved-reports", authMiddleware, async (req, res) => {
  try {
    if (!pool) return res.json([]);
    const { type } = req.query;
    const r = type
      ? await pool.query("SELECT id, type, label, params, created_by, created_at FROM saved_reports WHERE type=$1 ORDER BY created_at DESC", [type])
      : await pool.query("SELECT id, type, label, params, created_by, created_at FROM saved_reports ORDER BY created_at DESC");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/saved-reports/:id", authMiddleware, async (req, res) => {
  try {
    if (!pool) return res.status(404).json({ error: "No database configured" });
    const r = await pool.query("SELECT * FROM saved_reports WHERE id=$1", [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/saved-reports/:id", authMiddleware, requirePermission("action:manage_reports"), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured" });
    await pool.query("DELETE FROM saved_reports WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compare a baseline period (e.g. previous month) against a current period, with a
// campaign start/end window splitting the current period into pre/during/post buckets.
app.get("/api/reports/campaign-impact", authMiddleware, requirePermission("page:report-campaign"), async (req, res) => {
  try {
    const { baseline_from, baseline_to, current_from, current_to, campaign_start, campaign_end } = req.query;
    if (!baseline_from || !baseline_to || !current_from || !current_to || !campaign_start || !campaign_end) {
      return res.status(400).json({ error: "baseline_from, baseline_to, current_from, current_to, campaign_start, campaign_end required" });
    }

    // Both periods are read from the shared chat_totals_daily cache (only "today", if
    // present in either range, triggers a live fetch) — no more need to skip the
    // expensive supervised check for baseline just to save time.
    const [baseline, current] = await Promise.all([
      computeChatTotals({ dateFrom: baseline_from, dateTo: baseline_to, employeeFilter: null }),
      computeChatTotals({ dateFrom: current_from, dateTo: current_to, employeeFilter: null }),
    ]);

    const sumField = (arr, field) => arr.reduce((s, e) => s + (e[field] || 0), 0);

    const bucketOf = (date) => date < campaign_start ? "pre" : date > campaign_end ? "post" : "during";

    const emptyBucket = () => ({ livechat: 0, chatwoot: 0, days: 0 });
    const buckets = { pre: emptyBucket(), during: emptyBucket(), post: emptyBucket() };
    for (const [date, d] of Object.entries(current.daily || {})) {
      const b = buckets[bucketOf(date)];
      b.livechat += d.livechat;
      b.chatwoot += d.chatwoot;
    }
    // Count calendar days in each bucket (independent of whether chats occurred, for accurate averages)
    for (let d = new Date(`${current_from}T00:00:00Z`); d <= new Date(`${current_to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      buckets[bucketOf(key)].days++;
    }
    Object.values(buckets).forEach(b => { b.total = b.livechat + b.chatwoot; });

    const employees = current.employees.map(e => {
      const perDay = current.dailyByEmployee?.[e.name] || {};
      let duringLc = 0, duringCw = 0;
      for (const [date, d] of Object.entries(perDay)) {
        if (bucketOf(date) === "during") { duringLc += d.livechat; duringCw += d.chatwoot; }
      }
      return {
        name: e.name,
        livechat: e.livechat,
        chatwoot: e.chatwoot,
        total: e.total,
        supervised: e.supervised || 0,
        during_campaign_livechat: duringLc,
        during_campaign_chatwoot: duringCw,
        during_campaign_total: duringLc + duringCw,
      };
    }).sort((a, b) => b.during_campaign_total - a.during_campaign_total);

    res.json({
      baseline: {
        date_from: baseline_from, date_to: baseline_to,
        livechat: sumField(baseline.employees, "livechat"),
        chatwoot: sumField(baseline.employees, "chatwoot"),
        total: sumField(baseline.employees, "livechat") + sumField(baseline.employees, "chatwoot"),
      },
      current: {
        date_from: current_from, date_to: current_to,
        livechat: sumField(current.employees, "livechat"),
        chatwoot: sumField(current.employees, "chatwoot"),
        total: sumField(current.employees, "livechat") + sumField(current.employees, "chatwoot"),
      },
      campaign_start,
      campaign_end,
      pre_campaign: buckets.pre,
      during_campaign: buckets.during,
      post_campaign: buckets.post,
      daily: current.daily,
      employees,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live status + today/week/month/daily chat volume per platform (LiveChat, Chatwoot).
// "Active" reflects whether the platform's API is actually reachable right now, not
// just whether credentials are configured.
app.get("/api/reports/platform-status", authMiddleware, requirePermission("page:report-platform-status"), async (req, res) => {
  try {
    const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
    const pad = (n) => String(n).padStart(2, "0");
    const nowIst = new Date(Date.now() + ISTANBUL_OFFSET_MS);
    const y = nowIst.getUTCFullYear(), m = nowIst.getUTCMonth(), d = nowIst.getUTCDate();
    const todayKey = `${y}-${pad(m + 1)}-${pad(d)}`;
    const monthFromKey = `${y}-${pad(m + 1)}-01`;
    const dow = nowIst.getUTCDay();
    const daysSinceMonday = (dow + 6) % 7;
    const weekFromKey = new Date(nowIst.getTime() - daysSinceMonday * 86400000).toISOString().slice(0, 10);

    const fromDate = new Date(new Date(`${monthFromKey}T00:00:00.000Z`).getTime() - ISTANBUL_OFFSET_MS);
    const toDate   = new Date(new Date(`${todayKey}T23:59:59.999Z`).getTime() - ISTANBUL_OFFSET_MS);
    const lcFrom = fromDate.toISOString().replace(/\.\d{3}Z$/, ".000000+00:00");
    const lcTo   = toDate.toISOString().replace(/\.\d{3}Z$/, ".999999+00:00");

    function istDayKeyLocal(ms) {
      return new Date(ms + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
    }

    function summarize(daily) {
      let today = 0, week = 0, month = 0;
      for (const [key, count] of Object.entries(daily)) {
        month += count;
        if (key >= weekFromKey) week += count;
        if (key === todayKey) today += count;
      }
      return { today, week, month };
    }

    async function fetchLiveChatStatus() {
      try {
        const daily = {};
        let pid = null;
        do {
          const body = pid ? { page_id: pid } : { filters: { from: lcFrom, to: lcTo }, limit: 100 };
          const data = await lcPost("list_archives", body);
          pid = data.next_page_id || null;
          for (const c of data.chats || []) {
            const thread = c.thread || (c.threads?.[0]) || {};
            if (!thread.created_at) continue;
            const key = istDayKeyLocal(new Date(thread.created_at).getTime());
            daily[key] = (daily[key] || 0) + 1;
          }
        } while (pid);
        return { active: true, error: null, ...summarize(daily), daily };
      } catch (e) {
        return { active: false, error: e.message, today: 0, week: 0, month: 0, daily: {} };
      }
    }

    async function fetchChatwootStatus() {
      if (!chatwootEnabled()) return { active: false, error: "Not configured", today: 0, week: 0, month: 0, daily: {} };
      try {
        const cwFilter = [
          { attribute_key: "status", filter_operator: "equal_to", values: ["resolved"], query_operator: "AND" },
          { attribute_key: "created_at", filter_operator: "is_greater_than", values: [cwFilterDateFrom(lcFrom)], query_operator: "AND" },
          { attribute_key: "created_at", filter_operator: "is_less_than", values: [cwFilterDateTo(lcTo)], query_operator: null },
        ];
        let cwPage = 1, cwAll = [], cwTotal = 0;
        while (true) {
          const d = await cwPost("/conversations/filter", { payload: cwFilter }, { page: cwPage });
          const inner = d.data || d;
          const convs = inner.payload || inner.conversations || [];
          if (cwPage === 1) cwTotal = inner.meta?.all_count ?? inner.meta?.total_count ?? convs.length;
          if (!convs.length) break;
          cwAll = cwAll.concat(convs);
          if (convs.length < 25 || cwAll.length >= cwTotal) break;
          cwPage++;
        }
        const fromMs = new Date(lcFrom).getTime();
        const toMs   = new Date(lcTo).getTime();
        const daily = {};
        for (const conv of cwAll) {
          const ms = (conv.created_at || 0) * 1000;
          if (ms < fromMs || ms > toMs) continue;
          const key = istDayKeyLocal(ms);
          daily[key] = (daily[key] || 0) + 1;
        }
        return { active: true, error: null, ...summarize(daily), daily };
      } catch (e) {
        return { active: false, error: e.message, today: 0, week: 0, month: 0, daily: {} };
      }
    }

    const [livechat, chatwoot] = await Promise.all([fetchLiveChatStatus(), fetchChatwootStatus()]);
    res.json({ month: monthFromKey.slice(0, 7), today: todayKey, week_from: weekFromKey, livechat, chatwoot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Claude API cost report (today/week/month/custom range) from real tracked usage.
// Only reflects usage logged since claude_usage tracking was added — no historical
// backfill, since actual token counts weren't recorded before that.
app.get("/api/reports/platform-costs", authMiddleware, requirePermission("page:report-platform-costs"), async (req, res) => {
  try {
    if (!pool) {
      return res.json({ tracking_since: null, today: null, week: null, month: null, custom: null, custom_range: null, daily: {}, by_purpose: {} });
    }
    const { date_from, date_to } = req.query;

    const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
    const pad = (n) => String(n).padStart(2, "0");
    const nowIst = new Date(Date.now() + ISTANBUL_OFFSET_MS);
    const y = nowIst.getUTCFullYear(), m = nowIst.getUTCMonth(), d = nowIst.getUTCDate();
    const todayKey = `${y}-${pad(m + 1)}-${pad(d)}`;
    const monthFromKey = `${y}-${pad(m + 1)}-01`;
    const dow = nowIst.getUTCDay();
    const daysSinceMonday = (dow + 6) % 7;
    const weekFromKey = new Date(nowIst.getTime() - daysSinceMonday * 86400000).toISOString().slice(0, 10);

    const rows = await pool.query(`
      SELECT (created_at AT TIME ZONE 'UTC' + INTERVAL '3 hours')::date AS day,
             purpose, model,
             SUM(input_tokens)::bigint AS input_tokens,
             SUM(output_tokens)::bigint AS output_tokens,
             COUNT(*)::int AS calls
      FROM claude_usage
      GROUP BY day, purpose, model
      ORDER BY day
    `);

    const daily = {};
    const byPurpose = {};
    let earliestDay = null;

    for (const r of rows.rows) {
      const dayKey = r.day.toISOString().slice(0, 10);
      if (!earliestDay || dayKey < earliestDay) earliestDay = dayKey;
      const inputTokens = Number(r.input_tokens), outputTokens = Number(r.output_tokens);
      const cost = calcClaudeCost(r.model, inputTokens, outputTokens);

      if (!daily[dayKey]) daily[dayKey] = { cost: 0, input_tokens: 0, output_tokens: 0, calls: 0 };
      daily[dayKey].cost += cost;
      daily[dayKey].input_tokens += inputTokens;
      daily[dayKey].output_tokens += outputTokens;
      daily[dayKey].calls += r.calls;

      if (!byPurpose[r.purpose]) byPurpose[r.purpose] = { cost: 0, calls: 0 };
      byPurpose[r.purpose].cost += cost;
      byPurpose[r.purpose].calls += r.calls;
    }

    function sumRange(fromKey, toKey) {
      let cost = 0, calls = 0, inputTokens = 0, outputTokens = 0;
      for (const [day, dd] of Object.entries(daily)) {
        if (day >= fromKey && day <= toKey) {
          cost += dd.cost; calls += dd.calls; inputTokens += dd.input_tokens; outputTokens += dd.output_tokens;
        }
      }
      return { cost, calls, input_tokens: inputTokens, output_tokens: outputTokens };
    }

    res.json({
      tracking_since: earliestDay,
      today: sumRange(todayKey, todayKey),
      week: sumRange(weekFromKey, todayKey),
      month: sumRange(monthFromKey, todayKey),
      custom: (date_from && date_to) ? sumRange(date_from, date_to) : null,
      custom_range: (date_from && date_to) ? { from: date_from, to: date_to } : null,
      daily,
      by_purpose: byPurpose,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Agent Activity (online/closed hours) — cached in agent_activity_daily ─────
// Past days are read from the DB only (populated by the nightly 1am job below);
// "today" is always re-fetched live from LiveChat and upserted, since it's still
// accumulating. This avoids hitting the LiveChat API for every report view.

const AGENT_ACTIVITY_ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

function istLocalToUtcIso(dayKey, hour) {
  const localMidnightUtcMs = new Date(`${dayKey}T00:00:00.000Z`).getTime() - AGENT_ACTIVITY_ISTANBUL_OFFSET_MS;
  return new Date(localMidnightUtcMs + hour * 3600000).toISOString();
}

function istTodayKey() {
  return new Date(Date.now() + AGENT_ACTIVITY_ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

async function buildAgentKeyToEmail() {
  const agentsRaw = await lcPost("list_agents", {}, LC_CONFIG_API);
  const rawAgentList = Array.isArray(agentsRaw) ? agentsRaw
    : Array.isArray(agentsRaw?.agents) ? agentsRaw.agents
    : Object.values(agentsRaw || {}).find(v => Array.isArray(v)) || [];
  const agentKeyToEmail = {};
  for (const a of rawAgentList) {
    const low = a.name.toLowerCase().trim();
    const fst = low.split(" ")[0];
    if (!agentKeyToEmail[low]) agentKeyToEmail[low] = a.id;
    if (!agentKeyToEmail[fst]) agentKeyToEmail[fst] = a.id;
  }
  return agentKeyToEmail;
}

async function upsertAgentActivityDay(employee, date, onlineHours, closedHours) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO agent_activity_daily (employee, date, online_hours, closed_hours, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (employee, date) DO UPDATE SET online_hours=$3, closed_hours=$4, updated_at=NOW()`,
      [employee, date, onlineHours, closedHours]
    );
  } catch (e) { console.error(`[agent_activity_daily] upsert failed for ${employee} ${date}:`, e.message); }
}

async function loadAgentActivityRangeFromDB(dateFrom, dateTo, employeeFilter) {
  if (!pool) return {};
  try {
    const params = [dateFrom, dateTo];
    let q = "SELECT employee, date, online_hours, closed_hours FROM agent_activity_daily WHERE date >= $1 AND date <= $2";
    if (employeeFilter) { params.push(employeeFilter); q += " AND employee = $3"; }
    const r = await pool.query(q, params);
    const out = {};
    for (const row of r.rows) {
      if (!out[row.employee]) out[row.employee] = {};
      out[row.employee][row.date] = { onlineHours: +row.online_hours, closedHours: +row.closed_hours };
    }
    return out;
  } catch (e) { console.error("[agent_activity_daily] load failed:", e.message); return {}; }
}

async function markAgentActivityDayCached(dateKey) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO agent_activity_cached_days (date, computed_at) VALUES ($1, NOW())
       ON CONFLICT (date) DO UPDATE SET computed_at = NOW()`,
      [dateKey]
    );
  } catch (e) { console.error(`[agent_activity_cached_days] mark failed for ${dateKey}:`, e.message); }
}

async function getAgentActivityCachedDays(dateFrom, dateTo) {
  if (!pool) return new Set();
  try {
    const r = await pool.query("SELECT date FROM agent_activity_cached_days WHERE date >= $1 AND date <= $2", [dateFrom, dateTo]);
    return new Set(r.rows.map((row) => row.date));
  } catch (e) { console.error("[agent_activity_cached_days] load failed:", e.message); return new Set(); }
}

// Live-fetch one day's real availability for the given shifts and upsert into the DB.
// Returns { employee: { onlineHours, closedHours } } for that single day.
async function computeAndStoreAgentActivityDay(dateKey, shiftsToCompute, agentKeyToEmail) {
  const result = {};
  const tasks = shiftsToCompute.map((s) => (async () => {
    const agentEmail = agentKeyToEmail[s.agentKey.toLowerCase().trim()];
    if (!agentEmail) return;
    const from = istLocalToUtcIso(dateKey, s.start);
    const to = istLocalToUtcIso(dateKey, s.end);
    try {
      // agents/performance's accepting/not_accepting/logged_in_time fields always
      // fill the entire queried window (they don't reflect true presence at all —
      // confirmed by testing an agent known to be absent, which still showed ~the
      // full window as "not accepting"). agents/availability is the endpoint that
      // actually measures real online/session time, so use that instead.
      const data = await lcPost("availability", {
        distribution: "day",
        filters: { from, to, agents: { values: [agentEmail] } },
      }, LC_REPORTS_AGENTS_API);
      const shiftDurationHours = s.end - s.start;
      const onlineHours = Math.min(shiftDurationHours, data?.total || 0);
      const closedHours = Math.max(0, shiftDurationHours - onlineHours);
      if (!result[s.employee]) result[s.employee] = { onlineHours: 0, closedHours: 0 };
      result[s.employee].onlineHours += onlineHours;
      result[s.employee].closedHours += closedHours;
    } catch (e) {
      console.error(`[agent-activity] ${s.employee} ${dateKey} failed:`, e.message);
    }
  })());
  await Promise.all(tasks);
  await Promise.all(Object.entries(result).map(([employee, d]) => upsertAgentActivityDay(employee, dateKey, d.onlineHours, d.closedHours)));
  await markAgentActivityDayCached(dateKey);
  return result;
}

// Per-employee, per-day: hours logged in and hours with chat-accepting closed,
// scoped to each employee's own shift window (so shared LiveChat logins split
// correctly by time-of-day, same as the rest of the app).
async function computeAgentActivity({ dateFrom, dateTo, employeeFilter }) {
  const allShifts = await loadShifts();
  const shifts = visibleShifts(allShifts);
  const relevantShifts = employeeFilter ? shifts.filter(s => s.employee === employeeFilter) : shifts;

  const days = [];
  for (let d = new Date(`${dateFrom}T00:00:00Z`); d <= new Date(`${dateTo}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  // Any day not yet cached gets live-fetched here (same as "today" always does) —
  // no manual backfill required. Always computed for EVERY visible employee (not just
  // employeeFilter's subset), otherwise marking the day "cached" here would wrongly
  // cause other employees' data for that day to be silently skipped forever.
  const todayKey = istTodayKey();
  const cachedDays = await getAgentActivityCachedDays(dateFrom, dateTo);
  const daysToFetch = days.filter((d) => d === todayKey || !cachedDays.has(d));
  if (daysToFetch.length && shifts.length) {
    const agentKeyToEmail = await buildAgentKeyToEmail();
    const weekendOverrides = await loadWeekendOverrides();
    // Same as chat totals: one day's persistent failure shouldn't take down the whole
    // report — it just stays uncached and gets retried on the next search.
    await Promise.all(daysToFetch.map((d) =>
      computeAndStoreAgentActivityDay(d, shiftsForDate(shifts, weekendOverrides, d, "livechat"), agentKeyToEmail).catch((e) => console.error(`[agent-activity] failed to fetch ${d}:`, e.message))
    ));
  }

  const dbData = await loadAgentActivityRangeFromDB(dateFrom, dateTo, employeeFilter);

  const employeeNames = [...new Set(relevantShifts.map(s => s.employee))].sort((a, b) => a.localeCompare(b));
  const employees = employeeNames.map((name) => {
    const byDay = dbData[name] || {};
    const daysArr = days.map((date) => ({
      date,
      onlineHours: +(byDay[date]?.onlineHours ?? 0).toFixed(2),
      closedHours: +(byDay[date]?.closedHours ?? 0).toFixed(2),
    }));
    const totalOnline = daysArr.reduce((s, d) => s + d.onlineHours, 0);
    const totalClosed = daysArr.reduce((s, d) => s + d.closedHours, 0);
    return { name, days: daysArr, totalOnline: +totalOnline.toFixed(2), totalClosed: +totalClosed.toFixed(2) };
  });

  return { date_from: dateFrom, date_to: dateTo, employees };
}

// Nightly job: finalize "yesterday" (now fully complete) for every visible shift,
// so the DB has a permanent, accurate record without anyone needing to view the
// report that day. Runs at 1am Istanbul time — 1 hour after the day actually ends,
// to avoid any clock-skew edge cases right at midnight.
cron.schedule("0 1 * * *", () => runLcBackground(async () => {
  const yesterdayKey = new Date(Date.now() + AGENT_ACTIVITY_ISTANBUL_OFFSET_MS - 24 * 3600000).toISOString().slice(0, 10);

  try {
    console.log(`[agent-activity-cron] finalizing ${yesterdayKey}...`);
    const allShifts = visibleShifts(await loadShifts());
    if (allShifts.length) {
      const agentKeyToEmail = await buildAgentKeyToEmail();
      const weekendOverrides = await loadWeekendOverrides();
      const result = await computeAndStoreAgentActivityDay(yesterdayKey, shiftsForDate(allShifts, weekendOverrides, yesterdayKey, "livechat"), agentKeyToEmail);
      console.log(`[agent-activity-cron] finalized ${yesterdayKey} for ${Object.keys(result).length} employees`);
    }
  } catch (e) { console.error("[agent-activity-cron] failed:", e.message); }

  try {
    console.log(`[chat-totals-cron] finalizing ${yesterdayKey}...`);
    const result = await computeAndStoreChatTotalsDay(yesterdayKey);
    console.log(`[chat-totals-cron] finalized ${yesterdayKey} for ${result.employees.length} employees`);
  } catch (e) { console.error("[chat-totals-cron] failed:", e.message); }
}), { timezone: "Europe/Istanbul" });

app.get("/api/reports/agent-activity", authMiddleware, requirePermission("page:report-agent-activity"), async (req, res) => {
  try {
    const { date_from, date_to, employee } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    const result = await computeAgentActivity({ dateFrom: date_from, dateTo: date_to, employeeFilter: employee || null });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// In-memory progress trackers for the two backfill jobs below. A wide date range
// (many months) can take minutes to finish because of the LiveChat concurrency
// cap — holding the HTTP request open that long gets killed by Railway's proxy
// ("upstream error", not valid JSON) before Express ever responds. So the route
// now responds immediately once the job is kicked off, and the frontend polls
// the matching /status endpoint instead of awaiting one giant request.
const backfillJobs = { agentActivity: null, totalChats: null, groupTotals: null };

// One-time (or occasional) backfill: live-fetch every day in the range for every
// visible employee and upsert into agent_activity_daily. Use this to seed history
// that predates the nightly cron — normal report reads never need this since past
// days are cache-only.
app.post("/api/reports/agent-activity/backfill", authMiddleware, requirePermission("action:backfill"), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured" });
    const { date_from, date_to } = req.body || {};
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    if (backfillJobs.agentActivity?.running) {
      return res.json({ started: false, already_running: true });
    }

    const allShifts = visibleShifts(await loadShifts());
    if (!allShifts.length) return res.json({ started: true, days_total: 0 });
    const agentKeyToEmail = await buildAgentKeyToEmail();
    const weekendOverrides = await loadWeekendOverrides();

    const days = [];
    for (let d = new Date(`${date_from}T00:00:00Z`); d <= new Date(`${date_to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }

    const job = { running: true, daysTotal: days.length, daysDone: 0, employees: new Set() };
    backfillJobs.agentActivity = job;
    res.json({ started: true, days_total: days.length });

    // Run every day concurrently, through the background LiveChat pool — kept
    // separate from the interactive pool so a big backfill can't starve normal
    // report searches / the Employees agent list while it runs.
    runLcBackground(() => Promise.all(days.map((day) =>
      computeAndStoreAgentActivityDay(day, shiftsForDate(allShifts, weekendOverrides, day, "livechat"), agentKeyToEmail)
        .then((result) => {
          Object.keys(result).forEach((e) => job.employees.add(e));
          job.daysDone++;
          console.log(`[agent-activity-backfill] ${day} done (${Object.keys(result).length} employees) [${job.daysDone}/${job.daysTotal}]`);
        })
        .catch((e) => { job.daysDone++; console.error(`[agent-activity-backfill] ${day} failed:`, e.message); })
    ))).then(() => { job.running = false; console.log(`[agent-activity-backfill] finished: ${job.daysTotal} days, ${job.employees.size} employees`); });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/reports/agent-activity/backfill/status", authMiddleware, requirePermission("action:backfill"), (req, res) => {
  const job = backfillJobs.agentActivity;
  if (!job) return res.json({ running: false });
  res.json({ running: job.running, days_total: job.daysTotal, days_done: job.daysDone, employees: job.employees.size });
});

// One-time (or occasional) backfill for chat_totals_daily — seeds history for
// Total Chats / Campaign Impact that predates the nightly cron.
app.post("/api/reports/total-chats/backfill", authMiddleware, requirePermission("action:backfill"), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured" });
    const { date_from, date_to } = req.body || {};
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    if (backfillJobs.totalChats?.running) {
      return res.json({ started: false, already_running: true });
    }

    const days = [];
    for (let d = new Date(`${date_from}T00:00:00Z`); d <= new Date(`${date_to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }

    const job = { running: true, daysTotal: days.length, daysDone: 0, employees: new Set() };
    backfillJobs.totalChats = job;
    res.json({ started: true, days_total: days.length });

    runLcBackground(() => Promise.all(days.map((day) =>
      computeAndStoreChatTotalsDay(day)
        .then((result) => {
          result.employees.forEach((e) => job.employees.add(e.name));
          job.daysDone++;
          console.log(`[total-chats-backfill] ${day} done (${result.employees.length} employees) [${job.daysDone}/${job.daysTotal}]`);
        })
        .catch((e) => { job.daysDone++; console.error(`[total-chats-backfill] ${day} failed:`, e.message); })
    ))).then(() => { job.running = false; console.log(`[total-chats-backfill] finished: ${job.daysTotal} days, ${job.employees.size} employees`); });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/reports/total-chats/backfill/status", authMiddleware, requirePermission("action:backfill"), (req, res) => {
  const job = backfillJobs.totalChats;
  if (!job) return res.json({ running: false });
  res.json({ running: job.running, days_total: job.daysTotal, days_done: job.daysDone, employees: job.employees.size });
});

// Dashboard stats for current month — independent of Chat Review page
app.get("/api/dashboard-stats", authMiddleware, requirePermission("page:dashboard"), async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    // Match frontend iranDayToUtc: use Istanbul UTC+3 offset (same as getTehranHour)
    const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
    const fromDate = new Date(new Date(`${month}-01T00:00:00.000Z`).getTime() - ISTANBUL_OFFSET_MS);
    const toDate   = new Date(new Date(`${month}-${String(lastDay).padStart(2,"0")}T23:59:59.999Z`).getTime() - ISTANBUL_OFFSET_MS);
    const lcFrom = fromDate.toISOString().replace(/\.\d{3}Z$/, ".000000+00:00");
    const lcTo   = toDate.toISOString().replace(/\.\d{3}Z$/, ".999999+00:00");

    const [reviews, allShifts, agentsRaw, weekendOverrides] = await Promise.all([
      loadReviews(),
      loadShifts(),
      lcPost("list_agents", {}, LC_CONFIG_API),
      loadWeekendOverrides(),
    ]);
    const shifts = visibleShifts(allShifts);

    // Build agentKey → [shifts] (may have multiple employees for shared accounts)
    const agentKeyShifts = {};
    for (const s of shifts) {
      const key = s.agentKey.toLowerCase().trim();
      if (!agentKeyShifts[key]) agentKeyShifts[key] = [];
      agentKeyShifts[key].push(s);
    }

    // Build agentKey → LC email from list_agents
    const rawAgentList = Array.isArray(agentsRaw) ? agentsRaw
      : Array.isArray(agentsRaw?.agents) ? agentsRaw.agents
      : Object.values(agentsRaw || {}).find(v => Array.isArray(v)) || [];

    const agentKeyToEmail = {};
    for (const a of rawAgentList) {
      const low = a.name.toLowerCase().trim();
      const fst = low.split(" ")[0];
      for (const key of Object.keys(agentKeyShifts)) {
        if ((low === key || fst === key) && !agentKeyToEmail[key]) {
          agentKeyToEmail[key] = a.id;
        }
      }
    }

    // Use Istanbul UTC+3 to match frontend getTehranHour("Europe/Istanbul")
    function getIstHour(chatTime) {
      if (!chatTime) return 0;
      return ((new Date(chatTime).getTime() + ISTANBUL_OFFSET_MS) / 3600000) % 24;
    }

    // name → employee (first match, for review attribution)
    function toEmp(agentName) {
      if (!agentName) return null;
      const low = agentName.toLowerCase().trim();
      const fst = low.split(" ")[0];
      const s = shifts.find(s => s.agentKey === low || s.agentKey === fst);
      return s ? s.employee : null;
    }

    const emp = {};
    let cwCount = 0;

    // Per-agent approach matching Chat Review's applyEmployeeHourFilter exactly:
    // fetch each agent's chats via LC filter, run allAgentsInThread, apply shift-hour check.
    // Each agent's fetch runs concurrently (bounded by the shared lcAcquire limiter).
    async function fetchDashAgentChats(key, shiftList) {
      const agentEmail = agentKeyToEmail[key];
      if (!agentEmail) {
        console.log(`[dashboard] no LC agent for key: ${key} (${shiftList.map(s => s.employee).join("/")})`);
        return;
      }

      const uniqueEmpsForKey = [...new Set(shiftList.map(s => s.employee))];
      uniqueEmpsForKey.forEach(n => { if (!emp[n]) emp[n] = { total: 0, reviewed: 0, scores: [], resolved: 0 }; });
      const isShared = uniqueEmpsForKey.length > 1;

      let pid = null;
      do {
        const body = pid
          ? { page_id: pid }
          : { filters: { from: lcFrom, to: lcTo, agents: { values: [agentEmail] } }, limit: 100 };
        const data = await lcPost("list_archives", body);
        pid = data.next_page_id || null;

        for (const c of data.chats || []) {
          const thread = c.thread || (c.threads?.[0]) || {};
          const users = c.users || [];
          const events = thread.events || [];
          const chatTime = thread.created_at || null;
          const istHour = getIstHour(chatTime);

          const chatAgents = allAgentsInThread(events, users, shifts, chatTime);
          const agentInChat = chatAgents.some(a => {
            const n = (a.name || "").toLowerCase().trim();
            return n === key || n.split(" ")[0] === key;
          });
          if (!agentInChat) continue;

          const dayKey = istDayKeyFromIso(chatTime);
          const overrideEmp = findOverrideEmployee(weekendOverrides, "livechat", dayKey, istHour, uniqueEmpsForKey);

          if (overrideEmp) {
            emp[overrideEmp].total++;
          } else if (isShared) {
            const matched = shiftList.find(s => istHour >= s.start && istHour < s.end);
            const empName = (matched || shiftList[0]).employee;
            emp[empName].total++;
          } else {
            const inShift = shiftList.some(s => istHour >= s.start && istHour < s.end);
            if (!inShift) continue;
            emp[uniqueEmpsForKey[0]].total++;
          }
        }
      } while (pid);
    }

    async function fetchDashChatwoot() {
      if (!chatwootEnabled()) return;
      try {
        const cwFilter = [
          { attribute_key: "status", filter_operator: "equal_to", values: ["resolved"], query_operator: "AND" },
          { attribute_key: "created_at", filter_operator: "is_greater_than", values: [cwFilterDateFrom(lcFrom)], query_operator: "AND" },
          { attribute_key: "created_at", filter_operator: "is_less_than", values: [cwFilterDateTo(lcTo)], query_operator: null },
        ];
        let cwPage = 1, cwAll = [], cwTotal = 0;
        while (true) {
          const d = await cwPost("/conversations/filter", { payload: cwFilter }, { page: cwPage });
          const inner = d.data || d;
          const convs = inner.payload || inner.conversations || [];
          if (cwPage === 1) cwTotal = inner.meta?.all_count ?? inner.meta?.total_count ?? convs.length;
          if (!convs.length) break;
          cwAll = cwAll.concat(convs);
          if (convs.length < 25 || cwAll.length >= cwTotal) break;
          cwPage++;
        }
        // Fine-filter by exact UTC timestamp
        const fromMs = new Date(lcFrom).getTime();
        const toMs   = new Date(lcTo).getTime();
        cwAll = cwAll.filter(c => {
          const ms = (c.created_at || 0) * 1000;
          return ms >= fromMs && ms <= toMs;
        });
        cwCount = cwAll.length;
        for (const conv of cwAll) {
          const assignee = conv.meta?.assignee || null;
          if (!assignee) continue;
          const aEmail = (assignee.email || "").toLowerCase().trim();
          const aName  = (assignee.name  || "").toLowerCase().trim();
          const ms = shifts.find(s => {
            if (!s.chatwootAgentId) return false;
            const cwId = s.chatwootAgentId.toLowerCase().trim();
            return cwId === aEmail || cwId === aName || cwId.split("@")[0] === aName;
          });
          if (!ms) continue;
          const n = ms.employee;
          if (!emp[n]) emp[n] = { total: 0, reviewed: 0, scores: [], resolved: 0 };
          emp[n].total++;
        }
      } catch (e) { console.error("[dashboard] Chatwoot error:", e.message); }
    }

    const [firstPageResult] = await Promise.all([
      lcPost("list_archives", { filters: { from: lcFrom, to: lcTo }, limit: 1 }),
      Promise.all(Object.entries(agentKeyShifts).map(([key, shiftList]) => fetchDashAgentChats(key, shiftList))),
      fetchDashChatwoot(),
    ]);
    let totalChats = (firstPageResult.found_chats ?? firstPageResult.total_chats ?? 0) + cwCount;

    // Scores/reviews from database filtered by month
    for (const rv of Object.values(reviews)) {
      if (!rv || rv.skipped) continue;
      const chatMonth = (rv._chat_date || "").slice(0, 7);
      if (chatMonth !== month) continue;

      let empName;

      if (rv._platform === "chatwoot") {
        // Chatwoot review: _employee set at review time
        empName = rv._employee || null;
        if (!empName) continue;
        if (!emp[empName]) emp[empName] = { total: 0, reviewed: 0, scores: [], resolved: 0 };
      } else {
        // LiveChat review: match via agentKey
        const agentName = rv._agent_name || "";
        const low = agentName.toLowerCase().trim();
        const fst = low.split(" ")[0];
        const matchingShifts = shifts.filter(s => s.agentKey === low || s.agentKey === fst || s.agentKey.split(" ")[0] === fst);
        if (!matchingShifts.length) continue;
        const chatHour = rv._chat_date ? getIstHour(rv._chat_date) : -1;
        const chatDayKey = istDayKeyFromIso(rv._chat_date);
        const matchingEmps = matchingShifts.map(s => s.employee);
        const overrideEmp = chatHour >= 0 ? findOverrideEmployee(weekendOverrides, "livechat", chatDayKey, chatHour, matchingEmps) : null;
        if (overrideEmp) {
          empName = overrideEmp;
        } else if (matchingShifts.length === 1) {
          empName = matchingShifts[0].employee;
        } else {
          const matched = chatHour >= 0 ? matchingShifts.find(s => chatHour >= s.start && chatHour < s.end) : null;
          empName = (matched || matchingShifts[0]).employee;
        }
        if (!empName || !emp[empName]) continue;
      }

      const fst2 = (rv._agent_name || "").toLowerCase().trim().split(" ")[0];
      emp[empName].reviewed++;
      if (rv.per_agent_reviews) {
        const pr = Object.values(rv.per_agent_reviews).find(r =>
          r?.agent_name && (r.agent_name.toLowerCase().trim().startsWith(fst2) || fst2.startsWith(r.agent_name.toLowerCase().trim().split(" ")[0]))
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
app.post("/api/backfill-agent-names", authMiddleware, requirePermission("action:backfill"), async (req, res) => {
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
app.get("/api/agent-names", authMiddleware, requirePermission("action:backfill"), async (req, res) => {
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
      // Add show_in_chart column if it doesn't exist yet
      await pool.query("ALTER TABLE agent_shifts ADD COLUMN IF NOT EXISTS show_in_chart BOOLEAN NOT NULL DEFAULT TRUE").catch(() => {});
      const r = await pool.query("SELECT employee, agent_key, start_hour, end_hour, groups, languages, chatwoot_agent_id, show_in_chart FROM agent_shifts ORDER BY id");
      if (r.rows.length > 0) return r.rows.map(row => ({
        employee: row.employee,
        agentKey: row.agent_key,
        start: row.start_hour,
        end: row.end_hour,
        groups: Array.isArray(row.groups) ? row.groups : [],
        languages: Array.isArray(row.languages) ? row.languages : [],
        chatwootAgentId: row.chatwoot_agent_id || "",
        showInChart: row.show_in_chart !== false,
      }));
    } catch {}
  }
  try {
    const data = await fs.readFile(path.join(DATA_DIR, "agent_shifts.json"), "utf8");
    return JSON.parse(data);
  } catch { return []; }
}

// Shifts whose employee has the "Chart" checkbox unchecked in Employees — excluded
// from all cross-employee reports (Total Chats, Campaign Impact, Agent Activity,
// Dashboard, Monthly Overview), same as they're already hidden from the Dashboard chart.
function visibleShifts(shifts) {
  return shifts.filter(s => s.showInChart !== false);
}

async function saveShifts(shifts) {
  if (pool) {
    await pool.query("ALTER TABLE agent_shifts ADD COLUMN IF NOT EXISTS show_in_chart BOOLEAN NOT NULL DEFAULT TRUE").catch(() => {});
    await pool.query("TRUNCATE agent_shifts RESTART IDENTITY");
    for (const s of shifts) {
      await pool.query(
        `INSERT INTO agent_shifts (employee, agent_key, start_hour, end_hour, groups, languages, chatwoot_agent_id, show_in_chart) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
        [s.employee, s.agentKey, s.start, s.end, JSON.stringify(Array.isArray(s.groups) ? s.groups : []), JSON.stringify(Array.isArray(s.languages) ? s.languages : []), s.chatwootAgentId || "", s.showInChart !== false]
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

app.post("/api/agent-shifts", authMiddleware, requirePermission("action:manage_shifts"), async (req, res) => {
  try {
    await saveShifts(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Weekend overrides ────────────────────────────────────────────────────────
// Date-specific shift assignments that take priority over the recurring
// agent_shifts hour windows. Needed because weekend duty rotates day-to-day
// among employees, some of whom share a LiveChat login with someone else whose
// weekday shift covers different hours — a static recurring hour rule can't
// tell "Ardalan working late on this Saturday" apart from "Mahdi's usual
// evening slot" without knowing the actual date.
async function loadWeekendOverrides() {
  if (!pool) return [];
  try {
    const r = await pool.query("SELECT shift_date, employee, platform, start_hour, end_hour FROM weekend_overrides");
    return r.rows.map(row => ({ date: row.shift_date, employee: row.employee, platform: row.platform, start: row.start_hour, end: row.end_hour }));
  } catch { return []; }
}

// Given a chat's platform/date/hour, returns the employee an explicit override
// names for that exact slot, or null if no override applies (caller should
// then fall back to the normal recurring-hours logic). candidateEmployees scopes
// the lookup to whoever could plausibly own this chat's raw identity (e.g. the
// same shared agentKey) — without it, an unrelated employee's override for the
// same platform/date/hour under a DIFFERENT account would shadow the real match.
function findOverrideEmployee(weekendOverrides, platform, dayKey, hour, candidateEmployees) {
  const m = weekendOverrides.find(o => o.platform === platform && o.date === dayKey && hour >= o.start && hour < o.end && candidateEmployees.includes(o.employee));
  return m ? m.employee : null;
}

// Builds a per-day shift list for computeAndStoreAgentActivityDay: for any
// LiveChat agentKey touched by a weekend override on this date, replace ALL of
// that key's static rows with only the override-named employee(s) at their
// override hours — otherwise a shared key's other (off-duty) owner would still
// get a static-hours row and double-count/steal part of the actual worker's hours.
function shiftsForDate(staticShifts, weekendOverrides, dateKey, platform) {
  const overridesToday = weekendOverrides.filter(o => o.date === dateKey && o.platform === platform);
  if (!overridesToday.length) return staticShifts;
  const overriddenKeys = new Set();
  for (const o of overridesToday) {
    const staticRow = staticShifts.find(s => s.employee === o.employee);
    if (staticRow) overriddenKeys.add(staticRow.agentKey.toLowerCase().trim());
  }
  const result = staticShifts.filter(s => !overriddenKeys.has(s.agentKey.toLowerCase().trim()));
  for (const o of overridesToday) {
    const staticRow = staticShifts.find(s => s.employee === o.employee);
    if (staticRow) result.push({ ...staticRow, start: o.start, end: o.end });
  }
  return result;
}

app.get("/api/weekend-overrides", authMiddleware, async (req, res) => {
  try {
    res.json(await loadWeekendOverrides());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discover Telegram group IDs (call after adding bot to groups)
app.get("/api/telegram-setup", authMiddleware, requirePermission("action:debug_tools"), async (req, res) => {
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

// Refresh a single knowledge source
app.post("/api/refresh-knowledge/:source", authMiddleware, async (req, res) => {
  const { source } = req.params;
  const headers = { "User-Agent": "Mozilla/5.0" };
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    if (source === "kb") {
      const r = await fetch(GDOC_KNOWLEDGE_URL, { headers });
      if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
      kb.knowledge = await r.text();
      await fs.writeFile(path.join(DATA_DIR, "knowledge.txt"), kb.knowledge);
    } else if (source === "campaigns") {
      const r = await fetch(GSHEET_CAMPAIGNS_URL, { headers });
      if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
      kb.campaigns = await r.text();
      await fs.writeFile(path.join(DATA_DIR, "campaigns.csv"), kb.campaigns);
    } else if (source === "macros") {
      const r = await fetch(GSHEET_MACROS_URL, { headers });
      if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
      kb.macros = await r.text();
      await fs.writeFile(path.join(DATA_DIR, "macros.csv"), kb.macros);
    } else if (source === "tags") {
      const r = await fetch(GSHEET_TAGS_URL, { headers });
      if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
      kb.tags = await r.text();
      await fs.writeFile(path.join(DATA_DIR, "tags.csv"), kb.tags);
    } else if (source === "protocol") {
      await fetchProtocolDocs();
    } else if (source === "telegram") {
      await importTelegramExport();
      if (TELEGRAM_BOT_TOKEN) await pollTelegram();
      kb.telegram = await fs.readFile(path.join(DATA_DIR, "telegram_updates.txt"), "utf8").catch(() => "");
    } else {
      return res.status(400).json({ error: "Unknown source: " + source });
    }
    kb.lastFetched = new Date().toISOString();
    res.json({ ok: true, lastFetched: kb.lastFetched, knowledge: kb.knowledge.length, campaigns: kb.campaigns.length, telegram: kb.telegram.length, protocol: kb.protocol.length, macros: kb.macros.length, tags: kb.tags.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Refresh all knowledge base sources
app.post("/api/refresh-knowledge", authMiddleware, async (req, res) => {
  try {
    await loadKnowledge();
    res.json({ ok: true, lastFetched: kb.lastFetched, knowledge: kb.knowledge.length, campaigns: kb.campaigns.length, telegram: kb.telegram.length, protocol: kb.protocol.length, macros: kb.macros.length, tags: kb.tags.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Knowledge status
app.get("/api/knowledge-status", authMiddleware, (req, res) => {
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

// ── App settings (simple key/value store) ───────────────────────────────────
async function getAppSetting(key) {
  if (!pool) return null;
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key=$1", [key]);
    return r.rows[0]?.value ?? null;
  } catch (e) { console.error("[app_settings] get failed:", e.message); return null; }
}

async function setAppSetting(key, value) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, value]
  );
}

app.get("/api/settings/leave-sheet-url", authMiddleware, requirePermission("page:config"), async (req, res) => {
  try {
    const url = await getAppSetting("leave_sheet_url");
    res.json({ url: url || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/settings/leave-sheet-url", authMiddleware, requirePermission("page:config"), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured" });
    const { url } = req.body || {};
    await setAppSetting("leave_sheet_url", (url || "").trim());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Leave sheet (Google Sheets roster — cells marked "Leave") ──────────────────
// No live Google API integration — the sheet just needs to be link-shareable
// ("Anyone with the link can view"), and we read it via Sheets' built-in CSV
// export endpoint, which works unauthenticated for link-shared sheets.

// A minimal RFC-4180 CSV parser — needed because roster cells can contain
// embedded commas (e.g. "Chatwoot - Shift 10 to 18, Livechat - Shift 10 to 18"),
// which a naive comma-split would break.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // skip
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function googleSheetIdFromUrl(url) {
  const m = (url || "").match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

async function fetchLeaveSheetRows() {
  const url = await getAppSetting("leave_sheet_url");
  if (!url) return null;
  const sheetId = googleSheetIdFromUrl(url);
  if (!sheetId) throw new Error("Leave sheet URL doesn't look like a Google Sheets link");
  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
  const res = await fetch(exportUrl);
  if (!res.ok) throw new Error(`Leave sheet fetch failed: ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}

// Sheet dates are formatted M/D/YYYY (e.g. "8/31/2026") — convert to YYYY-MM-DD
// so they compare correctly against the report's date range.
function parseSheetDate(str) {
  const m = (str || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Returns { sheetEmployeeName: leaveDayCount } for cells exactly equal to "Leave"
// (case-insensitive) within [dateFrom, dateTo] inclusive. Row layout: col 0 =
// weekday, col 1 = Date, col 2+ = one column per employee (header = their name).
async function getLeaveCounts(dateFrom, dateTo) {
  const rows = await fetchLeaveSheetRows();
  if (!rows || !rows.length) return {};
  const header = rows[0];
  const employeeCols = header
    .map((name, idx) => ({ name: (name || "").trim(), col: idx }))
    .filter((c) => c.name && c.col >= 2);
  const counts = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const dateKey = parseSheetDate(row[1]);
    if (!dateKey || dateKey < dateFrom || dateKey > dateTo) continue;
    for (const { name, col } of employeeCols) {
      const cell = (row[col] || "").trim().toLowerCase();
      if (cell === "leave") counts[name] = (counts[name] || 0) + 1;
    }
  }
  return counts;
}

// Matches a sheet column header (often a first name) against an app employee
// name (which may be a fuller name) — same exact-or-first-word heuristic used
// elsewhere in this file (e.g. agentKey matching) to bridge two naming schemes.
function matchLeaveCount(leaveCounts, employeeFullName) {
  const empLow = employeeFullName.toLowerCase().trim();
  const empFirst = empLow.split(" ")[0];
  for (const [sheetName, count] of Object.entries(leaveCounts)) {
    const sLow = sheetName.toLowerCase().trim();
    const sFirst = sLow.split(" ")[0];
    if (sLow === empLow || sFirst === empFirst) return count;
  }
  return 0;
}

// Dedicated, uncached, single-pass count of unique chats by department — deliberately
// separate from computeChatTotals()/chat_totals_daily, which counts a chat once per
// employee who ever touched it (the right thing for "how many chats did X handle",
// but wrong for a department total: it would double-count a chat transferred across
// departments). Each chat here is attributed to exactly one department: whichever
// employee it ended with (final LiveChat agent, or Chatwoot's current assignee).
async function computeGroupChatTotalsLive({ dateFrom, dateTo }) {
  const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
  const fromDate = new Date(new Date(`${dateFrom}T00:00:00.000Z`).getTime() - ISTANBUL_OFFSET_MS);
  const toDate   = new Date(new Date(`${dateTo}T23:59:59.999Z`).getTime() - ISTANBUL_OFFSET_MS);
  const lcFrom = fromDate.toISOString().replace(/\.\d{3}Z$/, ".000000+00:00");
  const lcTo   = toDate.toISOString().replace(/\.\d{3}Z$/, ".999999+00:00");

  // Deliberately NOT filtered through visibleShifts() — the "Chart" checkbox in
  // Employees only means "leave this person out of the Dashboard chart / other
  // employee-performance breakdowns". Department attribution is a different
  // concern: a chat this employee closed still really happened and really
  // belongs to their department, chart-hidden or not.
  const [allShifts, lcGroupsRaw] = await Promise.all([
    loadShifts(),
    lcPost("list_groups", {}, LC_CONFIG_API),
  ]);

  const employeeGroups = {};
  for (const s of allShifts) {
    if (!employeeGroups[s.employee]) employeeGroups[s.employee] = new Set();
    (s.groups || []).forEach((g) => employeeGroups[s.employee].add(g));
  }

  // LiveChat chats carry their own routing "Group" (thread.access.group_ids) —
  // a far more reliable department signal than inferring it from whichever
  // agent happened to reply, so use it directly instead. Group names look like
  // "KYC (English)" / "Social-Trade (Farsi)" / "General" — the department is
  // whatever's before " (" (hyphens normalized to spaces to match this app's
  // "Social Trade" spelling). A few queues don't follow that naming convention
  // but are still explicitly wanted under a department (LC_GROUP_NAME_OVERRIDES);
  // anything else (ForFx/Instagram/Pay & Change/etc.) intentionally maps to null
  // — a different routing concern, not a fourth department — and chats landing
  // only in one of those fall through to "Unassigned" with the raw name shown.
  const KNOWN_DEPARTMENTS = ["General", "Social Trade", "KYC"];
  const LC_GROUP_NAME_OVERRIDES = { "Telegram": "General" };
  function deptFromLcGroupName(name) {
    if (LC_GROUP_NAME_OVERRIDES[name]) return LC_GROUP_NAME_OVERRIDES[name];
    const base = ((name || "").includes(" (") ? name.split(" (")[0] : name).replace(/-/g, " ").trim();
    return KNOWN_DEPARTMENTS.find((d) => d.toLowerCase() === base.toLowerCase()) || null;
  }
  const lcGroupList = Array.isArray(lcGroupsRaw) ? lcGroupsRaw : (lcGroupsRaw?.groups || []);
  const lcGroupNameById = Object.fromEntries(lcGroupList.map((g) => [g.id, g.name]));

  const groupCounts = {};
  const unassignedBreakdown = {}; // raw name -> { name, employee, reason, count, sampleChatIds }
  function bump(groups, meta) {
    if (groups.length) {
      groups.forEach((g) => { groupCounts[g] = (groupCounts[g] || 0) + 1; });
      return;
    }
    groupCounts.Unassigned = (groupCounts.Unassigned || 0) + 1;
    const label = meta?.name || "(unknown)";
    if (!unassignedBreakdown[label]) {
      unassignedBreakdown[label] = { name: label, employee: meta?.employee || null, reason: meta?.reason || "unmatched", count: 0, sampleChatIds: [] };
    }
    unassignedBreakdown[label].count++;
    if (meta?.chatId && unassignedBreakdown[label].sampleChatIds.length < 3 && !unassignedBreakdown[label].sampleChatIds.includes(meta.chatId)) {
      unassignedBreakdown[label].sampleChatIds.push(meta.chatId);
    }
  }

  // A chat transferred between groups should count once, for whichever group it
  // ACTUALLY ended with — not once per group it ever passed through. LiveChat
  // logs every transfer as a structured "chat_transferred" system message
  // (text_vars.targets = the destination group's exact name), so the last such
  // event in the thread tells us precisely where the chat ended up. No transfer
  // at all just means it stayed in whichever group(s) it started in.
  function finalLcGroupName(thread) {
    const transfers = (thread.events || [])
      .filter((e) => e.system_message_type === "chat_transferred" && e.text_vars?.targets)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (transfers.length) return transfers[transfers.length - 1].text_vars.targets;
    const groupIds = thread.access?.group_ids || [];
    return groupIds.length ? lcGroupNameById[groupIds[0]] : null;
  }

  let lcTotal = 0;
  let pid = null;
  do {
    const body = pid ? { page_id: pid } : { filters: { from: lcFrom, to: lcTo }, limit: 100 };
    const data = await lcPost("list_archives", body);
    pid = data.next_page_id || null;
    for (const c of data.chats || []) {
      const thread = c.thread || (c.threads?.[0]) || {};
      const chatTime = thread.created_at || null;
      if (!chatTime) continue;
      lcTotal++;
      const finalGroupName = finalLcGroupName(thread);
      const dept = finalGroupName ? deptFromLcGroupName(finalGroupName) : null;
      bump(dept ? [dept] : [], { name: finalGroupName || "(no group)", employee: null, reason: finalGroupName ? "chat's final LiveChat group isn't General/Social Trade/KYC" : "chat has no LiveChat routing group", chatId: c.id });
    }
  } while (pid);

  let cwTotal = 0;
  if (chatwootEnabled()) {
    try {
      const cwFilter = [
        { attribute_key: "status", filter_operator: "equal_to", values: ["resolved"], query_operator: "AND" },
        { attribute_key: "created_at", filter_operator: "is_greater_than", values: [cwFilterDateFrom(lcFrom)], query_operator: "AND" },
        { attribute_key: "created_at", filter_operator: "is_less_than", values: [cwFilterDateTo(lcTo)], query_operator: null },
      ];
      let cwPage = 1, cwAll = [], cwGrandTotal = 0;
      while (true) {
        const d = await cwPost("/conversations/filter", { payload: cwFilter }, { page: cwPage });
        const inner = d.data || d;
        const convs = inner.payload || inner.conversations || [];
        if (cwPage === 1) cwGrandTotal = inner.meta?.all_count ?? inner.meta?.total_count ?? convs.length;
        if (!convs.length) break;
        cwAll = cwAll.concat(convs);
        if (convs.length < 25 || cwAll.length >= cwGrandTotal) break;
        cwPage++;
      }
      const fromMs = new Date(lcFrom).getTime();
      const toMs = new Date(lcTo).getTime();
      cwAll = cwAll.filter((c) => { const ms = (c.created_at || 0) * 1000; return ms >= fromMs && ms <= toMs; });
      for (const conv of cwAll) {
        const assignee = conv.meta?.assignee || null;
        if (!assignee) continue;
        cwTotal++;
        const aEmail = (assignee.email || "").toLowerCase().trim();
        const aName  = (assignee.name  || "").toLowerCase().trim();
        const matchedShift = allShifts.find((s) => {
          if (!s.chatwootAgentId) return false;
          const cwId = s.chatwootAgentId.toLowerCase().trim();
          return cwId === aEmail || cwId === aName || cwId.split("@")[0] === aName;
        });
        const employee = matchedShift ? matchedShift.employee : null;
        // Chatwoot has no per-chat department signal like LiveChat's routing group,
        // so an employee tagged with 2+ departments can't be disambiguated per-chat —
        // take just their first department, consistent with "no double counting".
        const employeeDept = employee ? [...(employeeGroups[employee] || [])][0] : null;
        bump(employeeDept ? [employeeDept] : [], { name: assignee.name || assignee.email, employee, reason: employee ? "employee has no department groups set" : "assignee didn't match any employee's Chatwoot agent id", chatId: `cw:${conv.id}` });
      }
    } catch (e) { console.error("[group-totals] Chatwoot error:", e.message); }
  }

  const groupSet = new Set(["General", "Social Trade", ...Object.keys(groupCounts).filter((g) => g !== "Unassigned")]);
  const groups = [...groupSet].sort().map((g) => ({ name: g, totalChats: groupCounts[g] || 0 }));
  if (groupCounts.Unassigned) groups.push({ name: "Unassigned", totalChats: groupCounts.Unassigned });

  const unassignedBreakdownList = Object.values(unassignedBreakdown).sort((a, b) => b.count - a.count);
  // Exposed for debugging only — LiveChat department attribution no longer does any
  // string matching (it reads the chat's own routing group directly), so the only
  // remaining raw-string match is Chatwoot's assignee -> chatwootAgentId. Lets an
  // admin visually diff a raw Chatwoot assignee name/email against what's configured.
  const knownAgentKeys = allShifts.filter((s) => s.chatwootAgentId).map((s) => ({
    agentKey: s.chatwootAgentId,
    employees: [s.employee],
  }));
  return { grandTotal: lcTotal + cwTotal, groups, unassignedBreakdown: unassignedBreakdownList, knownAgentKeys };
}

// ── Department totals cache (department_totals_daily) — same cache-past-days,
// always-refetch-today strategy as chat_totals_daily / agent_activity_daily, so
// repeat views of the same range are instant instead of re-running the full
// live LiveChat/Chatwoot pass computeGroupChatTotalsLive() does above. ────────

function istTodayKeyGroups() {
  const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
  return new Date(Date.now() + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

async function upsertDepartmentTotalsDay(dateKey, grandTotal, departmentsObj) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO department_totals_daily (date, grand_total, departments, updated_at)
       VALUES ($1,$2,$3::jsonb,NOW())
       ON CONFLICT (date) DO UPDATE SET grand_total=$2, departments=$3::jsonb, updated_at=NOW()`,
      [dateKey, grandTotal, JSON.stringify(departmentsObj)]
    );
  } catch (e) { console.error(`[department_totals_daily] upsert failed for ${dateKey}:`, e.message); }
}

async function loadDepartmentTotalsRangeFromDB(dateFrom, dateTo) {
  if (!pool) return {};
  try {
    const r = await pool.query("SELECT date, grand_total, departments FROM department_totals_daily WHERE date >= $1 AND date <= $2", [dateFrom, dateTo]);
    const out = {};
    for (const row of r.rows) out[row.date] = { grandTotal: row.grand_total, departments: row.departments || {} };
    return out;
  } catch (e) { console.error("[department_totals_daily] load failed:", e.message); return {}; }
}

async function markGroupTotalsDayCached(dateKey) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO department_totals_cached_days (date, computed_at) VALUES ($1, NOW())
       ON CONFLICT (date) DO UPDATE SET computed_at = NOW()`,
      [dateKey]
    );
  } catch (e) { console.error(`[department_totals_cached_days] mark failed for ${dateKey}:`, e.message); }
}

async function getGroupTotalsCachedDays(dateFrom, dateTo) {
  if (!pool) return new Set();
  try {
    const r = await pool.query("SELECT date FROM department_totals_cached_days WHERE date >= $1 AND date <= $2", [dateFrom, dateTo]);
    return new Set(r.rows.map((row) => row.date));
  } catch (e) { console.error("[department_totals_cached_days] load failed:", e.message); return new Set(); }
}

async function computeAndStoreGroupTotalsDay(dateKey) {
  const result = await computeGroupChatTotalsLive({ dateFrom: dateKey, dateTo: dateKey });
  const departmentsObj = Object.fromEntries(result.groups.map((g) => [g.name, g.totalChats]));
  await upsertDepartmentTotalsDay(dateKey, result.grandTotal, departmentsObj);
  await markGroupTotalsDayCached(dateKey);
  return result;
}

// Cached entry point — computeMonthlySummary() calls this one.
async function computeGroupChatTotals({ dateFrom, dateTo }) {
  const todayKey = istTodayKeyGroups();
  const days = [];
  for (let d = new Date(`${dateFrom}T00:00:00Z`); d <= new Date(`${dateTo}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  const cachedDays = await getGroupTotalsCachedDays(dateFrom, dateTo);
  const daysToFetch = days.filter((d) => d === todayKey || !cachedDays.has(d));
  if (daysToFetch.length) {
    await Promise.all(daysToFetch.map((d) =>
      computeAndStoreGroupTotalsDay(d).catch((e) => console.error(`[group-totals] failed to fetch ${d}:`, e.message))
    ));
  }

  const dbData = await loadDepartmentTotalsRangeFromDB(dateFrom, dateTo);
  let grandTotal = 0;
  const deptTotals = {};
  for (const day of Object.values(dbData)) {
    grandTotal += day.grandTotal || 0;
    for (const [dept, count] of Object.entries(day.departments || {})) {
      deptTotals[dept] = (deptTotals[dept] || 0) + count;
    }
  }

  const groupSet = new Set(["General", "Social Trade", ...Object.keys(deptTotals).filter((g) => g !== "Unassigned")]);
  const groups = [...groupSet].sort().map((g) => ({ name: g, totalChats: deptTotals[g] || 0 }));
  if (deptTotals.Unassigned) groups.push({ name: "Unassigned", totalChats: deptTotals.Unassigned });

  return { grandTotal, groups };
}

// ── Monthly Summary Report (chats by group, per-employee share, chat hours,
// availability, leave) ──────────────────────────────────────────────────────
async function computeMonthlySummary({ dateFrom, dateTo }) {
  const [chatTotals, agentActivity, allShifts, leaveCounts, groupTotals] = await Promise.all([
    computeChatTotals({ dateFrom, dateTo, employeeFilter: null }),
    computeAgentActivity({ dateFrom, dateTo, employeeFilter: null }),
    loadShifts(),
    getLeaveCounts(dateFrom, dateTo).catch((e) => { console.error("[monthly-summary] leave sheet error:", e.message); return {}; }),
    computeGroupChatTotals({ dateFrom, dateTo }),
  ]);
  const shifts = visibleShifts(allShifts);

  // An employee's department(s) is the union of "groups" across all of their
  // shift rows (an employee can have more than one shift row, e.g. different
  // hours on different platforms).
  const employeeGroups = {};
  for (const s of shifts) {
    if (!employeeGroups[s.employee]) employeeGroups[s.employee] = new Set();
    (s.groups || []).forEach((g) => employeeGroups[s.employee].add(g));
  }

  const activityByName = Object.fromEntries(agentActivity.employees.map((e) => [e.name, e]));
  const chatByName = Object.fromEntries(chatTotals.employees.map((e) => [e.name, e]));

  const employeeNames = new Set([...Object.keys(chatByName), ...Object.keys(employeeGroups)]);

  // Note: an employee's totalChats/% Share here counts every chat they ever
  // touched (matching Total Chats/Transfers) — a different, deliberately larger
  // number than the department stat cards above, which count each chat once
  // toward whichever department it ended with (see computeGroupChatTotals).
  const employees = [...employeeNames].map((name) => {
    const chat = chatByName[name] || { total: 0, durationSec: 0 };
    const activity = activityByName[name] || { totalOnline: 0, totalClosed: 0 };
    const groups = [...(employeeGroups[name] || [])];
    return {
      name,
      groups,
      totalChats: chat.total || 0,
      chatHours: +((chat.durationSec || 0) / 3600).toFixed(2),
      onlineHours: activity.totalOnline || 0,
      closedHours: activity.totalClosed || 0,
      leaveDays: matchLeaveCount(leaveCounts, name),
    };
  }).sort((a, b) => b.totalChats - a.totalChats);

  return { date_from: dateFrom, date_to: dateTo, grand_total: groupTotals.grandTotal, groups: groupTotals.groups, employees };
}

app.get("/api/reports/monthly-summary", authMiddleware, requirePermission("page:report-monthly-summary"), async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    const result = await computeMonthlySummary({ dateFrom: date_from, dateTo: date_to });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: which raw agent/assignee names in LiveChat/Chatwoot failed to resolve
// to a department, and why — always live (bypasses the department_totals_daily
// cache) so it reflects the current agent_shifts data immediately.
app.get("/api/reports/monthly-summary/debug-unassigned", authMiddleware, requirePermission("action:backfill"), async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    const result = await computeGroupChatTotalsLive({ dateFrom: date_from, dateTo: date_to });
    res.json({ grand_total: result.grandTotal, groups: result.groups, unassigned_breakdown: result.unassignedBreakdown, known_agent_keys: result.knownAgentKeys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time (or occasional) backfill: force-recompute every day in the range,
// bypassing department_totals_cached_days — needed after a logic fix, so
// already-cached days pick up the corrected attribution instead of serving
// stale numbers until "today" naturally rolls over them.
app.post("/api/reports/monthly-summary/backfill", authMiddleware, requirePermission("action:backfill"), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured" });
    const { date_from, date_to } = req.body || {};
    if (!date_from || !date_to) return res.status(400).json({ error: "date_from and date_to required" });
    if (backfillJobs.groupTotals?.running) {
      return res.json({ started: false, already_running: true });
    }

    const days = [];
    for (let d = new Date(`${date_from}T00:00:00Z`); d <= new Date(`${date_to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }

    const job = { running: true, daysTotal: days.length, daysDone: 0 };
    backfillJobs.groupTotals = job;
    res.json({ started: true, days_total: days.length });

    runLcBackground(() => Promise.all(days.map((day) =>
      computeAndStoreGroupTotalsDay(day)
        .then(() => { job.daysDone++; console.log(`[group-totals-backfill] ${day} done [${job.daysDone}/${job.daysTotal}]`); })
        .catch((e) => { job.daysDone++; console.error(`[group-totals-backfill] ${day} failed:`, e.message); })
    ))).then(() => { job.running = false; console.log(`[group-totals-backfill] finished: ${job.daysTotal} days`); });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/reports/monthly-summary/backfill/status", authMiddleware, requirePermission("action:backfill"), (req, res) => {
  const job = backfillJobs.groupTotals;
  if (!job) return res.json({ running: false });
  res.json({ running: job.running, days_total: job.daysTotal, days_done: job.daysDone });
});

// Nightly auto-review disabled — enable by uncommenting below
// ── Reports ───────────────────────────────────────────────────────────────────

// Delete all reports (admin only)
app.get("/api/reports/monthly-overview", authMiddleware, requirePermission("page:report-monthly"), async (req, res) => {
  try {
    const year = (req.query.year || new Date().getFullYear()).toString();
    const [reviews, allShifts] = await Promise.all([loadReviews(), loadShifts()]);
    const shifts = visibleShifts(allShifts);

    // agent name/key → employee name lookup
    const agentToEmp = {};
    for (const s of shifts) {
      const low = s.agentKey.toLowerCase().trim();
      agentToEmp[low] = s.employee;
      agentToEmp[low.split(" ")[0]] = s.employee;
    }

    const byMonth = {};

    for (const [, review] of Object.entries(reviews)) {
      if (!review || review.skipped || review.overall_score == null) continue;
      const chatDate = review._chat_date || null;
      if (!chatDate) continue;
      const month = chatDate.slice(0, 7);
      if (!month.startsWith(year)) continue;

      const employee =
        review._employee ||
        agentToEmp[(review._agent_name || "").toLowerCase().trim()] ||
        agentToEmp[(review._agent_name || "").toLowerCase().trim().split(" ")[0]] ||
        review._agent_name;
      if (!employee) continue;

      if (!byMonth[month]) byMonth[month] = {};
      if (!byMonth[month][employee]) byMonth[month][employee] = { sum: 0, cnt: 0, resolved: 0 };
      byMonth[month][employee].sum   += review.overall_score;
      byMonth[month][employee].cnt++;
      if (review.resolved) byMonth[month][employee].resolved++;
    }

    const months = {};
    for (const [month, empData] of Object.entries(byMonth)) {
      months[month] = Object.entries(empData)
        .map(([name, d]) => ({ name, avg: +(d.sum / d.cnt).toFixed(2), count: d.cnt, resolved: d.resolved }))
        .sort((a, b) => b.avg - a.avg);
    }

    res.json({ year, months });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/reports", authMiddleware, requirePermission("action:manage_reports"), async (req, res) => {
  try {
    await pool.query("DELETE FROM reports");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/reports/:employee/:month", authMiddleware, requirePermission("action:manage_reports"), async (req, res) => {
  try {
    await pool.query("DELETE FROM reports WHERE employee=$1 AND month=$2", [req.params.employee, req.params.month]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List reports (admin: all; employee: own)
app.get("/api/reports", authMiddleware, requirePermission("page:reports"), async (req, res) => {
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
app.patch("/api/reports/:employee/:month", authMiddleware, requirePermission("action:manage_reports"), async (req, res) => {
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
app.post("/api/reports/generate", authMiddleware, requirePermission("action:manage_reports"), async (req, res) => {
  try {
    const { employee, month } = req.body; // month = "2026-07"
    if (!employee || !month) return res.status(400).json({ error: "employee and month required" });

    const shifts = await loadShifts();
    const shift = shifts.find(s => s.employee === employee);
    if (!shift) return res.status(404).json({ error: "Employee not found in shifts" });
    const weekendOverrides = await loadWeekendOverrides();
    // Employees who share this shift's LiveChat/Chatwoot identity — an override
    // naming one of them on a given date takes priority over ALL of their static
    // hour windows, not just this report's own employee.
    const sameKeyEmployees = shifts.filter(s => s.agentKey === shift.agentKey).map(s => s.employee);
    const sameCwIdEmployees = shift.chatwootAgentId
      ? shifts.filter(s => s.chatwootAgentId && s.chatwootAgentId.toLowerCase().trim() === shift.chatwootAgentId.toLowerCase().trim()).map(s => s.employee)
      : [employee];

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

      // Filter by shift hours — an exact-date override (weekend rotation) takes
      // priority over the recurring shift.start/end window.
      const h = getTehranHourFromIso(startedAt);
      const overrideEmpLc = findOverrideEmployee(weekendOverrides, "livechat", istDayKeyFromIso(startedAt), h, sameKeyEmployees);
      const inShiftLc = overrideEmpLc ? overrideEmpLc === employee : (h >= shift.start && h < shift.end);
      if (!inShiftLc) continue;
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

    // Chatwoot reviewed chats for this employee
    // Reviews store _employee (matched employee name), _chat_date, _platform — no conv fetch needed
    if (chatwootEnabled() && shift.chatwootAgentId) {
      const cwAgentId  = shift.chatwootAgentId.toLowerCase().trim();
      const cwPrefix   = cwAgentId.split("@")[0]; // "arad" from "arad@opofinance.com"
      const empLow     = employee.toLowerCase().trim();
      const fromMs     = new Date(dateFrom).getTime();
      const toMs       = new Date(dateTo).getTime();

      for (const [key, review] of Object.entries(reviews)) {
        if (!key.startsWith("cw:")) continue;
        if (!review) continue;

        // Match this review to the employee:
        // 1. _employee field set at review time (most reliable)
        // 2. _agent_name first-word / email-prefix match (fallback)
        const rEmployee = (review._employee    || "").toLowerCase().trim();
        const rName     = (review._agent_name  || "").toLowerCase().trim();
        const rFirst    = rName.split(" ")[0];
        const isMatch   = rEmployee === empLow ||
                          rName === cwAgentId  || rName === cwPrefix ||
                          rFirst === cwPrefix  || cwPrefix === rFirst;
        if (!isMatch) continue;

        // Date range filter using _chat_date stored in the review
        const chatDate = review._chat_date || null;
        const chatMs   = chatDate ? new Date(chatDate).getTime() : 0;
        if (!chatMs || chatMs < fromMs || chatMs > toMs) continue;

        totalChats++;

        // Shift hour filter — exact-date override takes priority over the recurring window
        const h = getTehranHourFromIso(chatDate);
        const overrideEmpCw = findOverrideEmployee(weekendOverrides, "chatwoot", istDayKeyFromIso(chatDate), h, sameCwIdEmployees);
        const inShiftCw = overrideEmpCw ? overrideEmpCw === employee : (h >= shift.start && h < shift.end);
        if (!inShiftCw) continue;
        chatsInShift++;

        if (review.skipped) continue;
        reviewedChats++;
        if (review.resolved) resolvedCount++;

        const scoreMap = {
          overall: review.overall_score, response_time: review.response_time_score,
          tone: review.tone_score, accuracy: review.accuracy_score,
          resolution: review.resolution_score, compliance: review.compliance_score,
          product_knowledge: review.product_knowledge_score,
          satisfaction: review.satisfaction_score, language: review.language_score,
        };
        for (const [k, v] of Object.entries(scoreMap)) {
          if (v != null && v > 0) { sums[k] += v; cnts[k]++; }
        }

        const dayOfMonth = new Date(chatDate).getDate();
        const weekLabel  = `Week ${Math.ceil(dayOfMonth / 7)}`;
        if (!weekData[weekLabel]) weekData[weekLabel] = { sum: 0, cnt: 0 };
        if (review.overall_score != null && review.overall_score > 0) {
          weekData[weekLabel].sum += review.overall_score; weekData[weekLabel].cnt++;
        }
        const noteParts = [review.summary, review.issues, review.strengths].filter(Boolean);
        if (noteParts.length > 0) allNotes.push(noteParts.join(" | "));
      }
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
        logClaudeUsage("monthly_report", "claude-sonnet-4-6", data.usage?.input_tokens, data.usage?.output_tokens, { employee });
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

app.listen(PORT, async () => {
  console.log(`\n✓ Chat Review running at http://localhost:${PORT}\n`);
  if (chatwootEnabled()) {
    await cwSignIn();
  }
});
