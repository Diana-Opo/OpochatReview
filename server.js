import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
const { Pool } = pg;

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

async function loadReviews() {
  if (pool) {
    const res = await pool.query("SELECT chat_id, data FROM reviews");
    const obj = {};
    res.rows.forEach(r => obj[r.chat_id] = r.data);
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

function buildTranscript(events, users) {
  return events
    .filter((e) => e.text && (e.type === "message" || e.type === "annotation"))
    .map((e) => {
      const user = users.find((u) => u.id === e.author_id);
      const role = user?.type || "unknown";
      const name = user?.name || e.author_id;
      const isPrivate = e.visibility === "agents" || e.type === "annotation";
      const prefix = isPrivate ? "[SUPERVISOR NOTE] " : "";
      return `[${e.created_at || ""}] ${prefix}${name} (${role}): ${e.text}`;
    })
    .join("\n");
}

function extractSupervisorNotes(events, users) {
  return events
    .filter((e) => e.text && (e.visibility === "agents" || e.type === "annotation"))
    .map((e) => {
      const user = users.find((u) => u.id === e.author_id);
      return { author: user?.name || e.author_id, text: e.text, created_at: e.created_at };
    });
}

function buildAgentSegments(events, users) {
  const segments = {};
  const agentUsers = users.filter(u => u.type === "agent");

  // Pre-populate from public events + system_message text parsing (catches transferred-but-silent agents)
  for (const e of events) {
    const isPrivate = e.visibility === "agents" || e.type === "annotation";
    if (!isPrivate) {
      const user = users.find(u => u.id === e.author_id);
      if (user?.type === "agent" && !segments[user.id]) {
        segments[user.id] = { id: user.id, name: user.name, events: [], responded: false };
      }
    }
    if (e.type === "system_message" && e.text) {
      const lower = e.text.toLowerCase();
      for (const a of agentUsers) {
        if (!segments[a.id] && lower.includes(a.name.toLowerCase())) {
          segments[a.id] = { id: a.id, name: a.name, events: [], responded: false };
        }
      }
    }
  }

  let currentAgent = null;
  for (const e of events) {
    const isPrivate = e.visibility === "agents" || e.type === "annotation";
    if (!e.text || isPrivate) continue;

    const user = users.find(u => u.id === e.author_id);
    if (user?.type === "agent") {
      currentAgent = { id: user.id, name: user.name };
      segments[user.id].responded = true;
    }
    if (currentAgent) {
      segments[currentAgent.id].events.push(e);
    }
  }
  return segments;
}

function allAgentsInThread(events, users) {
  const seen = {};
  const agentUsers = users.filter(u => u.type === "agent");
  for (const e of events) {
    const isPrivate = e.visibility === "agents" || e.type === "annotation";
    // Detect agents from public events only (skip supervisor notes)
    if (!isPrivate) {
      const user = users.find(u => u.id === e.author_id);
      if (user?.type === "agent" && !seen[user.id]) {
        seen[user.id] = { id: user.id, name: user.name };
      }
    }
    // Parse system_message text to detect routed/transferred agents (e.g. "Chat transferred to Arta")
    if (e.type === "system_message" && e.text) {
      const lower = e.text.toLowerCase();
      for (const a of agentUsers) {
        if (!seen[a.id] && lower.includes(a.name.toLowerCase())) {
          seen[a.id] = { id: a.id, name: a.name };
        }
      }
    }
  }
  return Object.values(seen);
}

async function reviewWithClaude(transcript, chatId, chatStartedAt, supervisorNotes = [], agentName = null) {
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
    ? `\nAVAILABLE TAGS (assign ALL that apply — minimum 1 per chat. If referral was mentioned, always include "referred"):\n${kb.tags.slice(0, 2000)}\n`
    : "";

  const isPerAgent = !!agentName;
  const agentContext = isPerAgent
    ? `\nPER-AGENT REVIEW MODE: You are ONLY reviewing the performance of "${agentName}" based on their assigned portion of the chat below. Do NOT factor in what other agents did. Score ONLY what "${agentName}" did or failed to do.\n`
    : "";

  const prompt = `You are a QA reviewer for a forex broker support team. Be concise.
CHAT DATE: ${chatStartedAt || "unknown"}
${agentContext}${knowledgeSection}${campaignsSection}${telegramSection}${protocolSection}${macrosSection}${tagsSection ? (isPerAgent ? "" : tagsSection) : ""}
Score the agent on 8 criteria. Write notes in SAME language as chat (FA/EN/AR). Keep each note to 1 sentence max.

LOST CHAT RULE: If the agent's assigned portion shows customer messages but ZERO responses from the agent, it means the agent lost/abandoned the chat. In this case: response_time_score = 0, overall_score must reflect this failure heavily, and notes must clearly state the agent did not respond and lost the chat.

BROKER CONTEXT:
This broker offers 4 trading platforms: MetaTrader 4 (MT4), MetaTrader 5 (MT5), cTrader, OpoTrade, and TradingView. Each platform has its own account types (Standard, Pro, Black, etc.) with DIFFERENT specifications — same account name on different platforms is intentional and NOT a contradiction. Always consider the platform context when evaluating specs.

IMPORTANT RULES FOR ACCURACY SCORING:
- If the agent's response matches or is consistent with ANYTHING in the knowledge base OR standard macros, consider it CORRECT — do not penalize.
- Only flag accuracy errors when the agent's response clearly contradicts BOTH the knowledge base AND the macros, or contains information found in neither.
- Do NOT flag contradictions between different parts of the KB or between different macros — these are data issues, not agent errors.
- Do NOT flag different specs for same-named accounts across different platforms — this is expected.

SPECIAL RULE — ACCOUNT TYPES:
- Whenever a customer asks about account types, account options, or account comparison, the agent MUST send BOTH: (1) the general account types macro (covering MT4/MT5/cTrader/OpoTrade) AND (2) the TradingView account types macro. If either one is missing, flag it as an issue in the resolution or accuracy notes.

SUPERVISOR NOTES RULE:
- Lines marked [SUPERVISOR NOTE] in the transcript are private internal messages from supervisors (not visible to customer).
- If a supervisor note contains a correction, warning, or instruction directed at the agent's behavior in this chat, set "supervisor_warning" to true and quote the note in "supervisor_warning_text".
- Supervisor warnings must be factored into the overall assessment and flagged clearly in issues.

SLA: first response <15s=10, 15-30s=8, 30-60s=6, >60s=4. Between replies: <45s good, 45-90s warning, >90s bad.
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
      model: "claude-haiku-4-5",
      max_tokens: 800,
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
  return JSON.parse(text);
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
app.get("/api/agents", async (req, res) => {
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
app.get("/api/chats", async (req, res) => {
  try {
    const { date_from, date_to, agent_id, page_id } = req.query;
    const filters = {};
    if (date_from) filters.from = date_from;
    if (date_to) filters.to = date_to;
    if (agent_id) filters.agents = { values: [agent_id] };

    const body = page_id ? { page_id } : { filters, limit: 25 };

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
    const reviews = await loadReviews();

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
      const allAgents = allAgentsInThread(events, users);
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
app.get("/api/chats/:chatId", async (req, res) => {
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
    const reviews = await loadReviews();

    const messages = events
      .filter((e) => e.text && (e.type === "message" || e.type === "annotation"))
      .map((e) => {
        const user = users.find((u) => u.id === e.author_id);
        const isPrivate = e.visibility === "agents" || e.type === "annotation";
        return {
          author_type: isPrivate ? "supervisor" : (user?.type || "unknown"),
          author_name: user?.name || e.author_id,
          content: e.text,
          created_at: e.created_at || null,
          is_private: isPrivate,
        };
      });

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
app.post("/api/review/:chatId", async (req, res) => {
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

    const transcript = buildTranscript(events, users);
    const supervisorNotes = extractSupervisorNotes(events, users);
    const agentSegments = buildAgentSegments(events, users);
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
            return [
              agentId,
              reviewWithClaude(buildTranscript(seg.events, users), chatId, chatStartedAt, supervisorNotes, seg.name)
                .then(r => ({ ...r, agent_name: seg.name }))
                .catch(() => null)
            ];
          })
        )
      : {};

    const review = await overallPromise;
    review.reviewed_at = new Date().toISOString();

    if (agentCount > 1) {
      const perAgent = {};
      for (const [agentId, promise] of Object.entries(agentPromises)) {
        perAgent[agentId] = await promise;
      }
      review.per_agent_reviews = perAgent;
    }

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

// Debug: show exact agent names from LiveChat
app.get("/api/agent-names", async (req, res) => {
  try {
    const data = await lcPost("list_agents", {}, LC_CONFIG_API);
    let list = Array.isArray(data) ? data : data?.agents || Object.values(data).find(v => Array.isArray(v)) || [];
    res.json(list.map(a => ({ id: a.id, name: a.name, name_lower: (a.name||"").toLowerCase().trim() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agent shift mapping
app.get("/api/agent-shifts", async (req, res) => {
  try {
    const data = await fs.readFile(path.join(DATA_DIR, "agent_shifts.json"), "utf8");
    res.json(JSON.parse(data));
  } catch { res.json({}); }
});

app.post("/api/agent-shifts", async (req, res) => {
  try {
    const shifts = req.body;
    await fs.writeFile(path.join(DATA_DIR, "agent_shifts.json"), JSON.stringify(shifts, null, 2));
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
app.post("/api/refresh-knowledge", async (req, res) => {
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
app.listen(PORT, () => {
  console.log(`\n✓ Chat Review running at http://localhost:${PORT}\n`);
});
