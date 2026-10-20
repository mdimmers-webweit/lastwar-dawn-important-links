"use strict";

let DATA = null;

const ROLE_OPTIONS = ["R5", "R4", "R3", "R2", "R1"];
const CACHE_BUST = "20261020-save-outlier";
const FILTER_STORAGE_KEY = "dawn-dashboard-filters";
const PERIOD_STORAGE_KEY = "dawn-dashboard-period";

/** Member-Filter nur auf Tabs mit Mitgliederdaten — nicht Links/Config. */
const FILTERABLE_VIEWS = new Set([
  "overview",
  "kills",
  "donations",
  "vs",
  "season",
  "events",
  "activity",
]);

/** @type {{ roles: string[], activeOnly: boolean, vsFlag: string, search: string }} */
let filters = { roles: [], activeOnly: true, vsFlag: "all", search: "" };

/** @type {"tag"|"woche"|"gesamt"} */
let periodMode = "tag";

let filterBarInitialized = false;

const IMPORTANT_LINKS_ORIGIN = "https://lastwar-dawn-important-links.pages.dev";
const IMPORTANT_LINKS_CONFIG_URL = IMPORTANT_LINKS_ORIGIN + "/config.json";
const IMPORTANT_LINKS_API_URL = IMPORTANT_LINKS_ORIGIN + "/api/config";
const VS_DAILY_MIN = 7200000;
/** Save/Economy = Tagesquote wie Push-Basis; fest 7.2M. */
const VS_SAVE_MIN = 7200000;
/** Save Mo–Do Outlier-Cap (darüber = „over“, kein Champion). */
const VS_OUTLIER_MAX = 12000000;
/** Config ≥20M = Champion/Push-Schwelle — nie als Save-Outlier. */
const VS_SAVE_OUTLIER_EXTREME = 20000000;

function parsePointsInput(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(/,/g, "");
  if (!s) return null;
  if (s.endsWith("m")) {
    const n = parseFloat(s.slice(0, -1));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 1e6);
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return Math.round(n * 1e6);
  return Math.round(n);
}

/** Push weeks: JSON ``max`` = optional elevated daily minimum (legacy key name). */
function pushElevatedMinFromEntry(entry) {
  if (!entry || String(entry.mode || "push").toLowerCase() !== "push") return null;
  const n = Number(entry.max);
  if (!Number.isFinite(n) || n <= VS_DAILY_MIN) return null;
  if (n === VS_OUTLIER_MAX) return null;
  return n;
}

/** Save/Economy Mo–Thu outlier; extreme ≥20M configs clamp to 12M. */
function saveOutlierMaxFromEntry(entry) {
  if (!entry || String(entry.mode || "").toLowerCase() !== "save") return null;
  const n = Number(entry.max);
  if (!Number.isFinite(n) || n <= VS_SAVE_MIN || n >= VS_SAVE_OUTLIER_EXTREME) {
    return VS_OUTLIER_MAX;
  }
  return n;
}

function formatPointsDe(n) {
  return Number(n).toLocaleString("de-DE");
}

function formatPointsInputValue(points) {
  if (points == null || points < 100000) return "";
  if (points >= 1_000_000 && points % 1_000_000 === 0) return points / 1_000_000 + "M";
  return String(points);
}

/** @type {object | null} */
let importantLinksConfig = null;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showError(msg) {
  const el = document.getElementById("bootErr");
  el.hidden = false;
  el.textContent = msg;
}

function showToast(msg, isError) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.hidden = true;
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("toast-error", !!isError);
  el.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

async function fetchImportantLinksConfig(force) {
  if (importantLinksConfig && !force) return importantLinksConfig;
  const res = await fetch(IMPORTANT_LINKS_CONFIG_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Konfiguration nicht geladen (HTTP ${res.status})`);
  importantLinksConfig = await res.json();
  return importantLinksConfig;
}

async function postImportantLinksConfig(body) {
  const res = await fetch(IMPORTANT_LINKS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error("Ungültige Antwort vom Server");
  }
  if (!json.ok) throw new Error(json.error || "Speichern fehlgeschlagen");
  return json;
}

function fmtPct(value, fallback) {
  if (value == null || Number.isNaN(value)) return fallback || "—";
  return (value * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " %";
}

function fmtNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("de-DE");
}

function formatStandBerlin() {
  if (DATA.stand_berlin) return String(DATA.stand_berlin);
  const raw = DATA.generated_at || DATA.snapshot;
  if (!raw) return "—";
  const iso = String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
  const withTz = /[Zz]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(withTz);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtPts(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (Number.isNaN(v)) return esc(String(n));
  if (v >= 1_000_000) return (v / 1_000_000).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + "M";
  return v.toLocaleString("de-DE");
}

function fmtThp(m) {
  const disp = m && m.thp_display != null ? String(m.thp_display).trim() : "";
  if (disp) return esc(disp);
  if (m && m.thp != null && m.thp !== "") return fmtNum(m.thp);
  return "—";
}

function vsBadge(flag) {
  const f = String(flag || "").trim();
  if (!f) return '<span class="badge off">—</span>';
  if (f === "OK") return '<span class="badge ok">OK</span>';
  if (/below/i.test(f)) return `<span class="badge warn">${esc(f)}</span>`;
  if (/over/i.test(f)) return `<span class="badge bad" title="Save/Economy over outlier">${esc(f)}</span>`;
  return `<span class="badge bad">${esc(f)}</span>`;
}

function ynBadge(val, label) {
  if (val === true) return `<span class="badge ok" title="${esc(label)}">Ja</span>`;
  if (val === false) return `<span class="badge off" title="${esc(label)}">Nein</span>`;
  return '<span class="badge off">—</span>';
}

function regPlayedCell(master) {
  if (!master) return "—";
  const reg = master.registered_display || (master.registered === true ? "Yes" : master.registered === false ? "No" : "");
  const played = master.played_display || (master.played === true ? "Yes" : master.played === false ? "No" : "");
  if (!reg && !played) return "—";
  const parts = [];
  if (reg) parts.push(`Reg: ${esc(reg)}`);
  if (played) parts.push(`Played: ${esc(played)}`);
  return parts.join(" · ");
}

function normalizeName(s) {
  return String(s ?? "")
    .normalize("NFC")
    .toLowerCase();
}

function nameMatchesSearch(name, query) {
  const q = normalizeName(query);
  if (!q) return true;
  return normalizeName(name).includes(q);
}

function filteredNameSet() {
  return new Set(filteredMembers().map((m) => normalizeName(m.name)));
}

function defaultFilters() {
  return { roles: [], activeOnly: true, vsFlag: "all", search: "" };
}

function sanitizeFilters(raw) {
  const base = defaultFilters();
  if (!raw || typeof raw !== "object") return base;
  let roles = raw.roles;
  if (!Array.isArray(roles)) {
    if (typeof raw.role === "string" && raw.role.trim() && ROLE_OPTIONS.includes(raw.role.trim())) {
      roles = [raw.role.trim()];
    } else {
      roles = [];
    }
  }
  roles = roles.filter((r) => ROLE_OPTIONS.includes(r));
  let vsFlag = String(raw.vsFlag ?? "all").toLowerCase();
  if (vsFlag !== "ok" && vsFlag !== "below") vsFlag = "all";
  return {
    roles,
    activeOnly: Boolean(raw.activeOnly),
    vsFlag,
    search: typeof raw.search === "string" ? raw.search : "",
  };
}

function noVsDataMessage() {
  if (periodMode === "tag") return "Heute noch keine Daten";
  if (periodMode === "woche") return "Keine VS-Daten für diese Woche";
  return "Keine VS-Daten verfügbar";
}

function noDonationDataMessage() {
  if (periodMode === "tag") return "Heute noch keine Daten";
  if (periodMode === "woche") return "Keine Spenden für diese Woche";
  return "Stand laut Dashboard-Sheet";
}

function berlinIsDst(at = new Date()) {
  const tz = at.toLocaleString("en-US", { timeZone: "Europe/Berlin", timeZoneName: "short" });
  return tz.includes("GMT+2") || tz.includes("CEST");
}

function berlinCalendarYmd(at = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" })
    .format(at)
    .split("-");
  return { y: Number(y), m: Number(m), d: Number(d) };
}

function berlinHour(at = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "numeric",
      hourCycle: "h23",
    }).format(at)
  );
}

/** Aktueller Spieltag (Europe/Berlin, Reset 03:00 / 04:00 MESZ). */
function currentGameDateLabel(now = new Date()) {
  const metaDate = DATA && DATA.meta && DATA.meta.GameDate;
  if (metaDate && /^\d{4}-\d{2}-\d{2}$/.test(String(metaDate))) {
    return String(metaDate);
  }
  const resetH = berlinIsDst(now) ? 4 : 3;
  let at = now;
  if (berlinHour(now) < resetH) {
    at = new Date(now.getTime() - 86400000);
  }
  const { y, m, d } = berlinCalendarYmd(at);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function currentGameDate() {
  return parseIsoDate(currentGameDateLabel()) || new Date();
}

function sheetColumnLabels(key) {
  return (sheetBlock(key) || {}).columns || [];
}

function hasSheetDateColumn(key, label) {
  return sheetColumnLabels(key).includes(label);
}

function loadFilterState() {
  const params = new URLSearchParams(location.search);
  const fromUrl = {
    roles: (params.get("role") || "")
      .split(",")
      .map((r) => r.trim())
      .filter((r) => ROLE_OPTIONS.includes(r)),
    vsFlag: params.get("vs") || "all",
    search: params.get("q") || "",
  };
  if (
    fromUrl.roles.length ||
    params.has("active") ||
    (fromUrl.vsFlag && fromUrl.vsFlag !== "all") ||
    fromUrl.search
  ) {
    filters = sanitizeFilters({
      ...defaultFilters(),
      roles: fromUrl.roles,
      activeOnly: params.has("active") ? params.get("active") === "1" : defaultFilters().activeOnly,
      vsFlag: fromUrl.vsFlag,
      search: fromUrl.search,
    });
    return;
  }
  try {
    const raw = sessionStorage.getItem(FILTER_STORAGE_KEY);
    if (raw) filters = sanitizeFilters({ ...defaultFilters(), ...JSON.parse(raw) });
    else filters = defaultFilters();
  } catch (e) {
    filters = defaultFilters();
  }
}

function loadPeriodState() {
  const params = new URLSearchParams(location.search);
  const p = params.get("period");
  if (p === "tag" || p === "woche" || p === "gesamt") {
    periodMode = p;
    return;
  }
  try {
    const stored = sessionStorage.getItem(PERIOD_STORAGE_KEY);
    if (stored === "tag" || stored === "woche" || stored === "gesamt") periodMode = stored;
  } catch (e) {
    /* ignore */
  }
}

function persistFilterState() {
  try {
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
    sessionStorage.setItem(PERIOD_STORAGE_KEY, periodMode);
  } catch (e) {
    /* ignore */
  }
  const params = new URLSearchParams(location.search);
  if (filters.roles.length) params.set("role", filters.roles.join(","));
  else params.delete("role");
  if (filters.activeOnly) params.set("active", "1");
  else params.delete("active");
  if (filters.vsFlag && filters.vsFlag !== "all") params.set("vs", filters.vsFlag);
  else params.delete("vs");
  if (filters.search.trim()) params.set("q", filters.search.trim());
  else params.delete("q");
  if (periodMode !== "woche") params.set("period", periodMode);
  else params.delete("period");
  const qs = params.toString();
  const url = location.pathname + (qs ? "?" + qs : "") + location.hash;
  try {
    history.replaceState(history.state, "", url);
  } catch (e) {
    /* file:// */
  }
}


function avgActFiltered(members) {
  if (!members.length) return null;
  return members.reduce((s, m) => s + (m.activity ?? 0), 0) / members.length;
}

function memberMatchesFilters(m) {
  if (filters.activeOnly && !m.active) return false;
  if (filters.roles.length && !filters.roles.includes(m.role)) return false;
  if (filters.vsFlag === "ok" && m.vs_flag !== "OK") return false;
  if (filters.vsFlag === "below" && !/below/i.test(String(m.vs_flag || ""))) return false;
  if (filters.search.trim() && !nameMatchesSearch(m.name, filters.search)) return false;
  return true;
}

function filteredMembers() {
  return (DATA.members || []).filter(memberMatchesFilters);
}

function sortedMembers(cmp) {
  return [...filteredMembers()].sort(cmp);
}

function vsSheetRow(name) {
  const block = sheetBlock("vs");
  if (!block || !block.rows) return null;
  const key = normalizeName(name);
  return block.rows.find((r) => normalizeName(r.name) === key) || null;
}

function memberVsLatest(m) {
  const row = vsSheetRow(m.name);
  if (!row) return 0;
  const cols = (sheetBlock("vs") || {}).columns || [];
  const latest = cols[0];
  if (latest && row.values && row.values[latest] != null) return Number(row.values[latest]) || 0;
  return Number(row.latest) || 0;
}

function donationSheetRow(name) {
  const block = sheetBlock("donations");
  if (!block || !block.rows) return null;
  const key = normalizeName(name);
  return block.rows.find((r) => normalizeName(r.name) === key) || null;
}

function parseIsoDate(label) {
  const s = String(label || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Google-Sheet-Serial oder ISO → Datum (VSLastDate). */
function parseMetaVsDate(raw) {
  const iso = parseIsoDate(raw);
  if (iso) return iso;
  const text = String(raw || "").trim();
  if (!/^\d+$/.test(text)) return null;
  const serial = Number(text);
  if (serial < 40000 || serial > 60000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86400000);
}

function isoDateLabel(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function pythonWeekday(d) {
  return (d.getUTCDay() + 6) % 7;
}

function legendConfig() {
  return (DATA && DATA.legend_config) || {};
}

function activeVsWeekKey() {
  const meta = (DATA && DATA.meta) || {};
  const y = Number(meta.VSWeekYear);
  const w = Number(meta.VSWeekNumber);
  if (Number.isFinite(y) && Number.isFinite(w) && y > 2000 && w >= 1 && w <= 53) {
    return { year: y, week: w };
  }
  return isoWeekKey(currentGameDate());
}

function vsWeeksEntryForDate(d) {
  const wk = isoWeekKey(d);
  const list = (DATA && DATA.vs_weeks) || [];
  const hit = list.find((item) => Number(item.year) === wk.year && Number(item.week) === wk.week);
  if (hit) return hit;
  const meta = (DATA && DATA.meta) || {};
  if (String(meta.VSWeekYear) === String(wk.year) && String(meta.VSWeekNumber) === String(wk.week)) {
    return { year: wk.year, week: wk.week, mode: meta.VSWeekMode || "push", max: null };
  }
  return { year: wk.year, week: wk.week, mode: "push", max: null };
}

function vsMinForGameDate(d) {
  if (!d) return 0;
  if (pythonWeekday(d) === 6) return 0;
  const cfg = legendConfig();
  const dailyMin = Number(cfg.vs_min_daily) || VS_DAILY_MIN;
  const saveMin = Number(cfg.vs_min_save) || VS_SAVE_MIN;
  const entry = vsWeeksEntryForDate(d);
  const mode = String(entry.mode || "push").toLowerCase();
  const wd = pythonWeekday(d);
  if (wd >= 4 || mode === "push") {
    if (mode === "push") {
      const elevated = pushElevatedMinFromEntry(entry);
      if (elevated && elevated > dailyMin) return elevated;
    }
    return dailyMin;
  }
  return saveMin;
}

function lastCapturedVsLabel() {
  const meta = (DATA && DATA.meta) || {};
  const fromMeta = parseMetaVsDate(meta.VSLastDate);
  return fromMeta ? isoDateLabel(fromMeta) : null;
}

function vsPointsAtLabel(member, label) {
  const row = vsSheetRow(member.name);
  if (!row || !row.values || !Object.prototype.hasOwnProperty.call(row.values, label)) return null;
  const raw = row.values[label];
  if (raw == null || raw === "") return null;
  const v = Number(raw);
  return Number.isNaN(v) ? null : v;
}

function memberBelowQuotaForPeriod(m) {
  if (periodMode === "tag") {
    const lab = currentGameDateLabel();
    if (!hasSheetDateColumn("vs", lab)) return false;
    const pts = vsPointsAtLabel(m, lab);
    if (pts == null) return false;
    const min = vsMinForGameDate(parseIsoDate(lab));
    if (min <= 0) return false;
    return pts < min;
  }
  return /below/i.test(String(m.vs_flag || ""));
}

/** Activity % im JSON = gewichteter Gesamt-KPI (Sheet), nicht Tages-/Wochenmodus. */
const WATCHLIST_DISPLAY_MAX = 15;

function memberLowActivityForWatchlist(m) {
  if (!m.active) return false;
  if ((m.activity ?? 0) >= 0.4) return false;
  return periodMode === "gesamt";
}

function buildWatchlistEntries(members, compare) {
  const watch = [];
  for (const m of members) {
    if (memberBelowQuotaForPeriod(m)) {
      const reason =
        periodMode === "tag" ? "VS heute unter Quote" : "VS unter Quote";
      watch.push({ m, reason, score: 3 });
    } else if (memberLowActivityForWatchlist(m)) {
      watch.push({ m, reason: "Niedrige Activity (Gesamt-KPI)", score: 2 });
    }
  }
  const cmpPlayers = (compare && compare.players) || [];
  for (const p of cmpPlayers) {
    if (!/unnecessary/i.test(String(p.verdict || ""))) continue;
    const mem = members.find((m) => normalizeName(m.name) === normalizeName(p.name));
    if (!mem) continue;
    watch.push({
      m: mem,
      reason: "Unnötige VS-Punkte",
      score: 1 + (Number(p.unnecessary) || 0) / 1e8,
    });
  }
  watch.sort(
    (a, b) =>
      b.score - a.score || String(a.m.name).localeCompare(String(b.m.name), "de")
  );
  return watch;
}

function memberVsStatusOk(m) {
  if (periodMode === "tag") {
    const lab = currentGameDateLabel();
    const pts = vsPointsAtLabel(m, lab);
    if (pts == null) return false;
    const min = vsMinForGameDate(parseIsoDate(lab));
    if (min <= 0) return pts > 0;
    return pts >= min;
  }
  return m.vs_flag === "OK";
}

function vsPulseCounts(members) {
  if (periodMode === "tag") {
    let ok = 0;
    let below = 0;
    const lab = currentGameDateLabel();
    const min = vsMinForGameDate(parseIsoDate(lab));
    if (!hasSheetDateColumn("vs", lab) || min <= 0) return { ok: 0, below: 0 };
    for (const m of members) {
      const pts = vsPointsAtLabel(m, lab);
      if (pts == null) continue;
      if (pts >= min) ok += 1;
      else below += 1;
    }
    return { ok, below };
  }
  return {
    ok: members.filter((m) => m.vs_flag === "OK").length,
    below: members.filter((m) => /below/i.test(String(m.vs_flag || ""))).length,
  };
}

function underQuotaBadge(m) {
  if (periodMode === "tag") {
    const lab = currentGameDateLabel();
    const pts = vsPointsAtLabel(m, lab);
    const min = vsMinForGameDate(parseIsoDate(lab));
    if (pts == null || min <= 0) return '<span class="badge off">—</span>';
    if (pts >= min) return '<span class="badge ok">OK</span>';
    return `<span class="badge warn">${fmtPts(pts)} · Min ${fmtPts(min)}</span>`;
  }
  return vsBadge(m.vs_flag);
}

function referenceVsDate() {
  const meta = DATA.meta || {};
  const fromMeta = parseMetaVsDate(meta.VSLastDate);
  if (fromMeta) return fromMeta;
  const block = sheetBlock("vs");
  const cols = (block && block.columns) || [];
  for (const col of cols) {
    const d = parseIsoDate(col);
    if (d) return d;
  }
  return new Date();
}

function sumVsRowValues(row, labelFilter) {
  const cells = row.values || {};
  let sum = 0;
  for (const [lab, raw] of Object.entries(cells)) {
    if (labelFilter && !labelFilter(lab)) continue;
    const v = Number(raw);
    if (!Number.isNaN(v)) sum += v;
  }
  return sum;
}

function donationMetric(member) {
  const row = donationSheetRow(member.name);
  const cols = sheetColumnLabels("donations");
  if (periodMode === "gesamt") return member.donations ?? 0;
  if (periodMode === "tag") {
    const today = currentGameDateLabel();
    if (!hasSheetDateColumn("donations", today)) return 0;
    if (!row || !row.values || row.values[today] == null) return 0;
    return Number(row.values[today]) || 0;
  }
  if (!row || !row.values) return member.donations ?? 0;
  const refWeek = isoWeekKey(currentGameDate());
  let sum = 0;
  for (const lab of cols) {
    const d = parseIsoDate(lab);
    if (!d) continue;
    const wk = isoWeekKey(d);
    if (wk.year === refWeek.year && wk.week === refWeek.week) {
      sum += Number(row.values[lab]) || 0;
    }
  }
  return sum;
}

function vsMetric(member) {
  const row = vsSheetRow(member.name);
  if (!row) return null;

  if (periodMode === "tag") {
    const today = currentGameDateLabel();
    if (!hasSheetDateColumn("vs", today)) return null;
    if (!row.values || row.values[today] == null) return null;
    const v = Number(row.values[today]);
    return Number.isNaN(v) ? null : v;
  }

  if (periodMode === "woche") {
    const refWeek = activeVsWeekKey();
    const weekSum = sumVsRowValues(row, (lab) => {
      const d = parseIsoDate(lab);
      if (!d) return false;
      const wk = isoWeekKey(d);
      return wk.year === refWeek.year && wk.week === refWeek.week;
    });
    if (weekSum > 0) return weekSum;
    if (row.latest != null) return Number(row.latest) || 0;
    if (row.weekly_avg != null) return Number(row.weekly_avg) || 0;
    return 0;
  }

  // Gesamt = Sheet-Stand (VS-Spalte „Latest“, nicht Summe aller Tage)
  if (row.latest != null) {
    const v = Number(row.latest);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  const meta = DATA.meta || {};
  const refDate = parseMetaVsDate(meta.VSLastDate);
  const refLabel = refDate ? isoDateLabel(refDate) : String(meta.VSLastDate || "").trim();
  if (refLabel && row.values && row.values[refLabel] != null) {
    return Number(row.values[refLabel]) || 0;
  }
  if (row.weekly_avg != null) return Number(row.weekly_avg) || 0;
  return 0;
}

function vsMetricSort(member) {
  const v = vsMetric(member);
  return v == null ? -1 : v;
}

function hasVsSheetData() {
  const block = sheetBlock("vs");
  return Boolean(block && block.rows && block.rows.length);
}

function killsMetric(member) {
  if (periodMode === "gesamt") return member.kills_pct ?? 0;
  return member.kills_pct ?? 0;
}

function currentIsoWeekLabel() {
  const wk = isoWeekKey(currentGameDate());
  return `${wk.year}-KW${String(wk.week).padStart(2, "0")}`;
}

function vsWeekModeLabel() {
  const meta = DATA.meta || {};
  const mode = String(meta.VSWeekMode || "push").toLowerCase();
  if (mode === "push") {
    const minLabel = meta.VSWeekMin || formatPointsDe(VS_DAILY_MIN);
    return `PUSH · Min ${minLabel}`;
  }
  const outlier = meta.VSWeekOutlierMax || formatPointsDe(VS_OUTLIER_MAX);
  return `SAVE · Min ${formatPointsDe(VS_SAVE_MIN)} · Outlier ${outlier}`;
}

function sheetBlock(key) {
  const sheets = DATA.sheets;
  return sheets && sheets[key] ? sheets[key] : null;
}

function renderMissingStrip() {
  const miss = sheetBlock("missing_entries");
  if (!miss || !miss.by_tab) return "";
  const parts = Object.entries(miss.by_tab)
    .map(
      ([tab, n]) =>
        `<span class="missing-pill"><strong>${esc(String(n ?? "—"))}</strong> · ${esc(tab)}</span>`
    )
    .join("");
  const total = miss.total != null ? ` · Summe ${esc(String(miss.total))}` : "";
  return (
    '<section class="panel glass">' +
    '<p class="gap-title">Datenlücken</p>' +
    `<div class="missing-strip" title="Active ohne Eintrag im Tab">${parts}${total}</div>` +
    "</section>"
  );
}

function renderPeriodToggle() {
  const modes = [
    ["tag", "Tag"],
    ["woche", "Woche"],
    ["gesamt", "Gesamt"],
  ];
  const btns = modes
    .map(
      ([id, label]) =>
        `<button type="button" data-period="${id}" aria-pressed="${periodMode === id}">${label}</button>`
    )
    .join("");
  return `<div class="period-toggle" role="group" aria-label="Zeitraum">${btns}</div>`;
}

function renderRankList(items, valueFn, emptyMsg) {
  if (!items.length) {
    return `<p class="sub">${esc(emptyMsg || "Keine Treffer mit aktuellem Filter.")}</p>`;
  }
  return (
    "<ol class=\"rank-list\">" +
    items
      .map(
        (m, i) =>
          `<li><span class="rank">${i + 1}</span>` +
          `<span class="who">${esc(m.name)}</span>` +
          `<span class="val">${valueFn(m)}</span></li>`
      )
      .join("") +
    "</ol>"
  );
}

function renderOverviewWidgets() {
  const members = filteredMembers();
  const vsReady = hasVsSheetData();
  const vsEmptyMsg = !vsReady ? "Keine VS-Daten verfügbar" : noVsDataMessage();
  const topVsAll = members
    .map((m) => ({ m, pts: vsMetric(m) }))
    .filter((x) => x.pts != null && x.pts > 0)
    .sort((a, b) => b.pts - a.pts);
  // Save/Economy „over“: kein Champion (z. B. >12M am Economy-Tag).
  const topVsChamp = topVsAll
    .filter((x) => !/over/i.test(String(x.m.vs_flag || "")))
    .slice(0, 5)
    .map((x) => x.m);
  const topVs = topVsAll.slice(0, 5).map((x) => x.m);
  const champ = topVsChamp[0];
  const underQuota = members
    .filter((m) => memberBelowQuotaForPeriod(m))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "de"))
    .slice(0, 8);
  const topDon = members
    .map((m) => ({ m, pts: donationMetric(m) }))
    .filter((x) => x.pts > 0)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 5)
    .map((x) => x.m);

  const compare = sheetBlock("vs_compare");
  const days = (compare && compare.days) || [];
  const compareWidget =
    days.length > 0
      ? `<article class="widget span-12 glass vs-overview-compare">${renderVsCompareDays(days)}</article>`
      : "";

  const vsPulse = vsPulseCounts(members);
  const vsOk = vsPulse.ok;
  const vsBelow = vsPulse.below;

  const watchAll = buildWatchlistEntries(members, compare);
  const watchShort = watchAll.slice(0, WATCHLIST_DISPLAY_MAX);
  const watchSubExtra =
    watchAll.length > watchShort.length
      ? ` · ${watchAll.length} gesamt, Top ${watchShort.length}`
      : watchAll.length
        ? ` · ${watchAll.length} Einträge`
        : "";
  const watchSub =
    periodMode === "tag"
      ? `Heute: VS unter Quote (nur wenn Tages-Spalte + Punkte)${watchSubExtra}`
      : periodMode === "woche"
        ? `Woche: VS-Flags & Vergleich${watchSubExtra}`
        : `Gesamt-KPI: Activity & VS-Flags${watchSubExtra}`;

  const periodHint =
    periodMode === "tag"
      ? "VS & Spende · heutiger Spieltag"
      : periodMode === "woche"
        ? "VS Wochensumme · Spende Wochensumme"
        : "Sheet-Stand · VS Latest · Spende Dashboard · VS-Flags";

  const champHtml = champ
    ? `<p class="sub">${esc(champ.name)} · ${fmtPts(vsMetric(champ))}</p>`
    : `<p class="sub">${esc(vsEmptyMsg)}</p>`;

  return (
    `<p class="sub">${esc(periodHint)} · ${members.length} Mitglieder nach Filter</p>` +
    '<div class="widget-grid">' +
    `<article class="widget span-4 glass"><h3>Champion VS</h3>${champHtml}` +
    renderRankList(
      vsReady && champ ? topVsChamp.slice(1) : [],
      (m) => fmtPts(vsMetric(m)),
      vsEmptyMsg
    ) +
    "</article>" +
    `<article class="widget span-4 glass"><h3>Top VS</h3><p class="sub">${
      periodMode === "gesamt" ? "Wochenstand (Sheet Latest)" : periodMode === "woche" ? "Wochensumme" : "Heute"
    }</p>` +
    renderRankList(vsReady ? topVs : [], (m) => fmtPts(vsMetric(m)), vsEmptyMsg) +
    "</article>" +
    `<article class="widget span-4 glass"><h3>Unter Quote</h3><p class="sub">${vsBelow} gesamt</p>` +
    (underQuota.length
      ? "<ul class=\"rank-list\">" +
        underQuota
          .map(
            (m) =>
              `<li><span class="rank">!</span><span class="who">${esc(m.name)}</span>` +
              `<span class="val">${underQuotaBadge(m)}</span></li>`
          )
          .join("") +
        "</ul>"
      : `<p class="sub">${esc(periodMode === "tag" && !hasSheetDateColumn("vs", currentGameDateLabel()) ? noVsDataMessage() : "Keine unter Quote im Filter.")}</p>`) +
    "</article>" +
    `<article class="widget span-4 glass"><h3>Top Spende</h3><p class="sub">${periodMode === "tag" ? "Heute" : periodMode === "woche" ? "Wochensumme" : "Gesamt"}</p>` +
    renderRankList(topDon, (m) => fmtNum(donationMetric(m)), noDonationDataMessage()) +
    "</article>" +
    compareWidget +
    `<article class="widget span-12 glass"><h3>Pulse</h3><div class="pulse-row">` +
    `<div class="pulse-pill"><strong>${fmtPct(avgActFiltered(members))}</strong>Ø Activity</div>` +
    `<div class="pulse-pill"><strong>${vsOk}</strong>VS OK</div>` +
    `<div class="pulse-pill"><strong>${vsBelow}</strong>Unter Quote</div>` +
    `<div class="pulse-pill"><strong>${fmtNum(
      topDon[0] ? donationMetric(topDon[0]) : null
    )}</strong>Top Spende</div>` +
    `<div class="pulse-pill"><strong>${fmtPts(champ ? vsMetric(champ) : null)}</strong>Top VS</div>` +
    "</div></article>" +
    `<article class="widget span-12 glass"><h3>Watchlist</h3><p class="sub">${esc(watchSub)}</p>` +
    (watchShort.length
      ? "<ul class=\"rank-list\">" +
        watchShort
          .map(
            (w) =>
              `<li><span class="rank">•</span><span class="who">${esc(w.m.name)}</span>` +
              `<span class="val">${esc(w.reason)}</span></li>`
          )
          .join("") +
        "</ul>"
      : '<p class="sub">Alles ruhig im Filter.</p>') +
    "</article></div>"
  );
}

function bindOverviewControls(root) {
  root.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      periodMode = btn.dataset.period;
      persistFilterState();
      renderAllViews();
    });
  });
}

function updateFilterCount() {
  const mount = document.getElementById("filterMount");
  if (!mount || !DATA) return;
  const countEl = mount.querySelector(".filter-count");
  if (countEl) {
    countEl.textContent = `${filteredMembers().length} / ${(DATA.members || []).length} sichtbar`;
  }
}

function syncRoleChipStates() {
  const mount = document.getElementById("filterMount");
  if (!mount) return;
  mount.querySelectorAll(".role-chip").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(filters.roles.includes(btn.dataset.role)));
  });
}

function onFiltersChanged() {
  filters = sanitizeFilters(filters);
  persistFilterState();
  updateFilterCount();
  syncRoleChipStates();
  renderAllViews();
}

function bindFilterBarOnce(mount) {
  if (filterBarInitialized) return;
  filterBarInitialized = true;
  mount.addEventListener("input", (e) => {
    if (e.target.id !== "filterSearch") return;
    filters.search = e.target.value;
    onFiltersChanged();
  });
  mount.addEventListener("change", (e) => {
    if (e.target.id === "filterActive") {
      filters.activeOnly = e.target.checked;
      onFiltersChanged();
    } else if (e.target.id === "filterVs") {
      filters.vsFlag = e.target.value;
      onFiltersChanged();
    }
  });
  mount.addEventListener("click", (e) => {
    const chip = e.target.closest(".role-chip");
    if (!chip || !chip.dataset.role) return;
    const role = chip.dataset.role;
    if (filters.roles.includes(role)) filters.roles = filters.roles.filter((r) => r !== role);
    else filters.roles = [...filters.roles, role];
    onFiltersChanged();
  });
}

function currentDashboardView() {
  const v = document.querySelector(".view:not([hidden])");
  return v ? v.id.slice(5) : "overview";
}

function syncFilterVisibility(view) {
  const mount = document.getElementById("filterMount");
  if (!mount) return;
  const v = view || currentDashboardView();
  mount.hidden = !FILTERABLE_VIEWS.has(v);
}

function renderFilterBar() {
  const mount = document.getElementById("filterMount");
  if (!mount || !DATA) return;
  syncFilterVisibility();
  bindFilterBarOnce(mount);
  const roleChips = ROLE_OPTIONS.map(
    (r) =>
      `<button type="button" class="role-chip" data-role="${r}" aria-pressed="${filters.roles.includes(r)}">${r}</button>`
  ).join("");
  mount.innerHTML =
    '<div class="filter-bar glass">' +
    '<div class="field"><label>Suche</label>' +
    `<input type="search" id="filterSearch" placeholder="Name…" value="${esc(filters.search)}" autocomplete="off"></div>` +
    '<div class="field"><label>Rolle</label><div class="role-chips">' +
    roleChips +
    "</div></div>" +
    '<div class="field"><label>VS Flag</label>' +
    `<select id="filterVs"><option value="all">Alle</option><option value="ok">OK</option><option value="below">Unter Quote</option></select></div>` +
    `<label class="filter-check"><input type="checkbox" id="filterActive" ${filters.activeOnly ? "checked" : ""}> Nur Active</label>` +
    `<span class="filter-count">${filteredMembers().length} / ${(DATA.members || []).length} sichtbar</span>` +
    "</div>";
  const vsSel = mount.querySelector("#filterVs");
  if (vsSel) vsSel.value = filters.vsFlag;
}

function renderAllViews() {
  renderOverview(document.getElementById("view-overview"));
  renderKills(document.getElementById("view-kills"));
  renderDonations(document.getElementById("view-donations"));
  renderVs(document.getElementById("view-vs"));
  renderSeason(document.getElementById("view-season"));
  renderEvents(document.getElementById("view-events"));
  renderActivity(document.getElementById("view-activity"));
  renderLinks(document.getElementById("view-links"));
  renderConfig(document.getElementById("view-config"));
}

function renderKpiCards() {
  const leg = DATA.legend || {};
  const sum = DATA.summary || {};
  const cards = [
    { label: "KPI Kills", value: leg["KPI Kills"] || "—", hint: "Gewicht Activity-Score" },
    { label: "KPI Donations", value: leg["KPI Donations"] || "—", hint: "Gewicht Activity-Score" },
    { label: "KPI Season", value: leg["KPI Season"] || "—", hint: "Gewicht Activity-Score" },
    { label: "KPI VS", value: leg["KPI VS"] || "—", hint: "Gewicht Activity-Score" },
    {
      label: "Aktive Mitglieder",
      value: String(sum.members_active ?? "—"),
      hint: `von ${sum.members_total ?? "—"} in der Liste`,
      accent: true,
    },
    {
      label: "Ø Activity",
      value: fmtPct(sum.activity_avg),
      hint: "Sheet-Spalte Activity (0–100 %)",
      accent: true,
    },
    {
      label: "VS Status OK",
      value: String(sum.vs_ok ?? "—"),
      hint: `${sum.vs_below_quota ?? 0} unter Quote · ${sum.vs_other ?? 0} sonstige Flags`,
      accent: true,
    },
    {
      label: "VS Min heute",
      value: (DATA.meta && DATA.meta.VSMinToday) || "—",
      hint: `Modus: ${(DATA.meta && DATA.meta.VSWeekMode) || "—"}`,
      accent: true,
    },
  ];
  return (
    '<div class="kpi-grid">' +
    cards
      .map(
        (c) =>
          `<article class="kpi-card glass${c.accent ? " accent" : ""}">` +
          `<p class="label">${esc(c.label)}</p>` +
          `<p class="value">${esc(c.value)}</p>` +
          `<p class="hint">${esc(c.hint)}</p></article>`
      )
      .join("") +
    "</div>"
  );
}

function memberTable(columns, rows, extraClass) {
  const head = columns
    .map((c) => `<th class="${esc(c.class || "")}">${esc(c.label)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const cls = row._inactive ? ' class="inactive"' : "";
      return `<tr${cls}>${columns
        .map((c) => `<td class="${esc(c.class || "")}">${row[c.key]}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  const tbl = extraClass ? ` ${extraClass}` : "";
  return `<div class="table-wrap"><table class="t${tbl}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function matrixTable(block, opts) {
  if (!block || !block.columns || !block.rows) return "";
  const maxRows = (opts && opts.maxRows) || 40;
  const cols = [{ key: "name", label: "Name", class: "name" }].concat(
    block.columns.map((c) => ({ key: c, label: c, class: "num" }))
  );
  let sourceRows = block.rows;
  if (!opts || opts.respectFilters !== false) {
    const allowed = filteredNameSet();
    sourceRows = sourceRows.filter((r) => allowed.has(normalizeName(r.name)));
  }
  const rows = sourceRows.slice(0, maxRows).map((r) => {
    const out = { name: `<span class="name">${esc(r.name)}</span>` };
    for (const c of block.columns) {
      out[c] = fmtPts(r.values && r.values[c] != null ? r.values[c] : r.daily_scores && r.daily_scores[c]);
    }
    if (r.latest != null) out.latest = fmtPts(r.latest);
    if (r.weekly_avg != null) out.weekly_avg = fmtPts(r.weekly_avg);
    return out;
  });
  if (block.summary_columns) {
    cols.splice(1, 0, { key: "latest", label: "Latest", class: "num" });
    cols.splice(2, 0, { key: "weekly_avg", label: "Ø Woche", class: "num" });
  }
  return memberTable(cols, rows, "compact");
}

function overviewRow(m) {
  const gt = m.generals_trial || {};
  return {
    _inactive: !m.active,
    role: esc(m.role),
    name: `<span class="name">${esc(m.name)}</span>`,
    thp: fmtThp(m),
    activity: esc(m.activity_display || fmtPct(m.activity)),
    season: esc(m.season_display || fmtPct(m.season_activity)),
    kills: esc(m.kills || "—"),
    donations: fmtNum(m.donations),
    events: esc(m.events || gt.level || "—"),
    ds: ynBadge(m.ds, "DS Registered") + " " + ynBadge((m.ds_master || {}).played, "DS Played"),
    cs: ynBadge(m.cs, "CS Registered") + " " + ynBadge((m.cs_master || {}).played, "CS Played"),
    vs: vsBadge(m.vs_flag),
  };
}

function renderOverview(el) {
  const stand = formatStandBerlin();
  el.innerHTML =
    '<section class="hero-ops glass">' +
    '<div class="hero-ops-inner">' +
    '<div class="hero-meta">' +
    `<p class="hero-stand">Stand <strong>${esc(stand)}</strong>` +
    `<span class="hero-mode-chip">${esc(currentIsoWeekLabel())} · ${esc(vsWeekModeLabel())}</span></p>` +
    renderPeriodToggle() +
    "</div>" +
    '<h2 class="hero-headline">DawN · <em>Ops Overview</em></h2>' +
    renderOverviewWidgets() +
    "</div></section>" +
    renderMissingStrip();
  bindOverviewControls(el);
}

function renderKills(el) {
  const block = sheetBlock("kills");
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    { key: "kills", label: "Kills Δ", class: "num" },
    { key: "activity", label: "Activity", class: "num" },
    { key: "events", label: "Events" },
  ];
  const rows = sortedMembers((a, b) => (b.kills_pct ?? -1) - (a.kills_pct ?? -1)).map((m) => ({
    _inactive: !m.active,
    role: esc(m.role),
    name: `<span class="name">${esc(m.name)}</span>`,
    kills: esc(m.kills || "—"),
    activity: esc(m.activity_display || fmtPct(m.activity)),
    events: esc(m.events || "—"),
  }));
  el.innerHTML =
    '<section class="panel glass"><h2>Kills</h2>' +
    '<p class="lead">Dashboard-Spalte Kills (WoW-Δ) plus Kalenderwochen aus dem Kills-Tab.</p>' +
    (block
      ? `<h3>Kills-Sheet · ${esc(block.columns.join(", "))}</h3>` + matrixTable(block)
      : "") +
    memberTable(cols, rows) +
    "</section>";
}

function renderDonations(el) {
  const block = sheetBlock("donations");
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    { key: "donations", label: "Spende", class: "num" },
    { key: "activity", label: "Activity", class: "num" },
  ];
  const rows = sortedMembers((a, b) => donationMetric(b) - donationMetric(a)).map((m) => ({
    _inactive: !m.active,
    role: esc(m.role),
    name: `<span class="name">${esc(m.name)}</span>`,
    donations: fmtNum(donationMetric(m)),
    activity: esc(m.activity_display || fmtPct(m.activity)),
  }));
  el.innerHTML =
    '<section class="panel glass"><h2>Donations</h2>' +
    '<p class="lead">Allianz-Spenden nach gewähltem Zeitraum (Overview: Tag/Woche/Gesamt).</p>' +
    (block
      ? `<h3>Donations-Sheet · recent</h3>` + matrixTable(block)
      : "") +
    memberTable(cols, rows) +
    "</section>";
}

function vsCompareDaysSorted(days) {
  return [...(days || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

/** Burn-up: kumulierte DawN- vs. Gegner-Punkte über VS-Tage (SVG, kein Chart-Lib). */
function renderVsBurnupChart(days) {
  const sorted = vsCompareDaysSorted(days);
  if (!sorted.length) return "";
  let cumDawn = 0;
  let cumOpp = 0;
  const series = sorted.map((d) => {
    cumDawn += Number(d.dawn) || 0;
    cumOpp += Number(d.opponent) || 0;
    return {
      date: d.date,
      dawn: cumDawn,
      opp: cumOpp,
      dayDawn: Number(d.dawn) || 0,
      dayOpp: Number(d.opponent) || 0,
      result: d.result,
    };
  });
  const maxY = Math.max(...series.map((p) => Math.max(p.dawn, p.opp)), 1);
  const W = 640;
  const H = 220;
  const pad = { t: 18, r: 16, b: 36, l: 48 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = series.length;
  const xAt = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yAt = (v) => pad.t + ih - (v / maxY) * ih;
  const pathFor = (key) =>
    series
      .map((p, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(p[key]).toFixed(1)}`)
      .join(" ");
  const areaDawn =
    `M${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} ` +
    series.map((p, i) => `L${xAt(i).toFixed(1)},${yAt(p.dawn).toFixed(1)}`).join(" ") +
    ` L${xAt(n - 1).toFixed(1)},${yAt(0).toFixed(1)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const v = maxY * t;
    const y = yAt(v);
    return (
      `<line class="chart-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" />` +
      `<text class="chart-tick" x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmtPts(v))}</text>`
    );
  });
  const labels = series
    .map((p, i) => {
      const label = String(p.date || "").slice(5); // MM-DD
      return `<text class="chart-x" x="${xAt(i).toFixed(1)}" y="${H - 12}" text-anchor="middle">${esc(label)}</text>`;
    })
    .join("");
  const dots = series
    .map((p, i) => {
      return (
        `<circle class="chart-dot dawn" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.dawn).toFixed(1)}" r="4">` +
        `<title>${esc(p.date)} DawN ${fmtPts(p.dawn)}</title></circle>` +
        `<circle class="chart-dot opp" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.opp).toFixed(1)}" r="4">` +
        `<title>${esc(p.date)} Gegner ${fmtPts(p.opp)}</title></circle>`
      );
    })
    .join("");
  const last = series[series.length - 1];
  const gap = last.opp - last.dawn;
  const summary =
    gap > 0
      ? `Rückstand ${fmtPts(gap)} · Burn-up`
      : gap < 0
        ? `Vorsprung ${fmtPts(-gap)} · Burn-up`
        : `Gleichstand · Burn-up`;
  return (
    '<div class="vs-chart glass">' +
    `<div class="vs-chart-head"><h3>VS Burn-up</h3><p class="sub">${esc(summary)}</p></div>` +
    '<div class="vs-chart-legend" aria-hidden="true">' +
    '<span class="lg dawn">DawN kumuliert</span><span class="lg opp">Gegner kumuliert</span></div>' +
    `<svg class="vs-burnup" viewBox="0 0 ${W} ${H}" role="img" aria-label="Burn-up Chart DawN gegen Gegner">` +
    ticks.join("") +
    `<path class="chart-area dawn" d="${areaDawn}" />` +
    `<path class="chart-line dawn" d="${pathFor("dawn")}" fill="none" />` +
    `<path class="chart-line opp" d="${pathFor("opp")}" fill="none" />` +
    dots +
    labels +
    "</svg></div>"
  );
}

function renderVsCompareDays(days) {
  if (!days || !days.length) return "";
  const sorted = vsCompareDaysSorted(days);
  const cards = sorted
    .map((d) => {
      const win = /win/i.test(String(d.result || ""));
      const loss = /loss/i.test(String(d.result || ""));
      const tone = win ? "win" : loss ? "loss" : "";
      return (
        `<article class="vs-day-card ${tone}">` +
        `<header><span class="d">${esc(d.date)}</span>` +
        `<span class="res">${esc(d.result || "—")}</span></header>` +
        '<dl class="vs-day-metrics">' +
        `<div><dt>DawN</dt><dd>${fmtPts(d.dawn)}</dd></div>` +
        `<div><dt>Gegner</dt><dd>${fmtPts(d.opponent)}</dd></div>` +
        `<div><dt>Delta</dt><dd class="num">${fmtPts(d.delta)}</dd></div>` +
        `<div><dt>Unnötig</dt><dd class="num">${fmtPts(d.unnecessary)}</dd></div>` +
        "</dl></article>"
      );
    })
    .join("");
  return (
    '<div class="vs-compare-block">' +
    "<h3>VS-Vergleich · Tage</h3>" +
    `<div class="vs-day-cards">${cards}</div>` +
    renderVsBurnupChart(sorted) +
    "</div>"
  );
}

function renderVsMetaSummary() {
  const meta = DATA.meta || {};
  const mode = String(meta.VSWeekMode || "push").toLowerCase();
  const pairs = [
    ["Letzter VS-Tag", meta.VSLastDate],
    ["Mindestpunkte heute", meta.VSMinToday],
    ["Wochenmodus", meta.VSWeekMode ? String(meta.VSWeekMode).toUpperCase() : ""],
  ];
  if (mode === "push") {
    pairs.push(["Push-Minimum", meta.VSWeekMin || formatPointsDe(VS_DAILY_MIN)]);
  } else {
    pairs.push(["Save-Minimum", meta.VSWeekMin || formatPointsDe(VS_SAVE_MIN)]);
    pairs.push([
      "Save-Outlier Mo–Do",
      meta.VSWeekOutlierMax || formatPointsDe(VS_OUTLIER_MAX),
    ]);
  }
  const visible = pairs.filter(([, v]) => v != null && String(v).trim());
  if (!visible.length) return "";
  return (
    '<div class="meta-grid">' +
    visible
      .map(
        ([k, v]) =>
          `<div class="meta-chip"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`
      )
      .join("") +
    "</div>"
  );
}

function renderVs(el) {
  const vsBlock = sheetBlock("vs");
  const compare = sheetBlock("vs_compare");
  const compareDays = compare && compare.days && compare.days.length ? compare.days : null;
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    { key: "vs_pts", label: "VS Punkte", class: "num" },
    { key: "vs", label: "VS Flag" },
    { key: "activity", label: "Activity", class: "num" },
  ];
  const rows = sortedMembers((a, b) => vsMetricSort(b) - vsMetricSort(a)).map((m) => ({
    _inactive: !m.active,
    role: esc(m.role),
    name: `<span class="name">${esc(m.name)}</span>`,
    vs_pts: fmtPts(vsMetric(m)),
    vs: vsBadge(m.vs_flag),
    activity: esc(m.activity_display || fmtPct(m.activity)),
  }));
  el.innerHTML =
    '<section class="panel glass"><h2>VS</h2>' +
    '<p class="lead">VS-Punkte und Flags — Zeitraum wie in Overview (Tag/Woche/Gesamt).</p>' +
    renderVsMetaSummary() +
    (compareDays ? renderVsCompareDays(compareDays) : "") +
    (vsBlock
      ? `<h3>VS-Sheet · ${esc((vsBlock.columns || []).join(", "))}</h3>` +
        matrixTable(vsBlock, { maxRows: 35 })
      : "") +
    memberTable(cols, rows) +
    "</section>";
}

function renderMasterTable(block, title) {
  if (!block || !block.rows || !block.rows.length) return "";
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name", class: "name" },
    { key: "thp", label: "THP", class: "num" },
    { key: "team", label: "Team" },
    { key: "slot", label: "Slot" },
    { key: "registered", label: "Registered" },
    { key: "played", label: "Played" },
    { key: "comment", label: "Comment" },
  ];
  const rows = block.rows.map((r) => ({
    role: esc(r.role),
    name: `<span class="name">${esc(r.name)}</span>`,
    thp: esc(r.thp_display || fmtNum(r.thp)),
    team: esc(r.preferred_team || "—"),
    slot: esc(r.preferred_slot || "—"),
    registered: esc(r.registered_display || (r.registered === true ? "Yes" : r.registered === false ? "No" : "—")),
    played: esc(r.played_display || (r.played === true ? "Yes" : r.played === false ? "No" : "—")),
    comment: esc(r.comment || "—"),
  }));
  return `<h3>${esc(title)}</h3>` + memberTable(cols, rows, "compact");
}

function renderEvents(el) {
  const sum = DATA.summary || {};
  const eventsBlock = sheetBlock("events");
  const dsBlock = sheetBlock("ds_master");
  const csBlock = sheetBlock("cs_master");
  const chips = [
    ["DS Registered", sum.ds_registered],
    ["DS Played", sum.ds_played],
    ["CS Registered", sum.cs_registered],
    ["CS Played", sum.cs_played],
    ["Generals Trial (Events)", sum.generals_trial_rows],
  ]
    .map(
      ([k, v]) =>
        `<div class="meta-chip"><span class="k">${esc(k)}</span><span class="v">${esc(String(v ?? "—"))}</span></div>`
    )
    .join("");

  let catalogHtml = "";
  if (eventsBlock && eventsBlock.catalog && eventsBlock.catalog.length) {
    const cols = [
      { key: "name", label: "Event" },
      { key: "level", label: "Level" },
      { key: "result", label: "Result" },
      { key: "max", label: "Max Part." },
      { key: "notes", label: "Notes" },
    ];
    const rows = eventsBlock.catalog.map((e) => ({
      name: esc(e.name),
      level: esc(e.level || "—"),
      result: esc(e.result || "—"),
      max: esc(e.max_participation || "—"),
      notes: esc(e.notes || "—"),
    }));
    catalogHtml = "<h3>Events · Katalog (Sheet links)</h3>" + memberTable(cols, rows, "compact");
  }

  let trialHtml = "";
  if (eventsBlock && eventsBlock.members && eventsBlock.members.length) {
    const cols = [
      { key: "name", label: "Name", class: "name" },
      { key: "difficulty", label: "Difficulty" },
      { key: "level", label: "Trial Level", class: "num" },
      { key: "damage", label: "Damage", class: "num" },
    ];
    const rows = eventsBlock.members.map((r) => ({
      name: `<span class="name">${esc(r.name)}</span>`,
      difficulty: esc(r.difficulty || "—"),
      level: esc(r.trial_level || "—"),
      damage: esc(r.damage || "—"),
    }));
    trialHtml = "<h3>Generals Trial · Teilnehmer (Events-Sheet)</h3>" + memberTable(cols, rows, "compact");
  }

  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name", class: "name" },
    { key: "events", label: "Dashboard Events" },
    { key: "ds", label: "DS" },
    { key: "cs", label: "CS" },
    { key: "trial", label: "Generals Trial" },
    { key: "team_ds", label: "DS Team/Slot" },
    { key: "team_cs", label: "CS Team/Slot" },
  ];
  const rows = sortedMembers((a, b) => String(a.name).localeCompare(String(b.name), "de")).map((m) => {
    const gt = m.generals_trial || {};
    const ds = m.ds_master || {};
    const cs = m.cs_master || {};
    const trialParts = [gt.difficulty, gt.level, gt.damage].filter(Boolean);
    return {
      _inactive: !m.active,
      role: esc(m.role),
      name: `<span class="name">${esc(m.name)}</span>`,
      events: esc(m.events || "—"),
      ds: regPlayedCell(ds),
      cs: regPlayedCell(cs),
      trial: esc(trialParts.length ? trialParts.join(" · ") : "—"),
      team_ds: esc([ds.preferred_team, ds.preferred_slot].filter(Boolean).join(" · ") || "—"),
      team_cs: esc([cs.preferred_team, cs.preferred_slot].filter(Boolean).join(" · ") || "—"),
    };
  });

  el.innerHTML =
    '<section class="panel glass"><h2>Events · DS / CS</h2>' +
    '<p class="lead">Dashboard-Spalten Events / DS / CS plus Master-Tabs und Generals-Trial aus dem Events-Sheet.</p>' +
    (chips ? `<div class="meta-grid">${chips}</div>` : "") +
    catalogHtml +
    trialHtml +
    renderMasterTable(dsBlock, "DS - Master") +
    renderMasterTable(csBlock, "CS - Master") +
    "<h3>Mitglieder · zusammengeführt</h3>" +
    memberTable(cols, rows) +
    "</section>";
}

function renderSeason(el) {
  const leg = DATA.legend || {};
  const seasonLegend = [
    "Season Mutual Assistance",
    "Season Clean Up",
    "Season Conquest",
    "Season Defeat",
  ]
    .filter((k) => leg[k])
    .map(
      (k) =>
        `<div class="meta-chip"><span class="k">${esc(k)}</span><span class="v">${esc(leg[k])}</span></div>`
    )
    .join("");
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    { key: "season", label: "Season Activity", class: "num" },
    { key: "ds", label: "DS" },
    { key: "cs", label: "CS" },
    { key: "events", label: "Events" },
  ];
  const rows = sortedMembers((a, b) => (b.season_activity ?? 0) - (a.season_activity ?? 0)).map((m) => ({
    _inactive: !m.active,
    role: esc(m.role),
    name: `<span class="name">${esc(m.name)}</span>`,
    season: esc(m.season_display || fmtPct(m.season_activity)),
    ds: regPlayedCell(m.ds_master) || (m.ds === true ? "Yes" : m.ds === false ? "No" : "—"),
    cs: regPlayedCell(m.cs_master) || (m.cs === true ? "Yes" : m.cs === false ? "No" : "—"),
    events: esc(m.events || "—"),
  }));
  el.innerHTML =
    '<section class="panel glass"><h2>Season</h2>' +
    '<p class="lead">Aggregierte Season Activity und Legend-Gewichte aus dem Dashboard.</p>' +
    (seasonLegend ? `<div class="meta-grid">${seasonLegend}</div>` : "") +
    memberTable(cols, rows) +
    "</section>";
}

function renderActivity(el) {
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    { key: "activity", label: "Activity", class: "num" },
    { key: "kills", label: "Kills", class: "num" },
    { key: "donations", label: "Spende", class: "num" },
    { key: "season", label: "Season", class: "num" },
    { key: "vs", label: "VS" },
  ];
  const rows = sortedMembers((a, b) => (b.activity ?? 0) - (a.activity ?? 0)).map((m) => ({
    _inactive: !m.active,
    role: esc(m.role),
    name: `<span class="name">${esc(m.name)}</span>`,
    activity: esc(m.activity_display || fmtPct(m.activity)),
    kills: esc(m.kills || "—"),
    donations: fmtNum(m.donations),
    season: esc(m.season_display || fmtPct(m.season_activity)),
    vs: vsBadge(m.vs_flag),
  }));
  el.innerHTML =
    '<section class="panel glass"><h2>Activity Score</h2>' +
    '<p class="lead">Gewichteter Score aus dem Dashboard-Sheet (Kills, Spende, Season, VS + R4/R5-Bonus).</p>' +
    memberTable(cols, rows) +
    "</section>";
}

function configDraftForWeek(cfg, year, week) {
  const entry = (cfg && cfg.vsWeeks ? cfg.vsWeeks : []).find(
    (item) => Number(item.year) === year && Number(item.week) === week
  );
  let mode = "push";
  if (entry) {
    mode = String(entry.mode || "push").toLowerCase();
    if (mode !== "push" && mode !== "save") mode = "push";
  } else {
    const meta = DATA.meta || {};
    mode = String(meta.VSWeekMode || "push").toLowerCase();
    if (mode !== "push" && mode !== "save") mode = "push";
  }
  const elevatedMin = entry ? pushElevatedMinFromEntry(entry) : null;
  const outlierMax = entry ? saveOutlierMaxFromEntry(entry) : null;
  return { year, week, mode, elevatedMin, outlierMax };
}

function applyVsWeekToDashboard(cfg) {
  if (!cfg || !Array.isArray(cfg.vsWeeks)) return;
  DATA.vs_weeks = cfg.vsWeeks;
  const ref = referenceVsDate();
  const wk = isoWeekKey(ref);
  const draft = configDraftForWeek(cfg, wk.year, wk.week);
  const meta = { ...(DATA.meta || {}) };
  meta.VSWeekMode = draft.mode;
  meta.VSWeekYear = String(draft.year);
  meta.VSWeekNumber = String(draft.week);
  delete meta.VSWeekMax;
  delete meta.VSWeekOutlierMax;
  if (draft.mode === "push") {
    const effective = draft.elevatedMin || VS_DAILY_MIN;
    meta.VSWeekMin = formatPointsDe(effective);
  } else {
    meta.VSWeekMin = formatPointsDe(VS_SAVE_MIN);
    const outlier = draft.outlierMax || VS_OUTLIER_MAX;
    meta.VSWeekOutlierMax = formatPointsDe(outlier);
  }
  DATA.meta = meta;
}

function syncConfigModeBlocks(el) {
  const mode = el.querySelector("#cfgMode").value;
  const pushBlock = el.querySelector("#cfgPushBlock");
  const saveBlock = el.querySelector("#cfgSaveBlock");
  if (pushBlock) pushBlock.hidden = mode !== "push";
  if (saveBlock) saveBlock.hidden = mode !== "save";
}

function bindConfigForm(el, draft) {
  el.querySelector("#cfgMode").value = draft.mode;
  syncConfigModeBlocks(el);
  el.querySelector("#cfgMode").addEventListener("change", () => syncConfigModeBlocks(el));

  const statusEl = el.querySelector("#cfgStatus");
  const setStatus = (msg, isError) => {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("config-status-error", !!isError);
  };

  el.querySelector("#cfgForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = el.querySelector("#cfgMode").value;
    const maxRaw = mode === "push" ? el.querySelector("#cfgElevatedMin").value : "";
    const btn = el.querySelector("#cfgSave");
    btn.disabled = true;
    setStatus("Speichern…");
    try {
      const json = await postImportantLinksConfig({
        kind: "vs-week",
        year: draft.year,
        week: draft.week,
        mode,
        max: maxRaw,
      });
      importantLinksConfig = json.data.config;
      applyVsWeekToDashboard(importantLinksConfig);
      const label = `${draft.year}-KW${String(draft.week).padStart(2, "0")}`;
      setStatus("");
      showToast(`${label} gespeichert (${mode.toUpperCase()}).`);
      document.getElementById("stamp").textContent = `Stand: ${formatStandBerlin()}`;
      renderOverview(document.getElementById("view-overview"));
    } catch (err) {
      const msg = String(err.message || err);
      setStatus(msg, true);
      showToast(msg, true);
    } finally {
      btn.disabled = false;
    }
  });
}

function renderConfigForm(el, cfg, draft, loadError) {
  const weekLabel = `${draft.year}-KW${String(draft.week).padStart(2, "0")}`;
  el.innerHTML =
    '<section class="panel glass"><h2>VS-Woche</h2>' +
    (loadError
      ? `<p class="config-status config-status-error">${esc(loadError)}</p>`
      : "") +
    '<form class="config-form" id="cfgForm">' +
    `<p class="config-week-label">Aktuelle Woche: <strong>${esc(weekLabel)}</strong></p>` +
    "<div><label for=\"cfgMode\">Modus</label>" +
    `<select id="cfgMode" name="mode"><option value="push">Push (Fr–Sa)</option><option value="save">Save (Mo–Do)</option></select></div>` +
    '<div id="cfgPushBlock">' +
    '<p class="config-hint">Minimum fest: <strong>7,2 Mio</strong> Punkte.</p>' +
    "<div><label for=\"cfgElevatedMin\">Höheres Minimum (optional)</label>" +
    `<input id="cfgElevatedMin" name="elevatedMin" type="text" inputmode="numeric" placeholder="z. B. 9M" value="${esc(
      formatPointsInputValue(draft.elevatedMin)
    )}"></div></div>` +
    '<div id="cfgSaveBlock" hidden>' +
    '<p class="config-hint">Minimum fest: <strong>7,2 Mio</strong> Punkte (Mo–Sa).</p>' +
    '<p class="config-hint">Outlier-Max Mo–Do: <strong>12 Mio</strong> (darüber = over; ≥20M-Config wird gekappt).</p>' +
    "</div>" +
    '<div class="btn-row">' +
    '<button type="submit" class="btn" id="cfgSave">Speichern</button>' +
    "</div>" +
    '<p class="config-status" id="cfgStatus" hidden></p>' +
    "</form></section>";
  bindConfigForm(el, draft);
  if (cfg) importantLinksConfig = cfg;
}

function renderConfig(el) {
  const wk = isoWeekKey(currentGameDate());
  el.innerHTML =
    '<section class="panel glass"><h2>VS-Woche</h2><p class="sub">Lade Einstellungen…</p></section>';
  fetchImportantLinksConfig(true)
    .then((cfg) => {
      renderConfigForm(el, cfg, configDraftForWeek(cfg, wk.year, wk.week));
    })
    .catch((err) => {
      renderConfigForm(
        el,
        importantLinksConfig,
        configDraftForWeek(importantLinksConfig, wk.year, wk.week),
        String(err.message || err)
      );
    });
}

function renderLinks(el) {
  const pack = DATA.links || {};
  const items = pack.links || [];
  if (!items.length) {
    el.innerHTML =
      '<section class="panel glass"><h2>Links</h2><p class="lead">Keine Links in config.json gefunden.</p></section>';
    return;
  }
  const byCat = new Map();
  for (const item of items) {
    const cat = item.category || pack.tagline || "Important Links";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(item);
  }
  let html =
    '<section class="panel glass"><h2>' +
    esc(pack.title || "DawN") +
    " · Links</h2>" +
    '<p class="lead">Wichtige Links für die Allianz.</p><div class="link-grid">';
  for (const [cat, list] of byCat) {
    html += `<h3 class="link-cat">${esc(cat)}</h3>`;
    for (const link of list) {
      html +=
        `<a class="link-card glass" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">` +
        `<p class="title">${esc(link.name)}</p>` +
        (link.desc ? `<p class="desc">${esc(link.desc)}</p>` : "") +
        `<p class="url">${esc(link.url.replace(/^https?:\/\//, ""))}</p></a>`;
    }
  }
  html += "</div></section>";
  el.innerHTML = html;
}

function renderAll() {
  renderFilterBar();
  renderAllViews();

  const stand = formatStandBerlin();
  document.getElementById("stamp").textContent = `Stand: ${stand}`;
  document.getElementById("foot").innerHTML = `<p>Stand: ${esc(stand)}</p>`;
}

async function bootData() {
  try {
    const res = await fetch("data/dashboard.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
    if (!Array.isArray(DATA.members) || !DATA.members.length) {
      throw new Error("Keine Mitglieder in dashboard.json");
    }
    renderAll();
    initRouter();
  } catch (err) {
    showError("Dashboard-Daten konnten nicht geladen werden. " + (err.message || String(err)));
  }
}

/** Hash + history routing (mirrors project-map.html tab pattern). */
function initRouter() {
  function current() {
    const v = document.querySelector(".view:not([hidden])");
    return v ? v.id.slice(5) : "overview";
  }

  function urlForView(view) {
    const qs = location.search || "";
    return location.pathname + qs + "#" + view;
  }

  function show(view) {
    const prev = current();
    document.querySelectorAll(".view").forEach((v) => {
      v.hidden = v.id !== "view-" + view;
    });
    document.querySelectorAll(".tab").forEach((t) => {
      t.setAttribute("aria-selected", String(t.dataset.view === view));
    });
    syncFilterVisibility(view);
    try {
      if (routed && prev !== view) {
        history.replaceState({ y: window.scrollY }, "", urlForView(prev));
        history.pushState({ y: 0 }, "", urlForView(view));
      } else if (!popping) {
        history.replaceState(history.state, "", urlForView(view));
      }
    } catch (e) {
      /* file:// or restricted contexts */
    }
    window.scrollTo({ top: 0 });
  }

  function viewOf(hash) {
    const v = (hash || "").slice(1);
    return v && document.getElementById("view-" + v) ? v : "overview";
  }

  let popping = false;
  let routed = false;
  try {
    history.scrollRestoration = "manual";
  } catch (e) {}

  window.addEventListener("popstate", (e) => {
    const view = viewOf(location.hash);
    const y = (e.state && e.state.y) || 0;
    popping = true;
    if (view !== current()) show(view);
    window.scrollTo(0, y);
    popping = false;
  });

  document.querySelectorAll("[data-view]").forEach((el) => {
    el.addEventListener("click", () => show(el.dataset.view));
  });

  if (viewOf(location.hash) !== "overview") show(viewOf(location.hash));
  else show("overview");
  routed = true;
}

bootData();
