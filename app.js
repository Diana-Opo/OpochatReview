// ── State ────────────────────────────────────────────────────────────────────
let chats = [];
let agents = [];
let nextPageId = null;
let pageHistory = [null];
let currentPage = 0;
let agentChart = null;
let totalChats = 0;
let agentShifts = [];
let allChats = [];
let activeEmployeeShift = null;
let currentUser = null; // { username, role, employee_name }

// ── Auth ──────────────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem("auth_token") || ""; }

function authFetch(url, opts = {}) {
  const token = getToken();
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
  });
}

async function doLogin() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.classList.add("hidden");
  if (!username || !password) { errEl.textContent = "Enter username and password"; errEl.classList.remove("hidden"); return; }
  const btn = document.getElementById("btnLogin");
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Login failed"; errEl.classList.remove("hidden"); return; }
    localStorage.setItem("auth_token", data.token);
    currentUser = { username: data.username, role: data.role };
    document.getElementById("loginModal").classList.add("hidden");
    initApp();
  } catch (e) {
    errEl.textContent = "Connection error"; errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Sign In";
  }
}

document.addEventListener("keydown", e => {
  if (e.key === "Enter" && !document.getElementById("loginModal").classList.contains("hidden")) doLogin();
});

async function checkAuth() {
  const token = getToken();
  if (!token) { document.getElementById("loginModal").classList.remove("hidden"); return false; }
  try {
    const res = await fetch("/api/me", { headers: { "Authorization": `Bearer ${token}` } });
    if (!res.ok) {
      localStorage.removeItem("auth_token");
      document.getElementById("loginModal").classList.remove("hidden");
      return false;
    }
    currentUser = await res.json();
    return true;
  } catch {
    document.getElementById("loginModal").classList.remove("hidden");
    return false;
  }
}

function logout() {
  authFetch("/api/logout", { method: "POST" }).catch(() => {});
  localStorage.removeItem("auth_token");
  location.reload();
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const authed = await checkAuth();
  if (!authed) return; // login modal stays visible
  document.getElementById("loginModal").classList.add("hidden");
  initApp();
});

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function initApp() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  document.getElementById("dateFrom").value = localDateStr(firstOfMonth);
  document.getElementById("dateTo").value = localDateStr(today);

  // Show logout button and hide settings if not admin
  const header = document.querySelector("header .flex.flex-wrap.items-center");
  if (header) {
    const logoutBtn = document.createElement("button");
    logoutBtn.textContent = `${currentUser.username} ↩`;
    logoutBtn.title = "Logout";
    logoutBtn.className = "text-xs text-gray-400 hover:text-red-500 px-2 py-1";
    logoutBtn.onclick = logout;
    header.appendChild(logoutBtn);
  }
  // Hide employee settings button for non-admin
  if (currentUser.role !== "admin") {
    const empBtn = document.querySelector("button[onclick='openSettings()']");
    if (empBtn) empBtn.style.display = "none";
  }

  await loadAgents();
  try { const r = await authFetch("/api/agent-shifts"); agentShifts = await r.json(); } catch {}
  renderAgentFilter();
  loadKnowledgeStatus();
  document.getElementById("btnLoad").addEventListener("click", () => loadChats(null));
  document.getElementById("btnReviewAll").addEventListener("click", reviewAllVisible);
  if (currentUser?.role !== "admin") {
    document.getElementById("btnRefreshKb").style.display = "none";
  } else {
    document.getElementById("btnRefreshKb").addEventListener("click", refreshKnowledge);
  }
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal")) closeModal();
  });
}

// ── Knowledge Base ───────────────────────────────────────────────────────────
async function loadKnowledgeStatus() {
  try {
    const res = await authFetch("/api/knowledge-status");
    const data = await res.json();
    updateKbStatus(data);
  } catch {}
}

async function refreshKnowledge() {
  const btn = document.getElementById("btnRefreshKb");
  btn.disabled = true;
  document.getElementById("kbStatus").textContent = "...";
  try {
    const res = await authFetch("/api/refresh-knowledge", { method: "POST" });
    const data = await res.json();
    updateKbStatus(data);
    showStatus("Knowledge base refreshed", "success");
  } catch (e) {
    showStatus("KB refresh failed: " + e.message, "error");
  }
  btn.disabled = false;
}

function updateKbStatus(data) {
  const kb = document.getElementById("kbStatus");
  const hasKb = data.knowledge > 0;
  const hasCamp = data.campaigns > 0;
  const hasTg = data.telegram > 0;
  const hasProt = data.protocol > 0;
  const hasMacros = data.macros > 0;
  const hasTags = data.tags > 0;
  const parts = [];
  if (hasKb) parts.push("KB✓");
  if (hasCamp) parts.push("Camp✓");
  if (hasTg) parts.push("TG✓");
  if (hasProt) parts.push("Proto✓");
  if (hasMacros) parts.push("Macros✓");
  if (hasTags) parts.push("Tags✓");
  kb.textContent = parts.length ? parts.join(" ") : "No data";
  kb.title = `Last fetched: ${data.lastFetched || "never"}\nKnowledge: ${data.knowledge} chars\nCampaigns: ${data.campaigns} chars\nTelegram: ${data.telegram} chars\nProtocol: ${data.protocol} chars`;
}

// ── Agents ────────────────────────────────────────────────────────────────────
async function loadAgents() {
  try {
    const res = await authFetch("/api/agents");
    const data = await res.json();
    if (!res.ok || data.error) {
      showStatus("Agents error: " + (data.error || res.status), "error");
      return;
    }
    agents = Array.isArray(data) ? data : [];
    renderAgentFilter();
  } catch (e) {
    showStatus("Could not load agents: " + e.message, "error");
  }
}

function renderAgentFilter() {
  const sel = document.getElementById("agentFilter");
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Employees</option>';
  const employees = (Array.isArray(agentShifts) ? [...agentShifts] : []).sort((a, b) => a.employee.localeCompare(b.employee));
  employees.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.employee;
    opt.textContent = s.employee;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function resolveEmployeeFilter() {
  const empName = document.getElementById("agentFilter").value;
  if (!empName) { activeEmployeeShift = null; return null; }
  const shift = agentShifts.find(s => s.employee === empName);
  if (!shift) { activeEmployeeShift = null; return null; }
  activeEmployeeShift = shift;
  const agent = agents.find(a => {
    const k = a.name.toLowerCase().trim();
    return k === shift.agentKey || k.split(" ")[0] === shift.agentKey;
  });
  return agent?.id || null;
}

function agentMatchesShift(agentName, shift) {
  if (!agentName || !shift) return false;
  const k = agentName.toLowerCase().trim();
  return k === shift.agentKey || k.split(" ")[0] === shift.agentKey;
}

function applyEmployeeHourFilter(list) {
  if (!activeEmployeeShift) return list;
  return list.filter(c => {
    const h = getTehranHour(c.started_at);
    if (h < activeEmployeeShift.start || h >= activeEmployeeShift.end) return false;
    // Only show chats where this employee's agent actually responded (is in chat.agents)
    const chatAgents = c.agents || [];
    return chatAgents.some(a => agentMatchesShift(a.name, activeEmployeeShift));
  });
}

// ── Chats ─────────────────────────────────────────────────────────────────────
async function loadChats(pageId) {
  document.getElementById("statusBar").classList.add("hidden");
  const from = document.getElementById("dateFrom").value;
  const to = document.getElementById("dateTo").value;
  const agentId = resolveEmployeeFilter();

  const params = new URLSearchParams();
  if (from) params.set("date_from", iranDayToUtc(from, false));
  if (to)   params.set("date_to",   iranDayToUtc(to, true));
  if (agentId) params.set("agent_id", agentId);
  if (pageId)  params.set("page_id", pageId);

  try {
    const res = await authFetch("/api/chats?" + params);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    chats = data.chats || [];
    nextPageId = data.next_page_id || null;
    totalChats = data.total_chats || chats.length;

    // Merge into allChats (reset on first page, accumulate on subsequent)
    if (!pageId) {
      allChats = [...chats];
    } else {
      const existingKeys = new Set(allChats.map(c => c.thread_id || c.id));
      chats.forEach(c => {
        const k = c.thread_id || c.id;
        if (existingKeys.has(k)) {
          const idx = allChats.findIndex(x => (x.thread_id || x.id) === k);
          if (idx !== -1) allChats[idx] = c;
        } else {
          allChats.push(c);
        }
      });
    }

    renderTable();
    updatePagination();
    document.getElementById("statusBar").classList.add("hidden");

    if (chats.length > 0 && currentUser?.role === "admin") {
      document.getElementById("btnReviewAll").classList.remove("hidden");
    }

    // Auto-fetch all remaining pages in background for complete stats
    if (!pageId && data.next_page_id) {
      setStatsLoading(true);
      setChartLoading(true);
      fetchAllPagesForStats(data.next_page_id, from, to, agentId).finally(() => {
        setStatsLoading(false);
        setChartLoading(false);
        updateStats();
        renderTable();
        updateChart();
      });
    } else {
      updateStats();
      if (!pageId) updateChart();
    }
  } catch (e) {
    showStatus("Error: " + e.message, "error");
  }
}

function setStatsLoading(on) {
  ["statTotal","statReviewed","statAvg","statResolved"].forEach(id => {
    const el = document.getElementById(id);
    if (on) el.innerHTML = `<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin align-middle"></span>`;
  });
}

function setChartLoading(on) {
  document.getElementById("chartLoading").classList.toggle("hidden", !on);
  document.getElementById("agentChart").classList.toggle("hidden", on);
}

async function fetchAllPagesForStats(startPageId, from, to, agentId) {
  let pid = startPageId;
  while (pid) {
    try {
      const p = new URLSearchParams();
      if (from) p.set("date_from", iranDayToUtc(from, false));
      if (to)   p.set("date_to",   iranDayToUtc(to, true));
      if (agentId) p.set("agent_id", agentId);
      p.set("page_id", pid);
      const res = await authFetch("/api/chats?" + p);
      const data = await res.json();
      if (data.error || !data.chats) break;
      // Merge into allChats
      data.chats.forEach(c => {
        const k = c.thread_id || c.id;
        const idx = allChats.findIndex(x => (x.thread_id || x.id) === k);
        if (idx !== -1) allChats[idx] = c; else allChats.push(c);
      });
      pid = data.next_page_id || null;
    } catch { break; }
  }
}

// ── Helpers for employee-filtered views ──────────────────────────────────────
function getAgentForShift(shift) {
  if (!shift) return null;
  return agents.find(a => {
    const k = a.name.toLowerCase().trim();
    return k === shift.agentKey || k.split(" ")[0] === shift.agentKey;
  }) || null;
}

function getPerAgentReview(review, agentName) {
  if (!review?.per_agent_reviews || !agentName) return null;
  return Object.values(review.per_agent_reviews).find(
    pr => pr?.agent_name?.toLowerCase() === agentName.toLowerCase()
  ) || null;
}

// ── Render Table ─────────────────────────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById("chatTableBody");
  const displayChats = applyEmployeeHourFilter(allChats);
  if (displayChats.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-12 text-gray-400">No chats found for this period</td></tr>`;
    return;
  }

  const filteredAgent = activeEmployeeShift ? getAgentForShift(activeEmployeeShift) : null;
  const filteredAgentName = filteredAgent?.name || null;

  const sortedChats = [...displayChats].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  tbody.innerHTML = sortedChats.map(chat => {
    const r = chat.review;
    const date = chat.started_at
      ? new Date(chat.started_at).toLocaleString("en-GB", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
      : "—";

    // When employee filter is active, show per-agent score; otherwise overall
    let displayScore = null, displayResolved = r?.resolved;
    const isSkipped = r?.skipped === true;
    if (!isSkipped && activeEmployeeShift && filteredAgentName && r) {
      const pr = getPerAgentReview(r, filteredAgentName);
      if (pr) {
        displayScore = pr.overall_score;
      } else {
        // Single-agent chat: no per_agent_reviews — fall back to overall score
        displayScore = r.overall_score ?? null;
      }
      displayResolved = r.resolved;
    } else if (!isSkipped) {
      displayScore = r?.overall_score ?? null;
    }

    const scoreBadge = isSkipped
      ? `<span class="text-xs text-gray-400 italic">No msg</span>`
      : displayScore != null ? scorePill(displayScore) : `<span class="text-gray-300 text-xs">—</span>`;
    const statusBadge = isSkipped
      ? `<span class="text-gray-300 text-xs">—</span>`
      : r
        ? `<span class="text-xs px-2 py-0.5 rounded-full ${displayResolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${displayResolved ? "✓" : "✗"}</span>`
        : `<span class="text-gray-300 text-xs">—</span>`;
    const langBadge = r?.language_detected ? `<span class="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">${r.language_detected.toUpperCase()}</span>` : "—";
    const shiftBadge = shiftLabel(chat.started_at);
    const allAgents = chat.agents?.length > 0 ? chat.agents : (chat.agent ? [chat.agent] : []);

    // When employee filter active: show only that agent; otherwise show all
    let agentNames, employeeNameHtml;
    if (activeEmployeeShift && filteredAgentName) {
      const matchAgent = allAgents.find(a => a.name.toLowerCase() === filteredAgentName.toLowerCase());
      agentNames = matchAgent ? matchAgent.name : (filteredAgentName + " (?)");
      employeeNameHtml = `<span class="font-medium text-gray-800">${activeEmployeeShift.employee}</span>`;
    } else {
      agentNames = allAgents.map(a => a.name).join(", ") || "—";
      const empNames = allAgents.length > 0
        ? [...new Set(allAgents.map(a => getEmployeeName(a.name, chat.started_at) || a.name))].join(", ")
        : "—";
      employeeNameHtml = `<span class="font-medium text-gray-800">${empNames}</span>`;
    }

    const isAdmin = currentUser?.role === "admin";
    const reReviewBtn = isAdmin ? `<button onclick="reviewChat('${chat.id}','${chat.thread_id||''}',this)" class="text-xs text-gray-400 hover:text-orange-500 px-1" title="Re-review">↺</button>` : "";
    const actionBtn = r
      ? `<div class="flex items-center gap-1" onclick="event.stopPropagation()">
           <button onclick="openModal('${chat.id}','${chat.thread_id||''}')" class="text-xs text-blue-500 hover:underline">View</button>
           ${reReviewBtn}
         </div>`
      : isAdmin
        ? `<button onclick="reviewChat('${chat.id}','${chat.thread_id||''}',this)" class="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-100">Review</button>`
        : `<span class="text-gray-300 text-xs">—</span>`;

    const rowKey = chat.thread_id || chat.id;
    return `<tr class="chat-row border-b border-gray-50" id="row-${rowKey}" onclick="openModal('${chat.id}','${chat.thread_id||""}')">
      <td class="px-4 py-3">
        <div class="flex flex-col gap-0.5">
          <div class="flex items-center gap-1">
            <span class="text-gray-300 text-xs">T:</span>
            <span class="font-mono text-xs text-gray-400">${chat.thread_id || chat.id}</span>
            <button onclick="event.stopPropagation();copyId('${chat.thread_id || chat.id}')" title="Copy thread ID" class="shrink-0 text-gray-300 hover:text-blue-500 px-1 text-sm leading-none">⎘</button>
          </div>
          ${chat.id !== chat.thread_id ? `<div class="flex items-center gap-1">
            <span class="text-gray-200 text-xs">C:</span>
            <span class="font-mono text-xs text-gray-300">${chat.id}</span>
            <button onclick="event.stopPropagation();copyId('${chat.id}')" title="Copy container ID" class="shrink-0 text-gray-200 hover:text-gray-400 px-1 text-xs leading-none">⎘</button>
          </div>` : ""}
        </div>
      </td>
      <td class="px-4 py-3 font-medium text-gray-700 text-xs">${agentNames}</td>
      <td class="px-4 py-3 text-gray-600">${chat.customer_name || "—"}</td>
      <td class="px-4 py-3 text-gray-500 text-xs">${date}</td>
      <td class="px-4 py-3">${shiftBadge}</td>
      <td class="px-4 py-3 text-sm font-medium text-gray-700">${employeeNameHtml}</td>
      <td class="px-4 py-3">${langBadge}</td>
      <td class="px-4 py-3" id="score-${rowKey}">${scoreBadge}</td>
      <td class="px-4 py-3" id="status-${rowKey}">${statusBadge}</td>
      <td class="px-4 py-3" id="action-${rowKey}" onclick="event.stopPropagation()">${actionBtn}</td>
    </tr>`;
  }).join("");
}

// ── Review single chat ────────────────────────────────────────────────────────
async function reviewChat(chatId, threadId, btn) {
  if (!btn) { btn = threadId; threadId = ""; } // backward compat
  const rowKey = threadId || chatId;
  const actionCell = document.getElementById("action-" + rowKey);
  if (actionCell) actionCell.innerHTML = `<span class="spinner"></span>`;

  try {
    const qs = threadId ? `?thread_id=${threadId}` : "";
    const res = await authFetch(`/api/review/${chatId}${qs}`, { method: "POST" });
    const review = await res.json();
    if (review.error) throw new Error(review.error);

    // Update chat in local state
    const chat = chats.find(c => (c.thread_id || c.id) === rowKey);
    if (chat) chat.review = review;

    const scoreEl = document.getElementById("score-" + rowKey);
    const statusEl = document.getElementById("status-" + rowKey);

    if (review.skipped) {
      if (scoreEl) scoreEl.innerHTML = `<span class="text-xs text-gray-400 italic">No msg</span>`;
      if (statusEl) statusEl.innerHTML = `<span class="text-gray-300 text-xs">—</span>`;
      if (actionCell) actionCell.innerHTML = `<span class="text-xs text-gray-400">—</span>`;
    } else {
      if (scoreEl) scoreEl.innerHTML = scorePill(review.overall_score);
      if (statusEl) statusEl.innerHTML =
        `<span class="text-xs px-2 py-0.5 rounded-full ${review.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${review.resolved ? "✓" : "✗"}</span>`;
      const reBtn = currentUser?.role === "admin" ? `<button onclick="reviewChat('${chatId}','${threadId||''}',this)" class="text-xs text-gray-400 hover:text-orange-500 px-1" title="Re-review">↺</button>` : "";
      if (actionCell) actionCell.innerHTML = `<div class="flex items-center gap-1">
        <button onclick="openModal('${chatId}','${threadId||''}')" class="text-xs text-blue-500 hover:underline">View</button>
        ${reBtn}
      </div>`;
    }

    updateStats();
    updateChart();
  } catch (e) {
    const retryBtn = currentUser?.role === "admin" ? `<button onclick="reviewChat('${chatId}','${threadId||''}',this)" class="text-xs text-gray-400 hover:text-orange-500 px-1" title="Re-review">↺</button>` : "";
    actionCell.innerHTML = `<div class="flex items-center gap-1">
      <span class="text-xs text-red-500">Error</span>
      ${retryBtn}
    </div>`;
    showStatus("Review failed: " + e.message, "error");
  }
}

// ── Review all pages ──────────────────────────────────────────────────────────
async function refreshChatList() {
  const btn = document.getElementById("btnRefreshList");
  btn.textContent = "⟳ ...";
  btn.disabled = true;
  await loadChats(null);
  btn.textContent = "⟳ Refresh";
  btn.disabled = false;
}

async function reviewAllVisible() {
  const btn = document.getElementById("btnReviewAll");
  btn.disabled = true;
  btn.textContent = "⏳ Reviewing...";
  btn.classList.replace("bg-green-600", "bg-gray-400");
  btn.classList.replace("hover:bg-green-700", "cursor-not-allowed");
  let done = 0, failed = 0;
  let pageId = null;

  const from = document.getElementById("dateFrom").value;
  const to = document.getElementById("dateTo").value;
  // resolveEmployeeFilter sets activeEmployeeShift and returns LiveChat agent ID (or null)
  const agentId = resolveEmployeeFilter();
  const employeeShift = activeEmployeeShift; // snapshot for filtering

  do {
    const params = new URLSearchParams();
    if (from) params.set("date_from", from + "T00:00:00.000000+00:00");
    if (to)   params.set("date_to",   to   + "T23:59:59.999999+00:00");
    if (agentId) params.set("agent_id", agentId);
    if (pageId)  params.set("page_id", pageId);

    let pageData;
    try {
      const res = await authFetch("/api/chats?" + params);
      pageData = await res.json();
      if (pageData.error) break;
    } catch { break; }

    pageId = pageData.next_page_id || null;
    const needsReview = (c) => {
      if (!c.review) return true;
      if (c.review.skipped) return false;
      const pa = c.review.per_agent_reviews;
      if (pa && Object.values(pa).some(r => r && r._error)) return true;
      return false;
    };
    // If employee filter active, only review chats in their shift hours
    const inShift = (c) => {
      if (!employeeShift) return true;
      const h = getTehranHour(c.started_at);
      return h >= employeeShift.start && h < employeeShift.end;
    };
    const pageChats = (pageData.chats || []).filter(c => needsReview(c) && inShift(c));

    // Process in batches of 5 in parallel
    const BATCH = 5;
    for (let i = 0; i < pageChats.length; i += BATCH) {
      const batch = pageChats.slice(i, i + BATCH);
      // Mark all as loading
      batch.forEach(chat => {
        const rk = chat.thread_id || chat.id;
        const cell = document.getElementById("action-" + rk);
        if (cell) cell.innerHTML = `<span class="spinner"></span>`;
      });
      showStatus(`Reviewing... ${done} done, ${failed} failed`, "info");

      await Promise.all(batch.map(async chat => {
        const tid = chat.thread_id || "";
        const rk = tid || chat.id;
        const actionCell = document.getElementById("action-" + rk);
        try {
          const qs = tid ? `?thread_id=${tid}` : "";
          const res = await authFetch(`/api/review/${chat.id}${qs}`, { method: "POST" });
          const review = await res.json();
          if (!review.error) {
            done++;
            const local = chats.find(c => (c.thread_id || c.id) === rk);
            if (local) local.review = review;
            const scoreEl = document.getElementById("score-" + rk);
            const statusEl = document.getElementById("status-" + rk);
            if (scoreEl) scoreEl.innerHTML = review.skipped ? `<span class="text-xs text-gray-400 italic">No msg</span>` : scorePill(review.overall_score);
            if (statusEl) statusEl.innerHTML = review.skipped ? `<span class="text-gray-300 text-xs">—</span>` :
              `<span class="text-xs px-2 py-0.5 rounded-full ${review.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${review.resolved ? "✓" : "✗"}</span>`;
            if (actionCell) actionCell.innerHTML = review.skipped ? `<span class="text-xs text-gray-400">—</span>` :
              `<div class="flex items-center gap-1"><button onclick="openModal('${chat.id}','${tid}')" class="text-xs text-blue-500 hover:underline">View</button></div>`;
          } else {
            failed++;
            if (actionCell) actionCell.innerHTML = `<span class="text-xs text-red-400">Failed</span>`;
          }
        } catch {
          failed++;
          if (actionCell) actionCell.innerHTML = `<span class="text-xs text-red-400">Error</span>`;
        }
      }));

      updateStats();
      updateChart();
    }
  } while (pageId);

  btn.disabled = false;
  btn.textContent = "Review All with AI";
  btn.classList.replace("bg-gray-400", "bg-green-600");
  btn.classList.replace("cursor-not-allowed", "hover:bg-green-700");
  showStatus(`Done! ${done} reviewed${failed ? ", " + failed + " failed" : ""}.`, "success");
}

// ── Modal ─────────────────────────────────────────────────────────────────────
async function openModal(chatId, threadId) {
  const modal = document.getElementById("modal");
  const content = document.getElementById("modalContent");
  content.innerHTML = `<div class="p-10 text-center text-gray-400">Loading…</div>`;
  modal.classList.remove("hidden");

  try {
    const qs = threadId ? `?thread_id=${threadId}` : "";
    const res = await authFetch(`/api/chats/${chatId}${qs}`);
    const chat = await res.json();
    if (chat.error) throw new Error(chat.error);

    const r = chat.review;
    const lang = { fa: "Persian", en: "English", ar: "Arabic", mixed: "Mixed" };

    // Determine if we're in employee-filtered mode
    const modalFilteredAgent = activeEmployeeShift ? getAgentForShift(activeEmployeeShift) : null;
    const modalFilteredAgentName = modalFilteredAgent?.name || null;
    const modalPR = modalFilteredAgentName ? getPerAgentReview(r, modalFilteredAgentName) : null;

    function renderPerAgentCard(pr) {
      if (pr._error) {
        return `<div class="mb-4 border border-red-200 rounded-xl p-4 bg-red-50 flex items-center justify-between">
          <div>
            <p class="text-sm font-bold text-red-700">${escHtml(pr.agent_name || "Agent")}</p>
            <p class="text-xs text-red-500 mt-0.5">Review failed — click Retry</p>
          </div>
          <button onclick="reviewChatModal('${chatId}','${threadId||''}')" class="text-xs bg-red-600 text-white px-3 py-1.5 rounded-lg hover:bg-red-700">Retry</button>
        </div>`;
      }
      return `<div class="mb-4 border border-gray-200 rounded-xl p-4">
        ${pr.supervisor_warning ? `<div class="mb-3 bg-orange-50 border border-orange-300 rounded-lg px-3 py-2 flex gap-2">
          <span class="text-orange-500 font-bold text-xs shrink-0">⚠ Supervisor Note</span>
          <span class="text-xs text-orange-700">${escHtml(pr.supervisor_warning_text || "")}</span>
        </div>` : ""}
        <div class="flex items-center justify-between mb-3">
          <p class="text-sm font-bold text-gray-700">${escHtml(pr.agent_name || "Agent")}</p>
          <span class="text-lg font-black ${scoreColor(pr.overall_score)}">${(pr.overall_score||0).toFixed(1)}</span>
        </div>
        ${scoreBar("Response Time", pr.response_time_score, pr.response_time_notes)}
        ${scoreBar("Tone", pr.tone_score, pr.tone_notes)}
        ${scoreBar("Accuracy", pr.accuracy_score, pr.accuracy_notes)}
        ${scoreBar("Resolution", pr.resolution_score, pr.resolution_notes)}
        ${scoreBar("Compliance", pr.compliance_score, pr.compliance_notes)}
        ${scoreBar("Product Knowledge", pr.product_knowledge_score, pr.product_knowledge_notes)}
        ${pr.notes ? `<p class="text-xs text-gray-600 mt-2 whitespace-pre-line">${escHtml(pr.notes)}</p>` : ""}
        ${pr.issues ? `<div class="mt-2 bg-red-50 border border-red-100 rounded p-2"><p class="text-xs text-red-600 whitespace-pre-line">${escHtml(Array.isArray(pr.issues) ? pr.issues.join("\n") : pr.issues)}</p></div>` : ""}
      </div>`;
    }

    let reviewHtml;
    if (!r) {
      reviewHtml = `<p class="text-gray-400 text-sm mb-4">No review yet</p>
        <button onclick="reviewChatModal('${chatId}','${threadId||''}')" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700">Review with AI</button>`;
    } else if (modalFilteredAgentName && modalPR) {
      // Employee-filtered mode: show only this agent's per-agent review
      reviewHtml = `<div>
        <p class="text-xs text-gray-400 uppercase font-semibold mb-3">Review: ${escHtml(activeEmployeeShift.employee)} (${escHtml(modalFilteredAgentName)})</p>
        ${renderPerAgentCard(modalPR)}
        <div class="mt-3 pt-3 border-t border-gray-100">
          <p class="text-xs text-gray-400">Overall chat score: <span class="font-semibold text-gray-600">${(r.overall_score||0).toFixed(1)}</span></p>
        </div>
      </div>`;
    } else if (modalFilteredAgentName && !modalPR) {
      // No per-agent review — single-agent chat, fall back to overall review
      reviewHtml = `<div>
        <p class="text-xs text-gray-400 uppercase font-semibold mb-3">Review: ${escHtml(activeEmployeeShift.employee)} (${escHtml(modalFilteredAgentName)})</p>
        ${renderPerAgentCard({ ...r, agent_name: modalFilteredAgentName })}
      </div>`;
    } else {
      // All employees mode: full review
      reviewHtml = `<div>
        ${r.supervisor_warning ? `<div class="mb-4 bg-orange-50 border border-orange-300 rounded-lg px-4 py-3 flex gap-2">
          <span class="text-orange-500 font-bold text-sm shrink-0">⚠ Supervisor Warning</span>
          <span class="text-sm text-orange-700">${escHtml(r.supervisor_warning_text || "")}</span>
        </div>` : ""}
        <div class="flex items-center gap-3 mb-5">
          <div class="text-3xl font-black ${scoreColor(r.overall_score)}">${(r.overall_score||0).toFixed(1)}</div>
          <div class="flex flex-col gap-1">
            <p class="text-xs text-gray-500">Overall Score</p>
            <div class="flex gap-1 flex-wrap">
              <span class="text-xs font-semibold px-2 py-0.5 rounded-full ${r.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">
                ${r.resolved ? "✓ Resolved" : "✗ Unresolved"}
              </span>
              ${r.escalated ? `<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">↑ Escalated</span>` : ""}
            </div>
          </div>
        </div>
        ${scoreBar("Response Time", r.response_time_score, r.response_time_notes)}
        ${scoreBar("Tone & Professionalism", r.tone_score, r.tone_notes)}
        ${scoreBar("Accuracy", r.accuracy_score, r.accuracy_notes)}
        ${scoreBar("Resolution", r.resolution_score, r.resolution_notes)}
        ${scoreBar("Compliance & Risk", r.compliance_score, r.compliance_notes)}
        ${scoreBar("Product Knowledge", r.product_knowledge_score, r.product_knowledge_notes)}
        ${scoreBar("Customer Satisfaction", r.satisfaction_score, r.satisfaction_notes)}
        ${scoreBar("Language & Grammar", r.language_score, r.language_notes)}
        ${r.suggested_tags?.length ? (() => {
          const applied = (chat.applied_tags || []).map(t => t.toLowerCase());
          const tagged = r.suggested_tags.filter(t => applied.includes(t.toLowerCase()));
          const missing = r.suggested_tags.filter(t => !applied.includes(t.toLowerCase()));
          return `<div class="mt-4">
            <p class="text-xs font-semibold text-gray-500 uppercase mb-2">Tags</p>
            <div class="flex flex-wrap gap-1.5">
              ${tagged.map(t => `<span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-medium"># ${escHtml(t)}</span>`).join("")}
              ${missing.map(t => `<span class="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200 font-medium">✗ ${escHtml(t)}</span>`).join("")}
            </div>
          </div>`;
        })() : ""}
        <div class="mt-4">
          <p class="text-xs font-semibold text-gray-500 uppercase mb-1">Summary</p>
          <p class="text-sm text-gray-700 leading-relaxed">${escHtml(r.summary || "—")}</p>
        </div>
        ${r.issues ? `<div class="mt-4 bg-red-50 border border-red-100 rounded-lg p-3">
          <p class="text-xs font-semibold text-red-600 mb-1">Issues</p>
          <p class="text-sm text-red-700 whitespace-pre-line">${escHtml(r.issues)}</p>
        </div>` : ""}
        ${r.strengths ? `<div class="mt-3 bg-green-50 border border-green-100 rounded-lg p-3">
          <p class="text-xs font-semibold text-green-600 mb-1">Strengths</p>
          <p class="text-sm text-green-700 whitespace-pre-line">${escHtml(r.strengths)}</p>
        </div>` : ""}
        ${r.per_agent_reviews && Object.keys(r.per_agent_reviews).length > 0 ? `
        <div class="mt-5 border-t border-gray-200 pt-4">
          <p class="text-xs font-semibold text-gray-500 uppercase mb-3">Per-Agent Reviews</p>
          ${Object.values(r.per_agent_reviews).filter(Boolean).map(pr => renderPerAgentCard(pr)).join("")}
        </div>` : ""}
      </div>`;
    }

    // Filter messages to agent's segment when employee filter is active
    const visibleMessages = modalFilteredAgentName
      ? (chat.messages || []).filter(m => m.is_private || !m.segment_agent || m.segment_agent.name === modalFilteredAgentName)
      : (chat.messages || []);

    const messages = visibleMessages.map(m => {
      if (m.is_private) return `
        <div class="flex justify-center mb-3">
          <div class="max-w-[90%] rounded-lg px-3 py-2 text-xs bg-orange-50 border border-orange-200 text-orange-700 text-center">
            <span class="font-semibold">⚠ ${escHtml(m.author_name)} (Supervisor Note):</span> ${escHtml(m.content)}
          </div>
        </div>`;
      if (m.event_type === "filled_form") return `
        <div class="flex justify-center mb-3">
          <div class="max-w-[90%] w-full rounded-lg px-3 py-2 text-xs bg-indigo-50 border border-indigo-200 text-indigo-800">
            <p class="font-semibold mb-1">📋 Pre-Chat Form</p>
            <pre class="whitespace-pre-wrap font-sans">${escHtml(m.content)}</pre>
          </div>
        </div>`;
      if (m.event_type === "system_message") return `
        <div class="flex justify-center mb-3">
          <div class="text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded-full px-3 py-1">
            ${escHtml(m.content)}
          </div>
        </div>`;
      return `
      <div class="flex ${m.author_type === "agent" ? "justify-end" : "justify-start"} mb-3">
        <div class="max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.author_type === "agent" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}">
          <p class="font-semibold text-xs opacity-70 mb-1">${m.author_name || ""}</p>
          <p class="leading-relaxed">${escHtml(m.content)}</p>
        </div>
      </div>`;
    }).join("") || `<p class="text-gray-400 text-sm text-center">No messages</p>`;

    content.innerHTML = `
      <div>
        <div class="flex items-start justify-between p-6 border-b">
          <div>
            <p class="text-xs text-gray-400 mb-1">Chat ID: ${chat.thread_id || chat.id}</p>
            <h2 class="text-xl font-bold text-gray-800">${chat.customer_name || "Unknown Customer"}</h2>
            <p class="text-sm text-gray-500 mt-1">
              ${modalFilteredAgentName
                ? `Employee: <span class="font-medium text-blue-600">${escHtml(activeEmployeeShift.employee)}</span> · Agent: <span class="font-medium">${escHtml(modalFilteredAgentName)}</span>`
                : `Agents: <span class="font-medium">${(chat.agents||[chat.agent]).filter(Boolean).map(a=>escHtml(a.name)).join(", ") || "—"}</span>`
              }
              · ${lang[r?.language_detected] || "Unknown language"}
              · ${chat.started_at ? new Date(chat.started_at).toLocaleString("en-GB", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : ""}
            </p>
          </div>
          <button onclick="closeModal()" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2">
          <div class="p-5 border-r overflow-y-auto max-h-[55vh]">
            <h3 class="font-semibold text-gray-700 mb-4 text-sm">Transcript</h3>
            ${messages}
          </div>
          <div class="p-5 overflow-y-auto max-h-[55vh]">
            <h3 class="font-semibold text-gray-700 mb-4 text-sm">AI Review</h3>
            ${reviewHtml}
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="p-10 text-center text-red-400">Error: ${e.message}</div>`;
  }
}

async function reviewChatModal(chatId) {
  document.getElementById("modalContent").innerHTML = `<div class="p-10 text-center text-gray-400"><span class="spinner"></span> Reviewing with AI...</div>`;
  try {
    const res = await authFetch(`/api/review/${chatId}`, { method: "POST" });
    const review = await res.json();
    if (review.error) throw new Error(review.error);
    const chat = chats.find(c => c.id === chatId);
    if (chat) chat.review = review;
    renderTable();
    updateStats();
    updateChart();
    await openModal(chatId);
  } catch (e) {
    document.getElementById("modalContent").innerHTML = `<div class="p-10 text-center text-red-400">Error: ${e.message}</div>`;
  }
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
}

// ── Stats & Chart ─────────────────────────────────────────────────────────────
function updateStats() {
  const filtered = applyEmployeeHourFilter(allChats);
  const reviewed = filtered.filter(c => c.review && !c.review.skipped);
  const scores = reviewed.map(c => c.review.overall_score).filter(Boolean);
  const resolved = reviewed.filter(c => c.review.resolved).length;

  document.getElementById("statTotal").textContent = filtered.length;
  document.getElementById("statReviewed").textContent = reviewed.length;
  document.getElementById("statAvg").textContent = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) + "/10" : "—";
  document.getElementById("statResolved").textContent = resolved || "—";
}

function getEmployeeName(agentName, dateStr) {
  if (!agentName || !dateStr) return agentName || null;
  const full = agentName.toLowerCase().trim();
  const first = full.split(" ")[0];
  const h = getTehranHour(dateStr);
  const match = agentShifts.find(s => (s.agentKey === full || s.agentKey === first) && h >= s.start && h < s.end);
  return match ? match.employee : agentName;
}

function getEmployeeNameForChart(agentName, dateStr) {
  // Try hour-matched shift first
  const matched = getEmployeeName(agentName, dateStr);
  if (matched !== agentName) return matched; // found a shift match
  // Fallback: find any shift for this agent (ignore hour) so agent names don't appear as separate bars
  const full = (agentName || "").toLowerCase().trim();
  const first = full.split(" ")[0];
  const anyShift = agentShifts.find(s => s.agentKey === full || s.agentKey === first);
  return anyShift ? anyShift.employee : agentName;
}

function updateChart() {
  const byEmployee = {};
  const filtered = applyEmployeeHourFilter(allChats);
  const filteredAgentName = activeEmployeeShift ? getAgentForShift(activeEmployeeShift)?.name || null : null;

  for (const chat of filtered) {
    if (!chat.review || chat.review.skipped || !chat.agent) continue;
    const emp = activeEmployeeShift
      ? (activeEmployeeShift.employee)
      : getEmployeeNameForChart(chat.agent.name, chat.started_at);

    // Use per-agent score when employee filter is active, else overall
    let score;
    if (activeEmployeeShift && filteredAgentName) {
      const pr = getPerAgentReview(chat.review, filteredAgentName);
      score = pr ? pr.overall_score : chat.review.overall_score;
    } else {
      score = chat.review.overall_score;
    }
    if (score == null) continue;
    if (!byEmployee[emp]) byEmployee[emp] = [];
    byEmployee[emp].push(score);
  }

  const labels = Object.keys(byEmployee);
  const counts = labels.map(n => byEmployee[n].length);
  const data = labels.map(n => +(byEmployee[n].reduce((a,b)=>a+b,0)/byEmployee[n].length).toFixed(2));
  const colors = data.map(s => s >= 7 ? "#22c55e" : s >= 5 ? "#eab308" : "#ef4444");

  if (agentChart) agentChart.destroy();
  const ctx = document.getElementById("agentChart").getContext("2d");
  agentChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Avg Score",
        data,
        backgroundColor: colors,
        borderRadius: 6,
      }],
    },
    options: {
      scales: {
        y: { min: 0, max: 10, grid: { color: "#f1f5f9" } },
        x: { grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Score: ${ctx.parsed.y.toFixed(1)}  |  Chats: ${counts[ctx.dataIndex]}`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 2,
          color: "#374151",
          font: { weight: "bold", size: 12 },
          formatter: (v, ctx) => `${v.toFixed(1)}\n(${counts[ctx.dataIndex]})`,
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

function updatePagination() {
  // Pagination hidden from UI — all pages load automatically in background
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function scorePill(score) {
  const cls = score >= 7 ? "score-high" : score >= 5 ? "score-mid" : "score-low";
  return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-bold ${cls}">${score.toFixed(1)}</span>`;
}

function scoreColor(score) {
  return score >= 7 ? "text-green-600" : score >= 5 ? "text-yellow-500" : "text-red-500";
}

function scoreBar(label, value, notes) {
  if (!value && value !== 0) return "";
  const pct = Math.round((value / 10) * 100);
  const barClass = value >= 7 ? "bar-green" : value >= 5 ? "bar-yellow" : "bar-red";
  return `<div class="mb-3">
    <div class="flex justify-between text-xs text-gray-500 mb-1">
      <span class="font-medium">${label}</span><span class="font-semibold text-gray-700">${value.toFixed(1)}</span>
    </div>
    <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div>
    ${notes ? `<p class="text-xs text-gray-400 mt-1 leading-relaxed">${escHtml(notes)}</p>` : ""}
  </div>`;
}

// Istanbul = UTC+3 = 180 minutes (no DST since 2016)
function iranDayToUtc(dateStr, isEnd) {
  const offsetMs = 180 * 60 * 1000;
  const time = isEnd ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const utc = new Date(new Date(dateStr + time).getTime() - offsetMs);
  const iso = utc.toISOString();
  return iso.replace(/\.\d{3}Z$/, (isEnd ? ".999999" : ".000000") + "+00:00");
}

function getTehranHour(dateStr) {
  return parseInt(new Date(dateStr).toLocaleString("en-US", { timeZone: "Europe/Istanbul", hour: "numeric", hour12: false }));
}

function getEmployee(agentName, dateStr) {
  if (!agentName || !dateStr) return `<span class="text-gray-300">—</span>`;
  const name = getEmployeeName(agentName, dateStr);
  return `<span class="font-medium text-gray-800">${name}</span>`;
}

function shiftLabel(dateStr) {
  if (!dateStr) return `<span class="text-gray-300 text-xs">—</span>`;
  const h = getTehranHour(dateStr);
  if (h >= 8 && h < 16)  return `<span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">☀ Day</span>`;
  if (h >= 16 && h < 24) return `<span class="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">🌙 Night</span>`;
  return `<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Off</span>`;
}

function copyId(id) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(id).then(() => showStatus("Copied: " + id, "success")).catch(() => copyFallback(id));
  } else {
    copyFallback(id);
  }
}

function copyFallback(id) {
  const el = document.createElement("textarea");
  el.value = id;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
  showStatus("Copied: " + id, "success");
}

function escHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function showStatus(msg, type) {
  const bar = document.getElementById("statusBar");
  bar.className = `text-sm px-6 py-2 border-b ${type === "error" ? "bg-red-50 border-red-200 text-red-700" : type === "success" ? "bg-green-50 border-green-200 text-green-700" : "bg-blue-50 border-blue-200 text-blue-700"}`;
  bar.textContent = msg;
  bar.classList.remove("hidden");
  if (type === "success") setTimeout(() => bar.classList.add("hidden"), 3000);
}

// ── Settings Modal ────────────────────────────────────────────────────────────
let settingsAgents = [];

async function openSettings() {
  document.getElementById("settingsModal").classList.remove("hidden");
  if (agents.length > 0) settingsAgents = agents;
  try {
    const [shiftsRes, usersRes] = await Promise.all([
      authFetch("/api/agent-shifts"),
      authFetch("/api/app-users"),
    ]);
    const fresh = await shiftsRes.json();
    const appUsers = await usersRes.json();
    if (Array.isArray(fresh)) {
      // Attach username to each shift from app_users
      const userMap = {};
      if (Array.isArray(appUsers)) appUsers.forEach(u => { if (u.employee_name) userMap[u.employee_name] = u.username; });
      agentShifts = fresh.map(s => ({ ...s, username: userMap[s.employee] || "" }));
    }
  } catch {}
  renderShiftsTable();
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

async function refreshSettingsAgents() {
  const icon = document.getElementById("settingsAgentRefreshIcon");
  icon.textContent = "…";
  try {
    const res = await authFetch("/api/agents");
    const data = await res.json();
    settingsAgents = data.agents || data || [];
    agents = settingsAgents;
    renderShiftsTable();
    renderAgentFilter();
  } catch (e) {
    showStatus("Failed to refresh agents", "error");
  }
  icon.textContent = "⟳";
}

function agentOptionsHtml(selectedKey) {
  const opts = settingsAgents.map(a => {
    const key = a.name.toLowerCase().trim();
    const sel = key === selectedKey ? "selected" : "";
    return `<option value="${escHtml(key)}" ${sel}>${escHtml(a.name)}</option>`;
  });
  return `<option value="">— Agent —</option>` + opts.join("");
}

function renderShiftsTable() {
  const tbody = document.getElementById("shiftsTableBody");
  tbody.innerHTML = (Array.isArray(agentShifts) ? agentShifts : []).map(s => shiftRowHtml(s)).join("");
}

const ALL_GROUPS = ["General", "Social Trade", "KYC"];

function groupCheckboxesHtml(selected) {
  const sel = selected || [];
  return ALL_GROUPS.map(g => {
    const checked = sel.includes(g) ? "checked" : "";
    const color = g === "General" ? "text-blue-600" : g === "Social Trade" ? "text-green-600" : "text-purple-600";
    return `<label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
      <input type="checkbox" class="sr-group" value="${g}" ${checked} />
      <span class="text-xs ${color}">${g}</span>
    </label>`;
  }).join("");
}

const ALL_LANGUAGES = [
  { value: "Persian", label: "FA", color: "text-rose-600" },
  { value: "English", label: "EN", color: "text-blue-600" },
  { value: "Arabic",  label: "AR", color: "text-emerald-600" },
];

function languageCheckboxesHtml(selected) {
  const sel = selected || [];
  return ALL_LANGUAGES.map(({ value, label, color }) => {
    const checked = sel.includes(value) ? "checked" : "";
    return `<label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
      <input type="checkbox" class="sr-lang" value="${value}" ${checked} />
      <span class="text-xs font-semibold ${color}">${label}</span>
    </label>`;
  }).join("");
}

function shiftRowHtml(s) {
  return `<tr class="border-b border-gray-100 shift-row">
    <td class="py-2 pr-3"><input class="sr-employee w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" value="${escHtml(s.employee || "")}" placeholder="Employee name" /></td>
    <td class="py-2 pr-3">
      <select class="sr-agent w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300">
        ${agentOptionsHtml(s.agentKey || "")}
      </select>
    </td>
    <td class="py-2 pr-3"><input class="sr-start w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="23" value="${s.start ?? 8}" /></td>
    <td class="py-2 pr-3"><input class="sr-end w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="24" value="${s.end ?? 16}" /></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${groupCheckboxesHtml(s.groups)}</div></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${languageCheckboxesHtml(s.languages)}</div></td>
    <td class="py-2 pr-3"><input class="sr-username w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" value="${escHtml(s.username || "")}" placeholder="username" autocomplete="off" /></td>
    <td class="py-2 pr-3"><input class="sr-password w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" type="password" placeholder="••••••" autocomplete="new-password" /></td>
    <td class="py-2"><button onclick="this.closest('tr').remove()" class="text-red-400 hover:text-red-600 text-lg leading-none px-1">×</button></td>
  </tr>`;
}

function addShiftRow() {
  const tbody = document.getElementById("shiftsTableBody");
  const tr = document.createElement("tr");
  tr.className = "border-b border-gray-100 shift-row";
  tr.innerHTML = `
    <td class="py-2 pr-3"><input class="sr-employee w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" value="" placeholder="Employee name" /></td>
    <td class="py-2 pr-3">
      <select class="sr-agent w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300">
        ${agentOptionsHtml("")}
      </select>
    </td>
    <td class="py-2 pr-3"><input class="sr-start w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="23" value="8" /></td>
    <td class="py-2 pr-3"><input class="sr-end w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="24" value="16" /></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${groupCheckboxesHtml([])}</div></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${languageCheckboxesHtml([])}</div></td>
    <td class="py-2 pr-3"><input class="sr-username w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" placeholder="username" autocomplete="off" /></td>
    <td class="py-2 pr-3"><input class="sr-password w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" type="password" placeholder="••••••" autocomplete="new-password" /></td>
    <td class="py-2"><button onclick="this.closest('tr').remove()" class="text-red-400 hover:text-red-600 text-lg leading-none px-1">×</button></td>
  `;
  tbody.appendChild(tr);
}

async function saveSettings() {
  const rows = document.querySelectorAll("#shiftsTableBody .shift-row");
  const newShifts = [];
  const userUpdates = []; // { username, password, employee_name }
  rows.forEach(row => {
    const employee = row.querySelector(".sr-employee").value.trim();
    const agentKey = row.querySelector(".sr-agent").value.trim();
    const start = parseInt(row.querySelector(".sr-start").value) || 0;
    const end = parseInt(row.querySelector(".sr-end").value) || 24;
    const groups = [...row.querySelectorAll(".sr-group:checked")].map(cb => cb.value);
    const languages = [...row.querySelectorAll(".sr-lang:checked")].map(cb => cb.value);
    const username = row.querySelector(".sr-username")?.value.trim() || "";
    const password = row.querySelector(".sr-password")?.value || "";
    if (!employee || !agentKey) return;
    newShifts.push({ employee, agentKey, start, end, groups, languages, username });
    if (username && password) userUpdates.push({ username, password, employee_name: employee });
  });

  try {
    // Save shifts
    const res = await authFetch("/api/agent-shifts", {
      method: "POST",
      body: JSON.stringify(newShifts),
    });
    const data = await res.json();
    // Save user credentials in parallel
    if (userUpdates.length > 0) {
      await Promise.all(userUpdates.map(u =>
        authFetch("/api/app-users", { method: "POST", body: JSON.stringify(u) })
      ));
    }
    if (data.ok) {
      agentShifts = newShifts;
      showStatus("Saved", "success");
      closeSettings();
      renderTable();
    } else {
      showStatus("Save failed: " + (data.error || "unknown"), "error");
    }
  } catch (e) {
    showStatus("Save failed: " + e.message, "error");
  }
}
