function togglePw(btn) {
  const inp = btn.previousElementSibling;
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  btn.textContent = show ? "🙈" : "👁";
}

// ── State ────────────────────────────────────────────────────────────────────
let chats = [];
let agents = [];
let nextPageId = null;
let currentPage = 0; // 0-indexed page into the currently-loaded/filtered chat list (CHATS_PAGE_SIZE per page)
let agentChart = null;
let totalChats = 0;
let agentShifts = [];
let weekendOverrides = []; // date-specific shift overrides — see server.js loadWeekendOverrides()
let allChats = [];
let activeEmployeeShift = null;
let currentUser = null; // { username, role, employee_name }

// ── Auth ──────────────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem("auth_token") || ""; }

async function authFetch(url, opts = {}) {
  const token = getToken();
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
  });
  if (res.status === 401) {
    localStorage.removeItem("auth_token");
    document.getElementById("loginModal").classList.remove("hidden");
    throw new Error("Session expired. Please log in again.");
  }
  return res;
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
    if (data.must_change_password) {
      openChangePassword(true);
    } else {
      initApp();
    }
  } catch (e) {
    errEl.textContent = "Connection error"; errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Sign In";
  }
}

let _pwChangeForced = false;

function openChangePassword(forced = false) {
  _pwChangeForced = forced;
  const modal = document.getElementById("changePasswordModal");
  document.getElementById("currentPassword").value = "";
  document.getElementById("newPassword").value = "";
  document.getElementById("confirmPassword").value = "";
  document.getElementById("changePwError").classList.add("hidden");
  document.getElementById("changePwSuccess").classList.add("hidden");
  document.getElementById("changePwSubtitle").textContent = forced
    ? "Your password was reset by admin. Set a new password to continue."
    : "Enter your current password then choose a new one.";
  document.getElementById("btnClosePwModal").classList.toggle("hidden", forced);
  modal.classList.remove("hidden");
}

function closeChangePassword() {
  if (_pwChangeForced) return;
  document.getElementById("changePasswordModal").classList.add("hidden");
}

async function doChangePassword() {
  const currentPw = document.getElementById("currentPassword").value;
  const newPw = document.getElementById("newPassword").value;
  const confirmPw = document.getElementById("confirmPassword").value;
  const errEl = document.getElementById("changePwError");
  const okEl = document.getElementById("changePwSuccess");
  errEl.classList.add("hidden"); okEl.classList.add("hidden");
  if (!currentPw) { errEl.textContent = "Enter your current password"; errEl.classList.remove("hidden"); return; }
  if (newPw.length < 6) { errEl.textContent = "New password must be at least 6 characters"; errEl.classList.remove("hidden"); return; }
  if (newPw !== confirmPw) { errEl.textContent = "Passwords do not match"; errEl.classList.remove("hidden"); return; }
  const btn = document.getElementById("btnChangePassword");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const res = await fetch("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getToken()}` },
      body: JSON.stringify({ current_password: currentPw, new_password: newPw })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Failed"; errEl.classList.remove("hidden"); return; }
    okEl.classList.remove("hidden");
    setTimeout(() => {
      document.getElementById("changePasswordModal").classList.add("hidden");
      if (_pwChangeForced) initApp();
    }, 1200);
  } catch (e) {
    errEl.textContent = "Connection error"; errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Update Password";
  }
}

document.addEventListener("keydown", e => {
  if (e.key === "Enter" && !document.getElementById("loginModal").classList.contains("hidden")) doLogin();
  if (e.key === "Enter" && !document.getElementById("changePasswordModal").classList.contains("hidden")) doChangePassword();
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

  // Sidebar user info
  const sidebar = document.getElementById("sidebarUserInfo");
  if (sidebar) {
    sidebar.classList.remove("hidden");
    document.getElementById("sidebarUsername").textContent = currentUser.username;
    document.getElementById("sidebarRole").textContent = currentUser.role;
  }
  // Show admin-only items
  if (currentUser.role === "admin") {
    document.querySelectorAll(".admin-only").forEach(el => el.classList.remove("hidden"));
  }

  // Navigate to correct page immediately — before any async calls so there's no flash
  const lastPage = localStorage.getItem("lastPage");
  const validPages = ["dashboard", "chats", "report-supervised-chats", "reports", "report-monthly", "report-total-chats", "report-campaign", "report-platform-status", "report-platform-costs", "report-agent-activity", "report-chat-transfers", "employees", "config"];
  const adminPages = ["employees", "config"];
  const startPage = validPages.includes(lastPage) && (!adminPages.includes(lastPage) || currentUser.role === "admin")
    ? lastPage : "chats";
  showPage(startPage);

  // Load agents + shifts in background (populate filter dropdowns)
  await loadAgents();
  try { const r = await authFetch("/api/agent-shifts"); agentShifts = await r.json(); } catch {}
  try { const r = await authFetch("/api/weekend-overrides"); weekendOverrides = await r.json(); } catch {}
  renderAgentFilter();
  // showPage(startPage) above ran before agentShifts finished loading, so if it landed on a
  // report page whose employee dropdown populates from agentShifts on open (e.g. after a
  // session-timeout re-login straight back into that page), that dropdown rendered empty.
  // Re-populate it now that agentShifts is actually loaded.
  const employeeFilterRepopulate = {
    "report-total-chats": populateTotalChatsAgentFilter,
    "report-chat-transfers": populateChatTransfersAgentFilter,
    "report-supervised-chats": populateSupervisedChatsAgentFilter,
    "report-agent-activity": populateAgentActivityFilter,
  };
  employeeFilterRepopulate[startPage]?.();
  loadKnowledgeStatus();
  document.getElementById("btnLoad").addEventListener("click", () => loadChats(null));
  document.getElementById("btnReviewAll").addEventListener("click", reviewAllVisible);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal")) closeModal();
  });
}

// ── Page navigation ───────────────────────────────────────────────────────────
const REPORT_PAGES = ["reports", "report-monthly", "report-total-chats", "report-campaign", "report-agent-activity", "report-chat-transfers"];
const PLATFORM_PAGES = ["report-platform-status", "report-platform-costs"];
const REVIEW_PAGES = ["chats", "report-supervised-chats"];

function toggleReviewsMenu() {
  const submenu = document.getElementById("reviews-submenu");
  const chevron = document.getElementById("reviews-chevron");
  if (!submenu) return;
  const open = !submenu.classList.contains("hidden");
  submenu.classList.toggle("hidden", open);
  if (chevron) chevron.style.transform = open ? "rotate(-90deg)" : "";
}

function toggleReportsMenu() {
  const submenu = document.getElementById("reports-submenu");
  const chevron = document.getElementById("reports-chevron");
  if (!submenu) return;
  const open = !submenu.classList.contains("hidden");
  submenu.classList.toggle("hidden", open);
  if (chevron) chevron.style.transform = open ? "rotate(-90deg)" : "";
}

function togglePlatformMenu() {
  const submenu = document.getElementById("platform-submenu");
  const chevron = document.getElementById("platform-chevron");
  if (!submenu) return;
  const open = !submenu.classList.contains("hidden");
  submenu.classList.toggle("hidden", open);
  if (chevron) chevron.style.transform = open ? "rotate(-90deg)" : "";
}

function showPage(name) {
  const pages = ["dashboard", "chats", "report-supervised-chats", "reports", "report-monthly", "report-total-chats", "report-campaign", "report-platform-status", "report-platform-costs", "report-agent-activity", "report-chat-transfers", "employees", "config"];
  pages.forEach(p => {
    document.getElementById(`page-${p}`)?.classList.add("hidden");
    const btn = document.getElementById(`nav-${p}`);
    if (btn) {
      btn.classList.remove("bg-slate-700", "text-white");
      btn.classList.add((REPORT_PAGES.includes(p) || PLATFORM_PAGES.includes(p) || REVIEW_PAGES.includes(p)) ? "text-slate-400" : "text-slate-300");
    }
  });
  document.getElementById(`page-${name}`)?.classList.remove("hidden");
  const activeBtn = document.getElementById(`nav-${name}`);
  if (activeBtn) {
    activeBtn.classList.add("bg-slate-700", "text-white");
    activeBtn.classList.remove("text-slate-300", "text-slate-400");
  }
  // Keep reports submenu open when on any reports sub-page
  if (REPORT_PAGES.includes(name)) {
    const submenu = document.getElementById("reports-submenu");
    const chevron = document.getElementById("reports-chevron");
    if (submenu) submenu.classList.remove("hidden");
    if (chevron) chevron.style.transform = "";
  }
  // Keep platform submenu open when on any platform sub-page
  if (PLATFORM_PAGES.includes(name)) {
    const submenu = document.getElementById("platform-submenu");
    const chevron = document.getElementById("platform-chevron");
    if (submenu) submenu.classList.remove("hidden");
    if (chevron) chevron.style.transform = "";
  }
  // Keep reviews submenu open when on any reviews sub-page
  if (REVIEW_PAGES.includes(name)) {
    const submenu = document.getElementById("reviews-submenu");
    const chevron = document.getElementById("reviews-chevron");
    if (submenu) submenu.classList.remove("hidden");
    if (chevron) chevron.style.transform = "";
  }
  if (name === "dashboard") loadDashboard();
  if (name === "reports") openReports();
  if (name === "report-monthly") openMonthlyOverview();
  if (name === "report-total-chats") openTotalChatsReport();
  if (name === "report-campaign") openCampaignImpactReport();
  if (name === "report-platform-status") loadPlatformStatus();
  if (name === "report-platform-costs") openPlatformCostsPage();
  if (name === "report-agent-activity") openAgentActivityPage();
  if (name === "report-chat-transfers") openChatTransfersReport();
  if (name === "report-supervised-chats") openSupervisedChatsReport();
  if (name === "employees") openSettings();
  if (name === "config") loadKnowledgeStatus();
  localStorage.setItem("lastPage", name);
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
  const kbEl = document.getElementById("kbStatus");
  if (kbEl) kbEl.textContent = "...";
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
  if (kb) {
    kb.textContent = parts.length ? parts.join(" ") : "No data";
    kb.title = `Last fetched: ${data.lastFetched || "never"}\nKnowledge: ${data.knowledge} chars\nCampaigns: ${data.campaigns} chars\nTelegram: ${data.telegram} chars\nProtocol: ${data.protocol} chars`;
  }
  updateConfigPage(data);
}

function updateConfigPage(data) {
  const fetched = data.lastFetched ? new Date(data.lastFetched).toLocaleString() : "Never";
  const badge = (chars, label) => {
    const ok = chars > 0;
    return `<span class="text-xs px-2 py-1 rounded-full ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}">${ok ? label + ' ✓ (' + Math.round(chars/1000) + 'k)' : 'No data'}</span>`;
  };
  const set = (id, chars, label) => {
    const el = document.getElementById(id);
    if (el) el.outerHTML = badge(chars, label).replace('>', ` id="${id}">`);
  };
  const setFetched = (id) => { const el = document.getElementById(id); if (el) el.textContent = fetched; };

  const kbBadge = document.getElementById("cfg-kb-badge");
  if (kbBadge) kbBadge.outerHTML = badge(data.knowledge, "KB").replace('<span', `<span id="cfg-kb-badge"`);
  const campBadge = document.getElementById("cfg-camp-badge");
  if (campBadge) campBadge.outerHTML = badge(data.campaigns, "Campaigns").replace('<span', `<span id="cfg-camp-badge"`);
  const macrosBadge = document.getElementById("cfg-macros-badge");
  if (macrosBadge) macrosBadge.outerHTML = badge(data.macros, "Macros").replace('<span', `<span id="cfg-macros-badge"`);
  const tagsBadge = document.getElementById("cfg-tags-badge");
  if (tagsBadge) tagsBadge.outerHTML = badge(data.tags, "Tags").replace('<span', `<span id="cfg-tags-badge"`);
  const protoBadge = document.getElementById("cfg-proto-badge");
  if (protoBadge) protoBadge.outerHTML = badge(data.protocol, "Protocol").replace('<span', `<span id="cfg-proto-badge"`);
  const tgBadge = document.getElementById("cfg-tg-badge");
  if (tgBadge) tgBadge.outerHTML = badge(data.telegram, "Telegram").replace('<span', `<span id="cfg-tg-badge"`);

  ["cfg-kb-fetched","cfg-camp-fetched","cfg-macros-fetched","cfg-tags-fetched","cfg-proto-fetched","cfg-tg-fetched"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = fetched;
  });
}

async function syncLcAgents() {
  const btn = document.getElementById("btnSyncAgents");
  const icon = document.getElementById("syncAgentsIcon");
  const status = document.getElementById("cfg-agents-status");
  const list = document.getElementById("cfg-agents-list");
  btn.disabled = true;
  if (icon) icon.textContent = "...";
  if (status) status.textContent = "Syncing...";
  try {
    const res = await authFetch("/api/agents");
    const data = await res.json();
    const agentArr = Array.isArray(data) ? data : (data.agents || []);
    settingsAgents = agentArr;
    agents = agentArr;
    renderAgentFilter();

    if (status) status.textContent = `${agentArr.length} agents synced from LiveChat`;
    if (list) {
      list.innerHTML = agentArr.map(a =>
        `<div class="flex items-center gap-2 px-2 py-1 rounded-lg bg-[#0a1628] text-xs text-white">
          ${a.avatar ? `<img src="${escHtml(a.avatar)}" class="w-5 h-5 rounded-full object-cover shrink-0" />` : `<div class="w-5 h-5 rounded-full bg-slate-300 shrink-0"></div>`}
          <span class="font-medium">${escHtml(a.name || "")}</span>
          <span class="text-slate-500 ml-auto">${escHtml(a.id || "")}</span>
        </div>`
      ).join("");
      list.classList.remove("hidden");
    }
    showStatus(`${agentArr.length} agents synced from LiveChat`, "success");
  } catch (e) {
    if (status) status.textContent = "Sync failed: " + e.message;
    showStatus("Agent sync failed: " + e.message, "error");
  }
  btn.disabled = false;
  if (icon) icon.textContent = "⟳";
}

async function syncCwAgents() {
  const btn = document.getElementById("btnSyncCwAgents");
  const icon = document.getElementById("syncCwAgentsIcon");
  const status = document.getElementById("cfg-cw-agents-status");
  const list = document.getElementById("cfg-cw-agents-list");
  btn.disabled = true;
  if (icon) icon.textContent = "...";
  if (status) status.textContent = "Syncing...";
  try {
    const res = await authFetch("/api/chatwoot-agents");
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.status);
    const agentArr = Array.isArray(data) ? data : [];
    cwAgents = agentArr;
    renderShiftsTable();

    if (status) status.textContent = agentArr.length
      ? `${agentArr.length} agents synced from Chatwoot`
      : "0 agents returned — check Chatwoot is enabled/configured";
    if (list) {
      list.innerHTML = agentArr.map(a =>
        `<div class="flex items-center gap-2 px-2 py-1 rounded-lg bg-[#0a1628] text-xs text-white">
          <div class="w-5 h-5 rounded-full bg-slate-300 shrink-0"></div>
          <span class="font-medium">${escHtml(a.name || "")}</span>
          <span class="text-slate-500 ml-auto">${escHtml(a.email || "")}</span>
        </div>`
      ).join("");
      list.classList.remove("hidden");
    }
    showStatus(`${agentArr.length} agents synced from Chatwoot`, "success");
  } catch (e) {
    if (status) status.textContent = "Sync failed: " + e.message;
    showStatus("Chatwoot agent sync failed: " + e.message, "error");
  }
  btn.disabled = false;
  if (icon) icon.textContent = "⟳";
}

async function refreshOneSource(source, btnEl) {
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = "…"; }
  try {
    const res = await authFetch(`/api/refresh-knowledge/${source}`, { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    updateKbStatus(data);
    showStatus(`${source} refreshed`, "success");
  } catch (e) {
    showStatus(`Refresh failed: ${e.message}`, "error");
  }
  if (btnEl) { btnEl.disabled = false; btnEl.textContent = "⟳"; }
}

async function refreshAllKnowledge() {
  const btn = document.getElementById("btnRefreshAllKb");
  const icon = document.getElementById("refreshAllIcon");
  btn.disabled = true;
  if (icon) icon.textContent = "...";
  try {
    const res = await authFetch("/api/refresh-knowledge", { method: "POST" });
    const data = await res.json();
    updateKbStatus(data);
    showStatus("All knowledge sources refreshed", "success");
  } catch (e) {
    showStatus("Refresh failed: " + e.message, "error");
  }
  btn.disabled = false;
  if (icon) icon.textContent = "⟳";
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

function agentMatchesShift(agentName, shift, platform, agentEmail) {
  if (!agentName || !shift) return false;
  if (platform === "chatwoot") {
    if (!shift.chatwootAgentId) return false;
    const cwId = shift.chatwootAgentId.toLowerCase().trim();
    // Email exact match — no hour restriction needed (unique identity)
    if (agentEmail && cwId === agentEmail.toLowerCase().trim()) return true;
    const n = agentName.toLowerCase().trim();
    return cwId === n || cwId.split("@")[0] === n || cwId === n.split("@")[0];
  }
  const k = agentName.toLowerCase().trim();
  return k === shift.agentKey || k.split(" ")[0] === shift.agentKey;
}

function applyEmployeeHourFilter(list) {
  if (!activeEmployeeShift) return list;
  // Employees sharing this shift's identity on the chat's platform — an override
  // naming one of them takes priority over everyone's static hour windows, not
  // just activeEmployeeShift's own.
  const sameKeyEmployees = agentShifts.filter(s => s.agentKey === activeEmployeeShift.agentKey).map(s => s.employee);
  const sameCwIdEmployees = activeEmployeeShift.chatwootAgentId
    ? agentShifts.filter(s => s.chatwootAgentId && s.chatwootAgentId.toLowerCase().trim() === activeEmployeeShift.chatwootAgentId.toLowerCase().trim()).map(s => s.employee)
    : [activeEmployeeShift.employee];
  return list.filter(c => {
    const chatAgents = c.agents || [];
    if (!chatAgents.some(a => agentMatchesShift(a.name, activeEmployeeShift, c.platform, a.email))) return false;
    const h = getTehranHour(c.started_at);
    const candidates = c.platform === "chatwoot" ? sameCwIdEmployees : sameKeyEmployees;
    const overrideEmp = findOverrideEmployee(c.platform, getIstanbulDayKey(c.started_at), h, candidates);
    if (overrideEmp) return overrideEmp === activeEmployeeShift.employee;
    return h >= activeEmployeeShift.start && h < activeEmployeeShift.end;
  });
}

// ── Chatwoot integration ──────────────────────────────────────────────────────
async function fetchChatwootChats(from, to) {
  try {
    const params = new URLSearchParams();
    if (from) params.set("date_from", iranDayToUtc(from, false));
    if (to)   params.set("date_to",   iranDayToUtc(to, true));
    const res = await authFetch("/api/chatwoot-chats?" + params);
    const data = await res.json();
    if (!data.enabled || !data.chats?.length) return;
    data.chats.forEach(c => {
      const k = c.thread_id || c.id;
      const idx = allChats.findIndex(x => (x.thread_id || x.id) === k && x.platform === "chatwoot");
      if (idx !== -1) allChats[idx] = c; else allChats.push(c);
    });
    totalChats += data.total_chats || 0;
    renderTable();
    updateStats();
    updateChart();
  } catch (e) {
    console.warn("[CW] fetch failed:", e.message);
  }
}

// ── Chats ─────────────────────────────────────────────────────────────────────
async function loadChats(pageId) {
  document.getElementById("statusBar").classList.add("hidden");
  const from = document.getElementById("dateFrom").value;
  const to = document.getElementById("dateTo").value;
  const agentId = resolveEmployeeFilter();

  if (!pageId) { setChatsLoading(true, "Loading chats..."); currentPage = 0; }

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
    document.getElementById("statusBar").classList.add("hidden");

    if (chats.length > 0 && currentUser?.role === "admin") {
      document.getElementById("btnReviewAll").classList.remove("hidden");
    }

    if (!pageId) {
      // Wait for all remaining LC pages + CW + cwAgents simultaneously, then hide loading
      const lcAllPages = data.next_page_id
        ? fetchAllPagesForStats(data.next_page_id, from, to, agentId)
        : Promise.resolve();

      // Ensure cwAgents is loaded (needed for modal filtering)
      const cwAgentsLoad = cwAgents.length === 0
        ? authFetch("/api/chatwoot-agents").then(r => r.json()).then(list => { if (Array.isArray(list)) cwAgents = list; }).catch(() => {})
        : Promise.resolve();

      setChatsLoading(true, "Loading all chats...");
      await Promise.all([lcAllPages, fetchChatwootChats(from, to), cwAgentsLoad]);

      updateStats();
      updateChart();
      renderTable();
      setChatsLoading(false);
    } else {
      updateStats();
    }
  } catch (e) {
    setChatsLoading(false);
    showStatus("Error: " + e.message, "error");
  }
}

function setChatsLoading(on, text) {
  const overlay = document.getElementById("chatsLoadingOverlay");
  const btn = document.getElementById("btnLoad");
  const controls = ["dateFrom","dateTo","agentFilter","platformFilter","btnRefreshList"];
  if (on) {
    overlay?.classList.remove("hidden");
    if (text) { const t = document.getElementById("chatsLoadingText"); if (t) t.textContent = text; }
    if (btn) { btn.disabled = true; btn.classList.add("opacity-50","cursor-not-allowed"); }
    controls.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
  } else {
    overlay?.classList.add("hidden");
    if (btn) { btn.disabled = false; btn.classList.remove("opacity-50","cursor-not-allowed"); }
    controls.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
  }
}

function setStatsLoading(on) {
  ["statTotal","statReviewed","statAvg","statResolved"].forEach(id => {
    const el = document.getElementById(id);
    if (on && el) el.innerHTML = `<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin align-middle"></span>`;
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
const CHATS_PAGE_SIZE = 20;

// Shared Prev/Next pager markup — gotoFnName is a global function called with the
// target 0-indexed page number, e.g. "goToChatsPage" or "goToSupervisedChatsPage".
function pagerHtml(page, totalPages, gotoFnName) {
  if (totalPages <= 1) return "";
  const prevDisabled = page <= 0;
  const nextDisabled = page >= totalPages - 1;
  return `
    <div class="flex items-center justify-between px-4 py-3 border-t border-[#1a2d4a]">
      <button onclick="${gotoFnName}(${page - 1})" ${prevDisabled ? "disabled" : ""}
        class="text-xs px-3 py-1.5 rounded-lg bg-[#1a2d4a] text-slate-300 hover:bg-[#243d61] transition disabled:opacity-40 disabled:cursor-not-allowed">← Prev</button>
      <span class="text-xs text-slate-500">Page ${page + 1} of ${totalPages}</span>
      <button onclick="${gotoFnName}(${page + 1})" ${nextDisabled ? "disabled" : ""}
        class="text-xs px-3 py-1.5 rounded-lg bg-[#1a2d4a] text-slate-300 hover:bg-[#243d61] transition disabled:opacity-40 disabled:cursor-not-allowed">Next →</button>
    </div>`;
}

function goToChatsPage(page) {
  currentPage = page;
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById("chatTableBody");
  const pagerEl = document.getElementById("pagination");
  const platformFilter = document.getElementById("platformFilter")?.value || "";
  let displayChats = applyEmployeeHourFilter(allChats);
  if (platformFilter) displayChats = displayChats.filter(c => c.platform === platformFilter);

  const countEl = document.getElementById("chatCount");
  if (countEl) {
    if (displayChats.length > 0) {
      countEl.textContent = `${displayChats.length} chats`;
      countEl.classList.remove("hidden");
    } else {
      countEl.classList.add("hidden");
    }
  }

  if (displayChats.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-12 text-slate-500">No chats found for this period</td></tr>`;
    if (pagerEl) { pagerEl.innerHTML = ""; pagerEl.classList.add("hidden"); }
    return;
  }

  const filteredAgent = activeEmployeeShift ? getAgentForShift(activeEmployeeShift) : null;
  const filteredAgentName = filteredAgent?.name || null;

  const sortedChats = [...displayChats].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  const totalPages = Math.max(1, Math.ceil(sortedChats.length / CHATS_PAGE_SIZE));
  if (currentPage >= totalPages) currentPage = totalPages - 1;
  if (currentPage < 0) currentPage = 0;
  const pageChats = sortedChats.slice(currentPage * CHATS_PAGE_SIZE, currentPage * CHATS_PAGE_SIZE + CHATS_PAGE_SIZE);

  if (pagerEl) {
    pagerEl.innerHTML = pagerHtml(currentPage, totalPages, "goToChatsPage");
    pagerEl.classList.toggle("hidden", totalPages <= 1);
  }

  tbody.innerHTML = pageChats.map(chat => {
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
      ? `<span class="text-xs text-slate-500 italic">No msg</span>`
      : displayScore != null ? scorePill(displayScore) : `<span class="text-slate-600 text-xs">—</span>`;
    const statusBadge = isSkipped
      ? `<span class="text-slate-600 text-xs">—</span>`
      : r
        ? `<span class="text-xs px-2 py-0.5 rounded-full ${displayResolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${displayResolved ? "✓" : "✗"}</span>`
        : `<span class="text-slate-600 text-xs">—</span>`;
    const langBadge = r?.language_detected ? `<span class="text-xs bg-[#1a2d4a] text-slate-300 px-2 py-0.5 rounded">${r.language_detected.toUpperCase()}</span>` : "—";
    const allAgents = chat.agents?.length > 0 ? chat.agents : (chat.agent ? [chat.agent] : []);

    // When employee filter active: show only that agent; otherwise show all
    let agentNames, employeeNameHtml;
    if (activeEmployeeShift && filteredAgentName) {
      const matchAgent = allAgents.find(a => a.name.toLowerCase() === filteredAgentName.toLowerCase());
      agentNames = matchAgent ? matchAgent.name : (filteredAgentName + " (?)");
      employeeNameHtml = `<span class="font-medium text-white">${activeEmployeeShift.employee}</span>`;
    } else {
      agentNames = allAgents.map(a => a.name).join(", ") || "—";
      const empNames = allAgents.length > 0
        ? [...new Set(allAgents.map(a => getEmployeeName(a.name, chat.started_at, chat.platform, a.email) || a.name))].join(", ")
        : "—";
      employeeNameHtml = `<span class="font-medium text-white">${empNames}</span>`;
    }

    const isAdmin = currentUser?.role === "admin";
    const isCW = chat.platform === "chatwoot";
    const reReviewBtn = isAdmin ? `<button onclick="reviewChat('${chat.id}','${chat.thread_id||''}',this)" class="text-xs text-slate-500 hover:text-orange-500 px-1" title="Re-review">↺</button>` : "";
    const actionBtn = r
      ? `<div class="flex items-center gap-1" onclick="event.stopPropagation()">
           <button onclick="openModal('${chat.id}','${chat.thread_id||''}')" class="text-xs text-[#F5B800] hover:underline">View</button>
           ${reReviewBtn}
         </div>`
      : isAdmin
        ? `<button onclick="reviewChat('${chat.id}','${chat.thread_id||''}',this)" class="text-xs bg-blue-50 text-[#F5B800] px-2 py-0.5 rounded hover:bg-blue-100">Review</button>`
        : `<span class="text-slate-600 text-xs">—</span>`;

    const platformBadge = isCW
      ? `<span class="text-xs bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded font-semibold">CW</span>`
      : `<span class="text-xs bg-blue-100 text-[#F5B800] px-1.5 py-0.5 rounded font-semibold">LC</span>`;

    const deviceIcon = chat.device === "mobile"
      ? `<span title="Agent on mobile" class="text-base leading-none">📱</span>`
      : chat.device === "desktop"
        ? `<span title="Agent on desktop" class="text-base leading-none">💻</span>`
        : `<span class="text-slate-600 text-xs">—</span>`;

    const rowKey = chat.thread_id || chat.id;
    return `<tr class="chat-row border-b border-[#1a2d4a]" id="row-${rowKey}" onclick="openModal('${chat.id}','${chat.thread_id||""}')">
      <td class="px-4 py-3">
        <div class="flex flex-col gap-0.5">
          <div class="flex items-center gap-1">
            ${platformBadge}
            <span class="font-mono text-xs text-slate-500">${chat.thread_id || chat.id}</span>
            <button onclick="event.stopPropagation();copyId('${chat.thread_id || chat.id}')" title="Copy ID" class="shrink-0 text-slate-600 hover:text-[#F5B800] px-1 text-sm leading-none">⎘</button>
          </div>
          ${!isCW && chat.id !== chat.thread_id ? `<div class="flex items-center gap-1">
            <span class="text-slate-600 text-xs">C:</span>
            <span class="font-mono text-xs text-slate-600">${chat.id}</span>
            <button onclick="event.stopPropagation();copyId('${chat.id}')" title="Copy container ID" class="shrink-0 text-slate-600 hover:text-slate-500 px-1 text-xs leading-none">⎘</button>
          </div>` : ""}
        </div>
      </td>
      <td class="px-4 py-3 font-medium text-white text-xs">${agentNames}</td>
      <td class="px-4 py-3 text-slate-300">${chat.customer_name || "—"}</td>
      <td class="px-4 py-3 text-center">${deviceIcon}</td>
      <td class="px-4 py-3 text-slate-400 text-xs">${date}</td>
      <td class="px-4 py-3 text-sm font-medium text-white">${employeeNameHtml}</td>
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

  const chatObj = allChats.find(c => (c.thread_id || c.id) === rowKey);
  const isCW = chatObj?.platform === "chatwoot";

  try {
    const url = isCW ? `/api/review/cw/${chatId}` : `/api/review/${chatId}${threadId ? `?thread_id=${threadId}` : ""}`;
    const res = await authFetch(url, { method: "POST" });
    const review = await res.json();
    if (review.error) throw new Error(review.error);

    // Update chat in local state (both paginated slice and full list)
    const chat = chats.find(c => (c.thread_id || c.id) === rowKey);
    if (chat) chat.review = review;
    const allChat = allChats.find(c => (c.thread_id || c.id) === rowKey);
    if (allChat) allChat.review = review;

    const scoreEl = document.getElementById("score-" + rowKey);
    const statusEl = document.getElementById("status-" + rowKey);

    if (review.skipped) {
      if (scoreEl) scoreEl.innerHTML = `<span class="text-xs text-slate-500 italic">No msg</span>`;
      if (statusEl) statusEl.innerHTML = `<span class="text-slate-600 text-xs">—</span>`;
      if (actionCell) actionCell.innerHTML = `<span class="text-xs text-slate-500">—</span>`;
    } else {
      if (scoreEl) scoreEl.innerHTML = scorePill(review.overall_score);
      if (statusEl) statusEl.innerHTML =
        `<span class="text-xs px-2 py-0.5 rounded-full ${review.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${review.resolved ? "✓" : "✗"}</span>`;
      const reBtn = currentUser?.role === "admin" ? `<button onclick="reviewChat('${chatId}','${threadId||''}',this)" class="text-xs text-slate-500 hover:text-orange-500 px-1" title="Re-review">↺</button>` : "";
      if (actionCell) actionCell.innerHTML = `<div class="flex items-center gap-1">
        <button onclick="openModal('${chatId}','${threadId||''}')" class="text-xs text-[#F5B800] hover:underline">View</button>
        ${reBtn}
      </div>`;
    }

    updateStats();
    updateChart();
  } catch (e) {
    const retryBtn = currentUser?.role === "admin" ? `<button onclick="reviewChat('${chatId}','${threadId||''}',this)" class="text-xs text-slate-500 hover:text-orange-500 px-1" title="Re-review">↺</button>` : "";
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
  const activePlatform = document.getElementById("platformFilter")?.value || "";
  // resolveEmployeeFilter sets activeEmployeeShift and returns LiveChat agent ID (or null)
  const agentId = resolveEmployeeFilter();
  const employeeShift = activeEmployeeShift; // snapshot for filtering

  if (activePlatform !== "chatwoot") do {
    const params = new URLSearchParams();
    if (from) params.set("date_from", iranDayToUtc(from, false));
    if (to)   params.set("date_to",   iranDayToUtc(to, true));
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
          const url = chat.platform === "chatwoot"
            ? `/api/review/cw/${chat.id}`
            : `/api/review/${chat.id}${tid ? `?thread_id=${tid}` : ""}`;
          const res = await authFetch(url, { method: "POST" });
          const review = await res.json();
          if (!review.error) {
            done++;
            const local = chats.find(c => (c.thread_id || c.id) === rk);
            if (local) local.review = review;
            const scoreEl = document.getElementById("score-" + rk);
            const statusEl = document.getElementById("status-" + rk);
            if (scoreEl) scoreEl.innerHTML = review.skipped ? `<span class="text-xs text-slate-500 italic">No msg</span>` : scorePill(review.overall_score);
            if (statusEl) statusEl.innerHTML = review.skipped ? `<span class="text-slate-600 text-xs">—</span>` :
              `<span class="text-xs px-2 py-0.5 rounded-full ${review.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${review.resolved ? "✓" : "✗"}</span>`;
            if (actionCell) actionCell.innerHTML = review.skipped ? `<span class="text-xs text-slate-500">—</span>` :
              `<div class="flex items-center gap-1"><button onclick="openModal('${chat.id}','${tid}')" class="text-xs text-[#F5B800] hover:underline">View</button></div>`;
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

  // Also review Chatwoot chats already loaded in allChats
  const cwPending = activePlatform === "livechat" ? [] : allChats.filter(c => {
    if (c.platform !== "chatwoot") return false;
    if (!c.review) return true;
    if (c.review.skipped) return false;
    if (c.review.per_agent_reviews && Object.values(c.review.per_agent_reviews).some(r => r?._error)) return true;
    return false;
  });
  const CW_BATCH = 3;
  for (let i = 0; i < cwPending.length; i += CW_BATCH) {
    const batch = cwPending.slice(i, i + CW_BATCH);
    batch.forEach(chat => {
      const cell = document.getElementById("action-" + chat.id);
      if (cell) cell.innerHTML = `<span class="spinner"></span>`;
    });
    showStatus(`Reviewing CW... ${done} done, ${failed} failed`, "info");
    await Promise.all(batch.map(async chat => {
      const actionCell = document.getElementById("action-" + chat.id);
      try {
        const res = await authFetch(`/api/review/cw/${chat.id}`, { method: "POST" });
        const review = await res.json();
        if (!review.error) {
          done++;
          const local = allChats.find(c => c.id === chat.id && c.platform === "chatwoot");
          if (local) local.review = review;
          const scoreEl = document.getElementById("score-" + chat.id);
          const statusEl = document.getElementById("status-" + chat.id);
          if (scoreEl) scoreEl.innerHTML = review.skipped ? `<span class="text-xs text-slate-500 italic">No msg</span>` : scorePill(review.overall_score);
          if (statusEl) statusEl.innerHTML = review.skipped ? `<span class="text-slate-600 text-xs">—</span>` :
            `<span class="text-xs px-2 py-0.5 rounded-full ${review.resolved ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${review.resolved ? "✓" : "✗"}</span>`;
          if (actionCell) actionCell.innerHTML = review.skipped ? `<span class="text-xs text-slate-500">—</span>` :
            `<div class="flex items-center gap-1"><button onclick="openModal('${chat.id}','${chat.id}')" class="text-xs text-[#F5B800] hover:underline">View</button></div>`;
        } else { failed++; if (actionCell) actionCell.innerHTML = `<span class="text-xs text-red-400">Failed</span>`; }
      } catch { failed++; if (actionCell) actionCell.innerHTML = `<span class="text-xs text-red-400">Error</span>`; }
    }));
    updateStats();
    updateChart();
  }

  btn.disabled = false;
  btn.textContent = "Review All with AI";
  btn.classList.replace("bg-gray-400", "bg-green-600");
  btn.classList.replace("cursor-not-allowed", "hover:bg-green-700");
  showStatus(`Done! ${done} reviewed${failed ? ", " + failed + " failed" : ""}.`, "success");
}

// ── Modal ─────────────────────────────────────────────────────────────────────
// platformOverride lets callers outside the main Chat Review page (which don't populate
// allChats) state the platform explicitly instead of relying on the allChats cache lookup.
async function openModal(chatId, threadId, platformOverride) {
  const modal = document.getElementById("modal");
  const content = document.getElementById("modalContent");
  content.innerHTML = `<div class="p-10 text-center text-slate-500">Loading…</div>`;
  modal.classList.remove("hidden");

  const rowKey = threadId || chatId;
  const cachedChat = allChats.find(c => (c.thread_id || c.id) === rowKey);
  const isCW = platformOverride ? platformOverride === "chatwoot" : cachedChat?.platform === "chatwoot";

  try {
    const res = isCW
      ? await authFetch(`/api/chatwoot-chats/${chatId}`)
      : await authFetch(`/api/chats/${chatId}${threadId ? `?thread_id=${threadId}` : ""}`);
    const chat = await res.json();
    if (chat.error) throw new Error(chat.error);

    const r = chat.review;
    const lang = { fa: "Persian", en: "English", ar: "Arabic", mixed: "Mixed" };

    // Determine if we're in employee-filtered mode
    let modalFilteredAgentName = null;
    let modalFilteredCwAgentId = null; // Chatwoot numeric agent ID for ID-based filtering
    if (activeEmployeeShift) {
      if (isCW) {
        // For Chatwoot chats: find agent by chatwootAgentId (email or name) in cwAgents
        const cwId = (activeEmployeeShift.chatwootAgentId || "").toLowerCase().trim();
        const cwAgent = cwAgents.find(a =>
          (a.email || "").toLowerCase().trim() === cwId ||
          (a.name || "").toLowerCase().trim() === cwId
        );
        if (cwAgent) {
          modalFilteredCwAgentId = String(cwAgent.id); // use ID for reliable matching
          modalFilteredAgentName = cwAgent.name;
        } else if (cwId) {
          // cwAgents not loaded yet — fall back to name-based matching using chatwootAgentId
          modalFilteredAgentName = cwId.includes("@") ? cwId.split("@")[0] : cwId;
        }
      } else {
        modalFilteredAgentName = getAgentForShift(activeEmployeeShift)?.name || null;
      }
    }
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
      return `<div class="mb-4 border border-[#1a2d4a] rounded-xl p-4">
        ${pr.supervisor_warning ? `<div class="mb-3 bg-orange-50 border border-orange-300 rounded-lg px-3 py-2 flex gap-2">
          <span class="text-orange-500 font-bold text-xs shrink-0">⚠ Supervisor Note</span>
          <span class="text-xs text-orange-700">${escHtml(pr.supervisor_warning_text || "")}</span>
        </div>` : ""}
        <div class="flex items-center justify-between mb-3">
          <p class="text-sm font-bold text-white">${escHtml(pr.agent_name || "Agent")}</p>
          <span class="text-lg font-black ${scoreColor(pr.overall_score)}">${(pr.overall_score||0).toFixed(1)}</span>
        </div>
        ${scoreBar("Response Time", pr.response_time_score, pr.response_time_notes)}
        ${scoreBar("Tone", pr.tone_score, pr.tone_notes)}
        ${scoreBar("Accuracy", pr.accuracy_score, pr.accuracy_notes)}
        ${scoreBar("Resolution", pr.resolution_score, pr.resolution_notes)}
        ${scoreBar("Compliance", pr.compliance_score, pr.compliance_notes)}
        ${scoreBar("Product Knowledge", pr.product_knowledge_score, pr.product_knowledge_notes)}
        ${pr.notes ? `<p class="text-xs text-slate-300 mt-2 whitespace-pre-line">${escHtml(pr.notes)}</p>` : ""}
        ${pr.issues ? `<div class="mt-2 bg-red-50 border border-red-100 rounded p-2"><p class="text-xs text-red-600 whitespace-pre-line">${escHtml(Array.isArray(pr.issues) ? pr.issues.join("\n") : pr.issues)}</p></div>` : ""}
      </div>`;
    }

    let reviewHtml;
    if (!r) {
      reviewHtml = `<p class="text-slate-500 text-sm mb-4">No review yet</p>
        <button onclick="reviewChatModal('${chatId}','${threadId||''}')" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700">Review with AI</button>`;
    } else if (modalFilteredAgentName && modalPR) {
      // Employee-filtered mode: show only this agent's per-agent review
      reviewHtml = `<div>
        <p class="text-xs text-slate-500 uppercase font-semibold mb-3">Review: ${escHtml(activeEmployeeShift.employee)} (${escHtml(modalFilteredAgentName)})</p>
        ${renderPerAgentCard(modalPR)}
        <div class="mt-3 pt-3 border-t border-[#1a2d4a]">
          <p class="text-xs text-slate-500">Overall chat score: <span class="font-semibold text-slate-300">${(r.overall_score||0).toFixed(1)}</span></p>
        </div>
      </div>`;
    } else if (modalFilteredAgentName && !modalPR) {
      // No per-agent review — single-agent chat, fall back to overall review
      reviewHtml = `<div>
        <p class="text-xs text-slate-500 uppercase font-semibold mb-3">Review: ${escHtml(activeEmployeeShift.employee)} (${escHtml(modalFilteredAgentName)})</p>
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
            <p class="text-xs text-slate-400">Overall Score</p>
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
            <p class="text-xs font-semibold text-slate-400 uppercase mb-2">Tags</p>
            <div class="flex flex-wrap gap-1.5">
              ${tagged.map(t => `<span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-medium"># ${escHtml(t)}</span>`).join("")}
              ${missing.map(t => `<span class="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200 font-medium">✗ ${escHtml(t)}</span>`).join("")}
            </div>
          </div>`;
        })() : ""}
        <div class="mt-4">
          <p class="text-xs font-semibold text-slate-400 uppercase mb-1">Summary</p>
          <p class="text-sm text-white leading-relaxed">${escHtml(r.summary || "—")}</p>
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
        <div class="mt-5 border-t border-[#1a2d4a] pt-4">
          <p class="text-xs font-semibold text-slate-400 uppercase mb-3">Per-Agent Reviews</p>
          ${Object.values(r.per_agent_reviews).filter(Boolean).map(pr => renderPerAgentCard(pr)).join("")}
        </div>` : ""}
      </div>`;
    }

    // Filter messages to agent's segment when employee filter is active
    const visibleMessages = (modalFilteredAgentName || modalFilteredCwAgentId)
      ? (chat.messages || []).filter(m => {
          if (m.is_private) return true;
          if (!m.segment_agent) return true; // customer / system messages always shown
          if (modalFilteredCwAgentId) return String(m.segment_agent.id) === modalFilteredCwAgentId;
          return m.segment_agent.name?.toLowerCase() === (modalFilteredAgentName || "").toLowerCase();
        })
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
          <div class="text-xs text-slate-500 bg-[#0a1628] border border-[#1a2d4a] rounded-full px-3 py-1">
            ${escHtml(m.content)}
          </div>
        </div>`;
      return `
      <div class="flex ${m.author_type === "agent" ? "justify-end" : "justify-start"} mb-3">
        <div class="max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.author_type === "agent" ? "bg-blue-600 text-white" : "bg-[#1a2d4a] text-white"}">
          <p class="font-semibold text-xs opacity-70 mb-1">${m.author_name || ""}</p>
          <p class="leading-relaxed">${escHtml(m.content)}</p>
        </div>
      </div>`;
    }).join("") || `<p class="text-slate-500 text-sm text-center">No messages</p>`;

    content.innerHTML = `
      <div>
        <div class="flex items-start justify-between p-6 border-b">
          <div>
            <p class="text-xs text-slate-500 mb-1">Chat ID: ${chat.thread_id || chat.id}</p>
            <h2 class="text-xl font-bold text-white">${chat.customer_name || "Unknown Customer"}</h2>
            <p class="text-sm text-slate-400 mt-1">
              ${modalFilteredAgentName
                ? `Employee: <span class="font-medium text-[#F5B800]">${escHtml(activeEmployeeShift.employee)}</span> · Agent: <span class="font-medium">${escHtml(modalFilteredAgentName)}</span>`
                : `Agents: <span class="font-medium">${(chat.agents||[chat.agent]).filter(Boolean).map(a=>escHtml(a.name)).join(", ") || "—"}</span>`
              }
              · ${lang[r?.language_detected] || "Unknown language"}
              · ${chat.started_at ? new Date(chat.started_at).toLocaleString("en-GB", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : ""}
            </p>
          </div>
          <button onclick="closeModal()" class="text-slate-500 hover:text-slate-300 text-2xl leading-none">&times;</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2">
          <div id="transcriptPane" class="p-5 border-r overflow-y-auto max-h-[55vh]">
            <h3 class="font-semibold text-white mb-4 text-sm">Transcript</h3>
            ${messages}
          </div>
          <div class="p-5 overflow-y-auto max-h-[55vh]">
            <h3 class="font-semibold text-white mb-4 text-sm">AI Review</h3>
            ${reviewHtml}
          </div>
        </div>
      </div>
    `;
    // Scroll transcript to bottom so latest agent messages are visible
    const transcriptPane = document.getElementById("transcriptPane");
    if (transcriptPane) transcriptPane.scrollTop = transcriptPane.scrollHeight;
  } catch (e) {
    content.innerHTML = `<div class="p-10 text-center text-red-400">Error: ${e.message}</div>`;
  }
}

async function reviewChatModal(chatId, threadId) {
  document.getElementById("modalContent").innerHTML = `<div class="p-10 text-center text-slate-500"><span class="spinner"></span> Reviewing with AI...</div>`;
  const rowKey = threadId || chatId;
  const chatObj = allChats.find(c => (c.thread_id || c.id) === rowKey);
  const isCW = chatObj?.platform === "chatwoot";
  try {
    const url = isCW ? `/api/review/cw/${chatId}` : `/api/review/${chatId}${threadId ? `?thread_id=${threadId}` : ""}`;
    const res = await authFetch(url, { method: "POST" });
    const review = await res.json();
    if (review.error) throw new Error(review.error);
    const rowKey = threadId || chatId;
    const chat = chats.find(c => (c.thread_id || c.id) === rowKey);
    if (chat) chat.review = review;
    const allChat = allChats.find(c => (c.thread_id || c.id) === rowKey);
    if (allChat) allChat.review = review;
    renderTable();
    updateStats();
    updateChart();
    await openModal(chatId, threadId);
  } catch (e) {
    document.getElementById("modalContent").innerHTML = `<div class="p-10 text-center text-red-400">Error: ${e.message}</div>`;
  }
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
}

// ── Stats & Chart ─────────────────────────────────────────────────────────────
function updateStats() {
  if (document.getElementById("page-chats")?.classList.contains("hidden")) return;
  const filtered = applyEmployeeHourFilter(allChats);
  const reviewed = filtered.filter(c => c.review && !c.review.skipped);
  const scores = reviewed.map(c => c.review.overall_score).filter(Boolean);
  const resolved = reviewed.filter(c => c.review.resolved).length;

  document.getElementById("statTotal").textContent = filtered.length;
  document.getElementById("statReviewed").textContent = reviewed.length;
  document.getElementById("statAvg").textContent = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) + "/10" : "—";
  document.getElementById("statResolved").textContent = resolved || "—";
}

function getEmployeeName(agentName, dateStr, platform, agentEmail) {
  if (!agentName || !dateStr) return agentName || null;
  const full = agentName.toLowerCase().trim();
  const first = full.split(" ")[0];
  const h = getTehranHour(dateStr);
  const dayKey = getIstanbulDayKey(dateStr);

  if (platform === "chatwoot") {
    // Email is a unique identity on CW — match without hour check
    if (agentEmail) {
      const email = agentEmail.toLowerCase().trim();
      const m = agentShifts.find(s => s.chatwootAgentId && s.chatwootAgentId.toLowerCase().trim() === email);
      if (m) return m.employee;
    }
    // Candidates by name/email-prefix (hour applied below, unless an exact-date override wins)
    const candidates = agentShifts.filter(s => {
      if (!s.chatwootAgentId) return false;
      const cwId = s.chatwootAgentId.toLowerCase().trim();
      return cwId === full || cwId.split("@")[0] === first;
    });
    const overrideEmp = findOverrideEmployee("chatwoot", dayKey, h, candidates.map(s => s.employee));
    if (overrideEmp) return overrideEmp;
    const m2 = candidates.find(s => h >= s.start && h < s.end);
    return m2 ? m2.employee : agentName;
  }

  const candidates = agentShifts.filter(s => s.agentKey === full || s.agentKey === first);
  const overrideEmp = findOverrideEmployee("livechat", dayKey, h, candidates.map(s => s.employee));
  if (overrideEmp) return overrideEmp;
  const match = candidates.find(s => h >= s.start && h < s.end);
  return match ? match.employee : agentName;
}

function getEmployeeNameForChart(agentName, dateStr, platform, agentEmail) {
  // getEmployeeName already handles CW email match without hour check
  return getEmployeeName(agentName, dateStr, platform, agentEmail);
}

function updateChart() {
  if (document.getElementById("page-chats")?.classList.contains("hidden")) return;
  const byEmployee = {};
  const filtered = applyEmployeeHourFilter(allChats);
  const filteredAgentName = activeEmployeeShift ? getAgentForShift(activeEmployeeShift)?.name || null : null;

  // Total count: when employee filter active, use statTotal (same source as the card)
  // In all-employees mode, count from loaded chats per employee
  const totalByEmployee = {};
  if (activeEmployeeShift) {
    // Single employee selected — count = all loaded chats for this employee (matches statTotal card)
    totalByEmployee[activeEmployeeShift.employee] = filtered.length;
  }

  // Build sets for employees hidden from chart (by employee name, agentKey, and chatwootAgentId)
  const hiddenEmployees = new Set();
  const hiddenAgentKeys = new Set();
  const hiddenCwIds = new Set();
  agentShifts.filter(s => s.showInChart === false).forEach(s => {
    if (s.employee) hiddenEmployees.add(s.employee.toLowerCase());
    if (s.agentKey) hiddenAgentKeys.add(s.agentKey.toLowerCase());
    if (s.chatwootAgentId) hiddenCwIds.add(s.chatwootAgentId.toLowerCase().trim());
  });

  function isHiddenFromChart(emp, agent) {
    if (hiddenEmployees.has((emp || "").toLowerCase())) return true;
    if (agent?.id && hiddenAgentKeys.has(String(agent.id).toLowerCase())) return true;
    if (agent?.email && hiddenCwIds.has(agent.email.toLowerCase().trim())) return true;
    if (agent?.name && hiddenAgentKeys.has(agent.name.toLowerCase().trim())) return true;
    return false;
  }

  for (const chat of filtered) {
    const primaryAgent = chat.agent || chat.agents?.[0] || null;
    if (!primaryAgent) continue;
    const emp = activeEmployeeShift
      ? activeEmployeeShift.employee
      : getEmployeeNameForChart(primaryAgent.name, chat.started_at, chat.platform, primaryAgent.email);

    if (isHiddenFromChart(emp, primaryAgent)) continue; // skip employees disabled in chart

    if (!activeEmployeeShift) {
      totalByEmployee[emp] = (totalByEmployee[emp] || 0) + 1;
    }

    if (!chat.review || chat.review.skipped) continue;
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

  const labels = Object.keys(totalByEmployee);
  const counts = labels.map(n => totalByEmployee[n] || 0);
  const data = labels.map(n => byEmployee[n]?.length ? +(byEmployee[n].reduce((a,b)=>a+b,0)/byEmployee[n].length).toFixed(2) : 0);
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
        y: {
          min: 0, max: 10,
          grid: { color: "rgba(148,163,184,0.15)" },
          ticks: { color: "#ffffff", font: { size: 12 } },
        },
        x: {
          grid: { display: false },
          ticks: { color: "#ffffff", font: { size: 12 }, maxRotation: 35, minRotation: 35 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => activeEmployeeShift
              ? `Score: ${ctx.parsed.y.toFixed(1)}  |  Chats: ${counts[ctx.dataIndex]}`
              : `Score: ${ctx.parsed.y.toFixed(1)}`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 2,
          color: "#ffffff",
          font: { weight: "bold", size: 12 },
          formatter: (v, ctx) => activeEmployeeShift
            ? `${v.toFixed(1)}\n(${counts[ctx.dataIndex]})`
            : v.toFixed(1),
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  // Destroy old chart immediately so background Chat Review fetch can't resurrect it
  if (agentChart) { agentChart.destroy(); agentChart = null; }

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const label = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  // Update header
  const hdr = document.querySelector("#page-dashboard .px-6.py-4 h2");
  if (hdr) hdr.textContent = `Dashboard — ${label}`;

  // Loading state
  const refreshBtn = document.getElementById("btnDashboardRefresh");
  const refreshIcon = document.getElementById("dashRefreshIcon");
  if (refreshBtn) refreshBtn.disabled = true;
  if (refreshIcon) refreshIcon.classList.add("animate-spin");
  ["statTotal","statReviewed","statAvg","statResolved"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin align-middle"></span>`;
  });
  setChartLoading(true);

  try {
    const res = await authFetch(`/api/dashboard-stats?month=${month}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error);

    document.getElementById("statTotal").textContent = d.total_chats ?? "—";
    document.getElementById("statReviewed").textContent = d.total_reviewed ?? "—";
    document.getElementById("statAvg").textContent = d.avg_score != null ? d.avg_score + "/10" : "—";
    document.getElementById("statResolved").textContent = d.total_resolved ?? "—";

    // Chart
    setChartLoading(false);
    if (agentChart) { agentChart.destroy(); agentChart = null; }
    const ctx = document.getElementById("agentChart").getContext("2d");
    // Filter out employees where showInChart === false
    const hiddenEmpNames = new Set(agentShifts.filter(s => s.showInChart === false).map(s => s.employee.toLowerCase()));
    const emps = (d.employees || []).filter(e => !hiddenEmpNames.has((e.name || "").toLowerCase()));
    const labels = emps.map(e => e.name);
    const scores = emps.map(e => e.avg_score ?? 0);
    const totals = emps.map(e => e.total ?? 0);
    const reviewed = emps.map(e => e.reviewed ?? 0);
    const colors = scores.map(s => s >= 7 ? "#22c55e" : s >= 5 ? "#eab308" : "#ef4444");
    agentChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Avg Score", data: scores, backgroundColor: colors, borderRadius: 6 }],
      },
      options: {
        scales: {
          y: { min: 0, max: 10, grid: { color: "rgba(148,163,184,0.15)" }, ticks: { color: "#ffffff" } },
          x: { grid: { display: false }, ticks: { color: "#ffffff" } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const i = ctx.dataIndex;
                const lines = [];
                if (scores[i] > 0) lines.push(`Score: ${scores[i].toFixed(1)}`);
                lines.push(`Total Chats: ${totals[i]}`);
                if (reviewed[i] > 0) lines.push(`Reviewed: ${reviewed[i]}`);
                return lines;
              },
            },
          },
          datalabels: {
            anchor: "end", align: "end", offset: 2,
            color: "#ffffff", font: { weight: "bold", size: 12 },
            formatter: (v, ctx) => {
              const i = ctx.dataIndex;
              return (v > 0 ? v.toFixed(1) + "\n" : "") + `(${totals[i]})`;
            },
          },
        },
      },
      plugins: [ChartDataLabels],
    });
  } catch (e) {
    setChartLoading(false);
    ["statTotal","statReviewed","statAvg","statResolved"].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = "—";
    });
    if (agentChart) { agentChart.destroy(); agentChart = null; }
    showStatus("Dashboard error: " + e.message, "error");
  } finally {
    const refreshBtn = document.getElementById("btnDashboardRefresh");
    const refreshIcon = document.getElementById("dashRefreshIcon");
    if (refreshBtn) refreshBtn.disabled = false;
    if (refreshIcon) refreshIcon.classList.remove("animate-spin");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function scorePill(score) {
  const cls = score >= 7 ? "score-high" : score >= 5 ? "score-mid" : "score-low";
  return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-bold ${cls}">${score.toFixed(1)}</span>`;
}

function scoreBar(label, value, notes) {
  if (!value && value !== 0) return "";
  const pct = Math.round((value / 10) * 100);
  const barClass = value >= 7 ? "bar-green" : value >= 5 ? "bar-yellow" : "bar-red";
  return `<div class="mb-3">
    <div class="flex justify-between text-xs text-slate-400 mb-1">
      <span class="font-medium">${label}</span><span class="font-semibold text-white">${value.toFixed(1)}</span>
    </div>
    <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div>
    ${notes ? `<p class="text-xs text-slate-500 mt-1 leading-relaxed">${escHtml(notes)}</p>` : ""}
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

// Istanbul-local "YYYY-MM-DD" for a chat timestamp — matches how weekend_overrides
// (and server.js's istDayKeyFromIso) key their date-specific shift overrides.
function getIstanbulDayKey(dateStr) {
  const IST_OFFSET_MS = 3 * 60 * 60 * 1000;
  return new Date(new Date(dateStr).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Exact-date weekend shift override for this platform/day/hour, or null if none applies
// (caller should then fall back to the recurring agentShifts hour window).
// candidateEmployees scopes the lookup to whoever could plausibly own this chat's raw
// identity — without it, an unrelated employee's override for the same platform/date/
// hour under a different account would shadow the real match.
function findOverrideEmployee(platform, dayKey, hour, candidateEmployees) {
  const m = weekendOverrides.find(o => o.platform === platform && o.date === dayKey && hour >= o.start && hour < o.end && candidateEmployees.includes(o.employee));
  return m ? m.employee : null;
}

function getEmployee(agentName, dateStr) {
  if (!agentName || !dateStr) return `<span class="text-slate-600">—</span>`;
  const name = getEmployeeName(agentName, dateStr);
  return `<span class="font-medium text-white">${name}</span>`;
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
let cwAgents = [];

function cwAgentOptionsHtml(selectedEmail) {
  const sel = (selectedEmail || "").toLowerCase().trim();
  const opts = cwAgents.map(a => {
    const val = (a.email || "").toLowerCase().trim();
    const isSelected = val === sel ? "selected" : "";
    return `<option value="${escHtml(a.email)}" ${isSelected}>${escHtml(a.name)}</option>`;
  });
  return `<option value="">— CW Agent —</option>` + opts.join("");
}

async function openSettings() {
  if (agents.length > 0) settingsAgents = agents;
  const [shiftsResult, usersResult, cwAgentsResult] = await Promise.allSettled([
    authFetch("/api/agent-shifts").then(r => r.json()),
    authFetch("/api/app-users").then(r => r.json()),
    authFetch("/api/chatwoot-agents").then(r => r.json()),
  ]);

  if (cwAgentsResult.status === "fulfilled" && Array.isArray(cwAgentsResult.value)) {
    cwAgents = cwAgentsResult.value;
  } else {
    console.error("[openSettings] chatwoot-agents failed:", cwAgentsResult.reason || cwAgentsResult.value);
  }

  if (shiftsResult.status === "fulfilled" && Array.isArray(shiftsResult.value)) {
    const userMap = {}, roleMap = {};
    if (usersResult.status === "fulfilled" && Array.isArray(usersResult.value)) {
      usersResult.value.forEach(u => {
        if (u.employee_name) { userMap[u.employee_name] = u.username; roleMap[u.employee_name] = u.role || "user"; }
      });
    } else {
      console.error("[openSettings] app-users failed:", usersResult.reason || usersResult.value);
    }
    agentShifts = shiftsResult.value.map(s => ({ ...s, username: userMap[s.employee] || "", userRole: roleMap[s.employee] || "user" }));
  } else {
    console.error("[openSettings] agent-shifts failed:", shiftsResult.reason || shiftsResult.value);
  }

  renderShiftsTable();
}

function closeSettings() { /* page-based, no modal to close */ }

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
    const color = g === "General" ? "text-[#F5B800]" : g === "Social Trade" ? "text-green-600" : "text-purple-600";
    return `<label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
      <input type="checkbox" class="sr-group" value="${g}" ${checked} />
      <span class="text-xs ${color}">${g}</span>
    </label>`;
  }).join("");
}

const ALL_LANGUAGES = [
  { value: "Persian", label: "FA", color: "text-rose-600" },
  { value: "English", label: "EN", color: "text-[#F5B800]" },
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
  return `<tr class="border-b border-[#1a2d4a] shift-row">
    <td class="py-2 pr-3"><input class="sr-employee w-full border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm" value="${escHtml(s.employee || "")}" placeholder="Employee name" /></td>
    <td class="py-2 pr-3">
      <select class="sr-agent w-full border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300">
        ${agentOptionsHtml(s.agentKey || "")}
      </select>
    </td>
    <td class="py-2 pr-3">
      <select class="sr-cw-agent w-36 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-teal-300">
        ${cwAgentOptionsHtml(s.chatwootAgentId || "")}
      </select>
    </td>
    <td class="py-2 pr-3"><input class="sr-start w-16 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="23" value="${s.start ?? 8}" /></td>
    <td class="py-2 pr-3"><input class="sr-end w-16 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="24" value="${s.end ?? 16}" /></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${groupCheckboxesHtml(s.groups)}</div></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${languageCheckboxesHtml(s.languages)}</div></td>
    <td class="py-2 pr-3"><input class="sr-username w-24 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm" value="${escHtml(s.username || "")}" placeholder="username" autocomplete="off" /></td>
    <td class="py-2 pr-3"><div class="relative w-24"><input class="sr-password w-full border border-[#1a2d4a] rounded-lg px-2 py-1.5 pr-7 text-sm" type="password" placeholder="••••••" autocomplete="new-password" /><button type="button" tabindex="-1" onclick="togglePw(this)" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">👁</button></div></td>
    <td class="py-2 pr-3">
      <select class="sr-role border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300">
        <option value="user" ${(s.userRole || "user") !== "admin" ? "selected" : ""}>User</option>
        <option value="admin" ${s.userRole === "admin" ? "selected" : ""}>Admin</option>
      </select>
    </td>
    <td class="py-2 pr-3 text-center"><input type="checkbox" class="sr-show-chart w-4 h-4 accent-blue-600" ${s.showInChart !== false ? "checked" : ""} title="Show in dashboard chart" /></td>
    <td class="py-2"><button onclick="this.closest('tr').remove()" class="text-red-400 hover:text-red-600 text-lg leading-none px-1">×</button></td>
  </tr>`;
}

function addShiftRow() {
  const tbody = document.getElementById("shiftsTableBody");
  const tr = document.createElement("tr");
  tr.className = "border-b border-[#1a2d4a] shift-row";
  tr.innerHTML = `
    <td class="py-2 pr-3"><input class="sr-employee w-full border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm" value="" placeholder="Employee name" /></td>
    <td class="py-2 pr-3">
      <select class="sr-agent w-full border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300">
        ${agentOptionsHtml("")}
      </select>
    </td>
    <td class="py-2 pr-3">
      <select class="sr-cw-agent w-36 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-teal-300">
        ${cwAgentOptionsHtml("")}
      </select>
    </td>
    <td class="py-2 pr-3"><input class="sr-start w-16 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="23" value="8" /></td>
    <td class="py-2 pr-3"><input class="sr-end w-16 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm text-center" type="number" min="0" max="24" value="16" /></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${groupCheckboxesHtml([])}</div></td>
    <td class="py-2 pr-3"><div class="flex flex-col gap-1">${languageCheckboxesHtml([])}</div></td>
    <td class="py-2 pr-3"><input class="sr-username w-24 border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm" placeholder="username" autocomplete="off" /></td>
    <td class="py-2 pr-3"><div class="relative w-24"><input class="sr-password w-full border border-[#1a2d4a] rounded-lg px-2 py-1.5 pr-7 text-sm" type="password" placeholder="••••••" autocomplete="new-password" /><button type="button" tabindex="-1" onclick="togglePw(this)" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">👁</button></div></td>
    <td class="py-2 pr-3">
      <select class="sr-role border border-[#1a2d4a] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300">
        <option value="user" selected>User</option>
        <option value="admin">Admin</option>
      </select>
    </td>
    <td class="py-2 pr-3 text-center"><input type="checkbox" class="sr-show-chart w-4 h-4 accent-blue-600" checked title="Show in dashboard chart" /></td>
    <td class="py-2"><button onclick="this.closest('tr').remove()" class="text-red-400 hover:text-red-600 text-lg leading-none px-1">×</button></td>
  `;
  tbody.appendChild(tr);
}

async function saveSettings() {
  const rows = document.querySelectorAll("#shiftsTableBody .shift-row");
  const newShifts = [];
  const userUpdates = [];
  const roleUpdates = [];
  rows.forEach(row => {
    const employee = row.querySelector(".sr-employee").value.trim();
    const agentKey = row.querySelector(".sr-agent").value.trim();
    const chatwootAgentId = row.querySelector(".sr-cw-agent")?.value.trim() || "";
    const start = parseInt(row.querySelector(".sr-start").value) || 0;
    const end = parseInt(row.querySelector(".sr-end").value) || 24;
    const groups = [...row.querySelectorAll(".sr-group:checked")].map(cb => cb.value);
    const languages = [...row.querySelectorAll(".sr-lang:checked")].map(cb => cb.value);
    const username = row.querySelector(".sr-username")?.value.trim() || "";
    const password = row.querySelector(".sr-password")?.value || "";
    const role = row.querySelector(".sr-role")?.value || "user";
    const showInChart = row.querySelector(".sr-show-chart")?.checked !== false;
    if (!employee || !agentKey) return;
    newShifts.push({ employee, agentKey, chatwootAgentId, start, end, groups, languages, username, showInChart });
    if (username && password) userUpdates.push({ username, password, employee_name: employee });
    if (username) roleUpdates.push({ username, role });
  });

  try {
    const res = await authFetch("/api/agent-shifts", {
      method: "POST",
      body: JSON.stringify(newShifts),
    });
    const data = await res.json();
    if (userUpdates.length > 0) {
      await Promise.all(userUpdates.map(u =>
        authFetch("/api/app-users", { method: "POST", body: JSON.stringify(u) })
      ));
    }
    if (roleUpdates.length > 0) {
      await Promise.all(roleUpdates.map(u =>
        authFetch(`/api/app-users/${encodeURIComponent(u.username)}/role`, {
          method: "PATCH", body: JSON.stringify({ role: u.role })
        })
      ));
    }
    if (data.ok) {
      agentShifts = newShifts;
      showStatus("Saved", "success");
      renderAgentFilter();
      renderTable();
      updateChart();
    } else {
      showStatus("Save failed: " + (data.error || "unknown"), "error");
    }
  } catch (e) {
    showStatus("Save failed: " + e.message, "error");
  }
}

// ── Reports ───────────────────────────────────────────────────────────────────

function closeReports() { /* page-based */ }

let _activeReport = null;

// ── Monthly Overview ──────────────────────────────────────────────────────────

const _monthlyCharts = {};

function openMonthlyOverview() {
  const sel = document.getElementById("monthlyYear");
  if (sel && !sel.options.length) {
    const cur = new Date().getFullYear();
    for (let y = cur; y >= cur - 4; y--) {
      sel.innerHTML += `<option value="${y}">${y}</option>`;
    }
  }
  loadMonthlyOverview();
}

async function loadMonthlyOverview() {
  const year = document.getElementById("monthlyYear")?.value || new Date().getFullYear();
  const content = document.getElementById("monthlyOverviewContent");
  if (!content) return;
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Loading...</div>`;

  // Destroy old charts
  Object.values(_monthlyCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  Object.keys(_monthlyCharts).forEach(k => delete _monthlyCharts[k]);

  try {
    const res = await authFetch(`/api/reports/monthly-overview?year=${year}`);
    const data = await res.json();
    const months = data.months || {};
    const now = new Date();
    const curYearStr = now.getFullYear().toString();

    // All months of the selected year, from current (or Dec) down to Jan
    const startMonth = (year.toString() === curYearStr) ? now.getMonth() + 1 : 12;
    const monthKeys = [];
    for (let m = startMonth; m >= 1; m--) {
      monthKeys.push(`${year}-${String(m).padStart(2, "0")}`);
    }

    const hasAny = monthKeys.some(k => months[k]?.length);
    if (!hasAny) {
      content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">No reviewed chats found for ${year}.</div>`;
      return;
    }

    content.innerHTML = monthKeys.map(month => {
      const emps = months[month] || [];
      const total = emps.reduce((a, e) => a + e.count, 0);
      const chartId = `mc_${month.replace("-", "_")}`;
      const best = emps[0] || null;
      return `
        <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden">
          <div class="px-5 py-3 border-b border-[#1a2d4a] flex items-center justify-between">
            <span class="font-semibold text-white text-sm">${monthLabel(month)}</span>
            ${total ? `<span class="text-xs text-slate-500">${total} chats reviewed</span>` : `<span class="text-xs text-slate-600">No data</span>`}
          </div>
          ${best ? `
          <div class="px-5 pt-3 pb-1 flex items-center gap-1.5">
            <span class="text-yellow-400 text-sm">🏆</span>
            <span class="text-xs font-semibold text-white">${escHtml(best.name)}</span>
            <span class="text-xs text-slate-500">— ${best.avg.toFixed(1)}</span>
          </div>` : ""}
          <div class="px-4 pb-4 pt-1">
            ${emps.length
              ? `<canvas id="${chartId}" height="90"></canvas>`
              : `<p class="text-center text-slate-600 text-sm py-6">No reviewed chats</p>`}
          </div>
        </div>`;
    }).join("");

    // Render a chart for each month that has data
    for (const month of monthKeys) {
      const emps = months[month];
      if (!emps?.length) continue;
      const chartId = `mc_${month.replace("-", "_")}`;
      const canvas = document.getElementById(chartId);
      if (!canvas) continue;
      const labels = emps.map(e => e.name);
      const scores = emps.map(e => e.avg);
      const counts = emps.map(e => e.count);
      const colors = scores.map(s => s >= 7 ? "#22c55e" : s >= 5 ? "#eab308" : "#ef4444");
      _monthlyCharts[month] = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [{ label: "Avg Score", data: scores, backgroundColor: colors, borderRadius: 6 }],
        },
        options: {
          scales: {
            y: { min: 0, max: 10, grid: { color: "#f1f5f9" }, ticks: { stepSize: 2 } },
            x: { grid: { display: false } },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => `Score: ${ctx.parsed.y.toFixed(1)}  |  ${counts[ctx.dataIndex]} chats`,
              },
            },
            datalabels: {
              anchor: "end", align: "end", offset: 2,
              color: "#374151", font: { weight: "bold", size: 11 },
              formatter: (v) => v.toFixed(1),
            },
          },
        },
        plugins: [ChartDataLabels],
      });
    }
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

// ── Total Chats Report ────────────────────────────────────────────────────────

function populateTotalChatsAgentFilter() {
  const sel = document.getElementById("totalChatsAgent");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Employees</option>';
  const employees = (Array.isArray(agentShifts) ? [...agentShifts] : []).sort((a, b) => a.employee.localeCompare(b.employee));
  const seen = new Set();
  employees.forEach(s => {
    if (seen.has(s.employee)) return;
    seen.add(s.employee);
    const opt = document.createElement("option");
    opt.value = s.employee;
    opt.textContent = s.employee;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function openTotalChatsReport() {
  populateTotalChatsAgentFilter();
  const fromEl = document.getElementById("totalChatsFrom");
  const toEl = document.getElementById("totalChatsTo");
  if (fromEl && toEl && !fromEl.value && !toEl.value) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    const pad = (n) => String(n).padStart(2, "0");
    fromEl.value = `${y}-${pad(m + 1)}-01`;
    toEl.value = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  }
  const content = document.getElementById("totalChatsContent");
  if (content && !content.innerHTML.trim()) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Pick a date range and click Search.</div>`;
  }
}

let _activeTotalChatsReport = null;

async function loadTotalChatsReport() {
  const content = document.getElementById("totalChatsContent");
  if (!content) return;
  const dateFrom = document.getElementById("totalChatsFrom")?.value;
  const dateTo = document.getElementById("totalChatsTo")?.value;
  const employee = document.getElementById("totalChatsAgent")?.value || "";
  if (!dateFrom || !dateTo) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Please pick a From and To date.</div>`;
    return;
  }
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm"><span class="spinner"></span></div>`;
  _activeTotalChatsReport = null;

  try {
    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (employee) params.set("employee", employee);
    const res = await authFetch(`/api/reports/total-chats?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(data.error || res.status)}</div>`;
      return;
    }
    const employees = data.employees || [];
    if (!employees.length) {
      content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">No chats found for this range.</div>`;
      return;
    }
    _activeTotalChatsReport = { dateFrom, dateTo, employeeFilter: employee, data };
    renderTotalChatsReport(content, dateFrom, dateTo, data);
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderTotalChatsReport(content, dateFrom, dateTo, data) {
  const employees = data.employees || [];
  const rows = employees.map(e => {
    const supervised = e.supervised ?? 0;
    const pctSupervised = e.total ? (supervised / e.total) * 100 : 0;
    const mobile = e.mobile ?? 0;
    const pctMobile = e.livechat ? (mobile / e.livechat) * 100 : 0;
    return `
    <tr class="border-t border-[#1a2d4a]">
      <td class="px-4 py-2.5 text-white text-sm text-center">${escHtml(e.name)}</td>
      <td class="px-4 py-2.5 text-center text-slate-400 text-sm">${e.livechat ?? 0}</td>
      <td class="px-4 py-2.5 text-center text-slate-400 text-sm">${e.chatwoot ?? 0}</td>
      <td class="px-4 py-2.5 text-center text-[#F5B800] font-semibold text-sm">${e.total}</td>
      <td class="px-4 py-2.5 text-center text-orange-400 font-semibold text-sm">${supervised}</td>
      <td class="px-4 py-2.5 text-center text-orange-400 text-sm">${pctSupervised.toFixed(1)}%</td>
      <td class="px-4 py-2.5 text-center text-sky-400 font-semibold text-sm">${mobile}</td>
      <td class="px-4 py-2.5 text-center text-sky-400 text-sm">${pctMobile.toFixed(1)}%</td>
    </tr>`;
  }).join("");

  const grandLc = employees.reduce((s, e) => s + (e.livechat || 0), 0);
  const grandCw = employees.reduce((s, e) => s + (e.chatwoot || 0), 0);
  const grandSupervised = employees.reduce((s, e) => s + (e.supervised || 0), 0);
  const grandMobile = employees.reduce((s, e) => s + (e.mobile || 0), 0);
  const statCard = (label, val, color) => `
    <div class="bg-[#0f1d35] rounded-xl border border-[#1a2d4a] p-4 text-center">
      <div class="text-xs text-slate-500 uppercase font-medium mb-1">${label}</div>
      <div class="text-xl font-bold" style="color:${color}">${val}</div>
    </div>`;

  content.innerHTML = `
    <div class="grid grid-cols-5 gap-4 mb-5">
      ${statCard("LiveChat", grandLc, "#94a3b8")}
      ${statCard("Chatwoot", grandCw, "#94a3b8")}
      ${statCard("Total", data.total_chats, "#F5B800")}
      ${statCard("Needed Help", grandSupervised, "#fb923c")}
      ${statCard("Mobile", grandMobile, "#38bdf8")}
    </div>
    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden">
      <div class="px-5 py-3 border-b border-[#1a2d4a] flex items-center justify-between">
        <span class="font-semibold text-white text-sm">${escHtml(dateFrom)} → ${escHtml(dateTo)}</span>
        <span class="text-xs text-slate-500">${data.total_chats} total chats</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="text-center text-xs text-slate-500 uppercase">
              <th class="px-4 py-2 font-medium">Employee</th>
              <th class="px-4 py-2 font-medium">LiveChat</th>
              <th class="px-4 py-2 font-medium">Chatwoot</th>
              <th class="px-4 py-2 font-medium">Total</th>
              <th class="px-4 py-2 font-medium" title="Chats with a supervisor/internal note — needed help from another person">Needed Help</th>
              <th class="px-4 py-2 font-medium">% Needed Help</th>
              <th class="px-4 py-2 font-medium" title="LiveChat chats answered from the LiveChat mobile app (Chatwoot doesn't expose device info)">Mobile</th>
              <th class="px-4 py-2 font-medium">% Mobile</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── PDF letterhead (Opo Finance branding) ─────────────────────────────────────

const OPO_BRAND_BLUE = "#1e70ff";
const OPO_LOGO_DATA_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDMwIDMwIiBmaWxsPSJub25lIj48cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTE0Ljk5OTggMEMyMy4yODQxIDAgMzAgNi43MTU1OCAzMCAxNC45OTk4QzMwIDIzLjI4NDEgMjMuMjg0MSAzMCAxNC45OTk4IDMwQzYuNzE1NTggMzAgMCAyMy4yODQxIDAgMTQuOTk5OEMzLjg4MjM0ZS0wNSA2LjcxNTYgNi43MTU2IDMuNTAzMThlLTA1IDE0Ljk5OTggMFpNMTQuOTg1OCAxLjE4NjczQzEzLjA5NzggMS4xODY3MyAxMS41Nzg1IDIuNzA2MDQgOC41Mzk5MyA1Ljc0NDY0TDUuNzQ0NjQgOC41Mzk5M0MyLjcwNjA0IDExLjU3ODUgMS4xODY3MyAxMy4wOTc4IDEuMTg2NzMgMTQuOTg1OEMxLjE4NjczIDE2Ljg3MzcgMi43MDYwNCAxOC4zOTMgNS43NDQ2NCAyMS40MzE3TDguNTM5OTMgMjQuMjI2OUMxMS41Nzg1IDI3LjI2NTUgMTMuMDk3OCAyOC43ODQ5IDE0Ljk4NTggMjguNzg0OUMxNi44NzM3IDI4Ljc4NDggMTguMzkzIDI3LjI2NTUgMjEuNDMxNyAyNC4yMjY5TDI0LjIyNjkgMjEuNDMxN0MyNy4yNjU1IDE4LjM5MzEgMjguNzg0OSAxNi44NzM3IDI4Ljc4NDkgMTQuOTg1OEMyOC43ODQ5IDEzLjA5NzggMjcuMjY1NSAxMS41Nzg1IDI0LjIyNjkgOC41Mzk5M0wyMS40MzE3IDUuNzQ0NjRDMTguMzkzIDIuNzA2MDQgMTYuODczNyAxLjE4NjczIDE0Ljk4NTggMS4xODY3M1oiIGZpbGw9IndoaXRlIj48L3BhdGg+PC9zdmc+";

// Dark theme shared across all PDF exports — matches opo.com's own dark navy site
// and this panel's own dark UI, instead of a plain white printout.
const PDF_BG        = "#0a1628";
const PDF_CARD_BG   = "#0f1d35";
const PDF_BORDER    = "#1a2d4a";
const PDF_TEXT      = "#f1f5f9";
const PDF_TEXT_DIM  = "#94a3b8";
const PDF_TEXT_BODY = "#cbd5e1";

// Forces background colors/images to actually print — browsers strip them by default
// unless "Background graphics" is checked in the print dialog, and this CSS overrides that.
const PDF_FORCE_PRINT_COLORS_CSS = `* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }`;

function opoLetterheadHtml() {
  return `
<div style="display:flex;align-items:center;justify-content:center;gap:9px;margin-bottom:8mm">
  <div style="width:32px;height:32px;border-radius:9px;background:${OPO_BRAND_BLUE};display:flex;align-items:center;justify-content:center;flex-shrink:0">
    <img src="${OPO_LOGO_DATA_URI}" style="width:18px;height:18px;display:block" />
  </div>
  <div>
    <div style="font-size:12.5px;font-weight:900;color:${PDF_TEXT};letter-spacing:.03em;line-height:1.1">OPO FINANCE</div>
    <div style="font-size:7px;color:${PDF_TEXT_DIM};letter-spacing:.09em;text-transform:uppercase;margin-top:1px;text-align:center">Support Quality Report</div>
  </div>
</div>`;
}

async function backfillTotalChats() {
  const dateFrom = document.getElementById("totalChatsFrom")?.value;
  const dateTo = document.getElementById("totalChatsTo")?.value;
  if (!dateFrom || !dateTo) { showStatus("Pick a From and To date first", "error"); return; }

  const btn = document.getElementById("btnBackfillTotalChats");
  const icon = document.getElementById("backfillTotalChatsIcon");
  btn.disabled = true;
  if (icon) icon.textContent = "…";

  try {
    const res = await authFetch("/api/reports/total-chats/backfill", {
      method: "POST",
      body: JSON.stringify({ date_from: dateFrom, date_to: dateTo }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.status);

    if (data.already_running) {
      showStatus("A backfill is already running in the background...", "success");
    } else {
      showStatus(`Backfill started for ${data.days_total} day(s) — running in the background, this can take a while`, "success");
    }

    const poll = setInterval(async () => {
      try {
        const sres = await authFetch("/api/reports/total-chats/backfill/status");
        const sdata = await sres.json();
        if (!sdata.running) {
          clearInterval(poll);
          showStatus(`Backfill done — ${sdata.days_total} day(s), ${sdata.employees} employee(s)`, "success");
          btn.disabled = false;
          if (icon) icon.textContent = "⏬";
          loadTotalChatsReport();
        } else {
          showStatus(`Backfilling... ${sdata.days_done}/${sdata.days_total} day(s) done`, "success");
        }
      } catch (e) { /* transient poll error, keep trying */ }
    }, 4000);
  } catch (e) {
    showStatus("Backfill failed: " + e.message, "error");
    btn.disabled = false;
    if (icon) icon.textContent = "⏬";
  }
}

function downloadTotalChatsPdf() {
  if (!_activeTotalChatsReport) { showStatus("Run a search first", "error"); return; }
  const { dateFrom, dateTo, employeeFilter, data } = _activeTotalChatsReport;
  const employees = data.employees || [];
  const grandLc = employees.reduce((s, e) => s + (e.livechat || 0), 0);
  const grandCw = employees.reduce((s, e) => s + (e.chatwoot || 0), 0);
  const grandSupervised = employees.reduce((s, e) => s + (e.supervised || 0), 0);
  const grandMobile = employees.reduce((s, e) => s + (e.mobile || 0), 0);

  const win = window.open("", "_blank");
  if (!win) { showStatus("Allow popups to download PDF", "error"); return; }

  const rows = employees.map((e, i) => {
    const supervised = e.supervised ?? 0;
    const pctSupervised = e.total ? (supervised / e.total) * 100 : 0;
    const mobile = e.mobile ?? 0;
    const pctMobile = e.livechat ? (mobile / e.livechat) * 100 : 0;
    return `
    <tr style="background:${i % 2 ? PDF_CARD_BG : PDF_BG}">
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;color:${PDF_TEXT};text-align:center">${escHtml(e.name)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;color:${PDF_TEXT_DIM};text-align:center">${e.livechat ?? 0}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;color:${PDF_TEXT_DIM};text-align:center">${e.chatwoot ?? 0}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;font-weight:700;color:#ffffff;text-align:center">${e.total}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;font-weight:700;color:#fb923c;text-align:center">${supervised}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;color:#fb923c;text-align:center">${pctSupervised.toFixed(1)}%</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;font-weight:700;color:#38bdf8;text-align:center">${mobile}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;color:#38bdf8;text-align:center">${pctMobile.toFixed(1)}%</td>
    </tr>`;
  }).join("");

  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Total Chats — ${escHtml(dateFrom)} to ${escHtml(dateTo)}</title>
<style>
  @page { size: A4 portrait; margin: 1.5cm 16mm; background: ${PDF_BG}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${PDF_FORCE_PRINT_COLORS_CSS}
  html { background: ${PDF_BG}; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: ${PDF_TEXT_BODY}; background: ${PDF_BG}; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
       color: ${PDF_TEXT_DIM}; text-align: center; padding: 8px 10px; border-bottom: 2px solid ${OPO_BRAND_BLUE}; }
  th.num { text-align: center; }
  .footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid ${PDF_BORDER};
            font-size: 8px; color: ${PDF_TEXT_DIM}; text-align: center; }
</style>
</head><body>
${opoLetterheadHtml()}
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${OPO_BRAND_BLUE};padding-bottom:10px;margin-bottom:14px">
  <div>
    <div style="font-size:20px;font-weight:900;color:${PDF_TEXT};line-height:1.1">Total Chats Report</div>
    <div style="font-size:11px;color:${PDF_TEXT_DIM};margin-top:4px">${escHtml(dateFrom)} → ${escHtml(dateTo)}${employeeFilter ? ` · ${escHtml(employeeFilter)}` : ""}</div>
  </div>
  <div style="background:#132a4d;color:#7fb0ff;font-size:9px;font-weight:700;text-transform:uppercase;
              letter-spacing:.06em;padding:4px 10px;border-radius:6px;white-space:nowrap;margin-top:4px">
    Generated ${new Date().toLocaleDateString()}
  </div>
</div>

<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px">
  ${[
    ["LiveChat", grandLc, PDF_TEXT_BODY],
    ["Chatwoot", grandCw, PDF_TEXT_BODY],
    ["Total", data.total_chats, OPO_BRAND_BLUE],
    ["Needed Help", grandSupervised, "#fb923c"],
    ["Mobile", grandMobile, "#38bdf8"],
  ].map(([l,v,c]) => `<div style="background:${PDF_CARD_BG};border:1px solid ${PDF_BORDER};border-radius:8px;padding:10px 6px;text-align:center">
    <div style="font-size:8px;color:${PDF_TEXT_DIM};text-transform:uppercase;font-weight:700;letter-spacing:.04em;margin-bottom:5px">${l}</div>
    <div style="font-size:18px;font-weight:900;color:${c}">${v}</div>
  </div>`).join("")}
</div>

<table>
  <thead>
    <tr>
      <th>Employee</th>
      <th class="num">LiveChat</th>
      <th class="num">Chatwoot</th>
      <th class="num">Total</th>
      <th class="num">Needed Help</th>
      <th class="num">% Needed Help</th>
      <th class="num">Mobile</th>
      <th class="num">% Mobile</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">Chat Review Dashboard — Total Chats Report · ${escHtml(dateFrom)} → ${escHtml(dateTo)}</div>

<script>setTimeout(() => window.print(), 350)<\/script>
</body></html>`);
  win.document.close();
}

// ── Chat Transfers Report ──────────────────────────────────────────────────────

let _activeChatTransfersReport = null;

function populateChatTransfersAgentFilter() {
  const sel = document.getElementById("transfersAgent");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Employees</option>';
  const employees = (Array.isArray(agentShifts) ? [...agentShifts] : []).sort((a, b) => a.employee.localeCompare(b.employee));
  const seen = new Set();
  employees.forEach(s => {
    if (seen.has(s.employee)) return;
    seen.add(s.employee);
    const opt = document.createElement("option");
    opt.value = s.employee;
    opt.textContent = s.employee;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function openChatTransfersReport() {
  populateChatTransfersAgentFilter();
  const fromEl = document.getElementById("transfersFrom");
  const toEl = document.getElementById("transfersTo");
  if (fromEl && toEl && !fromEl.value && !toEl.value) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    const pad = (n) => String(n).padStart(2, "0");
    fromEl.value = `${y}-${pad(m + 1)}-01`;
    toEl.value = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  }
  const content = document.getElementById("transfersContent");
  if (content && !content.innerHTML.trim()) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Pick a date range and click Search.</div>`;
  }
}

async function loadChatTransfersReport() {
  const content = document.getElementById("transfersContent");
  if (!content) return;
  const dateFrom = document.getElementById("transfersFrom")?.value;
  const dateTo = document.getElementById("transfersTo")?.value;
  const employee = document.getElementById("transfersAgent")?.value || "";
  if (!dateFrom || !dateTo) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Please pick a From and To date.</div>`;
    return;
  }
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm"><span class="spinner"></span></div>`;
  _activeChatTransfersReport = null;

  try {
    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (employee) params.set("employee", employee);
    const res = await authFetch(`/api/reports/chat-transfers?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(data.error || res.status)}</div>`;
      return;
    }
    const employees = data.employees || [];
    if (!employees.length) {
      content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">No chats found for this range.</div>`;
      return;
    }
    _activeChatTransfersReport = { dateFrom, dateTo, employeeFilter: employee, data };
    renderChatTransfersReport(content, dateFrom, dateTo, data);
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderChatTransfersReport(content, dateFrom, dateTo, data) {
  const employees = data.employees || [];
  const rows = employees.map(e => {
    const pctTransferred = e.total ? (e.transferred / e.total) * 100 : 0;
    return `
    <tr class="border-t border-[#1a2d4a]">
      <td class="px-4 py-2.5 text-white text-sm text-center">${escHtml(e.name)}</td>
      <td class="px-4 py-2.5 text-center text-[#F5B800] font-semibold text-sm">${e.total}</td>
      <td class="px-4 py-2.5 text-center text-emerald-400 font-semibold text-sm">${e.answered}</td>
      <td class="px-4 py-2.5 text-center text-rose-400 font-semibold text-sm">${e.transferred}</td>
      <td class="px-4 py-2.5 text-center text-rose-400 text-sm">${pctTransferred.toFixed(1)}%</td>
    </tr>`;
  }).join("");

  const grandTotal = employees.reduce((s, e) => s + e.total, 0);
  const grandAnswered = employees.reduce((s, e) => s + e.answered, 0);
  const grandTransferred = employees.reduce((s, e) => s + e.transferred, 0);
  const statCard = (label, val, color) => `
    <div class="bg-[#0f1d35] rounded-xl border border-[#1a2d4a] p-4 text-center">
      <div class="text-xs text-slate-500 uppercase font-medium mb-1">${label}</div>
      <div class="text-xl font-bold" style="color:${color}">${val}</div>
    </div>`;

  content.innerHTML = `
    <div class="grid grid-cols-3 gap-4 mb-5">
      ${statCard("Total (LiveChat)", grandTotal, "#F5B800")}
      ${statCard("Answered Solo", grandAnswered, "#34d399")}
      ${statCard("Transferred", grandTransferred, "#fb7185")}
    </div>
    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden">
      <div class="px-5 py-3 border-b border-[#1a2d4a] flex items-center justify-between">
        <span class="font-semibold text-white text-sm">${escHtml(dateFrom)} → ${escHtml(dateTo)}</span>
        <span class="text-xs text-slate-500">${grandTotal} total chats</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="text-center text-xs text-slate-500 uppercase">
              <th class="px-4 py-2 font-medium">Employee</th>
              <th class="px-4 py-2 font-medium">Total</th>
              <th class="px-4 py-2 font-medium" title="Only this employee ever sent a message in the chat">Answered Solo</th>
              <th class="px-4 py-2 font-medium" title="More than one agent sent a message in the chat">Transferred</th>
              <th class="px-4 py-2 font-medium">% Transferred</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function downloadChatTransfersPdf() {
  if (!_activeChatTransfersReport) { showStatus("Run a search first", "error"); return; }
  const { dateFrom, dateTo, employeeFilter, data } = _activeChatTransfersReport;
  const employees = data.employees || [];
  const grandTotal = employees.reduce((s, e) => s + e.total, 0);
  const grandAnswered = employees.reduce((s, e) => s + e.answered, 0);
  const grandTransferred = employees.reduce((s, e) => s + e.transferred, 0);

  const win = window.open("", "_blank");
  if (!win) { showStatus("Allow popups to download PDF", "error"); return; }

  const rows = employees.map((e, i) => {
    const pctTransferred = e.total ? (e.transferred / e.total) * 100 : 0;
    return `
    <tr style="background:${i % 2 ? PDF_CARD_BG : PDF_BG}">
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;color:${PDF_TEXT};text-align:center">${escHtml(e.name)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;font-weight:700;color:#ffffff;text-align:center">${e.total}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;font-weight:700;color:#34d399;text-align:center">${e.answered}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;font-weight:700;color:#fb7185;text-align:center">${e.transferred}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10.5px;color:#fb7185;text-align:center">${pctTransferred.toFixed(1)}%</td>
    </tr>`;
  }).join("");

  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Chat Transfers — ${escHtml(dateFrom)} to ${escHtml(dateTo)}</title>
<style>
  @page { size: A4 portrait; margin: 1.5cm 16mm; background: ${PDF_BG}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${PDF_FORCE_PRINT_COLORS_CSS}
  html { background: ${PDF_BG}; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: ${PDF_TEXT_BODY}; background: ${PDF_BG}; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
       color: ${PDF_TEXT_DIM}; text-align: center; padding: 8px 10px; border-bottom: 2px solid ${OPO_BRAND_BLUE}; }
  th.num { text-align: center; }
  .footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid ${PDF_BORDER};
            font-size: 8px; color: ${PDF_TEXT_DIM}; text-align: center; }
</style>
</head><body>
${opoLetterheadHtml()}
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${OPO_BRAND_BLUE};padding-bottom:10px;margin-bottom:14px">
  <div>
    <div style="font-size:20px;font-weight:900;color:${PDF_TEXT};line-height:1.1">Chat Transfers Report</div>
    <div style="font-size:11px;color:${PDF_TEXT_DIM};margin-top:4px">${escHtml(dateFrom)} → ${escHtml(dateTo)}${employeeFilter ? ` · ${escHtml(employeeFilter)}` : ""} · LiveChat only</div>
  </div>
  <div style="background:#132a4d;color:#7fb0ff;font-size:9px;font-weight:700;text-transform:uppercase;
              letter-spacing:.06em;padding:4px 10px;border-radius:6px;white-space:nowrap;margin-top:4px">
    Generated ${new Date().toLocaleDateString()}
  </div>
</div>

<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
  ${[
    ["Total (LiveChat)", grandTotal, OPO_BRAND_BLUE],
    ["Answered Solo", grandAnswered, "#34d399"],
    ["Transferred", grandTransferred, "#fb7185"],
  ].map(([l,v,c]) => `<div style="background:${PDF_CARD_BG};border:1px solid ${PDF_BORDER};border-radius:8px;padding:10px 6px;text-align:center">
    <div style="font-size:8px;color:${PDF_TEXT_DIM};text-transform:uppercase;font-weight:700;letter-spacing:.04em;margin-bottom:5px">${l}</div>
    <div style="font-size:18px;font-weight:900;color:${c}">${v}</div>
  </div>`).join("")}
</div>

<table>
  <thead>
    <tr>
      <th>Employee</th>
      <th class="num">Total</th>
      <th class="num">Answered Solo</th>
      <th class="num">Transferred</th>
      <th class="num">% Transferred</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">Chat Review Dashboard — Chat Transfers Report · ${escHtml(dateFrom)} → ${escHtml(dateTo)}</div>

<script>setTimeout(() => window.print(), 350)<\/script>
</body></html>`);
  win.document.close();
}

// ── Supervised Chats Report ────────────────────────────────────────────────────
let _activeSupervisedChatsReport = null;
let _supervisedChatsPage = 0;

function goToSupervisedChatsPage(page) {
  if (!_activeSupervisedChatsReport) return;
  _supervisedChatsPage = page;
  const { dateFrom, dateTo, data } = _activeSupervisedChatsReport;
  renderSupervisedChatsReport(document.getElementById("supervisedContent"), dateFrom, dateTo, data);
}

function populateSupervisedChatsAgentFilter() {
  const sel = document.getElementById("supervisedAgent");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Employees</option>';
  const employees = (Array.isArray(agentShifts) ? [...agentShifts] : []).sort((a, b) => a.employee.localeCompare(b.employee));
  const seen = new Set();
  employees.forEach(s => {
    if (seen.has(s.employee)) return;
    seen.add(s.employee);
    const opt = document.createElement("option");
    opt.value = s.employee;
    opt.textContent = s.employee;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function openSupervisedChatsReport() {
  populateSupervisedChatsAgentFilter();
  const fromEl = document.getElementById("supervisedFrom");
  const toEl = document.getElementById("supervisedTo");
  if (fromEl && toEl && !fromEl.value && !toEl.value) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    const pad = (n) => String(n).padStart(2, "0");
    fromEl.value = `${y}-${pad(m + 1)}-01`;
    toEl.value = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  }
  const content = document.getElementById("supervisedContent");
  if (content && !content.innerHTML.trim()) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Pick a date range and click Search.</div>`;
  }
}

async function loadSupervisedChatsReport() {
  const content = document.getElementById("supervisedContent");
  if (!content) return;
  const dateFrom = document.getElementById("supervisedFrom")?.value;
  const dateTo = document.getElementById("supervisedTo")?.value;
  const employee = document.getElementById("supervisedAgent")?.value || "";
  if (!dateFrom || !dateTo) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Please pick a From and To date.</div>`;
    return;
  }
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm"><span class="spinner"></span> This scans every chat in range for supervisor notes — can take a while for wide ranges.</div>`;
  _activeSupervisedChatsReport = null;
  _supervisedChatsPage = 0;

  try {
    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (employee) params.set("employee", employee);
    const res = await authFetch(`/api/reports/supervised-chats?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(data.error || res.status)}</div>`;
      return;
    }
    _activeSupervisedChatsReport = { dateFrom, dateTo, employeeFilter: employee, data };
    renderSupervisedChatsReport(content, dateFrom, dateTo, data);
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderSupervisedChatsReport(content, dateFrom, dateTo, data) {
  const chats = data.chats || [];
  if (!chats.length) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">No supervised chats found for this range.</div>`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(chats.length / CHATS_PAGE_SIZE));
  if (_supervisedChatsPage >= totalPages) _supervisedChatsPage = totalPages - 1;
  if (_supervisedChatsPage < 0) _supervisedChatsPage = 0;
  const pageChats = chats.slice(_supervisedChatsPage * CHATS_PAGE_SIZE, _supervisedChatsPage * CHATS_PAGE_SIZE + CHATS_PAGE_SIZE);

  const rows = pageChats.map(c => {
    const dateLabel = c.date ? new Date(c.date).toLocaleString() : "—";
    return `
    <tr class="border-t border-[#1a2d4a] align-top">
      <td class="px-4 py-2.5 text-white text-sm text-center">${escHtml(c.employee || "—")}</td>
      <td class="px-4 py-2.5 text-slate-400 text-sm text-center">${escHtml(c.agent_name || "—")}</td>
      <td class="px-4 py-2.5 text-slate-400 text-xs text-center whitespace-nowrap">${escHtml(dateLabel)}</td>
      <td class="px-4 py-2.5 text-[#F5B800] text-sm text-center">${escHtml(c.reviewed_by || "—")}</td>
      <td class="px-4 py-2.5 text-slate-300 text-sm max-w-md">
        <div class="line-clamp-2" title="${escHtml(c.note || "")}">${escHtml(c.note || "—")}</div>
      </td>
      <td class="px-4 py-2.5 text-center">
        <button onclick="openModal('${c.chat_id}','${c.thread_id || ''}','${c.platform}')" class="text-xs text-[#F5B800] hover:underline">View</button>
      </td>
    </tr>`;
  }).join("");

  content.innerHTML = `
    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden">
      <div class="px-5 py-3 border-b border-[#1a2d4a] flex items-center justify-between">
        <span class="font-semibold text-white text-sm">${escHtml(dateFrom)} → ${escHtml(dateTo)}</span>
        <span class="text-xs text-slate-500">${chats.length} supervised chat${chats.length === 1 ? "" : "s"}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="text-center text-xs text-slate-500 uppercase">
              <th class="px-4 py-2 font-medium">Employee</th>
              <th class="px-4 py-2 font-medium">Agent</th>
              <th class="px-4 py-2 font-medium">Date</th>
              <th class="px-4 py-2 font-medium">Reviewed By</th>
              <th class="px-4 py-2 font-medium">Note</th>
              <th class="px-4 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${pagerHtml(_supervisedChatsPage, totalPages, "goToSupervisedChatsPage")}
    </div>`;
}

// ── Campaign Impact Report ────────────────────────────────────────────────────

let _activeCampaignReport = null;
let _campCompareChart = null;
let _campDailyChart = null;

function openCampaignImpactReport() {
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();

  const curFromEl = document.getElementById("campCurrentFrom");
  const curToEl = document.getElementById("campCurrentTo");
  const baseFromEl = document.getElementById("campBaselineFrom");
  const baseToEl = document.getElementById("campBaselineTo");
  const startEl = document.getElementById("campStart");
  const endEl = document.getElementById("campEnd");

  if (curFromEl && !curFromEl.value) {
    curFromEl.value = `${y}-${pad(m + 1)}-01`;
    const currentToStr = `${y}-${pad(m + 1)}-${pad(now.getDate())}`;
    curToEl.value = currentToStr;

    const prev = new Date(y, m - 1, 1);
    const py = prev.getFullYear(), pm = prev.getMonth();
    const prevLastDay = new Date(py, pm + 1, 0).getDate();
    baseFromEl.value = `${py}-${pad(pm + 1)}-01`;
    baseToEl.value = `${py}-${pad(pm + 1)}-${pad(prevLastDay)}`;

    const daysInMonth = new Date(y, m + 1, 0).getDate();
    startEl.value = `${y}-${pad(m + 1)}-${pad(Math.min(21, daysInMonth))}`;
    // Campaign still running by default — ends at the current period's end date
    endEl.value = currentToStr;
  }
  const content = document.getElementById("campaignContent");
  if (content && !content.innerHTML.trim()) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Pick your date ranges and click Search.</div>`;
  }
}

function pctChange(from, to) {
  if (!from) return to ? 100 : 0;
  return ((to - from) / from) * 100;
}

function buildCampaignNarrative(data) {
  const { baseline, current, pre_campaign, during_campaign, post_campaign, campaign_start, campaign_end, employees } = data;
  const totalChange = pctChange(baseline.total, current.total);
  const preAvg = pre_campaign.days ? pre_campaign.total / pre_campaign.days : 0;
  const duringAvg = during_campaign.days ? during_campaign.total / during_campaign.days : 0;
  const postAvg = post_campaign.days ? post_campaign.total / post_campaign.days : 0;
  const avgChange = pctChange(preAvg, duringAvg);
  const top = employees[0];

  const parts = [];
  parts.push(`Total chats ${totalChange >= 0 ? "rose" : "fell"} from ${baseline.total} (${escHtml(baseline.date_from)} to ${escHtml(baseline.date_to)}) to ${current.total} (${escHtml(current.date_from)} to ${escHtml(current.date_to)}), a ${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(1)}% change.`);
  parts.push(`During the campaign window (${escHtml(campaign_start)} to ${escHtml(campaign_end)}), daily volume averaged ${duringAvg.toFixed(1)} chats/day, versus ${preAvg.toFixed(1)} chats/day beforehand — a ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}% change in daily load, consistent with the campaign launch.`);
  if (post_campaign.days > 0) {
    const postChange = pctChange(preAvg, postAvg);
    parts.push(`Since the campaign ended, daily volume has averaged ${postAvg.toFixed(1)} chats/day (${postChange >= 0 ? "+" : ""}${postChange.toFixed(1)}% vs. the pre-campaign baseline), ${Math.abs(postChange) <= 15 ? "indicating volume has largely returned to normal" : postChange > 0 ? "still elevated above pre-campaign levels" : "below pre-campaign levels"}.`);
  }
  if (top) {
    parts.push(`${escHtml(top.name)} handled the most chats during the campaign window (${top.during_campaign_total}), out of ${top.total} total chats in the current period.`);
  }
  return parts.join(" ");
}

// Bullet-point takeaways — what can be read off the charts/tables below, spelled out
// for a reader who wasn't in the room (e.g. broker management).
function buildCampaignKeyFindings(data) {
  const { baseline, current, pre_campaign, during_campaign, post_campaign, campaign_start, campaign_end, employees } = data;
  const totalChange = pctChange(baseline.total, current.total);
  const preAvg = pre_campaign.days ? pre_campaign.total / pre_campaign.days : 0;
  const duringAvg = during_campaign.days ? during_campaign.total / during_campaign.days : 0;
  const postAvg = post_campaign.days ? post_campaign.total / post_campaign.days : 0;
  const avgChange = pctChange(preAvg, duringAvg);

  const findings = [];

  findings.push(`<strong>Overall volume:</strong> ${totalChange >= 0 ? "up" : "down"} ${Math.abs(totalChange).toFixed(1)}% vs. baseline (${baseline.total} → ${current.total} chats). ${Math.abs(totalChange) >= 15 ? "A change this large points to the campaign as the main driver, not normal month-to-month variation." : "This is a modest shift, within the range of normal variation."}`);

  findings.push(`<strong>Daily load:</strong> averaged ${preAvg.toFixed(1)}/day before ${escHtml(campaign_start)}, then ${duringAvg.toFixed(1)}/day during the campaign (${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%). This jump is the chart to point to when explaining where the reported queue backlog came from.`);

  if (post_campaign.days > 0) {
    const postChange = pctChange(preAvg, postAvg);
    findings.push(`<strong>Since the campaign ended:</strong> daily volume is at ${postAvg.toFixed(1)}/day (${postChange >= 0 ? "+" : ""}${postChange.toFixed(1)}% vs. pre-campaign). ${Math.abs(postChange) <= 15 ? "Volume has settled back near normal — the spike looks temporary and tied to the promotion." : postChange > 0 ? "Volume is still elevated — demand hasn't fully returned to normal yet." : "Volume is now below the pre-campaign baseline."}`);
  }

  const baseLcShare = baseline.total ? (baseline.livechat / baseline.total) * 100 : 0;
  const curLcShare = current.total ? (current.livechat / current.total) * 100 : 0;
  const shareShift = curLcShare - baseLcShare;
  if (Math.abs(shareShift) >= 5) {
    findings.push(`<strong>Platform mix:</strong> LiveChat's share of total chats moved from ${baseLcShare.toFixed(0)}% to ${curLcShare.toFixed(0)}% (${shareShift >= 0 ? "+" : ""}${shareShift.toFixed(0)} pts), i.e. the campaign pushed disproportionately more traffic through ${shareShift >= 0 ? "LiveChat" : "Chatwoot"} than the other channel.`);
  }

  const withDuring = employees.filter(e => e.during_campaign_total > 0);
  const totalDuring = withDuring.reduce((s, e) => s + e.during_campaign_total, 0);
  if (withDuring.length && totalDuring > 0) {
    const top = withDuring[0];
    const topShare = (top.during_campaign_total / totalDuring) * 100;
    findings.push(`<strong>Per-employee table:</strong> ${escHtml(top.name)} carried the largest share of campaign-period chats (${top.during_campaign_total} of ${totalDuring} across the team, ${topShare.toFixed(0)}%). ${topShare >= 30 && withDuring.length > 2 ? "A concentration this high is worth a look for workload balance." : "Load looks reasonably spread across the team."}`);
  }

  const totalSupervised = employees.reduce((s, e) => s + (e.supervised || 0), 0);
  if (current.total) {
    const pctSup = (totalSupervised / current.total) * 100;
    findings.push(`<strong>Needed Help column:</strong> ${totalSupervised} chats (${pctSup.toFixed(1)}% of the current period) needed a note from a different agent than the one handling the chat — this is the clearest measure of how much extra supervision the team required to absorb the increased load.`);
  }

  return findings;
}

const CAMPAIGN_METHODOLOGY_HTML = `
  <strong>How to read this report:</strong> "Baseline" and "Current" are two full date ranges (e.g. last month vs. this month), each summed across both chat platforms (LiveChat + Chatwoot). The Current period is further split into <strong>Pre-Campaign</strong>, <strong>During Campaign</strong>, and <strong>Post-Campaign</strong> using the campaign's start/end dates, to isolate the campaign's effect from ordinary volume. <strong>Needed Help</strong> counts chats where an agent other than the one handling the conversation left an internal note — i.e. the assigned agent needed assistance from a colleague.
`;

// Analysis text specific to the "Baseline vs Current" bar chart.
function buildCompareChartAnalysis(data) {
  const { baseline, current } = data;
  const lcChange = pctChange(baseline.livechat, current.livechat);
  const cwChange = pctChange(baseline.chatwoot, current.chatwoot);
  const totalChange = pctChange(baseline.total, current.total);
  const baseLcShare = baseline.total ? (baseline.livechat / baseline.total) * 100 : 0;
  const curLcShare = current.total ? (current.livechat / current.total) * 100 : 0;
  const shareShift = curLcShare - baseLcShare;

  return `This chart lines up the two periods bar-for-bar across LiveChat, Chatwoot, and the combined Total. LiveChat went from ${baseline.livechat} to ${current.livechat} chats (${lcChange >= 0 ? "+" : ""}${lcChange.toFixed(1)}%), Chatwoot went from ${baseline.chatwoot} to ${current.chatwoot} (${cwChange >= 0 ? "+" : ""}${cwChange.toFixed(1)}%), and the combined Total moved ${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(1)}%. LiveChat's share of total chats went from ${baseLcShare.toFixed(0)}% to ${curLcShare.toFixed(0)}% — ${Math.abs(shareShift) >= 5 ? `the platform mix shifted toward ${shareShift >= 0 ? "LiveChat" : "Chatwoot"} during the campaign` : "the platform mix stayed roughly the same"}.`;
}

// Analysis text specific to the daily volume bar chart (pre/during/post campaign).
function buildDailyChartAnalysis(data) {
  const { daily, campaign_start, campaign_end, pre_campaign, during_campaign, post_campaign } = data;
  const days = Object.keys(daily || {}).sort();
  const totals = days.map(d => daily[d].livechat + daily[d].chatwoot);
  let peakDay = null, peakVal = -1;
  days.forEach((d, i) => { if (totals[i] > peakVal) { peakVal = totals[i]; peakDay = d; } });
  const preAvg = pre_campaign.days ? pre_campaign.total / pre_campaign.days : 0;
  const duringAvg = during_campaign.days ? during_campaign.total / during_campaign.days : 0;
  const postAvg = post_campaign.days ? post_campaign.total / post_campaign.days : 0;
  const duringChange = pctChange(preAvg, duringAvg);

  const parts = [];
  parts.push(`Each bar is one day's combined chat volume: grey bars fall before ${escHtml(campaign_start)}, gold bars mark the campaign window, and blue bars${post_campaign.days > 0 ? "" : " (none in this range)"} come after ${escHtml(campaign_end)}.`);
  if (peakDay) parts.push(`The busiest single day was ${escHtml(peakDay)} with ${peakVal} chats.`);
  parts.push(`Volume steps up at the grey-to-gold boundary, from ${preAvg.toFixed(1)} to ${duringAvg.toFixed(1)} chats/day (${duringChange >= 0 ? "+" : ""}${duringChange.toFixed(1)}%) — this is the clearest visual evidence tying the queue backlog to the campaign launch.`);
  if (post_campaign.days > 0) {
    const postChange = pctChange(preAvg, postAvg);
    parts.push(Math.abs(postChange) <= 15
      ? `The blue bars drop back down close to the grey (pre-campaign) level, indicating the spike was temporary.`
      : postAvg > preAvg
        ? `The blue bars stay above the grey (pre-campaign) level, suggesting some of the demand increase has persisted past the campaign.`
        : `The blue bars sit below the grey (pre-campaign) level.`);
  }
  return parts.join(" ");
}

async function loadCampaignImpactReport() {
  const content = document.getElementById("campaignContent");
  if (!content) return;
  const baselineFrom = document.getElementById("campBaselineFrom")?.value;
  const baselineTo = document.getElementById("campBaselineTo")?.value;
  const currentFrom = document.getElementById("campCurrentFrom")?.value;
  const currentTo = document.getElementById("campCurrentTo")?.value;
  const campaignStart = document.getElementById("campStart")?.value;
  const campaignEnd = document.getElementById("campEnd")?.value;
  if (!baselineFrom || !baselineTo || !currentFrom || !currentTo || !campaignStart || !campaignEnd) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Please fill in all date fields.</div>`;
    return;
  }
  if (campaignEnd < campaignStart) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Campaign End must be on or after Campaign Start.</div>`;
    return;
  }
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm"><span class="spinner"></span></div>`;
  _activeCampaignReport = null;

  try {
    const params = new URLSearchParams({
      baseline_from: baselineFrom, baseline_to: baselineTo,
      current_from: currentFrom, current_to: currentTo,
      campaign_start: campaignStart, campaign_end: campaignEnd,
    });
    const res = await authFetch(`/api/reports/campaign-impact?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(data.error || res.status)}</div>`;
      return;
    }
    _activeCampaignReport = data;
    renderCampaignReport(content, data);
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderCampaignReport(content, data) {
  const { baseline, current, pre_campaign, during_campaign, post_campaign, campaign_start, campaign_end, employees } = data;
  const totalChange = pctChange(baseline.total, current.total);
  const preAvg = pre_campaign.days ? pre_campaign.total / pre_campaign.days : 0;
  const duringAvg = during_campaign.days ? during_campaign.total / during_campaign.days : 0;
  const postAvg = post_campaign.days ? post_campaign.total / post_campaign.days : 0;
  const avgChange = pctChange(preAvg, duringAvg);
  const postChange = pctChange(preAvg, postAvg);

  const statCard = (label, val, color) => `
    <div class="bg-[#0f1d35] rounded-xl border border-[#1a2d4a] p-4 text-center">
      <div class="text-xs text-slate-500 uppercase font-medium mb-1">${label}</div>
      <div class="text-xl font-bold" style="color:${color}">${val}</div>
    </div>`;

  const empRows = employees.map(e => {
    const pct = e.total ? (e.during_campaign_total / e.total) * 100 : 0;
    const supervised = e.supervised ?? 0;
    const pctSupervised = e.total ? (supervised / e.total) * 100 : 0;
    return `
    <tr class="border-t border-[#1a2d4a]">
      <td class="px-4 py-2.5 text-white text-sm text-center">${escHtml(e.name)}</td>
      <td class="px-4 py-2.5 text-center text-slate-400 text-sm">${e.livechat}</td>
      <td class="px-4 py-2.5 text-center text-slate-400 text-sm">${e.chatwoot}</td>
      <td class="px-4 py-2.5 text-center text-white text-sm">${e.total}</td>
      <td class="px-4 py-2.5 text-center text-[#F5B800] font-semibold text-sm">${e.during_campaign_total}</td>
      <td class="px-4 py-2.5 text-center text-[#F5B800] font-semibold text-sm">${pct.toFixed(1)}%</td>
      <td class="px-4 py-2.5 text-center text-orange-400 font-semibold text-sm">${supervised}</td>
      <td class="px-4 py-2.5 text-center text-orange-400 text-sm">${pctSupervised.toFixed(1)}%</td>
    </tr>`;
  }).join("");

  const statCards = [
    statCard(`Total (${escHtml(baseline.date_from)} → ${escHtml(baseline.date_to)})`, baseline.total, "#94a3b8"),
    statCard(`Total (${escHtml(current.date_from)} → ${escHtml(current.date_to)})`, current.total, "#F5B800"),
    statCard("Change", `${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(1)}%`, totalChange >= 0 ? "#22c55e" : "#ef4444"),
    statCard(`Avg/day before ${escHtml(campaign_start)}`, preAvg.toFixed(1), "#94a3b8"),
    statCard(`Avg/day during (${escHtml(campaign_start)} → ${escHtml(campaign_end)})`, duringAvg.toFixed(1), "#F5B800"),
    statCard("Daily Load Change", `${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%`, avgChange >= 0 ? "#22c55e" : "#ef4444"),
  ];
  if (post_campaign.days > 0) {
    statCards.push(
      statCard(`Avg/day after ${escHtml(campaign_end)}`, postAvg.toFixed(1), "#38bdf8"),
      statCard("Post-Campaign vs Baseline", `${postChange >= 0 ? "+" : ""}${postChange.toFixed(1)}%`, Math.abs(postChange) <= 15 ? "#94a3b8" : postChange >= 0 ? "#22c55e" : "#ef4444"),
    );
  }

  content.innerHTML = `
    <div class="grid grid-cols-3 gap-4 mb-5">
      ${statCards.join("")}
    </div>

    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-5 mb-5">
      <p class="text-sm text-slate-300 leading-relaxed">${buildCampaignNarrative(data)}</p>
    </div>

    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-5 mb-5">
      <div class="text-xs text-slate-500 uppercase font-semibold mb-3">Key Findings</div>
      <ul class="space-y-2">
        ${buildCampaignKeyFindings(data).map(f => `<li class="text-sm text-slate-300 leading-relaxed flex gap-2"><span class="text-[#F5B800] shrink-0">•</span><span>${f}</span></li>`).join("")}
      </ul>
    </div>

    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-4 mb-5">
      <p class="text-xs text-slate-500 leading-relaxed">${CAMPAIGN_METHODOLOGY_HTML}</p>
    </div>

    <div class="grid grid-cols-2 gap-5 mb-5">
      <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-4">
        <div class="text-sm font-semibold text-white mb-3">Baseline vs Current</div>
        <canvas id="campCompareCanvas" height="180"></canvas>
        <p class="text-xs text-slate-400 leading-relaxed mt-3 pt-3 border-t border-[#1a2d4a]">${buildCompareChartAnalysis(data)}</p>
      </div>
      <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-4">
        <div class="text-sm font-semibold text-white mb-3">Daily Volume — Current Period <span class="text-xs font-normal text-slate-500">(grey/gold/blue = pre/during/post campaign)</span></div>
        <canvas id="campDailyCanvas" height="180"></canvas>
        <p class="text-xs text-slate-400 leading-relaxed mt-3 pt-3 border-t border-[#1a2d4a]">${buildDailyChartAnalysis(data)}</p>
      </div>
    </div>

    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden">
      <div class="px-5 py-3 border-b border-[#1a2d4a]">
        <span class="font-semibold text-white text-sm">Per-Employee Breakdown — Current Period</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="text-center text-xs text-slate-500 uppercase">
              <th class="px-4 py-2 font-medium">Employee</th>
              <th class="px-4 py-2 font-medium">LiveChat</th>
              <th class="px-4 py-2 font-medium">Chatwoot</th>
              <th class="px-4 py-2 font-medium">Total</th>
              <th class="px-4 py-2 font-medium">During Campaign</th>
              <th class="px-4 py-2 font-medium">% During Campaign</th>
              <th class="px-4 py-2 font-medium" title="Chats with a note from another agent — needed help">Needed Help</th>
              <th class="px-4 py-2 font-medium">% Needed Help</th>
            </tr>
          </thead>
          <tbody>${empRows}</tbody>
        </table>
      </div>
    </div>`;

  renderCampaignCharts(data);
}

function renderCampaignCharts(data) {
  const { baseline, current, daily, campaign_start, campaign_end } = data;

  if (_campCompareChart) { try { _campCompareChart.destroy(); } catch (_) {} }
  if (_campDailyChart) { try { _campDailyChart.destroy(); } catch (_) {} }

  const compareCanvas = document.getElementById("campCompareCanvas");
  if (compareCanvas) {
    _campCompareChart = new Chart(compareCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: ["LiveChat", "Chatwoot", "Total"],
        datasets: [
          { label: "Baseline", data: [baseline.livechat, baseline.chatwoot, baseline.total], backgroundColor: "#64748b", borderRadius: 6 },
          { label: "Current", data: [current.livechat, current.chatwoot, current.total], backgroundColor: "#F5B800", borderRadius: 6 },
        ],
      },
      options: {
        scales: {
          y: { beginAtZero: true, grid: { color: "#1a2d4a" }, ticks: { color: "#94a3b8" } },
          x: { grid: { display: false }, ticks: { color: "#94a3b8" } },
        },
        plugins: { legend: { labels: { color: "#e2e8f0" } } },
      },
    });
  }

  const dailyCanvas = document.getElementById("campDailyCanvas");
  if (dailyCanvas) {
    const days = Object.keys(daily).sort();
    const totals = days.map(d => daily[d].livechat + daily[d].chatwoot);
    const colors = days.map(d => d < campaign_start ? "#64748b" : d > campaign_end ? "#38bdf8" : "#F5B800");
    _campDailyChart = new Chart(dailyCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: days.map(d => d.slice(5)),
        datasets: [{ label: "Chats", data: totals, backgroundColor: colors, borderRadius: 4 }],
      },
      options: {
        scales: {
          y: { beginAtZero: true, grid: { color: "#1a2d4a" }, ticks: { color: "#94a3b8" } },
          x: { grid: { display: false }, ticks: { color: "#94a3b8", maxRotation: 90, minRotation: 90 } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }
}

function downloadCampaignImpactPdf() {
  if (!_activeCampaignReport) { showStatus("Run a search first", "error"); return; }
  const data = _activeCampaignReport;
  const { baseline, current, pre_campaign, during_campaign, post_campaign, campaign_start, campaign_end, employees } = data;
  const totalChange = pctChange(baseline.total, current.total);
  const preAvg = pre_campaign.days ? pre_campaign.total / pre_campaign.days : 0;
  const duringAvg = during_campaign.days ? during_campaign.total / during_campaign.days : 0;
  const postAvg = post_campaign.days ? post_campaign.total / post_campaign.days : 0;
  const avgChange = pctChange(preAvg, duringAvg);
  const postChange = pctChange(preAvg, postAvg);

  const compareImg = document.getElementById("campCompareCanvas")?.toDataURL("image/png") || "";
  const dailyImg = document.getElementById("campDailyCanvas")?.toDataURL("image/png") || "";

  const win = window.open("", "_blank");
  if (!win) { showStatus("Allow popups to download PDF", "error"); return; }

  const rows = employees.map((e, i) => {
    const pct = e.total ? (e.during_campaign_total / e.total) * 100 : 0;
    const supervised = e.supervised ?? 0;
    const pctSupervised = e.total ? (supervised / e.total) * 100 : 0;
    return `
    <tr style="background:${i % 2 ? PDF_CARD_BG : PDF_BG}">
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;color:${PDF_TEXT};text-align:center">${escHtml(e.name)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;color:${PDF_TEXT_DIM};text-align:center">${e.livechat}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;color:${PDF_TEXT_DIM};text-align:center">${e.chatwoot}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;font-weight:700;color:#ffffff;text-align:center">${e.total}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;font-weight:700;color:#7fb0ff;text-align:center">${e.during_campaign_total}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;font-weight:700;color:#7fb0ff;text-align:center">${pct.toFixed(1)}%</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;font-weight:700;color:#fb923c;text-align:center">${supervised}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;color:#fb923c;text-align:center">${pctSupervised.toFixed(1)}%</td>
    </tr>`;
  }).join("");

  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Campaign Impact Report</title>
<style>
  @page { size: A4 portrait; margin: 1.5cm 16mm; background: ${PDF_BG}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${PDF_FORCE_PRINT_COLORS_CSS}
  html { background: ${PDF_BG}; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: ${PDF_TEXT_BODY}; background: ${PDF_BG}; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
       color: ${PDF_TEXT_DIM}; text-align: center; padding: 8px 10px; border-bottom: 2px solid ${OPO_BRAND_BLUE}; }
  th.num { text-align: center; }
  .card { background: ${PDF_CARD_BG}; border: 1px solid ${PDF_BORDER}; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px;
          page-break-inside: avoid; break-inside: avoid; }
  .sec-title { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
               color: ${PDF_TEXT_DIM}; margin-bottom: 8px; }
  .footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid ${PDF_BORDER};
            font-size: 8px; color: ${PDF_TEXT_DIM}; text-align: center; }
  .page-break { page-break-before: always; }
</style>
</head><body>
${opoLetterheadHtml()}
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${OPO_BRAND_BLUE};padding-bottom:10px;margin-bottom:14px">
  <div>
    <div style="font-size:20px;font-weight:900;color:${PDF_TEXT};line-height:1.1">Campaign Impact Report</div>
    <div style="font-size:10.5px;color:${PDF_TEXT_DIM};margin-top:5px;line-height:1.6">
      <div><strong style="color:${PDF_TEXT_BODY}">Baseline:</strong> ${escHtml(baseline.date_from)} → ${escHtml(baseline.date_to)}</div>
      <div><strong style="color:${PDF_TEXT_BODY}">Current:</strong> ${escHtml(current.date_from)} → ${escHtml(current.date_to)}</div>
      <div><strong style="color:${PDF_TEXT_BODY}">Campaign:</strong> ${escHtml(campaign_start)} → ${escHtml(campaign_end)}</div>
    </div>
  </div>
  <div style="background:#132a4d;color:#7fb0ff;font-size:9px;font-weight:700;text-transform:uppercase;
              letter-spacing:.06em;padding:4px 10px;border-radius:6px;white-space:nowrap;margin-top:4px">
    Generated ${new Date().toLocaleDateString()}
  </div>
</div>

<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
  ${[
    [`Total (Baseline)`, baseline.total, PDF_TEXT_BODY],
    [`Total (Current)`, current.total, OPO_BRAND_BLUE],
    ["Change", `${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(1)}%`, totalChange >= 0 ? "#4ade80" : "#f87171"],
    [`Avg/day before ${escHtml(campaign_start)}`, preAvg.toFixed(1), PDF_TEXT_BODY],
    [`Avg/day during campaign`, duringAvg.toFixed(1), OPO_BRAND_BLUE],
    ["Daily Load Change", `${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%`, avgChange >= 0 ? "#4ade80" : "#f87171"],
    ...(post_campaign.days > 0 ? [
      [`Avg/day after ${escHtml(campaign_end)}`, postAvg.toFixed(1), "#38bdf8"],
      ["Post-Campaign vs Baseline", `${postChange >= 0 ? "+" : ""}${postChange.toFixed(1)}%`, Math.abs(postChange) <= 15 ? PDF_TEXT_BODY : postChange >= 0 ? "#4ade80" : "#f87171"],
    ] : []),
  ].map(([l,v,c]) => `<div style="background:${PDF_CARD_BG};border:1px solid ${PDF_BORDER};border-radius:8px;padding:9px 5px;text-align:center">
    <div style="font-size:7px;color:${PDF_TEXT_DIM};text-transform:uppercase;font-weight:700;letter-spacing:.03em;margin-bottom:4px">${l}</div>
    <div style="font-size:15px;font-weight:900;color:${c}">${v}</div>
  </div>`).join("")}
</div>

<div class="card">
  <div class="sec-title">Summary</div>
  <p style="font-size:10.5px;color:${PDF_TEXT_BODY};line-height:1.6">${buildCampaignNarrative(data)}</p>
</div>

<div class="card">
  <div class="sec-title">Key Findings</div>
  <ul style="list-style:none;padding:0;margin:0">
    ${buildCampaignKeyFindings(data).map(f => `<li style="font-size:10px;color:${PDF_TEXT_BODY};line-height:1.6;margin-bottom:6px;padding-left:14px;position:relative"><span style="position:absolute;left:0;color:${OPO_BRAND_BLUE}">•</span>${f}</li>`).join("")}
  </ul>
</div>

<div class="card" style="border-style:dashed">
  <div class="sec-title">How To Read This Report</div>
  <p style="font-size:9px;color:${PDF_TEXT_DIM};line-height:1.6">${CAMPAIGN_METHODOLOGY_HTML}</p>
</div>

${compareImg ? `<div class="card"><div class="sec-title">Baseline vs Current</div><img src="${compareImg}" style="width:100%;max-height:220px;object-fit:contain;border-radius:6px" /><p style="font-size:9px;color:${PDF_TEXT_DIM};line-height:1.6;margin-top:8px;padding-top:8px;border-top:1px solid ${PDF_BORDER}">${buildCompareChartAnalysis(data)}</p></div>` : ""}
${dailyImg ? `<div class="card"><div class="sec-title">Daily Volume — Current Period (grey = pre-campaign, gold = during campaign, blue = post-campaign)</div><img src="${dailyImg}" style="width:100%;max-height:220px;object-fit:contain;border-radius:6px" /><p style="font-size:9px;color:${PDF_TEXT_DIM};line-height:1.6;margin-top:8px;padding-top:8px;border-top:1px solid ${PDF_BORDER}">${buildDailyChartAnalysis(data)}</p></div>` : ""}

<div class="page-break"></div>

<div class="sec-title" style="margin-bottom:8px">Per-Employee Breakdown — Current Period</div>
<table>
  <thead>
    <tr>
      <th>Employee</th>
      <th class="num">LiveChat</th>
      <th class="num">Chatwoot</th>
      <th class="num">Total</th>
      <th class="num">During Campaign</th>
      <th class="num">% During Campaign</th>
      <th class="num">Needed Help</th>
      <th class="num">% Needed Help</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">Chat Review Dashboard — Campaign Impact Report · Generated ${new Date().toLocaleString()}</div>

<script>setTimeout(() => window.print(), 500)<\/script>
</body></html>`);
  win.document.close();
}

// ── Saved Report Snapshots (Total Chats / Campaign Impact) ────────────────────

let _saveReportModalResolve = null;

function openSaveReportModal(defaultLabel) {
  return new Promise((resolve) => {
    _saveReportModalResolve = resolve;
    const input = document.getElementById("saveReportLabelInput");
    input.value = defaultLabel;
    document.getElementById("saveReportModal").classList.remove("hidden");
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

function closeSaveReportModal(confirmed) {
  document.getElementById("saveReportModal").classList.add("hidden");
  const value = confirmed ? document.getElementById("saveReportLabelInput").value.trim() : null;
  if (_saveReportModalResolve) { _saveReportModalResolve(value || null); _saveReportModalResolve = null; }
}


async function saveReportSnapshot(type, params, data, defaultLabel) {
  const label = await openSaveReportModal(defaultLabel);
  if (!label) return;
  try {
    const res = await authFetch("/api/saved-reports", {
      method: "POST",
      body: JSON.stringify({ type, label, params, data }),
    });
    const saved = await res.json();
    if (!res.ok || saved.error) throw new Error(saved.error || res.status);
    showStatus("Report saved", "success");
  } catch (e) {
    showStatus("Save failed: " + e.message, "error");
  }
}

function saveTotalChatsReport() {
  if (!_activeTotalChatsReport) { showStatus("Run a search first", "error"); return; }
  const { dateFrom, dateTo, employeeFilter, data } = _activeTotalChatsReport;
  const defaultLabel = `Total Chats: ${dateFrom} to ${dateTo}${employeeFilter ? " (" + employeeFilter + ")" : ""}`;
  saveReportSnapshot("total_chats", { dateFrom, dateTo, employeeFilter }, data, defaultLabel);
}

function saveCampaignImpactReport() {
  if (!_activeCampaignReport) { showStatus("Run a search first", "error"); return; }
  const data = _activeCampaignReport;
  const defaultLabel = `Campaign Impact: ${data.current.date_from} to ${data.current.date_to}`;
  saveReportSnapshot("campaign_impact", {
    baselineFrom: data.baseline.date_from, baselineTo: data.baseline.date_to,
    currentFrom: data.current.date_from, currentTo: data.current.date_to,
    campaignStart: data.campaign_start, campaignEnd: data.campaign_end,
  }, data, defaultLabel);
}

async function toggleSavedReportsPanel(type, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!el.classList.contains("hidden")) { el.classList.add("hidden"); return; }
  await refreshSavedReportsPanel(type, containerId);
}

async function refreshSavedReportsPanel(type, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.classList.remove("hidden");
  el.innerHTML = `<div class="text-center text-slate-500 py-4 text-sm"><span class="spinner"></span></div>`;
  try {
    const res = await authFetch(`/api/saved-reports?type=${type}`);
    const list = await res.json();
    if (!res.ok || list.error) throw new Error(list.error || res.status);
    if (!list.length) {
      el.innerHTML = `<div class="text-center text-slate-500 py-4 text-sm">No saved reports yet.</div>`;
      return;
    }
    el.innerHTML = list.map(r => `
      <div class="flex items-center justify-between px-3 py-2 border-b border-[#1a2d4a] last:border-0">
        <div class="min-w-0">
          <div class="text-sm text-white truncate">${escHtml(r.label)}</div>
          <div class="text-xs text-slate-500">${new Date(r.created_at).toLocaleString()}${r.created_by ? " · " + escHtml(r.created_by) : ""}</div>
        </div>
        <div class="flex gap-2 shrink-0">
          <button onclick="loadSavedReport('${type}', ${r.id})" class="text-xs bg-[#1a2d4a] text-[#F5B800] hover:bg-[#243d61] px-2.5 py-1 rounded-lg transition">Load</button>
          ${currentUser?.role === "admin" ? `<button onclick="deleteSavedReport('${type}', ${r.id}, '${containerId}')" class="text-xs text-red-400 hover:text-red-300 px-2 py-1">✕</button>` : ""}
        </div>
      </div>`).join("");
  } catch (e) {
    el.innerHTML = `<div class="text-center text-red-400 py-4 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function deleteSavedReport(type, id, containerId) {
  showConfirmModal("This will permanently delete this saved report.", async () => {
    try {
      const res = await authFetch(`/api/saved-reports/${id}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || res.status);
      refreshSavedReportsPanel(type, containerId);
    } catch (e) { showStatus("Delete failed: " + e.message, "error"); }
  });
}

async function loadSavedReport(type, id) {
  try {
    const res = await authFetch(`/api/saved-reports/${id}`);
    const saved = await res.json();
    if (!res.ok || saved.error) throw new Error(saved.error || res.status);
    const { params, data } = saved;
    if (type === "total_chats") {
      document.getElementById("totalChatsFrom").value = params.dateFrom || "";
      document.getElementById("totalChatsTo").value = params.dateTo || "";
      document.getElementById("totalChatsAgent").value = params.employeeFilter || "";
      _activeTotalChatsReport = { dateFrom: params.dateFrom, dateTo: params.dateTo, employeeFilter: params.employeeFilter || "", data };
      renderTotalChatsReport(document.getElementById("totalChatsContent"), params.dateFrom, params.dateTo, data);
      document.getElementById("savedTotalChatsPanel")?.classList.add("hidden");
    } else if (type === "campaign_impact") {
      document.getElementById("campBaselineFrom").value = params.baselineFrom || "";
      document.getElementById("campBaselineTo").value = params.baselineTo || "";
      document.getElementById("campCurrentFrom").value = params.currentFrom || "";
      document.getElementById("campCurrentTo").value = params.currentTo || "";
      document.getElementById("campStart").value = params.campaignStart || "";
      document.getElementById("campEnd").value = params.campaignEnd || "";
      _activeCampaignReport = data;
      renderCampaignReport(document.getElementById("campaignContent"), data);
      document.getElementById("savedCampaignPanel")?.classList.add("hidden");
    }
    showStatus("Loaded saved report", "success");
  } catch (e) {
    showStatus("Load failed: " + e.message, "error");
  }
}

// ── Platform Status ────────────────────────────────────────────────────────────

let _platformStatusData = null;
let _platformActiveTab = "livechat";
let _platformStatusChart = null;

function switchPlatformTab(platform) {
  _platformActiveTab = platform;
  const activeCls = "px-4 py-2 text-sm font-medium border-b-2 border-[#F5B800] text-white transition";
  const inactiveCls = "px-4 py-2 text-sm font-medium border-b-2 border-transparent text-slate-400 hover:text-white transition";
  document.getElementById("tab-livechat").className = platform === "livechat" ? activeCls : inactiveCls;
  document.getElementById("tab-chatwoot").className = platform === "chatwoot" ? activeCls : inactiveCls;
  if (_platformStatusData) renderPlatformStatusTab();
}

async function loadPlatformStatus() {
  const content = document.getElementById("platformStatusContent");
  if (!content) return;
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm"><span class="spinner"></span></div>`;
  try {
    const res = await authFetch("/api/reports/platform-status");
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.status);
    _platformStatusData = data;
    renderPlatformStatusTab();
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderPlatformStatusTab() {
  const content = document.getElementById("platformStatusContent");
  if (!content || !_platformStatusData) return;
  const data = _platformStatusData;
  const p = _platformActiveTab === "livechat" ? data.livechat : data.chatwoot;

  const statCard = (label, val, color) => `
    <div class="bg-[#0f1d35] rounded-xl border border-[#1a2d4a] p-4 text-center">
      <div class="text-xs text-slate-500 uppercase font-medium mb-1">${label}</div>
      <div class="text-xl font-bold" style="color:${color}">${val}</div>
    </div>`;

  content.innerHTML = `
    <div class="flex items-center gap-2 mb-5">
      <span class="w-2.5 h-2.5 rounded-full ${p.active ? "bg-emerald-400" : "bg-red-500"}"></span>
      <span class="text-sm font-semibold ${p.active ? "text-emerald-400" : "text-red-400"}">${p.active ? "Active" : "Inactive"}</span>
      ${!p.active && p.error ? `<span class="text-xs text-slate-500">— ${escHtml(p.error)}</span>` : ""}
    </div>
    <div class="grid grid-cols-3 gap-4 mb-5">
      ${statCard("Today", p.today, "#F5B800")}
      ${statCard("This Week", p.week, "#94a3b8")}
      ${statCard("This Month", p.month, "#94a3b8")}
    </div>
    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-4">
      <div class="text-sm font-semibold text-white mb-3">Daily Volume — ${monthLabel(data.month)}</div>
      ${Object.keys(p.daily || {}).length
        ? `<canvas id="platformStatusCanvas" height="100"></canvas>`
        : `<p class="text-center text-slate-600 text-sm py-6">No chats yet this month</p>`}
    </div>`;

  renderPlatformStatusChart(p);
}

function renderPlatformStatusChart(p) {
  if (_platformStatusChart) { try { _platformStatusChart.destroy(); } catch (_) {} }
  const canvas = document.getElementById("platformStatusCanvas");
  if (!canvas) return;
  const days = Object.keys(p.daily || {}).sort();
  const totals = days.map(d => p.daily[d]);
  _platformStatusChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: days.map(d => d.slice(5)), datasets: [{ label: "Chats", data: totals, backgroundColor: "#F5B800", borderRadius: 4 }] },
    options: {
      scales: {
        y: { beginAtZero: true, grid: { color: "#1a2d4a" }, ticks: { color: "#94a3b8" } },
        x: { grid: { display: false }, ticks: { color: "#94a3b8", maxRotation: 90, minRotation: 90 } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ── Platform Costs ──────────────────────────────────────────────────────────

let _platformCostsData = null;
let _platformCostsChart = null;

function openPlatformCostsPage() {
  const fromEl = document.getElementById("costsCustomFrom");
  const toEl = document.getElementById("costsCustomTo");
  if (fromEl && !fromEl.value) {
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 6 * 86400000);
    fromEl.value = fmt(weekAgo);
    toEl.value = fmt(now);
  }
  loadPlatformCosts();
}

function fmtCost(v) {
  return v == null ? "—" : "$" + v.toFixed(2);
}

async function loadPlatformCosts() {
  const content = document.getElementById("platformCostsContent");
  if (!content) return;
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm"><span class="spinner"></span></div>`;
  const dateFrom = document.getElementById("costsCustomFrom")?.value;
  const dateTo = document.getElementById("costsCustomTo")?.value;
  try {
    const params = new URLSearchParams();
    if (dateFrom && dateTo) { params.set("date_from", dateFrom); params.set("date_to", dateTo); }
    const res = await authFetch(`/api/reports/platform-costs?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.status);
    _platformCostsData = data;
    renderPlatformCosts();
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderPlatformCosts() {
  const content = document.getElementById("platformCostsContent");
  const data = _platformCostsData;
  if (!content || !data) return;

  if (!data.tracking_since) {
    content.innerHTML = `
      <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-8 text-center">
        <p class="text-slate-400 text-sm">${data.today == null
          ? "Cost tracking requires a database — DATABASE_URL isn't configured on this deployment."
          : "No Claude usage tracked yet. Costs will appear here once reviews are run."}</p>
      </div>`;
    return;
  }

  const statCard = (label, val, color) => `
    <div class="bg-[#0f1d35] rounded-xl border border-[#1a2d4a] p-4 text-center">
      <div class="text-xs text-slate-500 uppercase font-medium mb-1">${label}</div>
      <div class="text-xl font-bold" style="color:${color}">${val}</div>
    </div>`;

  const purposeLabel = { chat_review: "Chat Reviews", monthly_report: "Monthly Report Analysis" };
  const purposeRows = Object.entries(data.by_purpose || {}).map(([k, v]) => `
    <tr class="border-t border-[#1a2d4a]">
      <td class="px-4 py-2.5 text-white text-sm text-center">${escHtml(purposeLabel[k] || k)}</td>
      <td class="px-4 py-2.5 text-center text-slate-400 text-sm">${v.calls}</td>
      <td class="px-4 py-2.5 text-center text-[#F5B800] font-semibold text-sm">${fmtCost(v.cost)}</td>
    </tr>`).join("");

  content.innerHTML = `
    <p class="text-xs text-slate-500 mb-4">Tracking Claude API usage since ${escHtml(data.tracking_since)}. Costs from before that date weren't recorded and can't be shown.</p>
    <div class="grid grid-cols-3 gap-4 mb-5">
      ${statCard("Today", fmtCost(data.today.cost), "#F5B800")}
      ${statCard("This Week", fmtCost(data.week.cost), "#94a3b8")}
      ${statCard("This Month", fmtCost(data.month.cost), "#94a3b8")}
    </div>

    ${data.custom ? `
    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-4 mb-5">
      <div class="text-xs text-slate-500 uppercase font-medium mb-1">Custom Range: ${escHtml(data.custom_range.from)} → ${escHtml(data.custom_range.to)}</div>
      <div class="text-2xl font-bold text-[#F5B800]">${fmtCost(data.custom.cost)}</div>
      <div class="text-xs text-slate-500 mt-1">${data.custom.calls} Claude calls · ${(data.custom.input_tokens / 1000).toFixed(0)}K input / ${(data.custom.output_tokens / 1000).toFixed(0)}K output tokens</div>
    </div>` : ""}

    <div class="grid grid-cols-2 gap-5 mb-5">
      <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-4">
        <div class="text-sm font-semibold text-white mb-3">Daily Cost</div>
        ${Object.keys(data.daily || {}).length
          ? `<canvas id="platformCostsCanvas" height="140"></canvas>`
          : `<p class="text-center text-slate-600 text-sm py-6">No data yet</p>`}
      </div>
      <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden">
        <div class="px-5 py-3 border-b border-[#1a2d4a]">
          <span class="font-semibold text-white text-sm">Cost by Purpose</span>
        </div>
        <table class="w-full">
          <thead>
            <tr class="text-center text-xs text-slate-500 uppercase">
              <th class="px-4 py-2 font-medium">Purpose</th>
              <th class="px-4 py-2 font-medium">Calls</th>
              <th class="px-4 py-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>${purposeRows || `<tr><td colspan="3" class="text-center text-slate-600 text-sm py-6">No data</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  renderPlatformCostsChart(data.daily);
}

function renderPlatformCostsChart(daily) {
  if (_platformCostsChart) { try { _platformCostsChart.destroy(); } catch (_) {} }
  const canvas = document.getElementById("platformCostsCanvas");
  if (!canvas) return;
  const days = Object.keys(daily || {}).sort().slice(-30);
  const costs = days.map(d => daily[d].cost);
  _platformCostsChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: days.map(d => d.slice(5)), datasets: [{ label: "Cost", data: costs, backgroundColor: "#F5B800", borderRadius: 4 }] },
    options: {
      scales: {
        y: { beginAtZero: true, grid: { color: "#1a2d4a" }, ticks: { color: "#94a3b8", callback: (v) => "$" + v } },
        x: { grid: { display: false }, ticks: { color: "#94a3b8", maxRotation: 90, minRotation: 90 } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => "$" + ctx.parsed.y.toFixed(3) } } },
    },
  });
}

// ── Agent Activity ──────────────────────────────────────────────────────────

let _activeAgentActivity = null;

function fmtHoursMinutes(hoursFloat) {
  const totalMinutes = Math.round((hoursFloat || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function populateAgentActivityFilter() {
  const sel = document.getElementById("activityAgent");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Employees</option>';
  const employees = (Array.isArray(agentShifts) ? [...agentShifts] : []).sort((a, b) => a.employee.localeCompare(b.employee));
  const seen = new Set();
  employees.forEach(s => {
    if (seen.has(s.employee)) return;
    seen.add(s.employee);
    const opt = document.createElement("option");
    opt.value = s.employee;
    opt.textContent = s.employee;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function openAgentActivityPage() {
  populateAgentActivityFilter();
  const fromEl = document.getElementById("activityFrom");
  const toEl = document.getElementById("activityTo");
  if (fromEl && !fromEl.value) {
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 6 * 86400000);
    fromEl.value = fmt(weekAgo);
    toEl.value = fmt(now);
  }
  const content = document.getElementById("activityContent");
  if (content && !content.innerHTML.trim()) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Pick a date range and click Search.</div>`;
  }
}

async function loadAgentActivity() {
  const content = document.getElementById("activityContent");
  if (!content) return;
  const dateFrom = document.getElementById("activityFrom")?.value;
  const dateTo = document.getElementById("activityTo")?.value;
  const employee = document.getElementById("activityAgent")?.value || "";
  if (!dateFrom || !dateTo) {
    content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">Please pick a From and To date.</div>`;
    return;
  }
  content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm"><span class="spinner"></span></div>`;
  _activeAgentActivity = null;

  try {
    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (employee) params.set("employee", employee);
    const res = await authFetch(`/api/reports/agent-activity?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.status);
    if (!data.employees?.length) {
      content.innerHTML = `<div class="text-center py-16 text-slate-500 text-sm">No shift data found for this range.</div>`;
      return;
    }
    _activeAgentActivity = { dateFrom, dateTo, employeeFilter: employee, data };
    renderAgentActivity(content, dateFrom, dateTo, data);
  } catch (e) {
    content.innerHTML = `<div class="text-center py-16 text-red-400 text-sm">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderAgentActivity(content, dateFrom, dateTo, data) {
  const cards = data.employees.map(e => {
    const rows = e.days.map(d => `
      <tr class="border-t border-[#1a2d4a]">
        <td class="px-4 py-2 text-slate-300 text-sm text-center">${escHtml(d.date)}</td>
        <td class="px-4 py-2 text-center text-emerald-400 text-sm">${fmtHoursMinutes(d.onlineHours)}</td>
        <td class="px-4 py-2 text-center text-orange-400 text-sm">${fmtHoursMinutes(d.closedHours)}</td>
      </tr>`).join("");
    return `
    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden">
      <div class="px-5 py-3 border-b border-[#1a2d4a] flex items-center justify-between">
        <span class="font-semibold text-white text-sm">${escHtml(e.name)}</span>
        <span class="text-xs text-slate-500">Online: <span class="text-emerald-400 font-semibold">${fmtHoursMinutes(e.totalOnline)}</span> · Chat Closed: <span class="text-orange-400 font-semibold">${fmtHoursMinutes(e.totalClosed)}</span></span>
      </div>
      <div class="overflow-x-auto max-h-64 overflow-y-auto">
        <table class="w-full">
          <thead class="sticky top-0 bg-[#0f1d35]">
            <tr class="text-center text-xs text-slate-500 uppercase">
              <th class="px-4 py-2 font-medium">Date</th>
              <th class="px-4 py-2 font-medium">Online</th>
              <th class="px-4 py-2 font-medium" title="Shift duration minus time actually accepting chats — includes both 'not accepting' and logged-out time">Chat Closed</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join("");

  content.innerHTML = `
    <div class="mb-4 text-sm text-slate-400">${escHtml(dateFrom)} → ${escHtml(dateTo)}</div>
    <div class="grid grid-cols-2 gap-5">${cards}</div>`;
}

async function backfillAgentActivity() {
  const dateFrom = document.getElementById("activityFrom")?.value;
  const dateTo = document.getElementById("activityTo")?.value;
  if (!dateFrom || !dateTo) { showStatus("Pick a From and To date first", "error"); return; }

  const btn = document.getElementById("btnBackfillActivity");
  const icon = document.getElementById("backfillActivityIcon");
  btn.disabled = true;
  if (icon) icon.textContent = "…";

  try {
    const res = await authFetch("/api/reports/agent-activity/backfill", {
      method: "POST",
      body: JSON.stringify({ date_from: dateFrom, date_to: dateTo }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.status);

    if (data.already_running) {
      showStatus("A backfill is already running in the background...", "success");
    } else {
      showStatus(`Backfill started for ${data.days_total} day(s) — running in the background, this can take a while`, "success");
    }

    const poll = setInterval(async () => {
      try {
        const sres = await authFetch("/api/reports/agent-activity/backfill/status");
        const sdata = await sres.json();
        if (!sdata.running) {
          clearInterval(poll);
          showStatus(`Backfill done — ${sdata.days_total} day(s), ${sdata.employees} employee(s)`, "success");
          btn.disabled = false;
          if (icon) icon.textContent = "⏬";
          loadAgentActivity();
        } else {
          showStatus(`Backfilling... ${sdata.days_done}/${sdata.days_total} day(s) done`, "success");
        }
      } catch (e) { /* transient poll error, keep trying */ }
    }, 4000);
  } catch (e) {
    showStatus("Backfill failed: " + e.message, "error");
    btn.disabled = false;
    if (icon) icon.textContent = "⏬";
  }
}

function downloadAgentActivityPdf() {
  if (!_activeAgentActivity) { showStatus("Run a search first", "error"); return; }
  const { dateFrom, dateTo, employeeFilter, data } = _activeAgentActivity;

  const win = window.open("", "_blank");
  if (!win) { showStatus("Allow popups to download PDF", "error"); return; }

  const sections = data.employees.map(e => {
    const rows = e.days.map((d, i) => `
      <tr style="background:${i % 2 ? PDF_CARD_BG : PDF_BG}">
        <td style="padding:6px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;color:${PDF_TEXT_DIM};text-align:center">${escHtml(d.date)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;color:#4ade80;text-align:center">${fmtHoursMinutes(d.onlineHours)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid ${PDF_BORDER};font-size:10px;color:#fb923c;text-align:center">${fmtHoursMinutes(d.closedHours)}</td>
      </tr>`).join("");
    return `
    <div class="card" style="page-break-inside: avoid;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:11px;font-weight:700;color:${PDF_TEXT}">${escHtml(e.name)}</span>
        <span style="font-size:9px;color:${PDF_TEXT_DIM}">Online: <strong style="color:#4ade80">${fmtHoursMinutes(e.totalOnline)}</strong> · Chat Closed: <strong style="color:#fb923c">${fmtHoursMinutes(e.totalClosed)}</strong></span>
      </div>
      <table>
        <thead><tr><th>Date</th><th class="num">Online</th><th class="num">Chat Closed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join("");

  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Agent Activity — ${escHtml(dateFrom)} to ${escHtml(dateTo)}</title>
<style>
  @page { size: A4 portrait; margin: 1.5cm 16mm; background: ${PDF_BG}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${PDF_FORCE_PRINT_COLORS_CSS}
  html { background: ${PDF_BG}; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: ${PDF_TEXT_BODY}; background: ${PDF_BG}; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
       color: ${PDF_TEXT_DIM}; text-align: center; padding: 6px 10px; border-bottom: 2px solid ${OPO_BRAND_BLUE}; }
  th.num { text-align: center; }
  .card { background: ${PDF_CARD_BG}; border: 1px solid ${PDF_BORDER}; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px;
          page-break-inside: avoid; break-inside: avoid; }
  .footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid ${PDF_BORDER};
            font-size: 8px; color: ${PDF_TEXT_DIM}; text-align: center; }
</style>
</head><body>
${opoLetterheadHtml()}
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${OPO_BRAND_BLUE};padding-bottom:10px;margin-bottom:14px">
  <div>
    <div style="font-size:20px;font-weight:900;color:${PDF_TEXT};line-height:1.1">Agent Activity Report</div>
    <div style="font-size:11px;color:${PDF_TEXT_DIM};margin-top:4px">${escHtml(dateFrom)} → ${escHtml(dateTo)}${employeeFilter ? ` · ${escHtml(employeeFilter)}` : ""}</div>
  </div>
  <div style="background:#132a4d;color:#7fb0ff;font-size:9px;font-weight:700;text-transform:uppercase;
              letter-spacing:.06em;padding:4px 10px;border-radius:6px;white-space:nowrap;margin-top:4px">
    Generated ${new Date().toLocaleDateString()}
  </div>
</div>

${sections}

<div class="footer">Chat Review Dashboard — Agent Activity Report · ${escHtml(dateFrom)} → ${escHtml(dateTo)}</div>

<script>setTimeout(() => window.print(), 350)<\/script>
</body></html>`);
  win.document.close();
}

async function openReports() {
  const el = document.getElementById("reportsContent");
  el.innerHTML = `<div class="text-center text-slate-500 py-8"><span class="spinner"></span></div>`;
  const res = await authFetch("/api/reports");
  const list = await res.json();
  el.innerHTML = currentUser?.role === "admin" ? renderReportsAdmin(list) : renderReportsEmployee(list);
}

function monthLabel(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleString("en-US", { month: "long" }) + " " + y;
}

function groupByYearMonth(list) {
  const tree = {};
  for (const r of list) {
    const year = r.month.split("-")[0];
    if (!tree[year]) tree[year] = {};
    if (!tree[year][r.month]) tree[year][r.month] = [];
    tree[year][r.month].push(r);
  }
  return tree;
}

function fmtDuration(sec) {
  if (!sec) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function scoreColor(s) {
  if (s == null) return "text-slate-500";
  return s >= 7 ? "text-green-600" : s >= 5 ? "text-yellow-600" : "text-red-600";
}

function renderScoreRow(label, val) {
  if (val == null) return "";
  const pct = (val / 10) * 100;
  const bg = val >= 7 ? "bg-green-500" : val >= 5 ? "bg-yellow-400" : "bg-red-500";
  return `<div class="flex items-center gap-2 mb-1.5">
    <span class="text-xs text-slate-400 w-36 shrink-0">${label}</span>
    <div class="flex-1 bg-[#1a2d4a] rounded-full h-2"><div class="${bg} h-2 rounded-full" style="width:${pct}%"></div></div>
    <span class="text-xs font-semibold w-8 text-right ${scoreColor(val)}">${val.toFixed(1)}</span>
  </div>`;
}

function renderReportView(r) {
  const s = r.avg_scores || {};
  const trend = (r.score_trend || []).map(w =>
    `<div class="text-center">
       <div class="text-xs text-slate-500 mb-1">${escHtml(w.label)}</div>
       <div class="text-2xl font-black ${scoreColor(w.avg)}">${w.avg != null ? w.avg.toFixed(1) : "—"}</div>
       <div class="text-xs text-slate-500">${w.count} chat</div>
     </div>`
  ).join("");

  const noReviewWarning = r.reviewed_chats === 0 && (r.chats_in_shift ?? r.total_chats) > 0
    ? `<div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
        <span class="font-semibold">No reviewed chats found.</span>
        ${r.chats_in_shift != null ? ` ${r.chats_in_shift} chat${r.chats_in_shift!==1?"s":""} found in shift hours` : ""}
        — review chats first using the Chat Review page, then regenerate this report.
       </div>` : "";

  return `<div class="space-y-5">
    ${noReviewWarning}
    <div class="flex flex-wrap gap-3">
      ${[
        ["Total Chats",   r.total_chats,                        "text-[#F5B800]"],
        ["In Shift",      r.chats_in_shift ?? "—",              "text-slate-300"],
        ["Reviewed",      r.reviewed_chats,                     "text-purple-600"],
        ["Missed",        r.missed_chats,                       "text-red-500"],
        ["Resolved",      (r.resolved_rate??0)+"%",             "text-green-600"],
        ["Avg Duration",  fmtDuration(r.avg_chat_duration_sec), "text-white"],
        ["First Response",fmtDuration(r.avg_first_response_sec),"text-white"],
      ].map(([l,v,c]) => `<div class="bg-[#0a1628] border border-[#1a2d4a] rounded-xl px-4 py-3 text-center min-w-[80px]">
        <div class="text-xs text-slate-500 mb-1">${l}</div>
        <div class="text-xl font-black ${c}">${v ?? "—"}</div>
      </div>`).join("")}
    </div>

    <div class="bg-[#0a1628] border border-[#1a2d4a] rounded-xl p-4">
      <p class="text-xs font-semibold text-slate-400 uppercase mb-3">Score Breakdown</p>
      <div class="flex items-center gap-3 mb-3">
        <span class="text-xs text-slate-400 w-36">Overall Average</span>
        <span class="text-3xl font-black ${scoreColor(s.overall)}">${s.overall?.toFixed(1) ?? "—"}</span>
        <span class="text-xs text-slate-500">/ 10</span>
      </div>
      ${renderScoreRow("Response Time",    s.response_time)}
      ${renderScoreRow("Tone",             s.tone)}
      ${renderScoreRow("Accuracy",         s.accuracy)}
      ${renderScoreRow("Resolution",       s.resolution)}
      ${renderScoreRow("Compliance",       s.compliance)}
      ${renderScoreRow("Product Knowledge",s.product_knowledge)}
      ${renderScoreRow("Satisfaction",     s.satisfaction)}
      ${renderScoreRow("Language",         s.language)}
    </div>

    ${trend ? `<div class="bg-[#0a1628] border border-[#1a2d4a] rounded-xl p-4">
      <p class="text-xs font-semibold text-slate-400 uppercase mb-4">Weekly Trend</p>
      <div class="flex gap-6 justify-around">${trend}</div>
    </div>` : ""}

    ${r.progress_narrative ? `<div class="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
      <p class="text-xs font-semibold text-indigo-600 uppercase mb-2">Progress & Trend</p>
      <p class="text-sm text-indigo-800 leading-relaxed">${escHtml(r.progress_narrative)}</p>
    </div>` : ""}

    <div class="grid grid-cols-2 gap-4">
      ${r.strengths?.length ? `<div class="bg-green-50 border border-green-100 rounded-xl p-4">
        <p class="text-xs font-semibold text-green-700 uppercase mb-2">Strengths</p>
        <ul class="space-y-1.5">${r.strengths.map(s => `<li class="text-xs text-green-800 flex gap-1.5"><span class="text-green-500 shrink-0">✓</span>${escHtml(s)}</li>`).join("")}</ul>
      </div>` : ""}
      ${r.weaknesses?.length ? `<div class="bg-red-50 border border-red-100 rounded-xl p-4">
        <p class="text-xs font-semibold text-red-600 uppercase mb-2">Areas for Improvement</p>
        <ul class="space-y-1.5">${r.weaknesses.map(w => `<li class="text-xs text-red-800 flex gap-1.5"><span class="text-red-400 shrink-0">✗</span>${escHtml(w)}</li>`).join("")}</ul>
      </div>` : ""}
    </div>

    ${r.review_notes?.length ? `<details class="bg-[#0a1628] border border-[#1a2d4a] rounded-xl">
      <summary class="px-4 py-3 text-xs font-semibold text-slate-400 uppercase cursor-pointer">
        Raw Review Notes (${r.review_notes.length})
      </summary>
      <div class="px-4 pb-4 space-y-2 max-h-48 overflow-y-auto">
        ${r.review_notes.map(n => `<div class="text-xs text-slate-300 border-l-2 border-gray-300 pl-2 pt-2">${escHtml(n)}</div>`).join("")}
      </div>
    </details>` : ""}

    <div class="bg-blue-50 border border-blue-100 rounded-xl p-4">
      <p class="text-xs font-semibold text-[#F5B800] uppercase mb-2">Admin Notes</p>
      ${currentUser?.role === "admin"
        ? `<textarea id="reportNotes" class="w-full text-sm border border-[#1a2d4a] rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-[#0f1d35]" rows="3" placeholder="Add notes...">${escHtml(r.admin_notes || "")}</textarea>
           <button onclick="saveReportNotes('${escHtml(r.employee)}','${escHtml(r.month)}')" class="mt-2 bg-blue-600 text-white px-3 py-1.5 text-xs rounded-lg hover:bg-blue-700">Save Notes</button>`
        : `<p class="text-sm text-blue-700">${r.admin_notes || "—"}</p>`}
    </div>
  </div>`;
}

function renderReportsAdmin(list) {
  const monthOpts = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    monthOpts.push(`<option value="${val}">${monthLabel(val)}</option>`);
  }

  const generatePanel = `
    <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] p-5 mb-6">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs font-semibold text-slate-400 uppercase">Generate New Report</p>
        <button onclick="deleteAllReports()" class="text-xs text-red-400 hover:text-red-600 hover:bg-red-50 px-2 py-1 rounded-lg transition">🗑 Delete All Reports</button>
      </div>
      <div class="flex flex-wrap gap-2 items-end">
        <div>
          <label class="text-xs text-slate-500 block mb-1">Employee</label>
          <select id="rptEmployee" class="text-sm border border-[#1a2d4a] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300">
            <option value="">Select...</option>
            ${[...new Map(agentShifts.map(s => [s.employee, s])).values()]
              .sort((a, b) => a.employee.localeCompare(b.employee))
              .map(s => `<option value="${escHtml(s.employee)}">${escHtml(s.employee)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="text-xs text-slate-500 block mb-1">Month</label>
          <select id="rptMonth" class="text-sm border border-[#1a2d4a] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300">
            ${monthOpts.join("")}
          </select>
        </div>
        <button onclick="generateReport()" id="btnGenReport"
          class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition">
          Generate
        </button>
      </div>
      <div id="rptResult" class="mt-3"></div>
    </div>`;

  if (!list.length) return generatePanel + `
    <div class="text-center py-12 text-slate-500 text-sm">No reports generated yet.</div>`;

  const tree = groupByYearMonth(list);
  const yearsHtml = Object.keys(tree).sort((a,b) => b-a).map(year => {
    const monthsHtml = Object.keys(tree[year]).sort((a,b) => b.localeCompare(a)).map(month => {
      const emps = tree[year][month].sort((a,b) => a.employee.localeCompare(b.employee));
      const empsHtml = emps.map(r => `
        <button onclick="viewSavedReport('${escHtml(r.employee)}','${month}')"
          class="w-full text-left flex justify-between items-center px-4 py-2.5 rounded-xl hover:bg-blue-50 transition group">
          <span class="text-sm font-medium text-white group-hover:text-blue-700">${escHtml(r.employee)}</span>
          <span class="text-xs text-slate-500">${new Date(r.generated_at).toLocaleDateString()}</span>
        </button>`).join("");
      const mid = `month-${month.replace("-","_")}`;
      return `
        <div class="mb-1">
          <button onclick="document.getElementById('${mid}').classList.toggle('hidden');this.querySelector('span').textContent=document.getElementById('${mid}').classList.contains('hidden')?'▶':'▼'"
            class="w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-[#1a2d4a] transition">
            <span class="text-xs text-slate-500 w-3">▼</span>
            <span class="text-sm font-semibold text-slate-300">${monthLabel(month)}</span>
            <span class="ml-auto text-xs text-slate-500">${emps.length} report${emps.length > 1 ? "s" : ""}</span>
          </button>
          <div id="${mid}" class="pl-3">${empsHtml}</div>
        </div>`;
    }).join("");
    const yid = `year-${year}`;
    const total = Object.values(tree[year]).flat().length;
    return `
      <div class="bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] overflow-hidden mb-4">
        <button onclick="document.getElementById('${yid}').classList.toggle('hidden');this.querySelector('span').textContent=document.getElementById('${yid}').classList.contains('hidden')?'▶':'▼'"
          class="w-full text-left flex items-center gap-3 px-5 py-3.5 bg-[#0a1628] hover:bg-[#1a2d4a] transition border-b border-[#1a2d4a]">
          <span class="text-xs text-slate-500 w-3">▼</span>
          <span class="text-base font-bold text-white">${year}</span>
          <span class="text-xs text-slate-500">${total} report${total > 1 ? "s" : ""}</span>
        </button>
        <div id="${yid}" class="p-3">${monthsHtml}</div>
      </div>`;
  }).join("");

  return generatePanel + yearsHtml;
}

function renderReportsEmployee(list) {
  if (!list.length) return `
    <div class="flex flex-col items-center justify-center py-20 text-center">
      <div class="w-16 h-16 bg-[#1a2d4a] rounded-2xl flex items-center justify-center text-3xl mb-4">📋</div>
      <p class="text-white font-semibold text-base mb-1">No reports yet</p>
      <p class="text-slate-500 text-sm max-w-xs">Your monthly performance reports will appear here once your manager generates them.</p>
    </div>`;

  const tree = groupByYearMonth(list);
  return Object.keys(tree).sort((a,b) => b-a).map(year => {
    const monthsHtml = Object.keys(tree[year]).sort((a,b) => b.localeCompare(a)).map(month => {
      const r = tree[year][month][0];
      return `
        <button onclick="viewSavedReport('${escHtml(r.employee)}','${month}')"
          class="w-full text-left flex justify-between items-center px-4 py-3.5 bg-[#0f1d35] rounded-2xl border border-[#1a2d4a] hover:border-blue-300 hover:bg-blue-50 transition group">
          <div>
            <p class="text-sm font-semibold text-white group-hover:text-blue-700">${monthLabel(month)}</p>
            <p class="text-xs text-slate-500 mt-0.5">Generated ${new Date(r.generated_at).toLocaleDateString()}</p>
          </div>
          <span class="text-slate-600 group-hover:text-blue-400 text-xl">›</span>
        </button>`;
    }).join("");
    return `<div class="mb-6">
      <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 px-1">${year}</p>
      <div class="space-y-2">${monthsHtml}</div>
    </div>`;
  }).join("");
}

async function generateReport() {
  const employee = document.getElementById("rptEmployee").value;
  const month = document.getElementById("rptMonth").value;
  if (!employee) return showStatus("Select an employee first", "error");
  const btn = document.getElementById("btnGenReport");
  btn.disabled = true; btn.textContent = "Generating...";
  const el = document.getElementById("rptResult");
  el.innerHTML = `<div class="text-center py-4 text-slate-500 text-sm"><span class="spinner"></span> Fetching chats & calculating…</div>`;
  try {
    const res = await authFetch("/api/reports/generate", { method: "POST", body: JSON.stringify({ employee, month }) });
    const report = await res.json();
    if (report.error) { el.innerHTML = `<p class="text-red-500 text-sm">${escHtml(report.error)}</p>`; return; }
    viewSavedReport(employee, month);
  } catch (e) {
    el.innerHTML = `<p class="text-red-500 text-sm">Error: ${escHtml(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = "Generate";
  }
}

async function viewSavedReport(employee, month) {
  const container = document.getElementById("reportsContent");
  container.innerHTML = `<div class="text-center py-8 text-slate-500"><span class="spinner"></span></div>`;
  const res = await authFetch(`/api/reports/${encodeURIComponent(employee)}/${encodeURIComponent(month)}`);
  const report = await res.json();
  if (report.error) { container.innerHTML = `<p class="text-red-500 p-6">${escHtml(report.error)}</p>`; return; }
  _activeReport = report;
  container.innerHTML = `
    <div class="flex items-center justify-between px-6 py-4 bg-[#0f1d35] border-b border-[#1a2d4a] sticky top-0 z-10">
      <div class="flex items-center gap-3">
        <button onclick="openReports()" class="text-slate-500 hover:text-white transition text-lg leading-none">←</button>
        <div>
          <h3 class="font-bold text-white">${escHtml(employee)}</h3>
          <p class="text-xs text-slate-500">${monthLabel(month)} — Generated ${new Date(report.generated_at).toLocaleString()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="downloadReportPdf()" class="flex items-center gap-1.5 bg-[#1a2d4a] hover:bg-[#243d61] text-white text-xs font-medium px-3 py-2 rounded-lg transition">
          ⬇ Download PDF
        </button>
        ${currentUser?.role === "admin" ? `<button onclick="deleteThisReport('${escHtml(employee)}','${escHtml(month)}')" class="flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-500 text-xs font-medium px-3 py-2 rounded-lg transition">
          🗑 Delete
        </button>` : ""}
      </div>
    </div>
    <div class="p-6">${renderReportView(report)}</div>`;
}

function downloadReportPdf() {
  if (!_activeReport) return;
  const r = _activeReport;
  const s = r.avg_scores || {};
  const scHex = v => v == null ? PDF_TEXT_DIM : v >= 7 ? "#4ade80" : v >= 5 ? "#fbbf24" : "#f87171";
  const bar = v => v == null ? "" :
    `<div style="flex:1;height:6px;background:${PDF_BORDER};border-radius:3px;overflow:hidden">
       <div style="width:${(v/10)*100}%;height:100%;background:${scHex(v)};border-radius:3px"></div>
     </div>`;
  const scoreRows = [
    ["Response Time", s.response_time], ["Tone", s.tone], ["Accuracy", s.accuracy],
    ["Resolution", s.resolution], ["Compliance", s.compliance],
    ["Product Knowledge", s.product_knowledge], ["Satisfaction", s.satisfaction], ["Language", s.language],
  ];

  const win = window.open("", "_blank");
  if (!win) { showStatus("Allow popups to download PDF", "error"); return; }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${escHtml(r.employee)} — ${monthLabel(r.month)}</title>
<style>
  @page { size: A4 portrait; margin: 1.5cm 16mm; background: ${PDF_BG}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${PDF_FORCE_PRINT_COLORS_CSS}
  html { background: ${PDF_BG}; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: ${PDF_TEXT_BODY}; background: ${PDF_BG}; }

  .card { background: ${PDF_CARD_BG}; border: 1px solid ${PDF_BORDER}; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px;
          page-break-inside: avoid; break-inside: avoid; }
  .sec-title { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
               color: ${PDF_TEXT_DIM}; margin-bottom: 8px; }
  .srow { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .slabel { font-size: 9.5px; color: ${PDF_TEXT_DIM}; width: 120px; flex-shrink: 0; }
  .sval { font-size: 9.5px; font-weight: 700; width: 28px; text-align: right; flex-shrink: 0; }
  ul { list-style: none; }
  li { font-size: 9.5px; margin-bottom: 4px; display: flex; gap: 5px; line-height: 1.4; }
  .footer { margin-top: 12px; padding-top: 6px; border-top: 1px solid ${PDF_BORDER};
            font-size: 8px; color: ${PDF_TEXT_DIM}; text-align: center; }
</style>
</head><body>
${opoLetterheadHtml()}
<!-- Header -->
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${OPO_BRAND_BLUE};padding-bottom:10px;margin-bottom:12px">
  <div>
    <div style="font-size:22px;font-weight:900;color:${PDF_TEXT};line-height:1.1">${escHtml(r.employee)}</div>
    <div style="font-size:12px;color:${PDF_TEXT_DIM};margin-top:3px">${monthLabel(r.month)} Performance Report</div>
  </div>
  <div style="background:#132a4d;color:#7fb0ff;font-size:9px;font-weight:700;text-transform:uppercase;
              letter-spacing:.06em;padding:4px 10px;border-radius:6px;white-space:nowrap;margin-top:4px">
    Generated ${new Date(r.generated_at).toLocaleDateString()}
  </div>
</div>

<!-- Stats row -->
<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:10px">
  ${[
    ["Total Chats",    r.total_chats,                         OPO_BRAND_BLUE],
    ["In Shift",       r.chats_in_shift ?? "—",               PDF_TEXT_BODY],
    ["Reviewed",       r.reviewed_chats,                      "#c4b5fd"],
    ["Missed",         r.missed_chats,                        "#f87171"],
    ["Resolved",       (r.resolved_rate ?? 0) + "%",          "#4ade80"],
    ["Avg Duration",   fmtDuration(r.avg_chat_duration_sec),  PDF_TEXT_BODY],
    ["First Response", fmtDuration(r.avg_first_response_sec), PDF_TEXT_BODY],
  ].map(([l,v,c]) => `<div style="background:${PDF_CARD_BG};border:1px solid ${PDF_BORDER};border-radius:8px;padding:7px 5px;text-align:center">
    <div style="font-size:7.5px;color:${PDF_TEXT_DIM};text-transform:uppercase;font-weight:700;letter-spacing:.04em;margin-bottom:4px">${l}</div>
    <div style="font-size:14px;font-weight:900;color:${c}">${v ?? "—"}</div>
  </div>`).join("")}
</div>

<!-- Score Breakdown -->
<div class="card">
  <div class="sec-title">Score Breakdown</div>
  <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:10px">
    <span style="font-size:9.5px;color:${PDF_TEXT_DIM};width:120px;flex-shrink:0">Overall Average</span>
    <span style="font-size:28px;font-weight:900;color:${scHex(s.overall)}">${s.overall?.toFixed(1) ?? "—"}</span>
    <span style="font-size:11px;color:${PDF_TEXT_DIM}">/ 10</span>
  </div>
  ${scoreRows.map(([l,v]) => v == null ? "" : `<div class="srow">
    <div class="slabel">${l}</div>
    ${bar(v)}
    <div class="sval" style="color:${scHex(v)}">${v.toFixed(1)}</div>
  </div>`).join("")}
</div>

<!-- Weekly Trend -->
${r.score_trend?.length ? `<div class="card">
  <div class="sec-title">Weekly Trend</div>
  <div style="display:flex;gap:8px;justify-content:space-around">
    ${r.score_trend.map(w => `<div style="text-align:center">
      <div style="font-size:8px;color:${PDF_TEXT_DIM};margin-bottom:3px">${escHtml(w.label)}</div>
      <div style="font-size:20px;font-weight:900;color:${scHex(w.avg)}">${w.avg != null ? w.avg.toFixed(1) : "—"}</div>
      <div style="font-size:8px;color:${PDF_TEXT_DIM};margin-top:2px">${w.count} chats</div>
    </div>`).join("")}
  </div>
</div>` : ""}

<!-- Progress & Trend -->
${r.progress_narrative ? `<div class="card" style="background:rgba(124,58,237,0.12);border-color:rgba(167,139,250,0.3)">
  <div class="sec-title" style="color:#c4b5fd">Progress & Trend</div>
  <p style="font-size:10px;color:#ddd6fe;line-height:1.6">${escHtml(r.progress_narrative)}</p>
</div>` : ""}

<!-- Strengths & Weaknesses -->
${(r.strengths?.length || r.weaknesses?.length) ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
  ${r.strengths?.length ? `<div class="card" style="background:rgba(34,197,94,0.12);border-color:rgba(74,222,128,0.3);margin-bottom:0">
    <div class="sec-title" style="color:#4ade80">Strengths</div>
    <ul>${r.strengths.map(s=>`<li><span style="color:#4ade80;flex-shrink:0">✓</span><span style="color:#bbf7d0">${escHtml(s)}</span></li>`).join("")}</ul>
  </div>` : "<div></div>"}
  ${r.weaknesses?.length ? `<div class="card" style="background:rgba(239,68,68,0.12);border-color:rgba(248,113,113,0.3);margin-bottom:0">
    <div class="sec-title" style="color:#f87171">Areas for Improvement</div>
    <ul>${r.weaknesses.map(w=>`<li><span style="color:#f87171;flex-shrink:0">✗</span><span style="color:#fecaca">${escHtml(w)}</span></li>`).join("")}</ul>
  </div>` : "<div></div>"}
</div>` : ""}

<!-- Admin Notes -->
${r.admin_notes ? `<div class="card" style="background:rgba(30,112,255,0.12);border-color:rgba(127,176,255,0.3)">
  <div class="sec-title" style="color:#7fb0ff">Manager Notes</div>
  <p style="font-size:10px;color:#bfdbfe;line-height:1.5">${escHtml(r.admin_notes)}</p>
</div>` : ""}

<div class="footer">Chat Review Dashboard — ${escHtml(r.employee)} · ${monthLabel(r.month)}</div>

<script>setTimeout(() => window.print(), 350)<\/script>
</body></html>`);
  win.document.close();
}

async function saveReportNotes(employee, month) {
  const notes = document.getElementById("reportNotes").value;
  await authFetch(`/api/reports/${encodeURIComponent(employee)}/${encodeURIComponent(month)}`, {
    method: "PATCH", body: JSON.stringify({ admin_notes: notes })
  });
  showStatus("Notes saved", "success");
}

let _confirmCallback = null;

function showConfirmModal(message, callback) {
  document.getElementById("confirmModalMsg").textContent = message;
  _confirmCallback = callback;
  document.getElementById("confirmModal").classList.remove("hidden");
}

function closeConfirmModal() {
  document.getElementById("confirmModal").classList.add("hidden");
  _confirmCallback = null;
}

async function runConfirmAction() {
  document.getElementById("confirmModal").classList.add("hidden");
  if (_confirmCallback) await _confirmCallback();
  _confirmCallback = null;
}

function deleteAllReports() {
  showConfirmModal("This action cannot be undone. All generated reports will be permanently deleted.", async () => {
    const res = await authFetch("/api/reports", { method: "DELETE" });
    const data = await res.json();
    if (data.ok) { showStatus("All reports deleted", "success"); openReports(); }
    else showStatus("Error: " + (data.error || "unknown"), "error");
  });
}

async function deleteThisReport(employee, month) {
  showConfirmModal(`Delete the report for ${employee} — ${monthLabel(month)}? This cannot be undone.`, async () => {
    const res = await authFetch(`/api/reports/${encodeURIComponent(employee)}/${encodeURIComponent(month)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) { showStatus("Report deleted", "success"); openReports(); }
    else showStatus("Error: " + (data.error || "unknown"), "error");
  });
}

async function backfillAgentNames() {
  const btn = document.getElementById("btnBackfill");
  if (btn) btn.textContent = "…";
  showStatus("Fetching agent info from LiveChat — this may take a minute…", "info");
  try {
    const res = await authFetch("/api/backfill-agent-names", { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showStatus(`Done — updated ${data.updated} of ${data.total} reviews. Refresh dashboard.`, "success");
    loadDashboard();
  } catch (e) {
    showStatus("Backfill error: " + e.message, "error");
  } finally {
    if (btn) btn.textContent = "⚙ Run";
  }
}
