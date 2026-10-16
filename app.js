import { shouldRefreshSupabaseHealth, supabaseHealthPresentation } from "./health-policy.js";
import { shouldTryAdminApiFallback } from "./api-failover-policy.js";
import { shouldRedirectToStaticFallback } from "./host-failover-policy.js";
import { shouldDeferLicenseRefresh } from "./note-refresh-policy.js";
import { initView } from "./nav.js";
import { renderDonut, renderLineChart } from "./series.js";
import { initMask } from "./mask.js";

// Cloudflare Worker 自定义域：备用端点（排在 Supabase 之后）。
// 2026-09-25 起策略为「Supabase 优先 / CF 为辅」，此处不再作为默认端点。
/* 镜像产物：与买家页同源，凭据一律不落 localStorage（缘由见 build-site-mirror.mjs） */
const localStorage = sessionStorage;

const CF_API = "https://license.re2347.ccwu.cc";
const SUPABASE_API = "https://kzqgphxrghdclkwneqyn.supabase.co/functions/v1/admin-api";
const SUPABASE_HEALTH_URL = "https://kzqgphxrghdclkwneqyn.supabase.co/functions/v1/auth/health";
const ADMIN_KEY_STORAGE = "cskin.admin.api-key";
/** 账号登录换来的会话令牌。令牌自带 exp（后端签发 8 小时），所以恢复时会先比对到期时间，过期的绝不自动带上。 */
const ADMIN_SESSION_STORAGE = "yunara.admin.session";
/**
 * 连过一次就记住连的是哪一条线。自动重连必须连回他刚才连的那个服务：以前刷新后地址会退回
 * HTML 里写死的默认值，于是备用端点（和本机预览）选过一次就等于没选。
 */
const API_URL_STORAGE = "yunara.admin.api-url";
const AUTO_REFRESH_MS = 15000;
const REMAINING_REFRESH_MS = 30000;
const SUPABASE_HEALTH_REFRESH_MS = 60000;
const SUPABASE_HEALTH_TIMEOUT_MS = 8000;
const STATIC_HOST_PROBE_MS = 60000;
const STATIC_HOST_PROBE_TIMEOUT_MS = 5000;
const STATIC_FALLBACK_PAGE = "https://re2347.github.io/leagueyunara-admin/";
const MAX_PLAN_DAYS = 36500;
/**
 * 趋势按日聚合，一天之内不会自己变，所以它不进 15 秒的自动刷新轮次：
 * 每 15 秒重扫一遍全表时间戳，等于用一张图把主库拖慢。
 */
const SERIES_REFRESH_MS = 300000;
const SERIES_DAYS_STORAGE = "yunara.admin.series-days";
const SERIES_DEFAULT_DAYS = 30;
const state = {
  apiUrl: SUPABASE_API,
  adminKey: "",
  sessionToken: "",
  adminUsername: "",
  connecting: false,
  connected: false,
  page: 1,
  pageSize: 20,
  total: 0,
  codes: [],
  currentItems: [],
  selectedLicenses: new Map(),
  refreshing: false,
  extendingLicense: null,
  supabaseHealth: { ok: false },
  supabaseHealthCheckedAt: 0,
  pendingNoteSaves: 0,
  orders: { page: 1, pageSize: 20, total: 0, items: [], revealed: new Map() },
  devices: { page: 1, pageSize: 20, total: 0, items: [] },
  series: null,
  seriesLoadedAt: 0,
  seriesDays: SERIES_DEFAULT_DAYS,
  seriesMetric: "issued",
  seriesError: "",
  lastMaintenance: null,
};
const $ = (selector) => document.querySelector(selector);

const orderLabels = { pending: "待支付", processing: "处理中", paid: "已支付", delivered: "已领取", expired: "已过期" };
const deviceLabels = { active: "在用", unbound: "已解绑", revoked: "已撤销" };

const labels = { unused: "未使用", active: "已激活", expired: "已过期", revoked: "已撤销" };
const ALLOC_STATUSES = [
  { key: "unused", label: "未使用" },
  { key: "active", label: "已激活" },
  { key: "expired", label: "已过期" },
  { key: "revoked", label: "已撤销" },
];
const METRIC_LABELS = { issued: "发卡", activated: "激活", expired: "到期", revenue: "收入" };
let toastTimer;
let refreshTimer;
let remainingTimer;
let staticHostProbeTimer;
let staticHostProbeFailures = 0;

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3200);
}

function setConnection(connected, message) {
  state.connected = Boolean(connected);
  const element = $("#connection-state");
  element.textContent = message || (connected ? "已连接" : "未连接");
  element.className = `connection-state ${connected ? "connection-ok" : "connection-error"}`;
  syncOfflineNotice();
}

function formatDate(value) {
  if (!value) return "未激活";
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function planLabel(days) { return `${days} 天`; }

function hasAdminAccess() { return Boolean(state.sessionToken || state.adminKey); }

function isValidPlanDays(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PLAN_DAYS;
}

function isExtendable(item) {
  return item.status === "active" && Number(item.expires_at || 0) > Math.floor(Date.now() / 1000);
}

function configuredApiUrl() {
  return ($("#api-url")?.value || state.apiUrl || "").trim().replace(/\/$/, "");
}

/**
 * 公告与版本两条路由也已由 Supabase 线代理到 Worker 主源，所以不再按路径钉端点。
 *
 * 浏览器到 Cloudflare 那一次握手实测 1 秒级（`CF-RAY` 落在阿姆斯特丹），而 Supabase
 * 到授权 Worker 是机房到机房、几十毫秒；两条线都由 `api-failover-policy.js` 在
 * 5xx/网络错误时互相兜底，所以先打哪条只影响快慢，不影响成败。
 */
function apiCandidates() {
  const configured = configuredApiUrl();
  const defaults = [SUPABASE_API, state.apiUrl, CF_API];
  const candidates = configured && configured !== SUPABASE_API && configured !== CF_API
    ? [configured]
    : defaults;
  return [...new Set(candidates.filter(Boolean).map((value) => value.replace(/\/$/, "")))];
}

async function requestWithFailover(path, options = {}) {
  const { endpoint: pinnedEndpoint, ...fetchOptions } = options;
  const headers = {
    "Content-Type": "application/json",
    ...(state.adminKey ? { "X-Admin-Key": state.adminKey } : {}),
    ...(state.sessionToken ? { "X-Admin-Session": state.sessionToken } : {}),
    ...(fetchOptions.headers || {}),
  };
  let lastBody = {};
  let lastStatus = 0;
  let sessionRejected = false;
  for (const endpoint of pinnedEndpoint ? [pinnedEndpoint] : apiCandidates()) {
    try {
      const response = await fetch(`${endpoint}${path}`, { cache: "no-store", ...fetchOptions, headers });
      const body = await response.json().catch(() => ({}));
      lastBody = body;
      lastStatus = response.status;
      if (response.ok) {
        state.apiUrl = endpoint;
        return { response, body, endpoint };
      }
      if (response.status === 401 && state.sessionToken) sessionRejected = true;
      if (!shouldTryAdminApiFallback({ status: response.status })) break;
    } catch (error) {
      lastBody = {};
      lastStatus = 0;
      if (!shouldTryAdminApiFallback({ status: 0, networkError: true })) break;
    }
  }
  if (sessionRejected) {
    // 会话失效这三步必须留在 try 外面：它们原来在循环体的 try 里，任何一次抛出（存储被禁用）
    // 都会被下面那个 catch 认成「网络错误」，于是一个正常的 401 反而多打一次备用端点。
    // 顺序也不能反：先停轮询、先把登录框摆出来，最后才去清存储——清不掉是环境问题，
    // 不该让人对着一个已经什么都不显示的页面等凭据。
    try {
      state.sessionToken = "";
      state.adminUsername = "";
      stopAutoRefresh();
      openLoginDialog();
      clearStoredSession();
    } catch { /* 清理失败也要把真实错误抛给调用方，别改判成掉线 */ }
  }
  throw new Error(lastBody?.error?.message || `请求失败（${lastStatus || "网络错误"}）`);
}

async function api(path, options = {}) {
  return (await requestWithFailover(path, options)).body;
}

/**
 * 存储对象本身在某些环境里就是取不到的（裸 Node 跑策略测试、老浏览器的隐私模式）。
 * 这里必须安静地返回空列表：这些读写都在 `requestWithFailover` 的 try 里被调用，
 * 一旦抛出就会被当成「网络错误」，把一个正常的 401 变成一次多余的备用端点回退。
 */
function credentialStores() {
  const found = [];
  try {
    found.push(sessionStorage);
  } catch { /* 没有会话存储 */ }
  try {
    void 0 /* 别名之后这里本来就是 sessionStorage，不再推第二次 */;
  } catch { /* 没有本地存储 */ }
  return found;
}

/**
 * 会话令牌是 `base64url({sub,exp}).hmac`，签名密钥拿不到，但 payload 自己可读，
 * 所以到期时间在前端就能判——省掉「带着过期令牌自动重连、然后弹一个看不懂的错」。
 */
function sessionExpiry(token) {
  const dot = String(token).lastIndexOf(".");
  if (dot <= 0) return 0;
  try {
    const b64 = String(token).slice(0, dot).replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return Number(decoded.exp) || 0;
  } catch {
    return 0;
  }
}

/** 先读会话存储（只活到标签页关闭），再读本地存储（勾了「记住此设备」才会写进去）。 */
function readStoredSession() {
  for (const store of credentialStores()) {
    let raw = null;
    try {
      raw = store.getItem(ADMIN_SESSION_STORAGE);
    } catch {
      continue;
    }
    if (!raw) continue;
    let saved = null;
    try {
      saved = JSON.parse(raw);
    } catch {
      saved = null;
    }
    const token = String(saved?.token || "");
    const exp = sessionExpiry(token);
    if (!token || !exp || exp * 1000 <= Date.now()) {
      try {
        store.removeItem(ADMIN_SESSION_STORAGE);
      } catch { /* 清不掉也只是下次再走一次登录框 */ }
      continue;
    }
    return { token, exp, apiUrl: String(saved.apiUrl || ""), username: String(saved.username || "") };
  }
  return null;
}

function writeStoredSession(payload, remember) {
  try {
    if (remember) localStorage.setItem(ADMIN_SESSION_STORAGE, payload);
    else sessionStorage.setItem(ADMIN_SESSION_STORAGE, payload);
  } catch { /* 存不下就退回「每次打开都要登录」，功能不坏 */ }
}

function storeSession() {
  if (!state.sessionToken) return;
  const remember = Boolean($("#remember-admin-key")?.checked);
  const payload = JSON.stringify({ token: state.sessionToken, apiUrl: state.apiUrl, username: state.adminUsername, exp: sessionExpiry(state.sessionToken) });
  try {
    // 两边只留一份，否则「记住」和「不记住」来回切一次会留下一个更早的会话等着被自动恢复。
    sessionStorage.removeItem(ADMIN_SESSION_STORAGE);
    localStorage.removeItem(ADMIN_SESSION_STORAGE);
  } catch { /* 同上 */ }
  writeStoredSession(payload, remember);
}

function clearStoredSession() {
  state.sessionToken = "";
  state.adminUsername = "";
  for (const store of credentialStores()) {
    try {
      store.removeItem(ADMIN_SESSION_STORAGE);
    } catch { /* 同上 */ }
  }
}

function openLoginDialog() {
  const dialog = $("#admin-login-dialog");
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $("#admin-username")?.focus(), 0);
}

async function login(event) {
  event.preventDefault();
  const button = $("#login-submit");
  const error = $("#login-error");
  const apiUrl = $("#api-url").value.trim().replace(/\/$/, "");
  const username = $("#admin-username").value.trim();
  const password = $("#admin-password").value;
  error.hidden = true;
  if (!apiUrl || !username || !password) {
    error.textContent = "请输入 Worker 地址、管理员账号和密码";
    error.hidden = false;
    return;
  }
  state.apiUrl = apiUrl || SUPABASE_API;
  button.disabled = true;
  button.textContent = "验证中…";
  try {
    const { response, body } = await requestWithFailover("/v1/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok || !body.sessionToken) throw new Error(body?.error?.message || `登录失败（${response.status}）`);
    state.sessionToken = body.sessionToken;
    state.adminUsername = username;
    storeSession();
    $("#admin-password").value = "";
    $("#admin-login-dialog").close();
    await connect();
  } catch (loginError) {
    error.textContent = loginError.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "登录管理后台";
  }
}

async function connect() {
  if (state.connecting) return;
  const url = $("#api-url").value.trim().replace(/\/$/, "");
  const key = $("#admin-key").value.trim();
  // 判断必须用「刚填进来的这把密钥」，而不是 state 里那一份：以前这里在赋值之前就调用
  // hasAdminAccess()，于是「只填 ADMIN_API_KEY、不走账号登录」这条路一点都走不通。
  const authorized = Boolean(state.sessionToken || key);
  if (!url || !authorized) {
    showToast("请先完成管理员登录，或填入管理员密钥", true);
    openLoginDialog();
    return;
  }
  state.apiUrl = url || SUPABASE_API;
  state.adminKey = key;
  if ($("#remember-admin-key").checked && key) localStorage.setItem(ADMIN_KEY_STORAGE, key);
  else if (!key) localStorage.removeItem(ADMIN_KEY_STORAGE);
  const button = $("#connect-button");
  button.disabled = true;
  button.textContent = "连接中…";
  state.connecting = true;
  try {
    const health = await requestWithFailover("/health", { method: "GET" });
    if (!health.body.ok) throw new Error("授权服务或数据库尚未就绪");
    try {
      localStorage.setItem(API_URL_STORAGE, state.apiUrl);
    } catch { /* 存不下也只是下次回到默认端点 */ }
    // 到这一步连接已经成立了。以前要等下面三块面板全填完才亮绿，于是「已连接」的等待时间里
    // 混着 auth/health 那一秒——那只是一个状态探针，不该决定连接算不算成功。
    setConnection(true, "已连接");
    await Promise.all([
      loadDashboard({ refreshSupabaseHealth: true, forceSeries: true }),
      loadPrices({ force: true }),
      loadNotice({ force: true }).catch((error) =>
        setNoticeStatus(`公告读取失败：${error.message}`, true)
      ),
    ]);
    startAutoRefresh();
    showToast("已连接到授权服务");
  } catch (error) {
    stopAutoRefresh();
    setConnection(false, "连接失败");
    showToast(error.message, true);
  } finally {
    state.connecting = false;
    button.disabled = false;
    button.textContent = "连接";
  }
}

async function loadDashboard({ refreshSupabaseHealth = false, forceSeries = false } = {}) {
  if (state.refreshing) return null;
  state.refreshing = true;
  try {
    const [stats] = await Promise.all([loadStats(refreshSupabaseHealth), loadLicenses(), loadOrders(), loadDevices(), loadSeries({ force: forceSeries })]);
    return stats;
  } finally {
    state.refreshing = false;
  }
}

async function loadSupabaseHealth(force = false) {
  const now = Date.now();
  if (!shouldRefreshSupabaseHealth(now, state.supabaseHealthCheckedAt, SUPABASE_HEALTH_REFRESH_MS, force)) {
    return state.supabaseHealth;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPABASE_HEALTH_TIMEOUT_MS);
  const health = await fetch(SUPABASE_HEALTH_URL, { cache: "no-store", signal: controller.signal })
    .then(async (result) => {
      const body = await result.json().catch(() => ({}));
      return { ok: result.ok && Boolean(body?.ok), body };
    })
    .catch((error) => ({ ok: false, body: { healthError: error?.name === "AbortError" ? "TIMEOUT" : "UNAVAILABLE" } }))
    .finally(() => clearTimeout(timeout));
  state.supabaseHealth = health;
  state.supabaseHealthCheckedAt = now;
  return health;
}

function applySupabaseHealth(supabase) {
  const supabasePresentation = supabaseHealthPresentation(supabase);
  $("#service-supabase").textContent = supabasePresentation.databaseText;
  $("#service-supabase").className = supabasePresentation.databaseClassName;
  $("#service-catalog").textContent = supabasePresentation.catalogText;
  $("#service-catalog").className = supabasePresentation.catalogClassName;
  $("#service-state").textContent = supabasePresentation.overallText;
  $("#service-state").className = `state-label ${supabasePresentation.overallClassName}`;
  renderHealth(supabasePresentation, state.lastMaintenance);
}

async function loadStats(refreshSupabaseHealth = false) {
  // auth/health 实测每次 ≈1.0s（它顺带查库和私有换肤目录状态），而 admin-api 的统计数据只要 0.2s。
  // 它只服务服务页那三行状态标签，所以让它自己在后台跑、探到再补——不然整块连接被一个探针拖着。
  const healthPromise = loadSupabaseHealth(refreshSupabaseHealth);
  healthPromise.then(applySupabaseHealth).catch(() => {});
  const response = await api("/v1/admin/stats");
  const stats = response.licenses || {};
  $("#metric-total").textContent = ["unused", "active", "expired", "revoked"].reduce((sum, key) => sum + Number(stats[key] || 0), 0);
  $("#metric-unused").textContent = Number(stats.unused || 0);
  $("#metric-active").textContent = Number(stats.active || 0);
  $("#metric-devices").textContent = Number(response.activeDevices || 0);
  $("#service-worker").textContent = "在线";
  $("#service-db").textContent = "已连接";
  $("#service-environment").textContent = "staging";
  $("#service-cleanup").textContent = describeMaintenanceRun(response.maintenance);
  $("#service-cleanup").className = maintenanceToneClass(response.maintenance);
  $("#service-request").textContent = new Date().toLocaleTimeString("zh-CN");
  state.lastMaintenance = response.maintenance || null;
  renderAllocation(stats);
  // 服务页那三行和「需要留意」那条提示都要看健康探针：先用手里已有的结果画一版，探针回来再补。
  applySupabaseHealth(state.supabaseHealth);
  renderStamp();
  return response;
}

// ---------------------------------------------------------------------------
// 总览屏。这里只负责把已经取到的数据换个形状展示，不新增任何请求：
// 库存表、订单表、统计卡与总览共用同一批数据，所以两边永远不可能对不上。
// ---------------------------------------------------------------------------
function sensitiveValue(value) {
  return `<span class="sensitive-value">${escapeHtml(value)}</span>`;
}

function renderAllocation(stats) {
  const rows = ALLOC_STATUSES.map((item) => ({ ...item, value: Number(stats[item.key] || 0) }));
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  renderDonut($("#alloc-chart"), rows);
  $("#alloc-legend").innerHTML = rows
    .map((row) => {
      const pct = total ? `${Math.round((row.value / total) * 100)}%` : "--";
      return `<li class="alloc-row"><span class="alloc-row__swatch swatch-${row.key}" aria-hidden="true"></span><span class="alloc-row__name">${row.label}</span><span class="alloc-row__value">${row.value}</span><span class="alloc-row__pct">${pct}</span></li>`;
    })
    .join("");
}

function healthIssues(supabasePresentation, maintenance) {
  const issues = [];
  if ((supabasePresentation?.overallClassName || "") === "state-error") issues.push("Supabase 主库或目录同步异常");
  const lastRunMs = Number(maintenance?.lastRunMs || 0);
  if (!lastRunMs) issues.push("过期清理任务尚无运行记录");
  else if (Date.now() - lastRunMs > 26 * 3600 * 1000) issues.push(`过期清理任务已 ${Math.round((Date.now() - lastRunMs) / 3600000)} 小时没有运行记录`);
  if (maintenance?.lastError) issues.push(`清理上次报错：${maintenance.lastError}`);
  const remaining = Number(maintenance?.remainingExpired || 0);
  if (remaining > 0) issues.push(`仍有 ${remaining} 张过期卡密待清理`);
  return issues;
}

function renderHealth(supabasePresentation, maintenance) {
  const issues = healthIssues(supabasePresentation, maintenance);
  const broken = (supabasePresentation?.overallClassName || "") === "state-error" || Boolean(maintenance?.lastError);
  const level = issues.length === 0 ? "good" : broken ? "bad" : "warn";
  const marker = $("#health-marker");
  if (marker) marker.dataset.level = level;
  $("#health-line").textContent = issues.length
    ? `${issues.length} 项需要留意：${issues.join("；")}。`
    : "两条授权线、目录同步与过期清理都在正常范围内。";
  const callout = $("#cleanup-callout");
  callout.hidden = false;
  callout.className = `callout ${level === "good" ? "is-ok" : broken ? "is-danger" : ""}`;
  $("#cleanup-callout-title").textContent = level === "good" ? "清理任务正常" : "清理任务需要确认";
  $("#cleanup-callout-body").textContent = `${describeMaintenanceRun(maintenance)}。每小时一次的清理一旦停下，两侧会各堆一批过期卡密且没有任何痕迹，所以这一行必须常驻。`;
  const serviceBadge = $("#nav-count-service");
  if (serviceBadge) serviceBadge.textContent = issues.length ? String(issues.length) : "";
}

function renderStamp() {
  const stamp = new Date().toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
  $("#overview-stamp").textContent = `所有数字取自当前授权服务，截至 ${stamp}。`;
  $("#side-updated").textContent = `最近取数 ${new Date().toLocaleTimeString("zh-CN")}`;
  $("#side-endpoint").textContent = state.apiUrl ? state.apiUrl.replace(/^https:\/\//, "") : "未连接";
}

async function loadSeries({ force = false } = {}) {
  if (!hasAdminAccess()) return;
  const now = Date.now();
  if (!force && now - state.seriesLoadedAt < SERIES_REFRESH_MS) return;
  state.seriesLoadedAt = now;
  try {
    const body = await api(`/v1/admin/stats/series?days=${state.seriesDays}`);
    state.series = Array.isArray(body?.buckets) ? body : null;
    state.seriesError = state.series ? "" : "授权服务没有返回按日数据";
  } catch (error) {
    // 这条路由比界面晚部署是正常状态：说清楚「没有趋势数据」，而不是画一条假曲线。
    state.series = null;
    state.seriesError = error?.message || "趋势读取失败";
  }
  renderSeries();
}

function seriesTotalText(metric, totals) {
  if (metric === "revenue") return `${(Number(totals?.revenueCents || 0) / 100).toFixed(2)} 元`;
  return `${Number(totals?.[metric] || 0)} 张`;
}

function renderSeries() {
  const chart = $("#series-chart");
  const empty = $("#series-empty");
  const buckets = state.series?.buckets || [];
  if (!buckets.length) {
    chart.toggleAttribute("hidden", true);
    empty.hidden = false;
    empty.textContent = state.seriesError ? `暂无趋势数据：${state.seriesError}` : "连接后加载趋势。";
    $("#series-subcopy").textContent = "按日聚合的发卡 / 激活 / 到期 / 收入。";
    chart.setAttribute("aria-label", "暂无趋势数据。");
    return;
  }
  chart.toggleAttribute("hidden", false);
  empty.hidden = true;
  renderLineChart(chart, buckets, state.seriesMetric);
  $("#series-subcopy").textContent = `近 ${state.series.days || state.seriesDays} 天 · ${METRIC_LABELS[state.seriesMetric]} · 合计 ${seriesTotalText(state.seriesMetric, state.series.totals)} · ${state.series.from} 至 ${state.series.to}（${state.series.timezone || "UTC+8"}）`;
  $("#series-footnote").textContent = state.series.revenueAvailable === false
    ? "备用线（Cloudflare）没有金额列，所以收入趋势只有 Supabase 主线能给出；发卡 / 激活 / 到期三条在两条线上口径一致。"
    : state.series.truncated
      ? "样本已达单次读取上限，曲线只是窗口内最近 5000 条的聚合，可能偏低。"
      : "趋势只按时间戳计数，不区分卡密当前状态；一天的口径是东八区。";
}

function describeLicenseFilter() {
  const parts = [];
  const status = $("#status-filter").value;
  parts.push(status ? labels[status] : "全部状态");
  const planDays = $("#plan-days-filter").value.trim();
  if (planDays) parts.push(`${planDays} 天卡`);
  const search = $("#search-filter").value.trim();
  if (search) parts.push(`搜索「${search}」`);
  return parts.join(" · ");
}

function renderRecent() {
  const list = $("#recent-list");
  const items = state.currentItems.slice(0, 8);
  if (!items.length) {
    list.innerHTML = '<li class="recent-row"><span class="recent-row__main">连接后加载</span></li>';
  } else {
    list.innerHTML = items
      .map((item) => {
        const status = labels[item.status] || item.status || "未知";
        const code = item.code || item.code_prefix || "历史记录不可恢复";
        return `<li class="recent-row">
          <span class="recent-row__main">
            <span class="recent-row__title sensitive">${sensitiveValue(code)}</span>
            <span class="recent-row__meta">${escapeHtml(planLabel(item.plan_days))} · ${escapeHtml(formatDate(item.created_at))} 创建${item.note ? ` · 备注 <span class="recent-row__note">${escapeHtml(item.note)}</span>` : ""}</span>
          </span>
          <span class="recent-row__value">${escapeHtml(formatRemaining(item))}</span>
          <span class="status-badge status-${escapeAttribute(item.status)}">${escapeHtml(status)}</span>
        </li>`;
      })
      .join("");
  }
  const shown = items.length ? `最近 ${items.length} 条` : "暂无数据";
  $("#recent-subcopy").textContent = `${escapeHtml(describeLicenseFilter())} · 共 ${state.total} 条，这里只是${shown}，与库存表同一批数据。`;
}

function updateNavCounts() {
  const licenses = $("#nav-count-licenses");
  const orders = $("#nav-count-orders");
  if (licenses) licenses.textContent = state.total ? String(state.total) : "";
  if (orders) orders.textContent = state.orders.total ? String(state.orders.total) : "";
}

/**
 * 未连接时只在仪表盘留一个入口。连接表单本身住在「服务与连接」页 ——
 * 它不该作为浮层压在每一页顶部。
 */
function syncOfflineNotice() {
  const notice = $("#offline-notice");
  if (notice) notice.hidden = state.connected === true;
}

async function refreshAll() {
  if (!hasAdminAccess()) {
    openLoginDialog();
    return;
  }
  try {
    await loadDashboard({ refreshSupabaseHealth: true });
    await loadPrices();
    await loadNotice().catch((error) => setNoticeStatus(`公告读取失败：${error.message}`, true));
    await loadSeries({ force: true });
    showToast("数据已刷新");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function recoverSupabase() {
  if (!hasAdminAccess()) {
    openLoginDialog();
    return;
  }
  const button = $("#recover-supabase");
  button.disabled = true;
  button.textContent = "恢复中…";
  try {
    await api("/v1/admin/supabase/recover", { method: "POST" });
    state.supabaseHealthCheckedAt = 0;
    await loadDashboard({ refreshSupabaseHealth: true });
    showToast("Supabase 目录已恢复并重新检测");
  } catch (error) {
    state.supabaseHealthCheckedAt = 0;
    await loadDashboard({ refreshSupabaseHealth: true }).catch(() => {});
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "恢复 Supabase";
  }
}

async function reconcileDatabases() {
  if (!hasAdminAccess()) {
    openLoginDialog();
    return;
  }
  const button = $("#reconcile-databases");
  button.disabled = true;
  button.textContent = "对账中…";
  try {
    let result;
    for (let pass = 0; pass < 10; pass += 1) {
      result = await api("/v1/admin/sync/reconcile?full=1", { method: "POST" });
      if (!Number(result.pendingSync || 0)) break;
    }
    state.supabaseHealthCheckedAt = 0;
    await loadDashboard({ refreshSupabaseHealth: true });
    showToast(Number(result?.pendingSync || 0) ? "对账仍在后台继续" : "Supabase 与 D1 已完成对账");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "同步对账";
  }
}

async function cleanupExpired() {
  if (!hasAdminAccess()) {
    openLoginDialog();
    return;
  }
  const button = $("#cleanup-expired");
  button.disabled = true;
  button.textContent = "清理中…";
  try {
    const result = await api("/v1/admin/cleanup-expired", { method: "POST" });
    state.supabaseHealthCheckedAt = 0;
    await loadDashboard({ refreshSupabaseHealth: true });
    showToast(result.deletedCount ? `已清理 ${result.deletedCount} 张过期卡密` : "没有需要清理的过期卡密");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "清理过期";
  }
}

async function loadLicenses() {
  if (!hasAdminAccess()) return;
  const activeNoteEditor = document.activeElement?.matches?.("input[data-license-note]") === true;
  if (shouldDeferLicenseRefresh({ activeNoteEditor, pendingNoteSaves: state.pendingNoteSaves })) return;
  const query = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
  const status = $("#status-filter").value;
  const planDays = $("#plan-days-filter").value.trim();
  const search = $("#search-filter").value.trim();
  if (status) query.set("status", status);
  if (planDays) query.set("planDays", planDays);
  if (search) query.set("search", search);
  const response = await api(`/v1/admin/licenses?${query}`);
  state.total = Number(response.total || 0);
  const pageCount = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page > pageCount) {
    state.page = pageCount;
    return loadLicenses();
  }
  renderTable(response.items || []);
  $("#page-label").textContent = `第 ${state.page} / ${pageCount} 页`;
  $("#table-summary").textContent = state.total
    ? `显示 ${(state.page - 1) * state.pageSize + 1}-${Math.min(state.page * state.pageSize, state.total)} 条，共 ${state.total} 条`
    : "暂无激活码";
  const noItems = state.total === 0;
  $("#page-input").max = String(pageCount);
  $("#page-input").value = String(state.page);
  $("#page-input").disabled = noItems;
  $("#go-to-page").disabled = noItems;
  $("#first-page").disabled = noItems || state.page <= 1;
  $("#previous-page").disabled = noItems || state.page <= 1;
  $("#next-page").disabled = noItems || state.page >= pageCount;
  $("#last-page").disabled = noItems || state.page >= pageCount;
}

function renderTable(items) {
  state.currentItems = items;
  for (const item of items) {
    if (state.selectedLicenses.has(item.license_id)) state.selectedLicenses.set(item.license_id, item);
  }
  const table = $("#license-table");
  if (!items.length) {
    table.innerHTML = '<tr><td colspan="10" class="empty-state">没有符合条件的激活码</td></tr>';
    updateSelectionControls();
    renderRecent();
    updateNavCounts();
    return;
  }
  table.innerHTML = items.map((item) => {
    const status = labels[item.status] || item.status || "未知";
    const device = item.bound_device_id ? `${item.bound_device_id.slice(0, 8)}…` : "未绑定";
    const remaining = formatRemaining(item);
    // 刻意不给敏感值加 title：悬停提示会把遮罩里的原文直接暴露出来，那等于没遮。
    const code = item.code
      ? `<div class="license-code-cell"><span class="license-code sensitive">${sensitiveValue(item.code)}</span><button type="button" class="copy-code-button" data-action="copy" data-code="${escapeAttribute(item.code)}" title="复制激活码">复制</button></div>`
      : '<span class="license-code license-code-missing">历史记录不可恢复</span>';
    const action = item.status === "revoked"
      ? `<button type="button" class="button button-quiet" data-action="reset" data-id="${escapeAttribute(item.license_id)}">重置设备</button><button type="button" class="button button-danger" data-action="delete" data-id="${escapeAttribute(item.license_id)}">删除</button>`
      : item.status === "expired"
        ? `<button type="button" class="button button-danger" data-action="delete" data-id="${escapeAttribute(item.license_id)}">删除</button>`
      : item.status === "unused"
          ? `<button type="button" class="button button-danger" data-action="delete" data-id="${escapeAttribute(item.license_id)}">删除</button>`
          : `${isExtendable(item) ? `<button type="button" class="button button-quiet" data-action="extend" data-id="${escapeAttribute(item.license_id)}">延长</button>` : ""}${item.bound_device_id ? `<button type="button" class="button button-quiet" data-action="unbind" data-id="${escapeAttribute(item.license_id)}">解绑</button>` : ""}<button type="button" class="button button-quiet" data-action="revoke" data-id="${escapeAttribute(item.license_id)}">撤销</button>`;
    const note = item.note || "";
    const checked = state.selectedLicenses.has(item.license_id) ? " checked" : "";
    return `<tr>
      <td class="selection-cell"><input type="checkbox" data-license-select data-id="${escapeAttribute(item.license_id)}" aria-label="选择激活码 ${escapeAttribute(item.code || item.code_prefix)}"${checked} /></td>
      <td>${code}</td>
      <td class="plan-cell">${planLabel(item.plan_days)}</td>
      <td><span class="status-badge status-${escapeAttribute(item.status)}">${escapeHtml(status)}</span></td>
      <td class="note-cell"><input class="note-input" data-license-note data-id="${escapeAttribute(item.license_id)}" data-note-value="${escapeAttribute(note)}" type="text" value="${escapeAttribute(note)}" maxlength="500" placeholder="添加备注" aria-label="${escapeAttribute(item.code || item.code_prefix)} 的备注" /></td>
      <td class="time-cell">${formatDate(item.created_at)}</td>
      <td class="time-cell">${formatDate(item.expires_at)}</td>
      <td class="remaining-cell" data-remaining-for="${escapeAttribute(item.license_id)}">${escapeHtml(remaining)}</td>
      <td>${item.bound_device_id ? `<span class="sensitive">${sensitiveValue(device)}</span>` : escapeHtml(device)}</td>
      <td><div class="row-actions">${action}</div></td>
    </tr>`;
  }).join("");
  updateSelectionControls();
  renderRecent();
  updateNavCounts();
}

async function loadOrders() {
  if (!hasAdminAccess()) return;
  const query = new URLSearchParams({ page: String(state.orders.page), pageSize: String(state.orders.pageSize) });
  const status = $("#order-status-filter").value;
  const search = $("#order-search").value.trim();
  if (status) query.set("status", status);
  if (search) query.set("search", search);
  let response;
  try {
    response = await api(`/v1/admin/orders?${query}`);
  } catch (error) {
    $("#order-table").innerHTML = `<tr><td colspan="9" class="empty-state">${escapeHtml(error.message || "订单读取失败")}</td></tr>`;
    return;
  }
  state.orders.total = Number(response.total || 0);
  state.orders.items = response.items || [];
  renderOrdersTable();
}

function renderOrdersTable() {
  const pageCount = Math.max(1, Math.ceil(state.orders.total / state.orders.pageSize));
  if (state.orders.page > pageCount) state.orders.page = pageCount;
  const table = $("#order-table");
  if (!state.orders.items.length) {
    table.innerHTML = '<tr><td colspan="9" class="empty-state">没有符合条件的订单</td></tr>';
  } else {
    table.innerHTML = state.orders.items.map((item) => {
      const revealed = state.orders.revealed.get(item.orderId);
      const code = revealed || (item.codeAvailable ? '<span class="license-code license-code-missing">已隐藏</span>' : '<span class="license-code license-code-missing">尚未发卡</span>');
      const locked = item.lockedUntil && item.lockedUntil * 1000 > Date.now();
      const lockNote = locked || item.lookupFailures > 0
        ? `<br /><span class="status-badge status-${locked ? "expired" : "unused"}">${locked ? "已锁定" : `密码错 ${item.lookupFailures} 次`}</span>`
        : "";
      return `<tr>
        <td title="${escapeAttribute(item.orderId)}">${escapeHtml(item.orderId.slice(0, 8))}…</td>
        <td>${escapeHtml(item.productName || planLabel(item.planDays))}</td>
        <td>${item.amountYuan ? `<span class="sensitive">${sensitiveValue(`${item.amountYuan} 元`)}</span>` : "--"}</td>
        <td>${item.contactValue ? `<span class="sensitive">${sensitiveValue(item.contactValue)}</span>` : "--"}${lockNote}</td>
        <td><span class="status-badge status-${escapeAttribute(item.status)}">${escapeHtml(orderLabels[item.status] || item.status || "未知")}</span></td>
        <td class="time-cell">${formatDate(item.createdAt)}</td>
        <td class="time-cell">${formatDate(item.paidAt)}</td>
        <td>${code}</td>
        <td><div class="row-actions">
          ${item.codeAvailable ? `<button type="button" class="button button-quiet" data-order-action="reveal" data-id="${escapeAttribute(item.orderId)}">显码</button>` : ""}
          <button type="button" class="button button-quiet" data-order-action="reset-password" data-id="${escapeAttribute(item.orderId)}">重置密码</button>
          ${lockNote ? `<button type="button" class="button button-quiet" data-order-action="unlock" data-id="${escapeAttribute(item.orderId)}">解锁</button>` : ""}
        </div></td>
      </tr>`;
    }).join("");
  }
  $("#order-summary").textContent = state.orders.total ? `共 ${state.orders.total} 条` : "暂无订单";
  $("#order-page-label").textContent = `第 ${state.orders.page} / ${pageCount} 页`;
  $("#order-previous-page").disabled = state.orders.page <= 1;
  $("#order-next-page").disabled = state.orders.page >= pageCount;
  updateNavCounts();
}

/**
 * 设备与租约（只读页）。
 *
 * 这一页刻意不提供任何"直接改设备"的写接口：解绑在语义上属于**卡密**的动作
 * （一张卡密同时只能绑一台设备），所以按钮复用的就是库存页那条
 * `POST /v1/admin/licenses/{id}/unbind-device`，两条授权线上都已实现并有审计。
 */
async function loadDevices() {
  if (!hasAdminAccess()) return;
  const query = new URLSearchParams({ page: String(state.devices.page), pageSize: String(state.devices.pageSize) });
  const status = $("#device-status-filter").value;
  const search = $("#device-search").value.trim();
  if (status) query.set("status", status);
  if (search) query.set("search", search);
  let response;
  try {
    response = await api(`/v1/admin/devices?${query}`);
  } catch (error) {
    state.devices.items = [];
    state.devices.total = 0;
    $("#device-table").innerHTML = `<tr><td colspan="9" class="empty-state">${escapeHtml(error.message || "设备读取失败")}（设备端点需与界面一起部署）</td></tr>`;
    updateDevicePager();
    return;
  }
  state.devices.total = Number(response.total || 0);
  state.devices.items = response.items || [];
  renderDevicesTable();
  updateDevicePager();
}

function formatAgo(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 90) return "刚刚";
  if (delta < 5400) return `${Math.round(delta / 60)} 分钟前`;
  if (delta < 172800) return `${Math.round(delta / 3600)} 小时前`;
  return `${Math.round(delta / 86400)} 天前`;
}

function renderDevicesTable() {
  const table = $("#device-table");
  if (!state.devices.items.length) {
    table.innerHTML = '<tr><td colspan="9" class="empty-state">没有符合条件的设备</td></tr>';
    return;
  }
  table.innerHTML = state.devices.items.map((item) => {
    const lease = item.lease;
    const leaseText = !lease
      ? "无有效租约"
      : lease.revokedAt
        ? "已撤销"
        : `${formatAgo(lease.expiresAt)} · ${formatDate(lease.expiresAt)}`;
    const action = item.status === "active"
      ? `<button type="button" class="button button-quiet" data-device-action="unbind" data-license="${escapeAttribute(item.licenseId)}" data-code="${escapeAttribute(item.codePrefix || "")}">解绑该设备</button>`
      : "";
    return `<tr>
      <td><span class="device-cell sensitive">${sensitiveValue(item.deviceId || "--")}</span></td>
      <td>${item.codePrefix ? `<span class="license-code sensitive">${sensitiveValue(item.codePrefix)}</span>` : '<span class="license-code license-code-missing">--</span>'}</td>
      <td><span class="status-badge status-${escapeAttribute(item.status)}">${escapeHtml(deviceLabels[item.status] || item.status || "未知")}</span></td>
      <td><span class="status-badge status-${escapeAttribute(item.licenseStatus || "")}">${escapeHtml(labels[item.licenseStatus] || item.licenseStatus || "--")}</span></td>
      <td class="time-cell">${formatDate(item.firstSeenAt)}</td>
      <td class="time-cell">${escapeHtml(formatAgo(item.lastSeenAt))}</td>
      <td>${escapeHtml(item.appVersion || "--")}</td>
      <td class="time-cell">${escapeHtml(leaseText)}</td>
      <td><div class="row-actions">${action}<button type="button" class="button button-quiet" data-device-action="find-license" data-prefix="${escapeAttribute(item.codePrefix || "")}">按前缀查卡密</button></div></td>
    </tr>`;
  }).join("");
}

function updateDevicePager() {
  const pageCount = Math.max(1, Math.ceil(state.devices.total / state.devices.pageSize));
  if (state.devices.page > pageCount) state.devices.page = pageCount;
  $("#device-summary").textContent = state.devices.total ? `共 ${state.devices.total} 台设备` : "暂无设备";
  $("#device-page-label").textContent = `第 ${state.devices.page} / ${pageCount} 页`;
  $("#device-previous-page").disabled = state.devices.page <= 1;
  $("#device-next-page").disabled = state.devices.page >= pageCount;
  const badge = $("#nav-count-devices");
  if (badge) badge.textContent = state.devices.total ? String(state.devices.total) : "";
}

function applyDeviceFilters() {
  state.devices.page = 1;
  if (hasAdminAccess()) loadDevices().catch((error) => showToast(error.message, true));
}

function deviceGoToPage(page) {
  state.devices.page = Math.max(1, Number(page) || 1);
  loadDevices();
}

async function handleDeviceAction(event) {
  const button = event.target.closest("[data-device-action]");
  if (!button) return;
  const action = button.dataset.deviceAction;
  if (action === "find-license") {
    const prefix = button.dataset.prefix || "";
    if (prefix.length < 4) {
      showToast("这张卡密没有可搜索的前缀，请到库存页按状态找", true);
      return;
    }
    $("#search-filter").value = prefix;
    applyFilters();
    location.hash = "#/licenses";
    return;
  }
  if (action === "unbind") {
    const licenseId = button.dataset.license;
    if (!window.confirm(`解绑卡密 ${button.dataset.code || licenseId} 当前绑定的设备？卡密会保留有效期，用户下次需要重新激活并绑定设备。`)) return;
    button.disabled = true;
    try {
      await api(`/v1/admin/licenses/${encodeURIComponent(licenseId)}/unbind-device`, { method: "POST", body: "{}" });
      await loadDashboard();
      showToast("设备已解绑，用户可重新激活绑定");
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
    }
  }
}

function exportCurrentPageDevices() {
  const items = state.devices.items;
  if (!items.length) {
    showToast("本页没有可导出的设备", true);
    return;
  }
  const header = ["设备标识", "关联卡密前缀", "设备状态", "卡密状态", "套餐天数", "首次出现", "最近在线", "客户端版本", "系统版本", "租约到期", "解绑时间"];
  const rows = items.map((item) => [
    item.deviceId || "",
    item.codePrefix || "",
    deviceLabels[item.status] || item.status || "",
    labels[item.licenseStatus] || item.licenseStatus || "",
    item.planDays ?? "",
    formatDate(item.firstSeenAt),
    formatDate(item.lastSeenAt),
    item.appVersion || "",
    item.osVersion || "",
    item.lease ? formatDate(item.lease.expiresAt) : "",
    item.unboundAt ? formatDate(item.unboundAt) : "",
  ]);
  downloadText(buildCsv(header, rows), `yunara-devices-page${state.devices.page}-${dateStamp()}.csv`, "text/csv;charset=utf-8");
  showToast(`已导出本页 ${items.length} 台设备`);
}

function applyOrderFilters() {
  state.orders.page = 1;
  // 换条件就等于换了一批订单，上一批显出来的卡密不该继续留在页面上。
  state.orders.revealed.clear();
  loadOrders();
}

function orderGoToPage(page) {
  state.orders.page = Math.max(1, Number(page) || 1);
  state.orders.revealed.clear();
  loadOrders();
}

async function handleOrderAction(event) {
  const button = event.target.closest("[data-order-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.orderAction;
  try {
    if (action === "reveal") {
      if (!window.confirm("直显这张订单的激活码？该动作会写入审计记录。")) return;
      const result = await api(`/v1/admin/orders/${encodeURIComponent(id)}/reveal`, { method: "POST" });
      state.orders.revealed.set(id, `<span class="license-code sensitive">${sensitiveValue(result.code)}</span>`);
      renderOrdersTable();
      showToast("激活码已显示");
      return;
    }
    if (action === "reset-password") {
      const password = window.prompt("输入新的查询密码（4–64 位）。买家忘密码时这是唯一出路：旧密码只存哈希、无法找回，重置会同时解除锁定。");
      if (password === null) return;
      if (password.trim().length < 4) {
        showToast("查询密码至少 4 位", true);
        return;
      }
      await api(`/v1/admin/orders/${encodeURIComponent(id)}/reset-password`, { method: "POST", body: JSON.stringify({ queryPassword: password }) });
      showToast("查询密码已重置");
      loadOrders();
      return;
    }
    if (action === "unlock") {
      await api(`/v1/admin/orders/${encodeURIComponent(id)}/unlock`, { method: "POST" });
      showToast("已解除该订单的锁定");
      loadOrders();
    }
  } catch (error) {
    showToast(error.message || "订单操作失败", true);
  }
}

function formatRemaining(item) {
  if (item.status === "unused") return "激活后开始计时";
  if (item.status === "revoked") return "已撤销";
  const expiresAt = Number(item.expires_at || 0);
  if (!expiresAt) return "--";
  const seconds = expiresAt - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "已到期";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分`;
  return `${seconds}秒`;
}

function updateRemainingTimes() {
  for (const item of state.currentItems) {
    const cell = document.querySelector(`[data-remaining-for="${CSS.escape(item.license_id)}"]`);
    if (cell) cell.textContent = formatRemaining(item);
  }
}

function stopAutoRefresh() {
  clearInterval(refreshTimer);
  clearInterval(remainingTimer);
  refreshTimer = undefined;
  remainingTimer = undefined;
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (document.hidden || state.refreshing || !hasAdminAccess()) return;
    loadDashboard().catch(() => setConnection(false, "刷新失败"));
  }, AUTO_REFRESH_MS);
  remainingTimer = setInterval(updateRemainingTimes, REMAINING_REFRESH_MS);
  startStaticHostProbe();
}

function startStaticHostProbe() {
  if (location.hostname !== "wind-xber.upma.site") return;
  if (staticHostProbeTimer) return;
  const probe = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STATIC_HOST_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`./?__upma_probe=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      staticHostProbeFailures = response.ok ? 0 : staticHostProbeFailures + 1;
    } catch {
      staticHostProbeFailures += 1;
    } finally {
      clearTimeout(timeout);
    }
    if (shouldRedirectToStaticFallback({
      host: location.hostname,
      consecutiveFailures: staticHostProbeFailures,
    })) {
      location.replace(STATIC_FALLBACK_PAGE);
    }
  };
  probe();
  staticHostProbeTimer = setInterval(probe, STATIC_HOST_PROBE_MS);
}

function updateSelectionControls() {
  const count = state.selectedLicenses.size;
  $("#selected-count").textContent = count ? `已选择 ${count} 张密钥` : "未选择密钥";
  const exportButton = $("#export-selected");
  const deleteButton = $("#bulk-delete");
  exportButton.disabled = count === 0;
  deleteButton.disabled = count === 0;
  exportButton.textContent = count ? `导出所选 (${count})` : "导出所选";
  deleteButton.textContent = count ? `批量删除 (${count})` : "批量删除";

  const pageSelector = $("#select-page");
  const pageItems = state.currentItems;
  const selectedOnPage = pageItems.filter((item) => state.selectedLicenses.has(item.license_id)).length;
  pageSelector.checked = pageItems.length > 0 && selectedOnPage === pageItems.length;
  pageSelector.indeterminate = selectedOnPage > 0 && selectedOnPage < pageItems.length;
  pageSelector.disabled = pageItems.length === 0;
}

function clearSelection() {
  state.selectedLicenses.clear();
  updateSelectionControls();
}

function applyFilters() {
  state.page = 1;
  clearSelection();
  if (hasAdminAccess()) loadLicenses().catch((error) => showToast(error.message, true));
}

function getPageCount() {
  return Math.max(1, Math.ceil(state.total / state.pageSize));
}

async function goToPage(targetPage) {
  if (!hasAdminAccess()) {
    openLoginDialog();
    return;
  }
  const page = Number(targetPage);
  const pageCount = getPageCount();
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    $("#page-input").value = String(state.page);
    showToast(`请输入 1-${pageCount} 之间的页码`, true);
    return;
  }
  if (page === state.page) return;
  state.page = page;
  try {
    await loadLicenses();
  } catch (error) {
    showToast(error.message, true);
  }
}

function toggleCustomPlanDays() {
  const isCustom = $("#plan-days").value === "custom";
  const field = $("#custom-plan-days-field");
  const input = $("#custom-plan-days");
  field.hidden = !isCustom;
  input.required = isCustom;
  if (isCustom) input.focus();
}

function selectedPlanDays() {
  return Number($("#plan-days").value === "custom" ? $("#custom-plan-days").value : $("#plan-days").value);
}

async function createLicenses(event) {
  event.preventDefault();
  if (!hasAdminAccess()) {
    showToast("请先完成管理员登录", true);
    return;
  }
  const planDays = selectedPlanDays();
  const count = Number($("#license-count").value);
  if (!isValidPlanDays(planDays)) {
    showToast(`自定义天数需为 1-${MAX_PLAN_DAYS} 的整数`, true);
    $("#custom-plan-days").focus();
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    showToast("生成数量需为 1-100 的整数", true);
    $("#license-count").focus();
    return;
  }
  const button = $(".create-button");
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const note = $("#license-note").value.trim();
    const response = await api("/v1/admin/licenses", {
      method: "POST",
      body: JSON.stringify({ planDays, count, createdBy: "owner", note }),
    });
    state.codes = response.codes || [];
    $("#generated-count").textContent = response.count || state.codes.length;
    $("#generated-plan").textContent = response.planDays || planDays;
    $("#code-list").innerHTML = state.codes.map((code) => `<div class="code-item sensitive">${sensitiveValue(code)}</div>`).join("");
    $("#generated-result").hidden = false;
    $("#license-note").value = "";
    state.page = 1;
    clearSelection();
    await loadDashboard();
    showToast(`已生成 ${state.codes.length} 张激活码`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "生成激活码";
  }
}

async function handleTableAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "copy") {
    try {
      await copyText(button.dataset.code || "");
      showToast("激活码已复制");
    } catch {
      showToast("浏览器禁止访问剪贴板，请手动选择复制", true);
    }
    return;
  }

  if (action === "extend") {
    const item = state.currentItems.find((candidate) => candidate.license_id === button.dataset.id);
    if (!item || !isExtendable(item)) {
      showToast("这张卡密已过期或状态已改变，请刷新后重试", true);
      return;
    }
    openExtendDialog(item);
    return;
  }

  const id = button.dataset.id;
  const isDelete = action === "delete";
  const isUnbind = action === "unbind";
  const title = isDelete
    ? "永久删除这张激活码？关联设备、租约和保存的密钥也会清理。"
    : isUnbind
      ? "解绑这张激活码的当前设备？卡密会保留有效期，用户下次需要重新激活并绑定设备。"
    : action === "revoke"
      ? "撤销这张激活码？撤销后现有租约会立即失效。"
      : "重置这张激活码的设备绑定？";
  if (!window.confirm(title)) return;
  button.disabled = true;
  try {
    const path = isDelete
      ? `/v1/admin/licenses/${encodeURIComponent(id)}`
      : `/v1/admin/licenses/${encodeURIComponent(id)}/${action === "revoke" ? "revoke" : isUnbind ? "unbind-device" : "reset-device"}`;
    await api(path, { method: isDelete ? "DELETE" : "POST", ...(isDelete ? {} : { body: "{}" }) });
    if (isDelete) state.selectedLicenses.delete(id);
    await loadDashboard();
    showToast(isDelete ? "激活码已删除" : action === "revoke" ? "激活码已撤销" : isUnbind ? "设备已解绑，用户可重新激活绑定" : "设备绑定已重置");
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
}

function openExtendDialog(item) {
  state.extendingLicense = item;
  $("#extend-license-code").innerHTML = sensitiveValue(item.code || item.code_prefix || "--");
  $("#extend-license-expiry").textContent = formatDate(item.expires_at);
  $("#extend-license-remaining").textContent = formatRemaining(item);
  $("#extend-license-days").value = "30";
  const dialog = $("#extend-license-dialog");
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $("#extend-license-days").focus(), 0);
}

function closeExtendDialog() {
  state.extendingLicense = null;
  const dialog = $("#extend-license-dialog");
  if (dialog.open) dialog.close();
}

async function extendLicense(event) {
  event.preventDefault();
  const item = state.extendingLicense;
  const days = Number($("#extend-license-days").value);
  if (!item || !isExtendable(item)) {
    closeExtendDialog();
    showToast("这张卡密已过期或状态已改变，请刷新后重试", true);
    return;
  }
  if (!isValidPlanDays(days)) {
    showToast(`延长天数需为 1-${MAX_PLAN_DAYS} 的整数`, true);
    $("#extend-license-days").focus();
    return;
  }
  const submit = $("#extend-submit");
  submit.disabled = true;
  submit.textContent = "延长中…";
  try {
    const response = await api(`/v1/admin/licenses/${encodeURIComponent(item.license_id)}/extend`, {
      method: "POST",
      body: JSON.stringify({ days }),
    });
    closeExtendDialog();
    await loadDashboard();
    showToast(`已延长 ${response.days} 天`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
    submit.textContent = "确认延长";
  }
}

function handleSelectionChange(event) {
  const input = event.target.closest("input[data-license-select]");
  if (!input) return;
  const item = state.currentItems.find((candidate) => candidate.license_id === input.dataset.id);
  if (!item) return;
  if (input.checked) state.selectedLicenses.set(item.license_id, item);
  else state.selectedLicenses.delete(item.license_id);
  updateSelectionControls();
}

function handleSelectPageChange(event) {
  for (const item of state.currentItems) {
    if (event.target.checked) state.selectedLicenses.set(item.license_id, item);
    else state.selectedLicenses.delete(item.license_id);
  }
  renderTable(state.currentItems);
}

async function updateLicenseNote(input) {
  const id = input.dataset.id;
  const previous = input.dataset.noteValue || "";
  const note = input.value.trim();
  if (note === previous) return;
  state.pendingNoteSaves += 1;
  input.disabled = true;
  try {
    const response = await api(`/v1/admin/licenses/${encodeURIComponent(id)}/note`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    });
    const savedNote = response.note || "";
    input.value = savedNote;
    input.dataset.noteValue = savedNote;
    const selected = state.selectedLicenses.get(id);
    if (selected) selected.note = savedNote || null;
    const current = state.currentItems.find((item) => item.license_id === id);
    if (current) current.note = savedNote || null;
    // 仪表盘的「近期激活码」读的就是这一批数据，改完备注要立刻跟着重画，
    // 否则要等下一次 15 秒自动刷新才对得上。
    renderRecent();
    showToast("备注已保存");
  } catch (error) {
    input.value = previous;
    showToast(error.message, true);
  } finally {
    state.pendingNoteSaves = Math.max(0, state.pendingNoteSaves - 1);
    input.disabled = false;
  }
}

function handleNoteChange(event) {
  const input = event.target.closest("input[data-license-note]");
  if (input) updateLicenseNote(input);
}

function handleNoteKeydown(event) {
  const input = event.target.closest("input[data-license-note]");
  if (!input || event.key !== "Enter") return;
  event.preventDefault();
  input.blur();
}

async function bulkDeleteSelected() {
  const selected = Array.from(state.selectedLicenses.values());
  if (!selected.length) return;
  if (!window.confirm(`永久删除所选 ${selected.length} 张激活码？未使用、已撤销或已过期的密钥会被删除，关联设备、租约和保存的密钥也会清理。`)) return;
  const button = $("#bulk-delete");
  button.disabled = true;
  try {
    const response = await api("/v1/admin/licenses/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ licenseIds: selected.map((item) => item.license_id) }),
    });
    const deletedCount = (response.deletedIds || []).length;
    const skippedCount = (response.skippedIds || []).length;
    clearSelection();
    await loadDashboard();
    if (deletedCount && skippedCount) showToast(`已删除 ${deletedCount} 张；${skippedCount} 张仍不可删除`);
    else if (deletedCount) showToast(`已删除 ${deletedCount} 张激活码`);
    else showToast("所选密钥均不可删除，只有未使用、已撤销或已过期的密钥可以删除", true);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    updateSelectionControls();
  }
}

async function copyText(text) {
  if (!text) throw new Error("EMPTY_CLIPBOARD");
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("COPY_FAILED");
}

async function copyCodes() {
  if (!state.codes.length) return;
  try {
    await copyText(state.codes.join("\n"));
    showToast("已复制全部激活码");
  } catch {
    showToast("浏览器禁止访问剪贴板，请手动选择复制", true);
  }
}

function downloadText(content, filename, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function downloadCodes() {
  if (!state.codes.length) return;
  downloadText(`${state.codes.join("\n")}\n`, `yunara-licenses-${new Date().toISOString().slice(0, 10)}.txt`, "text/plain;charset=utf-8");
  showToast("激活码文件已下载");
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildCsv(header, rows) {
  return `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function dateStamp() { return new Date().toISOString().slice(0, 10); }

const LICENSE_CSV_HEADER = ["激活码", "套餐天数", "状态", "创建时间", "到期时间", "剩余时间", "绑定设备", "备注"];

function licenseCsvRow(item) {
  return [
    item.code || "",
    item.plan_days,
    labels[item.status] || item.status || "",
    formatDate(item.created_at),
    formatDate(item.expires_at),
    formatRemaining(item),
    item.bound_device_id || "",
    item.note || "",
  ];
}

function exportSelectedLicenses() {
  const selected = Array.from(state.selectedLicenses.values());
  if (!selected.length) return;
  const csv = buildCsv(LICENSE_CSV_HEADER, selected.map(licenseCsvRow));
  downloadText(csv, `yunara-selected-licenses-${dateStamp()}.csv`, "text/csv;charset=utf-8");
  showToast(`已导出 ${selected.length} 张所选密钥`);
}

function exportCurrentPageLicenses() {
  const items = state.currentItems;
  if (!items.length) {
    showToast("本页没有可导出的激活码", true);
    return;
  }
  const csv = buildCsv(LICENSE_CSV_HEADER, items.map(licenseCsvRow));
  downloadText(csv, `yunara-licenses-page${state.page}-${dateStamp()}.csv`, "text/csv;charset=utf-8");
  showToast(`已导出本页 ${items.length} 张激活码`);
}

/**
 * 订单 CSV 刻意不含激活码：直显必须是一次有意识、留审计记录的动作，
 * 批量导出把「整个订单表」变成「整个卡密表」，那条约束就没了。
 */
function exportCurrentPageOrders() {
  const items = state.orders.items;
  if (!items.length) {
    showToast("本页没有可导出的订单", true);
    return;
  }
  const header = ["订单号", "商品", "套餐天数", "金额(元)", "联系方式", "状态", "下单时间", "支付时间", "激活码可直显", "密码错误次数", "锁定至"];
  const locked = (item) => Boolean(item.lockedUntil && item.lockedUntil * 1000 > Date.now());
  const rows = items.map((item) => [
    item.orderId,
    item.productName || planLabel(item.planDays),
    item.planDays,
    item.amountYuan ?? "",
    item.contactValue || "",
    orderLabels[item.status] || item.status || "",
    formatDate(item.createdAt),
    formatDate(item.paidAt),
    item.codeAvailable ? "可直显" : "无",
    item.lookupFailures || 0,
    locked(item) ? formatDate(item.lockedUntil) : "",
  ]);
  downloadText(buildCsv(header, rows), `yunara-orders-page${state.orders.page}-${dateStamp()}.csv`, "text/csv;charset=utf-8");
  showToast(`已导出本页 ${items.length} 条订单`);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

state.adminKey = localStorage.getItem(ADMIN_KEY_STORAGE) || "";
$("#admin-key").value = state.adminKey;
$("#remember-admin-key").checked = Boolean(state.adminKey);
try {
  const savedApiUrl = localStorage.getItem(API_URL_STORAGE);
  if (savedApiUrl) $("#api-url").value = savedApiUrl;
} catch { /* 读不到就用页面里写死的默认端点 */ }
/**
 * 定时任务还在不在跑，必须一眼看得出来。
 * 上一轮就是教训：授权 Worker 的 cron 从 9 月 25 日起静默停止，两侧各堆了十几条过期卡密，
 * 两周没人发现——因为它的执行痕迹只写 console，而 console 在这台机器上取不到。
 * 所以清理每次运行都写 license.maintenance_runs，这里把「上次运行距今多久」直接摆出来。
 */
function describeMaintenanceRun(run) {
  const lastRunMs = Number(run && run.lastRunMs);
  if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) return "尚无记录";
  const minutes = Math.max(0, Math.round((Date.now() - lastRunMs) / 60000));
  const when = minutes < 90 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
  const remaining = Number(run.remainingExpired || 0);
  // 订单侧那两个数也要露出来：这张留痕存在的全部理由就是「作业还在跑」能从外部看出来，
  // 只报卡密那一半，等于订单退役哪天停跑了照样看不出来。
  const ordersExpired = Number(run.ordersExpired || 0);
  const ordersDeleted = Number(run.ordersDeleted || 0);
  const orders = ordersExpired || ordersDeleted ? ` · 订单翻期 ${ordersExpired} · 退役 ${ordersDeleted}` : "";
  return `${when} · 删 ${Number(run.deletedCount || 0)} 条${remaining ? ` · 仍剩 ${remaining}` : ""}${orders}`;
}

/** 超过 26 小时没有运行记录 = 每小时一次的清理停了；出错也照样标红，别让它安静地烂掉。 */
function maintenanceToneClass(run) {
  const lastRunMs = Number(run && run.lastRunMs);
  if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) return "state-label state-muted";
  if (run.lastError || Date.now() - lastRunMs > 26 * 3600 * 1000) return "state-label state-error";
  return "state-label state-ok";
}

// ---------------------------------------------------------------------------
// 主题：theme.js 已经在首屏绘制前把 data-theme 落到 <html> 上（CSP 禁内联脚本，
// 所以那段只能独立成文件），这里只负责切换、记住选择、以及让开关的 aria 状态跟得上。
// 没手动选过的人跟随系统；选过一次之后就以他的选择为准，不再被系统改走。
// ---------------------------------------------------------------------------
const THEME_STORAGE = "yunara.admin.theme";
const isDarkTheme = () => document.documentElement.dataset.theme === "dark";

function storedTheme() {
  try { return localStorage.getItem(THEME_STORAGE); } catch { return null; }
}

function syncThemeToggle() {
  const button = $("#theme-toggle");
  if (!button) return;
  button.setAttribute("aria-checked", String(isDarkTheme()));
  button.setAttribute("aria-label", isDarkTheme() ? "深色模式已开启，点击切回浅色" : "浅色模式，点击切换深色");
  // 字形与那行字跟着状态走：只看侧栏底部就能知道现在是哪个主题。
  const glyph = button.querySelector(".theme-toggle__glyph");
  if (glyph) glyph.textContent = isDarkTheme() ? "☀" : "☾";
  const text = button.querySelector(".theme-toggle__text");
  if (text) text.textContent = isDarkTheme() ? "切回浅色" : "深色模式";
}

function applyTheme(theme, remember) {
  if (theme === "dark") document.documentElement.dataset.theme = "dark";
  else document.documentElement.removeAttribute("data-theme");
  if (remember) {
    try { localStorage.setItem(THEME_STORAGE, theme); } catch { /* 隐私模式存不下，但这一屏该切过去 */ }
  }
  syncThemeToggle();
}

function toggleTheme() { applyTheme(isDarkTheme() ? "light" : "dark", true); }

// ---------------------------------------------------------------------------
// 售卖定价。价格存在服务端（license.sale_plans），付款页每次刷新都重新读，
// 所以这里改完立刻生效；写这条线只认主线，备用 Worker 上没有定价路由，
// 让失败切换逻辑去试它会白白多一次 404。
// ---------------------------------------------------------------------------
const PRICE_PLANS = [1, 7, 30];
const priceState = { loaded: new Map(), saving: false };

function yuanLabel(cents) { return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`; }

function setPriceStatus(message, tone) {
  const el = $("#price-status");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
  el.className = tone === "error" ? "price-warning" : "";
}

function readPriceInputs() {
  const entries = [];
  let valid = true;
  for (const planDays of PRICE_PLANS) {
    const raw = $(`#price-${planDays}`).value.trim();
    const yuan = Number(raw);
    if (raw === "" || !Number.isInteger(yuan) || yuan < 1 || yuan > 1000) {
      valid = false;
      entries.push({ planDays, cents: null });
      continue;
    }
    entries.push({ planDays, cents: yuan * 100 });
  }
  return { entries, valid };
}

function priceChanges() {
  const { entries, valid } = readPriceInputs();
  if (!valid) return null;
  return entries.filter((entry) => priceState.loaded.get(entry.planDays) !== entry.cents);
}

function syncPriceForm() {
  const changes = priceChanges();
  $("#price-save").disabled = changes === null || changes.length === 0 || priceState.saving;
  $("#price-save").textContent = priceState.saving ? "保存中…" : "保存价格";
  for (const input of PRICE_PLANS.map((planDays) => $(`#price-${planDays}`))) {
    input.setAttribute("aria-invalid", priceChanges() === null ? "true" : "false");
  }
  if (changes === null) setPriceStatus("每档必须是 1–1000 之间的整数元", "error");
}

function renderPricePanel(items) {
  const centsByPlan = new Map(items.map((item) => [Number(item.planDays), Number(item.priceCents)]));
  priceState.loaded = centsByPlan;
  for (const planDays of PRICE_PLANS) {
    const cents = centsByPlan.get(planDays);
    const input = $(`#price-${planDays}`);
    const current = $(`#price-current-${planDays}`);
    if (!Number.isFinite(cents) || cents <= 0) {
      input.value = "";
      current.textContent = "未读到价格";
      continue;
    }
    input.value = String(cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2));
    current.textContent = `买家实付 ${yuanLabel(cents + 10)}–${yuanLabel(cents + 99)}`;
  }
  syncPriceForm();
}

async function loadPrices({ force = false } = {}) {
  if (!hasAdminAccess()) return;
  // 自动刷新每 15 秒跑一次，正在编辑的价格不能被它抹掉。
  if (!force && priceChanges() !== null && priceChanges().length > 0) return;
  try {
    const body = await api("/v1/admin/prices", { method: "GET", endpoint: SUPABASE_API });
    renderPricePanel(body.items || []);
  } catch (error) {
    setPriceStatus(error.message, "error");
  }
}

async function savePrices() {
  const changes = priceChanges();
  if (!changes || changes.length === 0) return;
  const prices = {};
  for (const change of changes) prices[change.planDays] = change.cents;
  priceState.saving = true;
  syncPriceForm();
  try {
    const body = await api("/v1/admin/prices", { method: "POST", endpoint: SUPABASE_API, body: JSON.stringify({ prices }) });
    renderPricePanel(body.items || []);
    const warnings = body.warnings || [];
    setPriceStatus(warnings.length ? warnings.join("；") : "", warnings.length ? "error" : "");
    showToast(`已更新 ${changes.length} 档价格`);
  } catch (error) {
    setPriceStatus(error.message, "error");
    showToast(error.message, true);
  } finally {
    priceState.saving = false;
    syncPriceForm();
  }
}

const NOTICE_ENDPOINT = "/v1/admin/app-notice";
const noticeState = { loaded: null, saving: false };

function noticeValues() {
  return {
    severity: $("#notice-severity").value,
    summary: $("#notice-summary").value.trim(),
    content: $("#notice-content").value,
  };
}

function noticeDirty() {
  const loaded = noticeState.loaded;
  if (!loaded) return false;
  const current = noticeValues();
  return (
    current.severity !== loaded.severity ||
    current.summary !== loaded.summary ||
    current.content !== loaded.content
  );
}

function syncNoticeForm() {
  const hasDraft = Boolean($("#notice-summary").value.trim());
  $("#notice-save").disabled =
    !noticeState.loaded || noticeState.saving || !hasDraft || !noticeDirty();
  $("#notice-save").textContent = noticeState.saving ? "保存中…" : "保存公告";
}

function formatNoticeTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "--";
}

function setNoticeStatus(message, warning = false) {
  const el = $("#notice-status");
  el.textContent = message;
  el.hidden = !message;
  el.className = warning ? "price-warning" : "";
}

function renderNotice(value) {
  noticeState.loaded = {
    severity: value.severity,
    summary: value.summary || "",
    content: value.content || "",
    revision: value.revision || "",
    updatedAt: value.updatedAt || "",
  };
  $("#notice-severity").value = noticeState.loaded.severity;
  $("#notice-summary").value = noticeState.loaded.summary;
  $("#notice-content").value = noticeState.loaded.content;
  $("#notice-current-summary").textContent = `当前线上：${noticeState.loaded.summary || "（空）"}`;
  $("#notice-meta").textContent =
    `线上 revision ${noticeState.loaded.revision || "--"} · 更新于 ${formatNoticeTime(noticeState.loaded.updatedAt)}`;
  syncNoticeForm();
}

async function loadNotice({ force = false } = {}) {
  if (!force && noticeDirty()) {
    setNoticeStatus("有未保存的修改，已跳过自动刷新");
    return;
  }
  const body = await api(NOTICE_ENDPOINT, { method: "GET" });
  if (!body?.value || typeof body.value !== "object") throw new Error("授权服务没有返回公告");
  renderNotice(body.value);
  if (force) showToast("公告已重新读取");
}

async function saveNotice() {
  if (noticeState.saving) return;
  const current = noticeValues();
  if (!current.summary) {
    showToast("公告标题不能为空", true);
    return;
  }
  noticeState.saving = true;
  setNoticeStatus("");
  syncNoticeForm();
  try {
    const body = await api(NOTICE_ENDPOINT, { method: "POST", body: JSON.stringify(current) });
    if (!body?.notice) throw new Error(body?.error?.message || "公告保存失败");
    renderNotice(body.notice);
    if (body.staticFallback === "published") {
      setNoticeStatus("已同步到 Supabase 静态备源");
      showToast("公告已保存，主源与静态备源均已更新");
    } else if (body.staticFallback === "skipped") {
      setNoticeStatus("静态备源未配置（缺 SUPABASE_SYNC_URL / AUTH_SYNC_SECRET）", true);
    } else {
      setNoticeStatus("静态备源发布失败：连不上 Cloudflare 的用户这次看不到这条", true);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    noticeState.saving = false;
    syncNoticeForm();
  }
}

$("#admin-login-form").addEventListener("submit", login);
$("#admin-login-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("#login-skip").addEventListener("click", () => {
  $("#admin-login-dialog").close();
  // 连接表单住在「服务与连接」页，所以这里只是把用户送到那一页，不再开浮层。
  location.hash = "#/service";
  showToast("API 地址与管理员密钥就在这一页");
});
$("#connect-button").addEventListener("click", connect);
$("#refresh-button").addEventListener("click", refreshAll);
$("#export-page").addEventListener("click", exportCurrentPageLicenses);
$("#order-export-page").addEventListener("click", exportCurrentPageOrders);
$("#recover-supabase").addEventListener("click", recoverSupabase);
$("#reconcile-databases").addEventListener("click", reconcileDatabases);
$("#cleanup-expired").addEventListener("click", cleanupExpired);
$("#theme-toggle").addEventListener("click", toggleTheme);
syncThemeToggle();
if (!storedTheme() && window.matchMedia) {
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const followSystem = (event) => { if (!storedTheme()) applyTheme(event.matches ? "dark" : "light", false); };
  if (darkQuery.addEventListener) darkQuery.addEventListener("change", followSystem);
}
for (const planDays of PRICE_PLANS) $(`#price-${planDays}`).addEventListener("input", syncPriceForm);
$("#price-save").addEventListener("click", savePrices);
for (const selector of ["#notice-severity", "#notice-summary", "#notice-content"]) {
  $(selector).addEventListener("input", syncNoticeForm);
  $(selector).addEventListener("change", syncNoticeForm);
}
$("#notice-save").addEventListener("click", saveNotice);
$("#notice-reload").addEventListener("click", () => {
  loadNotice({ force: true }).catch((error) => showToast(error.message, true));
});
$("#table-refresh").addEventListener("click", async () => {
  if (!hasAdminAccess()) return;
  try {
    await loadLicenses();
    showToast("列表已刷新");
  } catch (error) {
    showToast(error.message, true);
  }
});
$("#create-form").addEventListener("submit", createLicenses);
$("#extend-license-form").addEventListener("submit", extendLicense);
$("#extend-cancel").addEventListener("click", closeExtendDialog);
$("#extend-cancel-top").addEventListener("click", closeExtendDialog);
$("#extend-license-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeExtendDialog();
});
document.querySelectorAll("[data-extend-days]").forEach((button) => {
  button.addEventListener("click", () => {
    $("#extend-license-days").value = button.dataset.extendDays || "30";
    $("#extend-license-days").focus();
  });
});
$("#plan-days").addEventListener("change", toggleCustomPlanDays);
$("#license-table").addEventListener("click", handleTableAction);
$("#license-table").addEventListener("change", handleSelectionChange);
$("#license-table").addEventListener("change", handleNoteChange);
$("#license-table").addEventListener("keydown", handleNoteKeydown);
$("#select-page").addEventListener("change", handleSelectPageChange);
$("#copy-codes").addEventListener("click", copyCodes);
$("#download-codes").addEventListener("click", downloadCodes);
$("#export-selected").addEventListener("click", exportSelectedLicenses);
$("#bulk-delete").addEventListener("click", bulkDeleteSelected);
$("#status-filter").addEventListener("change", applyFilters);
$("#plan-days-filter").addEventListener("change", applyFilters);
$("#search-button").addEventListener("click", applyFilters);
$("#search-filter").addEventListener("keydown", (event) => { if (event.key === "Enter") applyFilters(); });
$("#plan-days-filter").addEventListener("keydown", (event) => { if (event.key === "Enter") applyFilters(); });
$("#first-page").addEventListener("click", () => { goToPage(1); });
$("#previous-page").addEventListener("click", () => { goToPage(state.page - 1); });
$("#go-to-page").addEventListener("click", () => { goToPage($("#page-input").value); });
$("#page-input").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); goToPage(event.currentTarget.value); } });
$("#page-input").addEventListener("change", (event) => { goToPage(event.currentTarget.value); });
$("#next-page").addEventListener("click", () => { goToPage(state.page + 1); });
$("#last-page").addEventListener("click", () => { goToPage(getPageCount()); });
$("#order-table").addEventListener("click", handleOrderAction);
$("#order-status-filter").addEventListener("change", applyOrderFilters);
$("#order-search-button").addEventListener("click", applyOrderFilters);
$("#order-search").addEventListener("keydown", (event) => { if (event.key === "Enter") applyOrderFilters(); });
$("#order-refresh").addEventListener("click", () => { state.orders.revealed.clear(); loadOrders(); });
$("#order-previous-page").addEventListener("click", () => { orderGoToPage(state.orders.page - 1); });
$("#order-next-page").addEventListener("click", () => { orderGoToPage(state.orders.page + 1); });

// 设备与租约页
$("#device-status-filter").addEventListener("change", applyDeviceFilters);
$("#device-search-button").addEventListener("click", applyDeviceFilters);
$("#device-search").addEventListener("keydown", (event) => { if (event.key === "Enter") applyDeviceFilters(); });
$("#device-reset").addEventListener("click", () => {
  $("#device-status-filter").value = "";
  $("#device-search").value = "";
  applyDeviceFilters();
});
$("#device-refresh").addEventListener("click", () => {
  if (!hasAdminAccess()) return;
  loadDevices().then(() => showToast("设备列表已刷新")).catch((error) => showToast(error.message, true));
});
$("#device-export-page").addEventListener("click", exportCurrentPageDevices);
$("#device-table").addEventListener("click", handleDeviceAction);
$("#device-previous-page").addEventListener("click", () => deviceGoToPage(state.devices.page - 1));
$("#device-next-page").addEventListener("click", () => deviceGoToPage(state.devices.page + 1));

// 重置：清条件并重新查，不是只把输入框擦干净
$("#license-reset").addEventListener("click", () => {
  $("#status-filter").value = "";
  $("#plan-days-filter").value = "";
  $("#search-filter").value = "";
  applyFilters();
});
$("#order-reset").addEventListener("click", () => {
  $("#order-status-filter").value = "";
  $("#order-search").value = "";
  applyOrderFilters();
});

function changePageSize(key, target, value) {
  const size = Number(value);
  if (![20, 50, 100].includes(size)) return;
  state[key].pageSize = size;
  state[key].page = 1;
  if (key === "orders") state.orders.revealed.clear();
  if (key === "devices") return loadDevices();
  return loadOrders();
}
$("#page-size").addEventListener("change", (event) => {
  state.pageSize = Number(event.target.value) || 20;
  state.page = 1;
  clearSelection();
  if (hasAdminAccess()) loadLicenses().catch((error) => showToast(error.message, true));
});
$("#order-page-size").addEventListener("change", (event) => {
  if (hasAdminAccess()) changePageSize("orders", "#order-table", event.target.value).catch((error) => showToast(error.message, true));
});
$("#device-page-size").addEventListener("change", (event) => {
  if (hasAdminAccess()) changePageSize("devices", "#device-table", event.target.value).catch((error) => showToast(error.message, true));
});

// ---------------------------------------------------------------------------
// 总览屏的两个切换器。换时间范围要重新取数（窗口不一样），换指标只换画哪一列
// （同一批 buckets）—— 代价完全不同，所以故意写成两条路径，别合并成一个"刷新"。
// ---------------------------------------------------------------------------
initMask();

function syncRangeChips() {
  for (const button of document.querySelectorAll("[data-range]")) {
    const active = Number(button.dataset.range) === state.seriesDays;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function syncMetricChips() {
  for (const button of document.querySelectorAll("[data-metric]")) {
    const active = button.dataset.metric === state.seriesMetric;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function selectSeriesDays(days) {
  state.seriesDays = days;
  try { localStorage.setItem(SERIES_DAYS_STORAGE, String(days)); } catch { /* 存不下也照样能看图 */ }
  syncRangeChips();
  loadSeries({ force: true });
}

for (const button of document.querySelectorAll("[data-range]")) {
  button.addEventListener("click", () => selectSeriesDays(Number(button.dataset.range)));
}
for (const button of document.querySelectorAll("[data-metric]")) {
  button.addEventListener("click", () => {
    state.seriesMetric = button.dataset.metric;
    syncMetricChips();
    renderSeries();
  });
}

try {
  const storedDays = Number(localStorage.getItem(SERIES_DAYS_STORAGE));
  if ([1, 7, 30].includes(storedDays)) state.seriesDays = storedDays;
} catch { /* 读不到就用默认窗口 */ }
syncRangeChips();
syncMetricChips();

let seriesResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(seriesResizeTimer);
  seriesResizeTimer = setTimeout(() => { if (state.series) renderSeries(); }, 200);
});

initView({
  onNavigate: (view) => {
    // 折线是按容器宽度量的，图在隐藏的分屏里量到的是 0，所以回到总览要按真实宽度重画一次。
    if (view === "overview" && state.series) renderSeries();
  },
});

// 未连接时仪表盘上会留一个「去连接」的入口；连接成功后自动收起。
syncOfflineNotice();

toggleCustomPlanDays();
updateSelectionControls();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && hasAdminAccess() && !state.refreshing) {
    loadDashboard().catch(() => setConnection(false, "刷新失败"));
  }
});
/**
 * 开台就把手里的凭据用上：有未过期的会话（或记住的管理员密钥）就直接连，不再拦一道登录框。
 * 会话令牌默认只存在 sessionStorage —— 刷新页面还在、关掉标签页就没了；勾了「记住此设备」
 * 才落到 localStorage，跟着令牌自己的 8 小时到期走。
 */
function restoreSession() {
  const saved = readStoredSession();
  if (!saved) return false;
  state.sessionToken = saved.token;
  state.adminUsername = saved.username;
  if (saved.apiUrl) {
    state.apiUrl = saved.apiUrl;
    $("#api-url").value = saved.apiUrl;
  }
  return true;
}

function logout() {
  clearStoredSession();
  state.adminKey = "";
  $("#admin-key").value = "";
  $("#remember-admin-key").checked = false;
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  stopAutoRefresh();
  setConnection(false, "未连接");
  openLoginDialog();
}

restoreSession();
if (hasAdminAccess()) connect();
else openLoginDialog();
$("#logout-button").addEventListener("click", logout);

// Keep a previously loaded copy available when the static host is rate-limited
// or temporarily unreachable. The worker handles navigation fallback; this
// registration is intentionally best-effort so it never blocks the console.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
}
startStaticHostProbe();
