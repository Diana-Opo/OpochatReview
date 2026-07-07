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
let activeEmployeeShift = null; // { employee, agentKey, start, end } when employee filter is on

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  document.getElementById("dateFrom").value = firstOfMonth.toISOString().slice(0, 10);
  document.getElementById("dateTo").value = today.toISOString().slice(0, 10);

  await loadAgents();
  try { const r = await fetch("/api/agent-shifts"); agentShifts = await r.json(); } catch {}
  renderAgentFilter();
  loadKnowledgeStatus();
  document.getElementById("btnLoad").addEventListener("click", () => loadChats(null));
  document.getElementById("btnRefreshKb").addEventListener("click", refreshKnowledge);
  document.getElementById("btnReviewAll").addEventListener("click", reviewAllVisible);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal")) closeModal();
  });
});

// ── Knowledge Base ───────────────────────────────────────────────────────────
async function loadKnowledgeStatus() {
  try {
    const res = await fetch("/api/knowledge-status");
    const data = await res.json();
    updateKbStatus(data);
  } catch {}
}

async function refreshKnowledge() {
  const btn = document.getElementById("btnRefreshKb");
  btn.disabled = true;
  document.getElementById("kbStatus").textContent = "...";
  try {
    const res = await fetch("/api/refresh-knowledge", { method: "POST" });
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
  const parts = [];
  if (hasKb) parts.push("KB✓");
  if (hasCamp) parts.push("Camp✓");
  if (hasTg) parts.push("TG✓");
  if (hasProt) parts.push("Proto✓");
  if (hasMacros) parts.push("Macros✓");
  kb.textContent = parts.length ? parts.join(" ") : "No data";
  kb.title = `Last fetched: ${data.lastFetched || "never"}\nKnowledge: ${data.knowledge} chars\nCampaigns: ${data.campaigns} chars\nTelegram: ${data.telegram} chars\nProtocol: ${data.protocol} chars`;
}

// ── Agents ────────────────────────────────────────────────────────────────────
async function loadAgents() {
  try {
    const res = await fetch("/api/agents");
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
  const employees = Array.isArray(agentShifts) ? agentShifts : [];
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

function applyEmployeeHourFilter(list) {
  if (!activeEmployeeShift) return list;
  return list.filter(c => {
    const h = getTehranHour(c.started_at);
    return h >= activeEmployeeShift.start && h < activeEmployeeShift.end;
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
    const res = await fetch("/api/chats?" + params);
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
    updateStats();
    updatePagination();
    document.getElementById("statusBar").classList.add("hidden");

    if (chats.length > 0) {
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
    } else if (!pageId) {
      updateChart();
    }
  } catch (e) {
    showStatus("Error: " + e.message, "error");
  }
}

function setStatsLoading(on) {
  ["statReviewed","statAvg","statResolved"].forEach(id => {
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
      const res = await fetch("/api/chats?" + p);
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

// ── Render Table ─────────────────────────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById("chatTableBody");
  const displayChats = applyEmployeeHourFilter(allChats);
  if (displayChats.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-12 text-gray-400">No chats found for this period</td></tr>`;
    return;
  }

  const sortedChats = [...displayChats].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  tbody.innerHTML = sortedChats.map(chat => {
    const r = chat.review;
    const date = chat.started_at
      ? new Date(chat.started_at).toLocaleString("en-GB", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
      : "—";
    const scoreBadge = r ? scorePill(r.overall_score) : `<span class="text-gray-300 text-xs">—</span>`;
    const statusBadge = r
      ? `<span class="text-xs px-2 py-0.5 rounded-full ${r.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${r.resolved ? "✓" : "✗"}</span>`
      : `<span class="text-gray-300 text-xs">—</span>`;
    const langBadge = r?.language_detected ? `<span class="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">${r.language_detected.toUpperCase()}</span>` : "—";
    const shiftBadge = shiftLabel(chat.started_at);
    const employeeName = getEmployee(chat.agent?.name, chat.started_at);

    const actionBtn = r
      ? `<div class="flex items-center gap-1" onclick="event.stopPropagation()">
           <button onclick="openModal('${chat.id}','${chat.thread_id||''}')" class="text-xs text-blue-500 hover:underline">View</button>
           <button onclick="reviewChat('${chat.id}','${chat.thread_id||''}',this)" class="text-xs text-gray-400 hover:text-orange-500 px-1" title="Re-review">↺</button>
         </div>`
      : `<button onclick="reviewChat('${chat.id}','${chat.thread_id||''}',this)" class="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-100">Review</button>`;

    const rowKey = chat.thread_id || chat.id;
    return `<tr class="chat-row border-b border-gray-50" id="row-${rowKey}" onclick="openModal('${chat.id}','${chat.thread_id||""}')">
      <td class="px-4 py-3">
        <div class="flex items-center gap-1">
          <span class="font-mono text-xs text-gray-400">${chat.thread_id || chat.id}</span>
          <button onclick="event.stopPropagation();copyId('${chat.thread_id || chat.id}')" title="Copy ID" class="shrink-0 text-gray-300 hover:text-blue-500 px-1 text-sm leading-none">⎘</button>
        </div>
      </td>
      <td class="px-4 py-3 font-medium text-gray-700">${chat.agent?.name || "—"}</td>
      <td class="px-4 py-3 text-gray-600">${chat.customer_name || "—"}</td>
      <td class="px-4 py-3 text-gray-500 text-xs">${date}</td>
      <td class="px-4 py-3">${shiftBadge}</td>
      <td class="px-4 py-3 text-sm font-medium text-gray-700">${employeeName}</td>
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
    const res = await fetch(`/api/review/${chatId}${qs}`, { method: "POST" });
    const review = await res.json();
    if (review.error) throw new Error(review.error);

    // Update chat in local state
    const chat = chats.find(c => (c.thread_id || c.id) === rowKey);
    if (chat) chat.review = review;

    const scoreEl = document.getElementById("score-" + rowKey);
    const statusEl = document.getElementById("status-" + rowKey);
    if (scoreEl) scoreEl.innerHTML = scorePill(review.overall_score);
    if (statusEl) statusEl.innerHTML =
      `<span class="text-xs px-2 py-0.5 rounded-full ${review.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${review.resolved ? "Resolved" : "Open"}</span>`;
    if (actionCell) actionCell.innerHTML = `<div class="flex items-center gap-1">
      <button onclick="openModal('${chatId}','${threadId||''}')" class="text-xs text-blue-500 hover:underline">View</button>
      <button onclick="reviewChat('${chatId}','${threadId||''}',this)" class="text-xs text-gray-400 hover:text-orange-500 px-1" title="Re-review">↺</button>
    </div>`;

    updateStats();
    updateChart();
  } catch (e) {
    actionCell.innerHTML = `<span class="text-xs text-red-500">Error</span>`;
    showStatus("Review failed: " + e.message, "error");
  }
}

// ── Review all pages ──────────────────────────────────────────────────────────
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
  const agentId = document.getElementById("agentFilter").value;

  do {
    const params = new URLSearchParams();
    if (from) params.set("date_from", from + "T00:00:00.000000+00:00");
    if (to)   params.set("date_to",   to   + "T23:59:59.999999+00:00");
    if (agentId) params.set("agent_id", agentId);
    if (pageId)  params.set("page_id", pageId);

    let pageData;
    try {
      const res = await fetch("/api/chats?" + params);
      pageData = await res.json();
      if (pageData.error) break;
    } catch { break; }

    pageId = pageData.next_page_id || null;
    const pageChats = (pageData.chats || []).filter(c => !c.review);

    for (const chat of pageChats) {
      showStatus(`Reviewing... ${done + 1} done, ${failed} failed`, "info");
      const tid = chat.thread_id || "";
      const rk = tid || chat.id;
      const actionCell = document.getElementById("action-" + rk);
      if (actionCell) actionCell.innerHTML = `<span class="spinner"></span>`;
      try {
        const qs = tid ? `?thread_id=${tid}` : "";
        const res = await fetch(`/api/review/${chat.id}${qs}`, { method: "POST" });
        const review = await res.json();
        if (!review.error) {
          done++;
          const local = chats.find(c => (c.thread_id || c.id) === rk);
          if (local) local.review = review;
          const scoreEl = document.getElementById("score-" + rk);
          const statusEl = document.getElementById("status-" + rk);
          if (scoreEl) scoreEl.innerHTML = scorePill(review.overall_score);
          if (statusEl) statusEl.innerHTML =
            `<span class="text-xs px-2 py-0.5 rounded-full ${review.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${review.resolved ? "Resolved" : "Open"}</span>`;
          if (actionCell) actionCell.innerHTML = `<div class="flex items-center gap-1">
            <button onclick="openModal('${chat.id}','${tid}')" class="text-xs text-blue-500 hover:underline">View</button>
            <button onclick="reviewChat('${chat.id}','${tid}',this)" class="text-xs text-gray-400 hover:text-orange-500 px-1" title="Re-review">↺</button>
          </div>`;
        } else {
          failed++;
          if (actionCell) actionCell.innerHTML = `<span class="text-xs text-red-400">Failed</span>`;
        }
      } catch {
        failed++;
        if (actionCell) actionCell.innerHTML = `<span class="text-xs text-red-400">Error</span>`;
      }
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
    const res = await fetch(`/api/chats/${chatId}${qs}`);
    const chat = await res.json();
    if (chat.error) throw new Error(chat.error);

    const r = chat.review;
    const lang = { fa: "Persian", en: "English", ar: "Arabic", mixed: "Mixed" };

    const reviewHtml = r ? `
      <div>
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
      </div>
    ` : `
      <p class="text-gray-400 text-sm mb-4">No review yet</p>
      <button onclick="reviewChatModal('${chatId}')" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700">
        Review with AI
      </button>
    `;

    const messages = (chat.messages || []).map(m => `
      <div class="flex ${m.author_type === "agent" ? "justify-end" : "justify-start"} mb-3">
        <div class="max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.author_type === "agent" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}">
          <p class="font-semibold text-xs opacity-70 mb-1">${m.author_name || ""}</p>
          <p class="leading-relaxed">${escHtml(m.content)}</p>
        </div>
      </div>
    `).join("") || `<p class="text-gray-400 text-sm text-center">No messages</p>`;

    content.innerHTML = `
      <div>
        <div class="flex items-start justify-between p-6 border-b">
          <div>
            <p class="text-xs text-gray-400 mb-1">Chat ID: ${chat.id}</p>
            <h2 class="text-xl font-bold text-gray-800">${chat.customer_name || "Unknown Customer"}</h2>
            <p class="text-sm text-gray-500 mt-1">
              Agent: <span class="font-medium">${chat.agent?.name || "—"}</span>
              · ${lang[r?.language_detected] || "Unknown language"}
              · ${chat.started_at ? new Date(chat.started_at).toLocaleString() : ""}
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
    const res = await fetch(`/api/review/${chatId}`, { method: "POST" });
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
  const reviewed = filtered.filter(c => c.review);
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

function updateChart() {
  const byEmployee = {};
  for (const chat of applyEmployeeHourFilter(allChats)) {
    if (!chat.review || !chat.agent) continue;
    const emp = getEmployeeName(chat.agent.name, chat.started_at) || chat.agent.name;
    if (!byEmployee[emp]) byEmployee[emp] = [];
    byEmployee[emp].push(chat.review.overall_score);
  }

  const labels = Object.keys(byEmployee);
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
      plugins: { legend: { display: false } },
    },
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
  renderShiftsTable();
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

async function refreshSettingsAgents() {
  const icon = document.getElementById("settingsAgentRefreshIcon");
  icon.textContent = "…";
  try {
    const res = await fetch("/api/agents");
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
    <td class="py-2"><button onclick="this.closest('tr').remove()" class="text-red-400 hover:text-red-600 text-lg leading-none px-1">×</button></td>
  `;
  tbody.appendChild(tr);
}

async function saveSettings() {
  const rows = document.querySelectorAll("#shiftsTableBody .shift-row");
  const newShifts = [];
  rows.forEach(row => {
    const employee = row.querySelector(".sr-employee").value.trim();
    const agentKey = row.querySelector(".sr-agent").value.trim();
    const start = parseInt(row.querySelector(".sr-start").value) || 0;
    const end = parseInt(row.querySelector(".sr-end").value) || 24;
    if (!employee || !agentKey) return;
    newShifts.push({ employee, agentKey, start, end });
  });

  try {
    const res = await fetch("/api/agent-shifts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(newShifts),
    });
    const data = await res.json();
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
