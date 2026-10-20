"use strict";

let DATA = null;

const ROLE_OPTIONS = ["R5", "R4", "R3", "R2", "R1"];
const CACHE_BUST = "20261020-kills-delta";

/** Season contribution columns — mirrors Sheet tabs / SEASON_CATEGORIES. */
const SEASON_CATS = [
  { key: "support", label: "Assistance", legend: "Season Mutual Assistance" },
  { key: "cleanup", label: "Clean Up", legend: "Season Clean Up" },
  { key: "conquest", label: "Conquest", legend: "Season Conquest" },
  { key: "defeat", label: "Defeat", legend: "Season Defeat" },
];

/** Overview „Wenig aktiv“ — niedrigste Activity-% (5–10, Default 8). Config später. */
const WENIG_AKTIV_COUNT = 8;
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

/** @type {"woche"|"gesamt"} */
let periodMode = "woche";

let filterBarInitialized = false;

const IMPORTANT_LINKS_ORIGIN = "https://lastwar-dawn-important-links.pages.dev";
const IMPORTANT_LINKS_CONFIG_URL = IMPORTANT_LINKS_ORIGIN + "/config.json";
const IMPORTANT_LINKS_API_URL = IMPORTANT_LINKS_ORIGIN + "/api/config";
const VS_DAILY_MIN = 7200000;
/** Save/Economy Mo–Do-Tagesminimum. Fr–Sa offen (kein under/over). */
const VS_SAVE_MIN = 7200000;
/** Legacy JSON max that must never become a push elevated min. */
const LEGACY_SAVE_12M = 12_000_000;

/**
 * Per-week champion rules live on vs_weeks[].champion (see vs_weeks.json).
 * Punkte-Regeln oder manuell (z.B. Bestes Outfit):
 * - max_score — highest VS points in the active period (classic Push)
 * - day_min — list members with day score >= day_min
 * - save_exact_and_closest — exact day_target per day + week_agg over week_days
 *   (week_agg: closest_sum → Mo–Do sum closest to day_target)
 * - manual — free-text title + winners[] (not computed from VS points)
 */
const CHAMPION_DAY_INDEX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5 };
const CHAMPION_DAY_LABEL_DE = {
  mon: "Mo",
  tue: "Di",
  wed: "Mi",
  thu: "Do",
  fri: "Fr",
  sat: "Sa",
};

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
  // Legacy 12M (old Save outlier floor) is never a push elevated min.
  if (n === LEGACY_SAVE_12M) return null;
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

/** Exact integer points with German grouping (e.g. 7.200.002) — never abbreviate to M. */
function fmtPts(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (Number.isNaN(v)) return esc(String(n));
  return Math.round(v).toLocaleString("de-DE");
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
  if (/over/i.test(f)) return `<span class="badge bad" title="VS over">${esc(f)}</span>`;
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
  // Tag removed (data always a day late); map legacy "tag" → Woche.
  if (p === "woche" || p === "gesamt") {
    periodMode = p;
    return;
  }
  if (p === "tag") {
    periodMode = "woche";
    return;
  }
  try {
    const stored = sessionStorage.getItem(PERIOD_STORAGE_KEY);
    if (stored === "woche" || stored === "gesamt") periodMode = stored;
    else if (stored === "tag") periodMode = "woche";
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

function activeVsWeekMode() {
  const meta = (DATA && DATA.meta) || {};
  const fromMeta = String(meta.VSWeekMode || "").toLowerCase();
  if (fromMeta === "save" || fromMeta === "push") return fromMeta;
  const wk = activeVsWeekKey();
  const list = (DATA && DATA.vs_weeks) || [];
  const hit = list.find((item) => Number(item.year) === wk.year && Number(item.week) === wk.week);
  const mode = String((hit && hit.mode) || "push").toLowerCase();
  return mode === "save" ? "save" : "push";
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
  if (mode === "save") {
    if (wd >= 4) return 0; // Fr–Sa open
    return saveMin; // Mo–Do
  }
  const elevated = pushElevatedMinFromEntry(entry);
  if (elevated && elevated > dailyMin) return elevated;
  return dailyMin;
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

function memberVsDayPoints(member, isoLabel) {
  const days = member && member.vs_days;
  if (days && days[isoLabel] != null) {
    const v = Number(days[isoLabel]);
    return Number.isNaN(v) ? null : v;
  }
  const row = vsSheetRow(member && member.name);
  if (!row || !row.values || row.values[isoLabel] == null) return null;
  const v = Number(row.values[isoLabel]);
  return Number.isNaN(v) ? null : v;
}

function memberVsWeekSum(member, dayLabels) {
  if (member && member.vs_week_sum != null) {
    const v = Number(member.vs_week_sum);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  let sum = 0;
  let any = false;
  for (const lab of dayLabels || []) {
    const v = memberVsDayPoints(member, lab);
    if (v == null) continue;
    sum += v;
    any = true;
  }
  if (any) return sum;
  if (member && member.vs_latest != null) {
    const v = Number(member.vs_latest);
    return Number.isNaN(v) ? null : v;
  }
  const row = vsSheetRow(member && member.name);
  if (!row) return null;
  if (row.latest != null) return Number(row.latest) || 0;
  return 0;
}

function vsWeekDayLabels() {
  const block = sheetBlock("vs");
  const cols = (block && block.columns) || [];
  const refWeek = activeVsWeekKey();
  const inWeek = cols.filter((lab) => {
    const d = parseIsoDate(lab);
    if (!d) return false;
    const wk = isoWeekKey(d);
    return wk.year === refWeek.year && wk.week === refWeek.week;
  });
  return inWeek.length ? inWeek : cols.filter((lab) => !!parseIsoDate(lab));
}

function vsDayHeaderLabel(iso) {
  const d = parseIsoDate(iso);
  if (!d) return String(iso || "");
  const wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getUTCDay()];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${wd} ${dd}.${mm}`;
}

function vsTabLead() {
  const meta = DATA.meta || {};
  const mode = String(meta.VSWeekMode || "push").toLowerCase();
  if (mode === "save") {
    return (
      `Save-Woche: Mo–Do Quote ${formatPointsDe(VS_SAVE_MIN)} · Fr–Sa offen. ` +
      "Zahlen = exakte Tageswerte + Wochensumme."
    );
  }
  const minLabel = meta.VSWeekMin || formatPointsDe(VS_DAILY_MIN);
  return `Push-Woche: Quote ${minLabel}. Zahlen = exakte Tageswerte + Wochensumme.`;
}

function vsMetric(member) {
  const dayLabs = vsWeekDayLabels();

  if (periodMode === "tag") {
    const today = currentGameDateLabel();
    return memberVsDayPoints(member, today);
  }

  if (periodMode === "woche") {
    return memberVsWeekSum(member, dayLabs);
  }

  // Gesamt = Sheet-Stand (Latest), sonst Wochensumme / Tagessumme
  if (member && member.vs_latest != null) {
    const v = Number(member.vs_latest);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  const row = vsSheetRow(member && member.name);
  if (!row) return memberVsWeekSum(member, dayLabs);
  if (row.latest != null) {
    const v = Number(row.latest);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  const meta = DATA.meta || {};
  const refDate = parseMetaVsDate(meta.VSLastDate);
  const refLabel = refDate ? isoDateLabel(refDate) : String(meta.VSLastDate || "").trim();
  if (refLabel) {
    const dayPts = memberVsDayPoints(member, refLabel);
    if (dayPts != null) return dayPts;
  }
  if (row.weekly_avg != null) return Number(row.weekly_avg) || 0;
  return memberVsWeekSum(member, dayLabs) || 0;
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
  return `SAVE · MO–DO ${formatPointsDe(VS_SAVE_MIN)} · FR–SA OFFEN`;
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

function activeVsWeekEntry() {
  const wk = activeVsWeekKey();
  const list = (DATA && DATA.vs_weeks) || [];
  const hit = list.find((item) => Number(item.year) === wk.year && Number(item.week) === wk.week);
  if (hit) return hit;
  return { year: wk.year, week: wk.week, mode: activeVsWeekMode() };
}

/** Resolve champion rule for the active VS week (config or mode default). */
function activeChampionRule() {
  const entry = activeVsWeekEntry();
  const raw = entry && entry.champion;
  if (raw && typeof raw === "object") {
    const type = String(raw.type || "").toLowerCase();
    if (type === "save_exact_and_closest") {
      const dayTarget = Number(raw.day_target);
      return {
        type,
        day_target: Number.isFinite(dayTarget) && dayTarget > 0 ? dayTarget : VS_SAVE_MIN,
        week_days: Array.isArray(raw.week_days) && raw.week_days.length
          ? raw.week_days.map((d) => String(d).toLowerCase())
          : ["mon", "tue", "wed", "thu"],
        week_agg: String(raw.week_agg || "closest_sum").toLowerCase(),
      };
    }
    if (type === "day_min") {
      const dayMin = Number(raw.day_min);
      if (Number.isFinite(dayMin) && dayMin > 0) return { type, day_min: dayMin };
    }
    if (type === "manual") {
      const title = String(raw.title || "").trim() || "Champion";
      const winners = Array.isArray(raw.winners)
        ? raw.winners.map((n) => String(n ?? "").trim()).filter(Boolean)
        : [];
      const note = String(raw.note || "").trim();
      return { type: "manual", title, winners, note };
    }
    if (type === "max_score") return { type: "max_score" };
  }
  return { type: "max_score" };
}

/** Match a free-text winner name against the roster (exact NFC lowercase). */
function findMemberByEnteredName(entered) {
  const key = normalizeName(entered);
  if (!key) return null;
  return (DATA.members || []).find((m) => normalizeName(m.name) === key) || null;
}

function vsDaySlotsForWeek(dayKeys) {
  const refWeek = activeVsWeekKey();
  const allow =
    dayKeys && dayKeys.length
      ? new Set(
          dayKeys
            .map((k) => CHAMPION_DAY_INDEX[String(k).toLowerCase()])
            .filter((n) => n != null)
        )
      : null;
  const byWd = new Map();
  for (const lab of sheetColumnLabels("vs")) {
    const d = parseIsoDate(lab);
    if (!d) continue;
    const wk = isoWeekKey(d);
    if (wk.year !== refWeek.year || wk.week !== refWeek.week) continue;
    const wd = pythonWeekday(d);
    if (allow && !allow.has(wd)) continue;
    byWd.set(wd, { label: lab, date: d, weekday: wd });
  }
  const order = allow
    ? [...allow].sort((a, b) => a - b)
    : [0, 1, 2, 3, 4, 5].filter((wd) => byWd.has(wd));
  return order.map((wd) => {
    const hit = byWd.get(wd);
    if (hit) return hit;
    return { label: null, date: null, weekday: wd };
  });
}

function weekdayKeyFromIndex(wd) {
  for (const [key, idx] of Object.entries(CHAMPION_DAY_INDEX)) {
    if (idx === wd) return key;
  }
  return "";
}

function formatChampDayLabel(slot) {
  const key = weekdayKeyFromIndex(slot.weekday);
  const short = CHAMPION_DAY_LABEL_DE[key] || "?";
  if (!slot.date) return short;
  const dd = String(slot.date.getUTCDate()).padStart(2, "0");
  const mm = String(slot.date.getUTCMonth() + 1).padStart(2, "0");
  return `${short} ${dd}.${mm}.`;
}

function computeChampionState(members) {
  const rule = activeChampionRule();
  if (rule.type === "manual") {
    const winners = (rule.winners || []).map((name) => {
      const m = findMemberByEnteredName(name);
      return { name, m };
    });
    return {
      rule,
      dayHits: [],
      weekWinners: [],
      weekSlots: [],
      topList: [],
      manualWinners: winners,
      pulsePts: null,
    };
  }
  if (rule.type === "save_exact_and_closest") {
    const target = Math.round(rule.day_target);
    const allDays = vsDaySlotsForWeek(["mon", "tue", "wed", "thu", "fri", "sat"]).filter(
      (s) => s.label
    );
    const weekSlots = vsDaySlotsForWeek(rule.week_days);
    /** Flat list of every exact day hit (all names, no cap). */
    const exactHits = [];
    for (const slot of allDays) {
      const hits = members
        .map((m) => ({ m, pts: vsPointsAtLabel(m, slot.label) }))
        .filter((x) => x.pts != null && Math.round(x.pts) === target)
        .sort((a, b) => String(a.m.name).localeCompare(String(b.m.name), "de"));
      for (const h of hits) {
        exactHits.push({ slot, m: h.m, pts: Math.round(h.pts) });
      }
    }
    exactHits.sort(
      (a, b) =>
        a.slot.weekday - b.slot.weekday ||
        String(a.m.name).localeCompare(String(b.m.name), "de")
    );
    const sums = members
      .map((m) => {
        let sum = 0;
        let n = 0;
        for (const slot of weekSlots) {
          if (!slot.label) continue;
          const pts = vsPointsAtLabel(m, slot.label);
          if (pts == null) continue;
          sum += pts;
          n += 1;
        }
        return { m, sum, n, dist: Math.abs(sum - target) };
      })
      .filter((x) => x.n > 0);
    let best = Infinity;
    for (const x of sums) if (x.dist < best) best = x.dist;
    const weekWinners =
      best === Infinity
        ? []
        : sums
            .filter((x) => x.dist === best)
            .sort((a, b) => String(a.m.name).localeCompare(String(b.m.name), "de"));
    return {
      rule,
      exactHits,
      dayHits: [],
      weekWinners,
      weekSlots,
      topList: [],
      pulsePts: weekWinners[0] ? weekWinners[0].sum : null,
    };
  }
  if (rule.type === "day_min") {
    const dayMin = rule.day_min;
    const days = vsDaySlotsForWeek(["mon", "tue", "wed", "thu", "fri", "sat"]).filter(
      (s) => s.label
    );
    const dayHits = days.map((slot) => {
      const hits = members
        .map((m) => ({ m, pts: vsPointsAtLabel(m, slot.label) }))
        .filter((x) => x.pts != null && x.pts >= dayMin)
        .sort((a, b) => b.pts - a.pts || String(a.m.name).localeCompare(String(b.m.name), "de"));
      return { slot, hits };
    });
    const top = dayHits.flatMap((d) => d.hits).sort((a, b) => b.pts - a.pts);
    return {
      rule,
      exactHits: [],
      dayHits,
      weekWinners: [],
      weekSlots: [],
      topList: top.slice(0, 5).map((x) => x.m),
      pulsePts: top[0] ? top[0].pts : null,
    };
  }
  // max_score (default)
  const ranked = members
    .map((m) => ({ m, pts: vsMetric(m) }))
    .filter((x) => x.pts != null && x.pts > 0)
    .sort((a, b) => b.pts - a.pts);
  return {
    rule: { type: "max_score" },
    exactHits: [],
    dayHits: [],
    weekWinners: [],
    weekSlots: [],
    topList: ranked.slice(0, 5).map((x) => x.m),
    pulsePts: ranked[0] ? ranked[0].pts : null,
  };
}

function renderChampionWidget(champState, vsReady, vsEmptyMsg) {
  const rule = champState.rule;
  if (rule.type === "manual") {
    const title = rule.title || "Champion";
    const winners = champState.manualWinners || [];
    const rows = winners
      .map((w, i) => {
        const display = w.m ? w.m.name : w.name;
        const hint = w.m ? "" : " · Freitext";
        return (
          `<li><span class="rank">${i + 1}</span>` +
          `<span class="who">${esc(display)}${hint ? `<span class="champ-freitext">${hint}</span>` : ""}</span>` +
          `<span class="val"></span></li>`
        );
      })
      .join("");
    const noteHtml = rule.note
      ? `<p class="sub champ-note">${esc(rule.note)}</p>`
      : "";
    return (
      `<article class="widget span-12 glass champ-widget"><h3>Champion</h3>` +
      `<p class="sub">${esc(title)} · manuell</p>` +
      noteHtml +
      (rows
        ? `<ul class="rank-list champ-list">${rows}</ul>`
        : `<p class="sub">Noch keine Gewinner eingetragen.</p>`) +
      `</article>`
    );
  }
  if (!vsReady) {
    return (
      `<article class="widget span-12 glass champ-widget"><h3>Champion</h3>` +
      `<p class="sub">${esc(vsEmptyMsg)}</p></article>`
    );
  }
  if (rule.type === "save_exact_and_closest") {
    const targetLabel = fmtPts(rule.day_target);
    const weekDaysLabel = (rule.week_days || [])
      .map((d) => CHAMPION_DAY_LABEL_DE[d] || d)
      .join("–");
    const exactRows = (champState.exactHits || [])
      .map(
        (h) =>
          `<li><span class="rank">${esc(formatChampDayLabel(h.slot))}</span>` +
          `<span class="who">${esc(h.m.name)}</span>` +
          `<span class="val">${fmtPts(h.pts)}</span></li>`
      )
      .join("");
    const weekRows = (champState.weekWinners || [])
      .map(
        (w) =>
          `<li><span class="rank">Δ</span>` +
          `<span class="who">${esc(w.m.name)}</span>` +
          `<span class="val">${fmtPts(w.sum)} · Δ ${fmtPts(w.dist)}</span></li>`
      )
      .join("");
    return (
      `<article class="widget span-12 glass champ-widget"><h3>Champion</h3>` +
      `<p class="sub">Save-Woche: Tagesziel ${esc(targetLabel)} exakt treffen · ` +
      `Wochen-Summe (${esc(weekDaysLabel)}) möglichst nah an ${esc(targetLabel)}</p>` +
      `<div class="champ-blocks">` +
      `<div class="champ-block">` +
      `<p class="champ-section-label">Tages-Treffer · exakt ${esc(targetLabel)}</p>` +
      (exactRows
        ? `<ul class="rank-list champ-list">${exactRows}</ul>`
        : `<p class="sub">Noch kein Exact-Treffer.</p>`) +
      `</div>` +
      `<div class="champ-block">` +
      `<p class="champ-section-label">Wochen-Sieger · Summe ${esc(
        weekDaysLabel
      )} am nächsten an ${esc(targetLabel)}</p>` +
      (weekRows
        ? `<ul class="rank-list champ-list">${weekRows}</ul>`
        : `<p class="sub">${esc(vsEmptyMsg)}</p>`) +
      `</div></div></article>`
    );
  }
  if (rule.type === "day_min") {
    const minLabel = fmtPts(rule.day_min);
    const dayRows = champState.dayHits
      .filter((dh) => dh.hits.length)
      .map((dh) => {
        const who = dh.hits
          .map((h) => `${esc(h.m.name)} (${fmtPts(h.pts)})`)
          .join(", ");
        return (
          `<li><span class="rank">${esc(formatChampDayLabel(dh.slot))}</span>` +
          `<span class="who">${who}</span>` +
          `<span class="val">≥ ${esc(minLabel)}</span></li>`
        );
      })
      .join("");
    return (
      `<article class="widget span-12 glass champ-widget"><h3>Champion</h3>` +
      `<p class="sub">Tag ≥ ${esc(minLabel)} · alle Treffer</p>` +
      (dayRows
        ? `<ul class="rank-list champ-list">${dayRows}</ul>`
        : `<p class="sub">${esc(vsEmptyMsg)}</p>`) +
      `</article>`
    );
  }
  const periodSub =
    periodMode === "gesamt" ? "Wochenstand (Sheet Latest)" : "Wochensumme";
  const head = champState.topList[0];
  const headHtml = head
    ? `<p class="sub">${esc(head.name)} · ${fmtPts(vsMetric(head))}</p>`
    : `<p class="sub">${esc(vsEmptyMsg)}</p>`;
  return (
    `<article class="widget span-12 glass champ-widget"><h3>Champion</h3><p class="sub">${esc(
      periodSub
    )}</p>${headHtml}` +
    renderRankList(
      head ? champState.topList.slice(1) : [],
      (m) => fmtPts(vsMetric(m)),
      vsEmptyMsg
    ) +
    `</article>`
  );
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

/** True if member has any KPI signal — not just a 0% ghost after Fresh Start / name miss. */
function hasActivitySignal(m) {
  if ((Number(m.donations) || 0) > 0) return true;
  if ((Number(m.vs_week_sum) || Number(m.vs_latest) || 0) > 0) return true;
  if ((Number(m.season_activity) || 0) > 0) return true;
  // Kill-Wachstum (Kämpfe/Verteidigung) — nur echtes Δ, kein Fake-+100%.
  if ((Number(m.kills_delta) || 0) > 0) return true;
  if (m.kills_pct != null && !Number.isNaN(Number(m.kills_pct)) && Number(m.kills_pct) > 0) {
    return true;
  }
  const cats = m.season_cats || {};
  for (const key of Object.keys(cats)) {
    if ((Number(cats[key] && cats[key].pts) || 0) > 0) return true;
  }
  return false;
}

function wenigAktivMembers(members) {
  const n = Math.min(10, Math.max(5, WENIG_AKTIV_COUNT));
  return members
    .filter(
      (m) =>
        m.active &&
        m.activity != null &&
        !Number.isNaN(Number(m.activity)) &&
        hasActivitySignal(m)
    )
    .slice()
    .sort(
      (a, b) =>
        Number(a.activity) - Number(b.activity) ||
        String(a.name).localeCompare(String(b.name), "de")
    )
    .slice(0, n);
}

function activityTrendPoints() {
  const raw = (DATA && DATA.activity_trend) || [];
  return raw
    .map((p) => ({
      date: String(p.date || ""),
      avg: Number(p.avg),
      n: Number(p.n) || 0,
    }))
    .filter((p) => p.date && Number.isFinite(p.avg));
}

function activityTrendSummary(points) {
  if (!points.length) return "Keine Verlaufsdaten";
  if (points.length === 1) return `Stand ${fmtPct(points[0].avg)}`;
  const first = points[0].avg;
  const last = points[points.length - 1].avg;
  const delta = last - first;
  const abs = Math.abs(delta);
  const label = fmtPct(abs);
  if (abs < 0.005) return `Stabil · zuletzt ${fmtPct(last)}`;
  if (delta > 0) return `Steigend · +${label} · zuletzt ${fmtPct(last)}`;
  return `Fallend · −${label} · zuletzt ${fmtPct(last)}`;
}

/** Ø-Activity-Verlauf (Archiv + Live) — Overview only, kein VS-Burnup. */
function renderActivityTrendChart() {
  const series = activityTrendPoints();
  if (!series.length) {
    return (
      '<article class="widget span-12 glass">' +
      "<h3>Activity-Verlauf</h3>" +
      '<p class="sub">Noch keine Archiv-Snapshots für den Trend.</p></article>'
    );
  }
  const summary = activityTrendSummary(series);
  const W = 640;
  const H = 220;
  const pad = { t: 18, r: 16, b: 36, l: 44 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = series.length;
  const xAt = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yAt = (v) => pad.t + ih - Math.min(1, Math.max(0, v)) * ih;
  const path = series
    .map((p, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(p.avg).toFixed(1)}`)
    .join(" ");
  const area =
    `M${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} ` +
    series.map((p, i) => `L${xAt(i).toFixed(1)},${yAt(p.avg).toFixed(1)}`).join(" ") +
    ` L${xAt(n - 1).toFixed(1)},${yAt(0).toFixed(1)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const y = yAt(t);
    return (
      `<line class="chart-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" />` +
      `<text class="chart-tick" x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(
        fmtPct(t)
      )}</text>`
    );
  });
  const step = n > 12 ? Math.ceil(n / 8) : 1;
  const labels = series
    .map((p, i) => {
      if (i % step !== 0 && i !== n - 1) return "";
      return `<text class="chart-x" x="${xAt(i).toFixed(1)}" y="${H - 12}" text-anchor="middle">${esc(
        String(p.date).slice(5)
      )}</text>`;
    })
    .join("");
  const dots = series
    .map(
      (p, i) =>
        `<circle class="chart-dot dawn" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.avg).toFixed(1)}" r="3.5">` +
        `<title>${esc(p.date)} Ø ${fmtPct(p.avg)}${p.n ? ` · n=${p.n}` : ""}</title></circle>`
    )
    .join("");
  return (
    '<article class="widget span-12 glass">' +
    '<div class="vs-chart-head"><h3>Activity-Verlauf</h3>' +
    `<p class="sub">${esc(summary)}</p></div>` +
    '<p class="sub">Ø Activity der Aktiven · Archiv-Snapshots (+ heute live)</p>' +
    '<div class="vs-chart">' +
    `<svg class="activity-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity-Verlauf">` +
    ticks.join("") +
    `<path class="chart-area dawn" d="${area}" />` +
    `<path class="chart-line dawn" d="${path}" fill="none" />` +
    dots +
    labels +
    "</svg></div></article>"
  );
}

function renderOverviewWidgets() {
  const members = filteredMembers();
  const vsReady = hasVsSheetData();
  const vsEmptyMsg = !vsReady ? "Keine VS-Daten verfügbar" : noVsDataMessage();
  const champState = computeChampionState(members);
  const underQuota = members
    .filter((m) => memberBelowQuotaForPeriod(m))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
  const topDon = members
    .map((m) => ({ m, pts: donationMetric(m) }))
    .filter((x) => x.pts > 0)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 5)
    .map((x) => x.m);
  const wenigAktiv = wenigAktivMembers(members);

  const compare = sheetBlock("vs_compare");
  const days = (compare && compare.days) || [];
  // Overview: day cards only — no VS burn-up (Activity-Verlauf is the chart here).
  const compareWidget =
    days.length > 0
      ? `<article class="widget span-12 glass vs-overview-compare">${renderVsCompareDays(days, {
          includeBurnup: false,
        })}</article>`
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
    periodMode === "woche"
      ? `Woche: VS-Flags & Vergleich${watchSubExtra}`
      : `Gesamt-KPI: Activity & VS-Flags${watchSubExtra}`;

  const periodHint =
    periodMode === "woche"
      ? "VS Wochensumme · Spende Wochensumme"
      : "Sheet-Stand · VS Latest · Spende Dashboard · VS-Flags";

  return (
    `<p class="sub">${esc(periodHint)} · ${members.length} Mitglieder nach Filter</p>` +
    '<div class="widget-grid">' +
    renderChampionWidget(champState, vsReady, vsEmptyMsg) +
    `<article class="widget span-6 glass"><h3>Unter Quote</h3>` +
    `<p class="sub">${underQuota.length} ${
      underQuota.length === 1 ? "Mitglied" : "Mitglieder"
    } · vollständige Liste</p>` +
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
      : `<p class="sub">Keine unter Quote im Filter.</p>`) +
    "</article>" +
    `<article class="widget span-6 glass"><h3>Top Spende</h3><p class="sub">${
      periodMode === "woche" ? "Wochensumme · Top 5" : "Gesamt · Top 5"
    }</p>` +
    renderRankList(topDon, (m) => fmtNum(donationMetric(m)), noDonationDataMessage()) +
    "</article>" +
    `<article class="widget span-6 glass"><h3>Wenig aktiv</h3>` +
    `<p class="sub">Niedrigste Activity · ${wenigAktiv.length} von max. ${Math.min(
      10,
      Math.max(5, WENIG_AKTIV_COUNT)
    )}</p>` +
    (wenigAktiv.length
      ? "<ol class=\"rank-list\">" +
        wenigAktiv
          .map(
            (m, i) =>
              `<li><span class="rank">${i + 1}</span>` +
              `<span class="who">${esc(m.name)}</span>` +
              `<span class="val">${esc(m.activity_display || fmtPct(m.activity))}</span></li>`
          )
          .join("") +
        "</ol>"
      : `<p class="sub">Keine Activity-Werte im Filter.</p>`) +
    "</article>" +
    `<article class="widget span-6 glass"><h3>Pulse</h3><div class="pulse-row">` +
    `<div class="pulse-pill"><strong>${fmtPct(avgActFiltered(members))}</strong>Ø Activity</div>` +
    `<div class="pulse-pill"><strong>${vsOk}</strong>VS OK</div>` +
    `<div class="pulse-pill"><strong>${vsBelow}</strong>Unter Quote</div>` +
    `<div class="pulse-pill"><strong>${fmtNum(
      topDon[0] ? donationMetric(topDon[0]) : null
    )}</strong>Top Spende</div>` +
    `<div class="pulse-pill"><strong>${
      champState.rule && champState.rule.type === "manual"
        ? esc(champState.rule.title || "Manuell")
        : fmtPts(champState.pulsePts)
    }</strong>Champion</div>` +
    "</div></article>" +
    renderActivityTrendChart() +
    compareWidget +
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
    '<p class="lead">Allianz-Spenden nach gewähltem Zeitraum (Overview: Woche/Gesamt).</p>' +
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

function renderVsCompareDays(days, options) {
  if (!days || !days.length) return "";
  const includeBurnup = !!(options && options.includeBurnup);
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
        "</dl></article>"
      );
    })
    .join("");
  return (
    '<div class="vs-compare-block">' +
    "<h3>VS-Vergleich · Tage</h3>" +
    `<div class="vs-day-cards">${cards}</div>` +
    (includeBurnup ? renderVsBurnupChart(sorted) : "") +
    "</div>"
  );
}

function renderVsMetaSummary() {
  const meta = DATA.meta || {};
  // Only date chip — mode/min already in Wochenquote lead. No Activity/Season noise.
  const last = meta.VSLastDate;
  if (last == null || !String(last).trim()) return "";
  return (
    '<div class="meta-grid">' +
    `<div class="meta-chip"><span class="k">Letzter VS-Tag</span><span class="v">${esc(String(last))}</span></div>` +
    "</div>"
  );
}

function renderVs(el) {
  const compare = sheetBlock("vs_compare");
  const compareDays = compare && compare.days && compare.days.length ? compare.days : null;
  const dayLabs = vsWeekDayLabels();
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    ...dayLabs.map((lab) => ({
      key: "d_" + lab,
      label: vsDayHeaderLabel(lab),
      class: "num",
    })),
    { key: "week_sum", label: "Wochensumme", class: "num" },
    { key: "vs", label: "VS Flag" },
  ];
  const rows = sortedMembers((a, b) => {
    const wa = memberVsWeekSum(a, dayLabs);
    const wb = memberVsWeekSum(b, dayLabs);
    return (wb == null ? -1 : wb) - (wa == null ? -1 : wa);
  }).map((m) => {
    const out = {
      _inactive: !m.active,
      role: esc(m.role),
      name: `<span class="name">${esc(m.name)}</span>`,
      week_sum: fmtPts(memberVsWeekSum(m, dayLabs)),
      vs: vsBadge(m.vs_flag),
    };
    for (const lab of dayLabs) {
      out["d_" + lab] = fmtPts(memberVsDayPoints(m, lab));
    }
    return out;
  });
  // VS tab: quote + day compare (no burn-up) + day columns + Wochensumme + Flag. No Champion / Activity.
  el.innerHTML =
    '<section class="panel glass"><h2>VS</h2>' +
    `<p class="lead">${esc(vsTabLead())}</p>` +
    renderVsMetaSummary() +
    (compareDays ? renderVsCompareDays(compareDays, { includeBurnup: false }) : "") +
    "<h3>Mitglieder · Tagespunkte &amp; Wochensumme</h3>" +
    '<p class="sub">Eine Spalte pro VS-Tag · Wochensumme · Flag · sortiert nach Wochensumme</p>' +
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

function memberSeasonCat(m, key) {
  const cats = m && m.season_cats;
  if (!cats || typeof cats !== "object") return null;
  return cats[key] || null;
}

function memberSeasonPts(m, key) {
  const cat = memberSeasonCat(m, key);
  if (!cat || cat.pts == null) return null;
  const n = Number(cat.pts);
  return Number.isFinite(n) ? n : null;
}

function seasonCatCell(m, key) {
  const pts = memberSeasonPts(m, key);
  if (pts != null) return fmtPts(pts);
  const cat = memberSeasonCat(m, key);
  if (cat && cat.pct != null) return fmtPct(cat.pct);
  return "—";
}

function seasonDataReady() {
  const members = DATA.members || [];
  return members.some((m) =>
    SEASON_CATS.some((c) => memberSeasonPts(m, c.key) != null)
  );
}

function renderSeason(el) {
  const leg = DATA.legend || {};
  const seasonLegend = SEASON_CATS.map((c) => {
    const weight = leg[c.legend];
    if (!weight) return "";
    return `<div class="meta-chip"><span class="k">${esc(c.label)}</span><span class="v">${esc(weight)}</span></div>`;
  })
    .filter(Boolean)
    .join("");
  const hasPts = seasonDataReady();
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    ...SEASON_CATS.map((c) => ({ key: "s_" + c.key, label: c.label, class: "num" })),
    { key: "season", label: "Season %", class: "num" },
  ];
  const rows = sortedMembers((a, b) => (b.season_activity ?? 0) - (a.season_activity ?? 0)).map(
    (m) => {
      const out = {
        _inactive: !m.active,
        role: esc(m.role),
        name: `<span class="name">${esc(m.name)}</span>`,
        season: esc(m.season_display || fmtPct(m.season_activity)),
      };
      for (const c of SEASON_CATS) {
        out["s_" + c.key] = seasonCatCell(m, c.key);
      }
      return out;
    }
  );
  // Season tab: four Sheet categories + Season Activity only. No CS/DS/Events/Activity.
  el.innerHTML =
    '<section class="panel glass"><h2>Season</h2>' +
    '<p class="lead">Mutual Assistance · Clean Up · Conquest · Defeat — Punkte aus den Season-Tabs, Season % gewichtet.</p>' +
    (seasonLegend ? `<div class="meta-grid">${seasonLegend}</div>` : "") +
    (hasPts
      ? ""
      : '<p class="sub">Season-Tabs sind leer (noch keine Beiträge nach Fresh Start). Spalten stehen bereit.</p>') +
    "<h3>Mitglieder · Season-Kategorien</h3>" +
    '<p class="sub">Eine Spalte pro Kategorie · Season % · sortiert nach Season %</p>' +
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

function normalizeChampionDraft(raw) {
  if (!raw || typeof raw !== "object") return { type: "max_score" };
  const type = String(raw.type || "").toLowerCase();
  if (type === "day_min") {
    const dayMin = Number(raw.day_min);
    return {
      type: "day_min",
      day_min: Number.isFinite(dayMin) && dayMin > 0 ? dayMin : VS_SAVE_MIN,
    };
  }
  if (type === "save_exact_and_closest") {
    const dayTarget = Number(raw.day_target);
    const days = Array.isArray(raw.week_days) && raw.week_days.length
      ? raw.week_days.map((d) => String(d).toLowerCase())
      : ["mon", "tue", "wed", "thu"];
    return {
      type: "save_exact_and_closest",
      day_target: Number.isFinite(dayTarget) && dayTarget > 0 ? dayTarget : VS_SAVE_MIN,
      week_days: days,
      week_agg: String(raw.week_agg || "closest_sum").toLowerCase(),
    };
  }
  if (type === "manual") {
    return {
      type: "manual",
      title: String(raw.title || "").trim(),
      winners: Array.isArray(raw.winners)
        ? raw.winners.map((n) => String(n ?? "").trim()).filter(Boolean)
        : [],
      note: String(raw.note || "").trim(),
    };
  }
  return { type: "max_score" };
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
  const champion = normalizeChampionDraft(entry && entry.champion);
  return { year, week, mode, elevatedMin, champion };
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
    meta.VSWeekMin = `MO–DO ${formatPointsDe(VS_SAVE_MIN)} · FR–SA OFFEN`;
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

function syncConfigChampionBlocks(el) {
  const type = el.querySelector("#cfgChampType").value;
  for (const block of el.querySelectorAll("[data-champ-type]")) {
    block.hidden = block.getAttribute("data-champ-type") !== type;
  }
}

function collectChampionFromForm(el) {
  const type = el.querySelector("#cfgChampType").value;
  if (type === "day_min") {
    const dayMin = parsePointsInput(el.querySelector("#cfgChampDayMin").value);
    if (!dayMin) throw new Error("Champion: Tagesminimum erforderlich");
    return { type: "day_min", day_min: dayMin };
  }
  if (type === "save_exact_and_closest") {
    const dayTarget =
      parsePointsInput(el.querySelector("#cfgChampDayTarget").value) || VS_SAVE_MIN;
    const weekDays = [...el.querySelectorAll('input[name="cfgChampWeekDay"]:checked')].map(
      (cb) => cb.value
    );
    return {
      type: "save_exact_and_closest",
      day_target: dayTarget,
      week_days: weekDays.length ? weekDays : ["mon", "tue", "wed", "thu"],
      week_agg: "closest_sum",
    };
  }
  if (type === "manual") {
    const title = el.querySelector("#cfgChampTitle").value.trim();
    const winners = el
      .querySelector("#cfgChampWinners")
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const note = el.querySelector("#cfgChampNote").value.trim();
    if (!title) throw new Error("Champion: Titel erforderlich (z. B. Bestes Outfit)");
    if (!winners.length) throw new Error("Champion: mindestens einen Gewinner eintragen");
    const out = { type: "manual", title, winners };
    if (note) out.note = note;
    return out;
  }
  return { type: "max_score" };
}

function bindConfigForm(el, draft) {
  el.querySelector("#cfgMode").value = draft.mode;
  syncConfigModeBlocks(el);
  el.querySelector("#cfgMode").addEventListener("change", () => syncConfigModeBlocks(el));

  const champ = draft.champion || { type: "max_score" };
  el.querySelector("#cfgChampType").value = champ.type || "max_score";
  syncConfigChampionBlocks(el);
  el.querySelector("#cfgChampType").addEventListener("change", () => syncConfigChampionBlocks(el));

  if (champ.type === "day_min") {
    el.querySelector("#cfgChampDayMin").value = formatPointsInputValue(champ.day_min) || String(champ.day_min || "");
  }
  if (champ.type === "save_exact_and_closest") {
    el.querySelector("#cfgChampDayTarget").value =
      formatPointsInputValue(champ.day_target) || String(champ.day_target || VS_SAVE_MIN);
    const selected = new Set(champ.week_days || ["mon", "tue", "wed", "thu"]);
    el.querySelectorAll('input[name="cfgChampWeekDay"]').forEach((cb) => {
      cb.checked = selected.has(cb.value);
    });
  }
  if (champ.type === "manual") {
    el.querySelector("#cfgChampTitle").value = champ.title || "";
    el.querySelector("#cfgChampWinners").value = (champ.winners || []).join("\n");
    el.querySelector("#cfgChampNote").value = champ.note || "";
  }

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
      const champion = collectChampionFromForm(el);
      const json = await postImportantLinksConfig({
        kind: "vs-week",
        year: draft.year,
        week: draft.week,
        mode,
        max: maxRaw,
        champion,
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
  const champ = draft.champion || { type: "max_score" };
  const dayChecks = ["mon", "tue", "wed", "thu", "fri", "sat"]
    .map((d) => {
      const checked = (champ.week_days || ["mon", "tue", "wed", "thu"]).includes(d) ? " checked" : "";
      return (
        `<label class="cfg-day-check"><input type="checkbox" name="cfgChampWeekDay" value="${d}"${checked}>` +
        `${CHAMPION_DAY_LABEL_DE[d]}</label>`
      );
    })
    .join("");
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
    '<p class="config-hint">Mo–Do: <strong>7,2 Mio</strong> · Fr–Sa: <strong>offen</strong> (kein under/over).</p>' +
    "</div>" +
    '<fieldset class="cfg-champ-fieldset">' +
    "<legend>Champion</legend>" +
    '<p class="config-hint">Punkte-Regeln oder manuell (z. B. Bestes Outfit).</p>' +
    "<div><label for=\"cfgChampType\">Typ</label>" +
    '<select id="cfgChampType" name="champType">' +
    '<option value="max_score">Höchste Punkte (max_score)</option>' +
    '<option value="day_min">Tagesminimum (day_min)</option>' +
    '<option value="save_exact_and_closest">Exact + nächste Summe</option>' +
    '<option value="manual">Manuell (Outfit / Custom)</option>' +
    "</select></div>" +
    '<div data-champ-type="day_min" hidden>' +
    "<div><label for=\"cfgChampDayMin\">Tagesminimum</label>" +
    `<input id="cfgChampDayMin" type="text" inputmode="numeric" placeholder="z. B. 7.2M" value="${esc(
      formatPointsInputValue(champ.day_min)
    )}"></div></div>` +
    '<div data-champ-type="save_exact_and_closest" hidden>' +
    "<div><label for=\"cfgChampDayTarget\">Tagesziel (Exact)</label>" +
    `<input id="cfgChampDayTarget" type="text" inputmode="numeric" placeholder="7200000" value="${esc(
      formatPointsInputValue(champ.day_target) || "7.2M"
    )}"></div>` +
    '<p class="config-hint">Wochentage für Summe (closest_sum):</p>' +
    `<div class="cfg-day-row">${dayChecks}</div>` +
    "</div>" +
    '<div data-champ-type="manual" hidden>' +
    "<div><label for=\"cfgChampTitle\">Titel</label>" +
    `<input id="cfgChampTitle" type="text" placeholder="z. B. Bestes Outfit" value="${esc(
      champ.title || ""
    )}"></div>` +
    "<div><label for=\"cfgChampWinners\">Gewinner (ein Name pro Zeile)</label>" +
    `<textarea id="cfgChampWinners" rows="4" placeholder="Name1&#10;Name2">${esc(
      (champ.winners || []).join("\n")
    )}</textarea></div>` +
    "<div><label for=\"cfgChampNote\">Notiz (optional)</label>" +
    `<input id="cfgChampNote" type="text" placeholder="optional" value="${esc(
      champ.note || ""
    )}"></div></div>` +
    "</fieldset>" +
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
