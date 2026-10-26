"use strict";

let DATA = null;

const ROLE_OPTIONS = ["R5", "R4", "R3", "R2", "R1"];
const CACHE_BUST = "20261022-presence";

/** Save-Woche: eigenes Widget — Tages-VS über dieser Schwelle (Tracking). */
const WATCH_SAVE_DAY_OVER = 15_000_000;

/** Season contribution columns — mirrors Sheet tabs / SEASON_CATEGORIES. */
const SEASON_CATS = [
  { key: "support", label: "Assistance", legend: "Season Mutual Assistance" },
  { key: "cleanup", label: "Clean Up", legend: "Season Clean Up" },
  { key: "conquest", label: "Conquest", legend: "Season Conquest" },
  { key: "defeat", label: "Defeat", legend: "Season Defeat" },
];

/** Overview „Wenig aktiv“ — niedrigste Activity-% (5–10, Default 8). Config später. */
const WENIG_AKTIV_COUNT = 8;
/** v3: per-view filter fields (Kills tendenz/anstieg, VS flag only on VS/Overview). */
const FILTER_STORAGE_KEY = "dawn-dashboard-filters-v3";
const PERIOD_STORAGE_KEY = "dawn-dashboard-period";

/** Mitglieder-Filter: Overview/Gegner/Links/Config ohne Filterleiste. */
const FILTERABLE_VIEWS = new Set([
  "kills",
  "donations",
  "vs",
  "season",
  "events",
  "activity",
]);

const COLLAPSE_STORAGE_KEY = "dawn-dashboard-collapse-v1";
/** @type {Record<string, boolean>|null} */
let collapseState = null;

/**
 * @typedef {{
 *   roles: string[],
 *   activeOnly: boolean,
 *   vsFlag: string,
 *   search: string,
 *   killsTrend: string,
 *   killsSteep: string,
 * }} DashboardFilters
 */
/** @type {DashboardFilters} */
let filters = {
  roles: [],
  activeOnly: false,
  vsFlag: "all",
  search: "",
  killsTrend: "all",
  killsSteep: "all",
};

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
 * Per-week champion rules: vs_weeks[].champions[] (legacy: .champion single).
 * Messbar: max_score | day_min | save_exact_and_closest (aus VS).
 * Nicht messbar: manual — Titel + winners[] aus Active-Roster (Checkbox).
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

function filteredNameSet(view) {
  return new Set(filteredMembers(view).map((m) => normalizeName(m.name)));
}

/** True once a second KW/kill column exists and deltas are computed. */
function killsCompareReady() {
  return (DATA.members || []).some(
    (m) =>
      m.kills_delta != null ||
      (m.kills_trend && m.kills_trend !== "unknown")
  );
}

/** Latest date label present on a sheet block (YYYY-MM-DD → de). */
function sheetLatestDateLabel(key) {
  const cols = sheetColumnLabels(key);
  const dates = cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c)));
  if (!dates.length) return null;
  dates.sort();
  const iso = dates[dates.length - 1];
  const d = parseIsoDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** One-line data reality for the current export (no excuses in the UI). */
function dataRealityLine() {
  const vsD = sheetLatestDateLabel("vs");
  const donD = sheetLatestDateLabel("donations");
  const kills = killsCompareReady() ? "Kills mit KW-Vergleich" : "Kills Startstand";
  const parts = [];
  if (vsD) parts.push(`VS ${vsD}`);
  else parts.push("VS —");
  if (donD) parts.push(`Spende ${donD}`);
  else parts.push("Spende —");
  parts.push(kills);
  return parts.join(" · ");
}

function defaultFilters() {
  return {
    roles: [],
    activeOnly: false,
    vsFlag: "all",
    search: "",
    killsTrend: "all",
    killsSteep: "all",
  };
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
  let killsTrend = String(raw.killsTrend ?? "all").toLowerCase();
  if (!["all", "up", "flat", "unknown"].includes(killsTrend)) killsTrend = "all";
  let killsSteep = String(raw.killsSteep ?? "all").toLowerCase();
  if (!["all", "steep", "mild", "flat"].includes(killsSteep)) killsSteep = "all";
  return {
    roles,
    activeOnly: Boolean(raw.activeOnly),
    vsFlag,
    search: typeof raw.search === "string" ? raw.search : "",
    killsTrend,
    killsSteep,
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
    killsTrend: params.get("ktrend") || "all",
    killsSteep: params.get("ksteep") || "all",
  };
  if (
    fromUrl.roles.length ||
    params.has("active") ||
    (fromUrl.vsFlag && fromUrl.vsFlag !== "all") ||
    fromUrl.search ||
    (fromUrl.killsTrend && fromUrl.killsTrend !== "all") ||
    (fromUrl.killsSteep && fromUrl.killsSteep !== "all")
  ) {
    filters = sanitizeFilters({
      ...defaultFilters(),
      roles: fromUrl.roles,
      activeOnly: params.has("active") ? params.get("active") === "1" : defaultFilters().activeOnly,
      vsFlag: fromUrl.vsFlag,
      search: fromUrl.search,
      killsTrend: fromUrl.killsTrend,
      killsSteep: fromUrl.killsSteep,
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
  if (filters.killsTrend && filters.killsTrend !== "all") params.set("ktrend", filters.killsTrend);
  else params.delete("ktrend");
  if (filters.killsSteep && filters.killsSteep !== "all") params.set("ksteep", filters.killsSteep);
  else params.delete("ksteep");
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

function memberMatchesFilters(m, view) {
  const v = view || currentDashboardView();
  if (filters.activeOnly && !m.active) return false;
  if (filters.roles.length && !filters.roles.includes(m.role)) return false;
  if (filters.search.trim() && !nameMatchesSearch(m.name, filters.search)) return false;
  // VS Flag nur auf Overview / VS
  if (v === "overview" || v === "vs") {
    if (filters.vsFlag === "ok" && m.vs_flag !== "OK") return false;
    if (filters.vsFlag === "below" && !/below/i.test(String(m.vs_flag || ""))) return false;
  }
  // Kill-Tendenz / Anstieg nur auf Kills
  if (v === "kills") {
    if (filters.killsTrend !== "all") {
      const t = String(m.kills_trend || "unknown");
      if (t !== filters.killsTrend) return false;
    }
    if (filters.killsSteep !== "all") {
      const s = String(m.kills_steep || "");
      if (s !== filters.killsSteep) return false;
    }
  }
  return true;
}

function filteredMembers(view) {
  return (DATA.members || []).filter((m) => memberMatchesFilters(m, view));
}

function sortedMembers(cmp, view) {
  return [...filteredMembers(view)].sort(cmp);
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
  // Live Spieltag-ISO-Woche hat Vorrang — Montag startet saubere Woche auch bei
  // veraltetem Sheet-Meta (VSWeekYear/Number von letzter Woche).
  const fromGame = isoWeekKey(currentGameDate());
  const meta = (DATA && DATA.meta) || {};
  const y = Number(meta.VSWeekYear);
  const w = Number(meta.VSWeekNumber);
  if (
    Number.isFinite(y) &&
    Number.isFinite(w) &&
    y === fromGame.year &&
    w === fromGame.week
  ) {
    return { year: y, week: w };
  }
  return fromGame;
}

/** VS-Flag aus Tageswerten der aktiven ISO-Woche (nicht Sheet-vs_flag der Vorwoche). */
function memberVsWeekFlag(m) {
  const labs = vsWeekDayLabels();
  let nDays = 0;
  let nBelow = 0;
  for (const lab of labs) {
    const d = parseIsoDate(lab);
    if (!d) continue;
    const min = vsMinForGameDate(d);
    if (min <= 0) continue;
    const pts = vsPointsAtLabel(m, lab);
    if (pts == null || pts <= 0) continue;
    nDays += 1;
    if (pts < min) nBelow += 1;
  }
  if (nDays === 0) return "";
  if (nBelow) return `${nBelow}/${nDays} below`;
  return "OK";
}

function currentWeekHasQuotaScores() {
  const roster = (DATA && DATA.members) || [];
  return roster.some((m) => memberVsWeekFlag(m) !== "");
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
  if (row && row.values && Object.prototype.hasOwnProperty.call(row.values, label)) {
    const raw = row.values[label];
    if (raw != null && raw !== "") {
      const v = Number(raw);
      if (!Number.isNaN(v)) return v;
    }
  }
  // Fallback: member.vs_days from export
  const days = member && member.vs_days;
  if (days && Object.prototype.hasOwnProperty.call(days, label)) {
    const raw = days[label];
    if (raw != null && raw !== "") {
      const v = Number(raw);
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
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
  return /below/i.test(memberVsWeekFlag(m));
}

/** Activity % im JSON = gewichteter Gesamt-KPI (Sheet), nicht Tages-/Wochenmodus. */
const WATCHLIST_DISPLAY_MAX = 15;

function memberLowActivityForWatchlist(m) {
  if (!m.active) return false;
  if ((m.activity ?? 0) >= 0.4) return false;
  return true;
}

function memberSaveDayOverHits(m) {
  if (activeVsWeekMode() !== "save") return [];
  const labs = vsWeekDayLabels();
  const hits = [];
  for (const lab of labs) {
    const pts = vsPointsAtLabel(m, lab);
    if (pts == null) continue;
    if (pts > WATCH_SAVE_DAY_OVER) {
      hits.push({ label: lab, pts: Math.round(pts) });
    }
  }
  return hits;
}

function buildWatchlistEntries(members, compare) {
  const watch = [];
  for (const m of members) {
    // Overview-Woche: Flag aus aktuellen VS-Tageswerten (Montags leer bis neue Daten)
    if (/below/i.test(memberVsWeekFlag(m))) {
      watch.push({ m, reason: "Unter Quote", score: 3 });
    } else if (memberLowActivityForWatchlist(m)) {
      watch.push({ m, reason: "Activity niedrig", score: 2 });
    }
  }
  const cmpPlayers = (compare && compare.players) || [];
  for (const p of cmpPlayers) {
    if (!/unnecessary/i.test(String(p.verdict || ""))) continue;
    const mem = members.find((m) => normalizeName(m.name) === normalizeName(p.name));
    if (!mem) continue;
    watch.push({
      m: mem,
      reason: "Unnötige VS",
      score: 1 + (Number(p.unnecessary) || 0) / 1e8,
    });
  }
  watch.sort(
    (a, b) =>
      b.score - a.score || String(a.m.name).localeCompare(String(b.m.name), "de")
  );
  return watch;
}

/** Save-Woche: Mitglieder mit Tages-VS > 15M — eigenes Overview-Element. */
function buildSavePushEntries(members) {
  if (activeVsWeekMode() !== "save") return [];
  const entries = [];
  for (const m of members) {
    for (const hit of memberSaveDayOverHits(m)) {
      entries.push({
        m,
        label: hit.label,
        pts: hit.pts,
        dayShort: String(hit.label).slice(5),
      });
    }
  }
  entries.sort(
    (a, b) =>
      b.pts - a.pts ||
      String(a.label).localeCompare(String(b.label)) ||
      String(a.m.name).localeCompare(String(b.m.name), "de")
  );
  return entries;
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
  return memberVsWeekFlag(m) === "OK";
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
    ok: members.filter((m) => memberVsWeekFlag(m) === "OK").length,
    below: members.filter((m) => /below/i.test(memberVsWeekFlag(m))).length,
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
  // Nur Spalten der aktiven ISO-Woche — kein Fallback auf Vorwochen (Montags-Reset).
  const block = sheetBlock("vs");
  const cols = (block && block.columns) || [];
  const refWeek = activeVsWeekKey();
  return cols.filter((lab) => {
    const d = parseIsoDate(lab);
    if (!d) return false;
    const wk = isoWeekKey(d);
    return wk.year === refWeek.year && wk.week === refWeek.week;
  });
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

function normalizeChampionRule(raw) {
  if (!raw || typeof raw !== "object") return { type: "max_score" };
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
    return {
      type: "day_min",
      day_min: Number.isFinite(dayMin) && dayMin > 0 ? dayMin : VS_SAVE_MIN,
    };
  }
  if (type === "manual") {
    return {
      type: "manual",
      title: String(raw.title || "").trim() || "Champion",
      winners: Array.isArray(raw.winners)
        ? raw.winners.map((n) => String(n ?? "").trim()).filter(Boolean)
        : [],
      note: String(raw.note || "").trim(),
    };
  }
  return { type: "max_score" };
}

/** All champion rules for the active VS week (champions[] or legacy champion). */
function activeChampionRules() {
  const entry = activeVsWeekEntry();
  if (entry && Array.isArray(entry.champions) && entry.champions.length) {
    return entry.champions.map(normalizeChampionRule);
  }
  if (entry && entry.champion && typeof entry.champion === "object") {
    return [normalizeChampionRule(entry.champion)];
  }
  return [{ type: "max_score" }];
}

/** Primary rule for Pulse (first measurable, else first). */
function activeChampionRule() {
  const rules = activeChampionRules();
  return rules.find((r) => r.type !== "manual") || rules[0] || { type: "max_score" };
}

function findMemberByRosterName(name) {
  const key = normalizeName(name);
  if (!key) return null;
  return (DATA.members || []).find((m) => normalizeName(m.name) === key) || null;
}

function activeRosterNames() {
  return (DATA.members || [])
    .filter((m) => m.active)
    .map((m) => m.name)
    .sort((a, b) => String(a).localeCompare(String(b), "de"));
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

/** Wochen-Sieger erst Sonntag (Spieltag) — vorher nur Tages-Treffer. */
function championWeekReady(now = new Date()) {
  const d = parseIsoDate(currentGameDateLabel(now)) || currentGameDate();
  return pythonWeekday(d) === 6;
}

function computeChampionState(members, ruleIn) {
  const rule = ruleIn || activeChampionRule();
  if (rule.type === "manual") {
    const winners = (rule.winners || []).map((name) => {
      const m = findMemberByRosterName(name);
      return { name: m ? m.name : name, m };
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
    /** Knapp daneben (|Δ| 1–10) — oft mit „7.2M“ verwechselt wenn nur M angezeigt wird. */
    const nearHits = [];
    for (const slot of allDays) {
      const scored = members
        .map((m) => ({ m, pts: vsPointsAtLabel(m, slot.label) }))
        .filter((x) => x.pts != null);
      for (const h of scored) {
        const pts = Math.round(h.pts);
        const dist = Math.abs(pts - target);
        if (dist === 0) exactHits.push({ slot, m: h.m, pts, dist: 0 });
        else if (dist > 0 && dist <= 10) nearHits.push({ slot, m: h.m, pts, dist });
      }
    }
    exactHits.sort(
      (a, b) =>
        a.slot.weekday - b.slot.weekday ||
        String(a.m.name).localeCompare(String(b.m.name), "de")
    );
    nearHits.sort(
      (a, b) =>
        a.dist - b.dist ||
        a.slot.weekday - b.slot.weekday ||
        String(a.m.name).localeCompare(String(b.m.name), "de")
    );
    // Wochen-Sieger erst am Sonntag (nach kompletter VS-Woche) — vorher nur Tages-Treffer.
    const weekReady = championWeekReady();
    let weekWinners = [];
    if (weekReady) {
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
      weekWinners =
        best === Infinity
          ? []
          : sums
              .filter((x) => x.dist === best)
              .sort((a, b) => String(a.m.name).localeCompare(String(b.m.name), "de"));
    }
    return {
      rule,
      exactHits,
      nearHits,
      dayHits: [],
      weekWinners,
      weekSlots,
      weekReady,
      topList: [],
      pulsePts: weekWinners[0] ? weekWinners[0].sum : exactHits[0] ? exactHits[0].pts : null,
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

function computeAllChampionStates(members) {
  return activeChampionRules().map((rule) => computeChampionState(members, rule));
}

function renderChampionWidgets(champStates, vsReady, vsEmptyMsg) {
  return champStates
    .map((st, i) => renderChampionWidget(st, vsReady, vsEmptyMsg, i))
    .join("");
}

function renderChampionWidget(champState, vsReady, vsEmptyMsg, idx) {
  const rule = champState.rule;
  const idSuffix = idx != null ? `-${idx}` : "";
  if (rule.type === "manual") {
    const title = rule.title || "Champion";
    const winners = champState.manualWinners || [];
    const rows = winners
      .map(
        (w, i) =>
          `<li><span class="rank">${i + 1}</span>` +
          `<span class="who">${esc(w.m ? w.m.name : w.name)}</span>` +
          `<span class="val"></span></li>`
      )
      .join("");
    const noteHtml = rule.note
      ? `<p class="sub champ-note">${esc(rule.note)}</p>`
      : "";
    return widgetShell(
      `champion${idSuffix}`,
      title,
      "Nicht messbar · Roster-Auswahl",
      noteHtml +
        (rows
          ? `<ul class="rank-list champ-list">${rows}</ul>`
          : `<p class="sub">Noch niemand ausgewählt.</p>`),
      { className: "champ-widget", span: "span-12" }
    );
  }
  if (!vsReady) {
    return widgetShell(
      `champion${idSuffix}`,
      "Champion",
      esc(vsEmptyMsg),
      "",
      { className: "champ-widget", span: "span-12" }
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
    const nearRows = (champState.nearHits || [])
      .slice(0, 8)
      .map(
        (h) =>
          `<li><span class="rank">${esc(formatChampDayLabel(h.slot))}</span>` +
          `<span class="who">${esc(h.m.name)}</span>` +
          `<span class="val">${fmtPts(h.pts)} · Δ ${fmtPts(h.dist)}</span></li>`
      )
      .join("");
    const weekReady = !!champState.weekReady;
    const weekRows = (champState.weekWinners || [])
      .map(
        (w) =>
          `<li><span class="rank">Δ</span>` +
          `<span class="who">${esc(w.m.name)}</span>` +
          `<span class="val">${fmtPts(w.sum)} · Δ ${fmtPts(w.dist)}</span></li>`
      )
      .join("");
    const weekBody = !weekReady
      ? `<p class="sub">Erst Sonntag — Summe ${esc(weekDaysLabel)} am nächsten an ${esc(
          targetLabel
        )}</p>`
      : weekRows
        ? `<ul class="rank-list champ-list">${weekRows}</ul>`
        : `<p class="sub">${esc(vsEmptyMsg)}</p>`;
    const body =
      `<div class="champ-blocks">` +
      `<div class="champ-block">` +
      `<p class="champ-section-label">Tages-Treffer · exakt ${esc(targetLabel)}</p>` +
      (exactRows
        ? `<ul class="rank-list champ-list">${exactRows}</ul>`
        : `<p class="sub">Noch kein Exact-Treffer.</p>`) +
      (nearRows
        ? `<p class="champ-section-label">Knapp daneben (nicht Exact, Δ≤10)</p>` +
          `<ul class="rank-list champ-list">${nearRows}</ul>`
        : "") +
      `</div>` +
      `<div class="champ-block">` +
      `<p class="champ-section-label">Wochen-Sieger</p>` +
      weekBody +
      `</div></div>`;
    return widgetShell(
      `champion${idSuffix}`,
      "Champion",
      `Save-Woche · Tagesziel ${esc(targetLabel)} exakt · Wochen-Sieger Sonntag`,
      body,
      { className: "champ-widget", span: "span-12" }
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
    return widgetShell(
      `champion${idSuffix}`,
      "Champion",
      `Tag ≥ ${esc(minLabel)} · alle Treffer`,
      dayRows
        ? `<ul class="rank-list champ-list">${dayRows}</ul>`
        : `<p class="sub">${esc(vsEmptyMsg)}</p>`,
      { className: "champ-widget", span: "span-12" }
    );
  }
  const head = champState.topList[0];
  const body =
    (head
      ? `<p class="sub">${esc(head.name)} · ${fmtPts(vsMetric(head))}</p>`
      : `<p class="sub">${esc(vsEmptyMsg)}</p>`) +
    renderRankList(
      head ? champState.topList.slice(1) : [],
      (m) => fmtPts(vsMetric(m)),
      vsEmptyMsg
    );
  return widgetShell(`champion${idSuffix}`, "Champion", "Wochensumme", body, {
    className: "champ-widget",
    span: "span-12",
  });
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
  // KPI Kills: nur echtes Wochen-Δ (kein Fake-+100% bei einer Spalte).
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

function loadCollapseState() {
  if (collapseState) return collapseState;
  try {
    collapseState = JSON.parse(sessionStorage.getItem(COLLAPSE_STORAGE_KEY) || "{}") || {};
  } catch (e) {
    collapseState = {};
  }
  return collapseState;
}

function isWidgetCollapsed(id, defaultCollapsed) {
  const s = loadCollapseState();
  if (Object.prototype.hasOwnProperty.call(s, id)) return !!s[id];
  return !!defaultCollapsed;
}

function setWidgetCollapsed(id, collapsed) {
  const s = loadCollapseState();
  s[id] = !!collapsed;
  try {
    sessionStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    /* ignore */
  }
}

/**
 * Collapsible overview widget shell.
 * @param {string} id
 * @param {string} title
 * @param {string} subHtml already-escaped or plain via esc in caller
 * @param {string} bodyHtml
 * @param {{ className?: string, defaultCollapsed?: boolean, span?: string }} [opts]
 */
function widgetShell(id, title, subHtml, bodyHtml, opts) {
  const o = opts || {};
  const collapsed = isWidgetCollapsed(id, !!o.defaultCollapsed);
  const span = o.span || "span-12";
  const extra = o.className ? " " + o.className : "";
  return (
    `<article class="widget ${span} glass${extra}" data-collapse-id="${esc(id)}">` +
    `<button type="button" class="widget-toggle" aria-expanded="${collapsed ? "false" : "true"}">` +
    `<span class="widget-toggle-text"><h3>${esc(title)}</h3>` +
    (subHtml ? `<p class="sub">${subHtml}</p>` : "") +
    `</span><span class="widget-chevron" aria-hidden="true"></span></button>` +
    `<div class="widget-body"${collapsed ? " hidden" : ""}>${bodyHtml}</div></article>`
  );
}

function pulseGesamtDonation(members) {
  let best = null;
  let pts = 0;
  for (const m of members) {
    const d = Number(m.donations) || 0;
    if (d > pts) {
      pts = d;
      best = m;
    }
  }
  return { m: best, pts };
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

/** Ø-Activity-Verlauf body (Archiv + Live) — wrapped by widgetShell in Overview. */
function renderActivityTrendChartBody() {
  const series = activityTrendPoints();
  if (!series.length) {
    return {
      summary: "Gesamtverlauf",
      body: '<p class="sub">Noch keine Archiv-Snapshots für den Trend.</p>',
    };
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
  return {
    summary: esc(summary),
    body:
      '<p class="sub">Ø Activity der Aktiven · Archiv (+ live)</p>' +
      '<div class="vs-chart">' +
      `<svg class="activity-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity-Verlauf">` +
      ticks.join("") +
      `<path class="chart-area dawn" d="${area}" />` +
      `<path class="chart-line dawn" d="${path}" fill="none" />` +
      dots +
      labels +
      "</svg></div>",
  };
}

/** Compact week day strip for Overview (not a card wall). */
function renderVsCompareCompact(days) {
  const sorted = vsCompareDaysSorted(days);
  if (!sorted.length) return { summary: "", body: "" };
  let wins = 0;
  let losses = 0;
  for (const d of sorted) {
    if (/win/i.test(String(d.result || ""))) wins += 1;
    else if (/loss/i.test(String(d.result || ""))) losses += 1;
  }
  const last = sorted[sorted.length - 1];
  const summary = esc(
    `${sorted.length} Tag${sorted.length === 1 ? "" : "e"} · ${wins}W/${losses}L` +
      (last ? ` · zuletzt Δ ${fmtPts(last.delta)}` : "")
  );
  const head =
    "<thead><tr><th>Tag</th><th>Ergebnis</th><th class=\"num\">DawN</th>" +
    "<th class=\"num\">Gegner</th><th class=\"num\">Δ</th></tr></thead>";
  const bodyRows = sorted
    .map((d) => {
      const win = /win/i.test(String(d.result || ""));
      const loss = /loss/i.test(String(d.result || ""));
      const cls = win ? "win" : loss ? "loss" : "";
      return (
        `<tr class="${cls}"><td>${esc(String(d.date).slice(5))}</td>` +
        `<td>${esc(d.result || "—")}</td>` +
        `<td class="num">${fmtPts(d.dawn)}</td>` +
        `<td class="num">${fmtPts(d.opponent)}</td>` +
        `<td class="num">${fmtPts(d.delta)}</td></tr>`
      );
    })
    .join("");
  return {
    summary,
    body:
      '<div class="table-wrap"><table class="t compact vs-compare-table">' +
      head +
      `<tbody>${bodyRows}</tbody></table></div>` +
      '<p class="sub">Details &amp; Gegner-Rangliste → Tab Gegner</p>',
  };
}

function renderOverviewWidgets() {
  // Overview = aktuelle VS-Woche. Kein Filter, kein Woche/Gesamt-Toggle.
  periodMode = "woche";
  const roster = DATA.members || [];
  const champStates = computeAllChampionStates(roster);
  const champState = champStates.find((s) => s.rule && s.rule.type !== "manual") || champStates[0];
  const vsReady = hasVsSheetData();
  const vsEmptyMsg = !vsReady ? "Keine VS-Daten verfügbar" : noVsDataMessage();
  const weekHasVs = currentWeekHasQuotaScores();
  const underQuota = weekHasVs
    ? roster
        .filter((m) => /below/i.test(memberVsWeekFlag(m)))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "de"))
    : [];
  const topDonWeek = roster
    .map((m) => ({ m, pts: donationMetric(m) }))
    .filter((x) => x.pts > 0)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 5)
    .map((x) => x.m);
  const wenigAktiv = wenigAktivMembers(roster);
  const compare = sheetBlock("vs_compare");
  const days = (compare && compare.days) || [];
  // VS-Vergleich nur Tage der aktiven ISO-Woche (Montags leer bis neue Daten)
  const refWeek = activeVsWeekKey();
  const daysThisWeek = days.filter((d) => {
    const lab = d && (d.date || d.day || d.label);
    const parsed = parseIsoDate(lab);
    if (!parsed) return false;
    const wk = isoWeekKey(parsed);
    return wk.year === refWeek.year && wk.week === refWeek.week;
  });
  const cmp = daysThisWeek.length ? renderVsCompareCompact(daysThisWeek) : null;
  const trend = renderActivityTrendChartBody();
  const vsOk = weekHasVs
    ? roster.filter((m) => memberVsWeekFlag(m) === "OK").length
    : 0;
  const vsBelow = underQuota.length;
  const topDonGesamt = pulseGesamtDonation(roster);
  const watchAll = buildWatchlistEntries(roster, compare);
  const watchShort = watchAll.slice(0, WATCHLIST_DISPLAY_MAX);
  const watchSubExtra =
    watchAll.length > watchShort.length
      ? ` · ${watchAll.length} gesamt, Top ${watchShort.length}`
      : watchAll.length
        ? ` · ${watchAll.length} Einträge`
        : "";
  const savePushAll = buildSavePushEntries(roster);
  const savePushShort = savePushAll.slice(0, WATCHLIST_DISPLAY_MAX);
  const savePushSub =
    activeVsWeekMode() !== "save"
      ? "Nur in Save-Wochen"
      : savePushAll.length > savePushShort.length
        ? `Save · &gt;15M/Tag · ${savePushAll.length} gesamt, Top ${savePushShort.length}`
        : savePushAll.length
          ? `Save · &gt;15M/Tag · ${savePushAll.length}`
          : "Save · &gt;15M/Tag · keine";
  const presence = presenceBlock();
  const offlineN =
    presence && presence.online && presence.online.offline_count != null
      ? presence.online.offline_count
      : "—";
  const noGiftN =
    presence && presence.gifts && presence.gifts.no_gift_count != null
      ? presence.gifts.no_gift_count
      : "—";

  return (
    `<p class="ops-stand">${esc(dataRealityLine())}</p>` +
    `<p class="sub">Ops · aktuelle VS-Woche · ${roster.length} Mitglieder</p>` +
    '<div class="widget-grid">' +
    renderChampionWidgets(champStates, vsReady, vsEmptyMsg) +
    widgetShell(
      "under-quota",
      "Unter Quote",
      weekHasVs
        ? `${underQuota.length} · diese Woche`
        : "Neue Woche · noch keine VS-Tage",
      weekHasVs
        ? underQuota.length
          ? "<ul class=\"rank-list\">" +
              underQuota
                .map(
                  (m) =>
                    `<li><span class="rank">!</span><span class="who">${esc(m.name)}</span>` +
                    `<span class="val">${vsBadge(memberVsWeekFlag(m))}</span></li>`
                )
                .join("") +
              "</ul>"
          : '<p class="sub">Keine unter Quote.</p>'
        : '<p class="sub">Noch keine VS-Daten in dieser Woche.</p>',
      { span: "span-6" }
    ) +
    widgetShell(
      "top-don",
      "Top Spende",
      "Wochensumme · Top 5",
      renderRankList(topDonWeek, (m) => fmtNum(donationMetric(m)), noDonationDataMessage()),
      { span: "span-6" }
    ) +
    widgetShell(
      "wenig-aktiv",
      "Wenig aktiv",
      `Gesamt-KPI · niedrigste Activity · ${wenigAktiv.length}`,
      wenigAktiv.length
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
        : '<p class="sub">Keine Activity-Werte.</p>',
      { span: "span-6" }
    ) +
    widgetShell(
      "pulse",
      "Pulse",
      "Gesamtverlauf",
      `<div class="pulse-row">` +
        `<div class="pulse-pill"><strong>${fmtPct(avgActFiltered(roster))}</strong>Ø Activity</div>` +
        `<div class="pulse-pill"><strong>${vsOk}</strong>VS OK</div>` +
        `<div class="pulse-pill"><strong>${vsBelow}</strong>Unter Quote</div>` +
        `<div class="pulse-pill"><strong>${fmtNum(topDonGesamt.pts || null)}</strong>Top Spende</div>` +
        `<div class="pulse-pill"><strong>${
          champState.rule && champState.rule.type === "manual"
            ? esc(champState.rule.title || "Manuell")
            : fmtPts(champState.pulsePts)
        }</strong>Champion</div>` +
        `<div class="pulse-pill"><strong>${esc(String(offlineN))}</strong>Offline ≥12h</div>` +
        `<div class="pulse-pill"><strong>${esc(String(noGiftN))}</strong>Ohne Geschenk</div></div>`,
      { span: "span-6" }
    ) +
    renderPresenceOfflineWidget() +
    renderPresenceGiftsWidgets() +
    widgetShell("activity-trend", "Activity-Verlauf", trend.summary, trend.body, {
      span: "span-12",
      defaultCollapsed: false,
    }) +
    (cmp
      ? widgetShell("vs-compare", "VS-Vergleich · Woche", cmp.summary, cmp.body, {
          span: "span-12",
          className: "vs-overview-compare",
          defaultCollapsed: false,
        })
      : "") +
    widgetShell(
      "watchlist",
      "Watchlist",
      `Unter Quote · Activity${watchSubExtra}`,
      watchShort.length
        ? "<ul class=\"rank-list watch-list\">" +
            watchShort
              .map(
                (w) =>
                  `<li><span class="who">${esc(w.m.name)}</span>` +
                  `<span class="val">${esc(w.reason)}</span></li>`
              )
              .join("") +
            "</ul>"
        : '<p class="sub">Alles ruhig.</p>',
      { span: "span-12", className: "watch-widget", defaultCollapsed: false }
    ) +
    widgetShell(
      "save-push",
      "Save · über 15M",
      savePushSub,
      savePushShort.length
        ? "<ul class=\"rank-list\">" +
            savePushShort
              .map(
                (e) =>
                  `<li><span class="rank">↑</span><span class="who">${esc(e.m.name)}</span>` +
                  `<span class="val">${esc(e.dayShort)} · ${fmtPts(e.pts)}</span></li>`
              )
              .join("") +
            "</ul>"
        : activeVsWeekMode() === "save"
          ? '<p class="sub">Niemand über 15M/Tag.</p>'
          : '<p class="sub">Nur in Save-Wochen sichtbar.</p>',
      { span: "span-12", defaultCollapsed: false }
    ) +
    "</div>"
  );
}

/** Presence block from export (Last-Online + Allianzgeschenk). */
function presenceBlock() {
  const p = DATA && DATA.presence;
  return p && typeof p === "object" ? p : null;
}

function fmtHoursOffline(h) {
  if (h == null || !Number.isFinite(Number(h))) return "—";
  const n = Number(h);
  if (n < 1) return `${Math.round(n * 60)} Min`;
  if (Number.isInteger(n)) return `${n} Std`;
  return `${n.toFixed(1)} Std`;
}

function renderPresenceOfflineWidget() {
  const p = presenceBlock();
  const online = (p && p.online) || {};
  const flagH = (p && p.offline_flag_hours) || 12;
  const list = Array.isArray(online.offline) ? online.offline : [];
  const count = online.offline_count != null ? online.offline_count : list.length;
  const sub =
    online.date
      ? `≥${flagH} Std offline · ${online.date}`
      : `≥${flagH} Std offline`;
  if (!p || !online.sampled) {
    return widgetShell(
      "presence-offline",
      "Offline",
      sub,
      '<p class="sub">Noch kein Last-Online-Capture.</p>',
      { span: "span-6" }
    );
  }
  const body = list.length
    ? "<ul class=\"rank-list\">" +
      list
        .slice(0, 20)
        .map(
          (e) =>
            `<li><span class="rank">⏱</span><span class="who">${esc(e.name)}</span>` +
            `<span class="val">${esc(fmtHoursOffline(e.hours_offline))}</span></li>`
        )
        .join("") +
      "</ul>"
    : '<p class="sub">Niemand ≥' + flagH + " Std offline.</p>";
  return widgetShell(
    "presence-offline",
    "Offline",
    `${count} · ${sub}`,
    body,
    { span: "span-6", defaultCollapsed: false }
  );
}

function renderPresenceGiftsWidgets() {
  const p = presenceBlock();
  const gifts = (p && p.gifts) || {};
  const top = Array.isArray(gifts.top) ? gifts.top : [];
  const noGift = Array.isArray(gifts.no_gift) ? gifts.no_gift : [];
  const noCount =
    gifts.no_gift_count != null ? gifts.no_gift_count : noGift.length;
  const dateHint = gifts.date ? ` · ${gifts.date}` : "";
  if (!p || gifts.events == null) {
    const empty = widgetShell(
      "presence-gifts",
      "Allianzgeschenk",
      "Feed",
      '<p class="sub">Noch kein Geschenk-Capture.</p>',
      { span: "span-6" }
    );
    const emptyMiss = widgetShell(
      "presence-no-gift",
      "Ohne Geschenk",
      "Active · kein Treffer",
      '<p class="sub">Noch kein Geschenk-Capture.</p>',
      { span: "span-6" }
    );
    return empty + emptyMiss;
  }
  const topBody = top.length
    ? "<ol class=\"rank-list\">" +
      top
        .slice(0, 10)
        .map(
          (e, i) =>
            `<li><span class="rank">${i + 1}</span>` +
            `<span class="who">${esc(e.name)}</span>` +
            `<span class="val">${esc(String(e.count))}×</span></li>`
        )
        .join("") +
      "</ol>"
    : '<p class="sub">Keine Geschenk-Events gematcht.</p>';
  const missBody = noGift.length
    ? "<ul class=\"rank-list\">" +
      noGift
        .slice(0, 25)
        .map(
          (e) =>
            `<li><span class="who">${esc(e.name)}</span>` +
            `<span class="val">—</span></li>`
        )
        .join("") +
      "</ul>"
    : '<p class="sub">Alle Active mit mindestens einem Geschenk.</p>';
  return (
    widgetShell(
      "presence-gifts",
      "Allianzgeschenk",
      `${gifts.events || 0} Events · ${gifts.unique_members || 0} Namen${dateHint}`,
      topBody,
      { span: "span-6", defaultCollapsed: false }
    ) +
    widgetShell(
      "presence-no-gift",
      "Ohne Geschenk",
      `Active · ${noCount} ohne Treffer${dateHint}`,
      missBody,
      { span: "span-6", defaultCollapsed: noCount === 0 }
    )
  );
}

function bindOverviewControls(root) {
  root.querySelectorAll(".widget-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const art = btn.closest("[data-collapse-id]");
      if (!art) return;
      const id = art.getAttribute("data-collapse-id");
      const body = art.querySelector(".widget-body");
      const open = btn.getAttribute("aria-expanded") === "true";
      const nextOpen = !open;
      btn.setAttribute("aria-expanded", String(nextOpen));
      if (body) body.hidden = !nextOpen;
      setWidgetCollapsed(id, !nextOpen);
    });
  });
}

function updateFilterCount() {
  const mount = document.getElementById("filterMount");
  if (!mount || !DATA) return;
  const countEl = mount.querySelector(".filter-count");
  if (countEl) {
    const view = currentDashboardView();
    countEl.textContent = `${filteredMembers(view).length} / ${(DATA.members || []).length} sichtbar`;
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
    const id = e.target.id;
    if (id === "filterActive") {
      filters.activeOnly = e.target.checked;
      onFiltersChanged();
    } else if (id === "filterVs") {
      filters.vsFlag = e.target.value;
      onFiltersChanged();
    } else if (id === "filterKillsTrend") {
      filters.killsTrend = e.target.value;
      onFiltersChanged();
    } else if (id === "filterKillsSteep") {
      filters.killsSteep = e.target.value;
      onFiltersChanged();
    }
  });
  mount.addEventListener("click", (e) => {
    if (e.target.closest("#filterReset")) {
      filters = defaultFilters();
      onFiltersChanged();
      renderFilterBar();
      return;
    }
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

function filterFieldSearch() {
  return (
    '<div class="field"><label>Suche</label>' +
    `<input type="search" id="filterSearch" placeholder="Name…" value="${esc(filters.search)}" autocomplete="off"></div>`
  );
}

function filterFieldRoles() {
  const roleChips = ROLE_OPTIONS.map(
    (r) =>
      `<button type="button" class="role-chip" data-role="${r}" aria-pressed="${filters.roles.includes(r)}">${r}</button>`
  ).join("");
  return '<div class="field"><label>Rolle</label><div class="role-chips">' + roleChips + "</div></div>";
}

function filterFieldActive() {
  return `<label class="filter-check"><input type="checkbox" id="filterActive" ${
    filters.activeOnly ? "checked" : ""
  }> Nur Active</label>`;
}

function filterFieldVsFlag() {
  return (
    '<div class="field"><label>VS Flag</label>' +
    `<select id="filterVs"><option value="all">Alle</option><option value="ok">OK</option><option value="below">Unter Quote</option></select></div>`
  );
}

function filterFieldKillsTrend() {
  return (
    '<div class="field"><label>Tendenz</label>' +
    `<select id="filterKillsTrend">` +
    `<option value="all">Alle</option>` +
    `<option value="up">↑ gestiegen</option>` +
    `<option value="flat">→ gleich</option>` +
    `<option value="unknown">· kein Vergleich</option>` +
    `</select></div>`
  );
}

function filterFieldKillsSteep() {
  return (
    '<div class="field"><label>Anstieg</label>' +
    `<select id="filterKillsSteep">` +
    `<option value="all">Alle</option>` +
    `<option value="steep">steil</option>` +
    `<option value="mild">mittel</option>` +
    `<option value="flat">flach</option>` +
    `</select></div>`
  );
}

/** Passende Filter-Felder je Tab — nicht überall der gleiche VS-Filter. */
function filterFieldsForView(view) {
  const common = filterFieldSearch() + filterFieldRoles() + filterFieldActive();
  switch (view) {
    case "kills":
      return common + filterFieldKillsTrend() + filterFieldKillsSteep();
    case "vs":
    case "overview":
      return common + filterFieldVsFlag();
    case "donations":
    case "season":
    case "events":
    case "activity":
      return common;
    default: {
      const _exhaustive = view;
      return common;
    }
  }
}

function renderFilterBar() {
  const mount = document.getElementById("filterMount");
  if (!mount || !DATA) return;
  const view = currentDashboardView();
  syncFilterVisibility(view);
  bindFilterBarOnce(mount);
  if (!FILTERABLE_VIEWS.has(view)) {
    mount.innerHTML = "";
    return;
  }
  const n = filteredMembers(view).length;
  const total = (DATA.members || []).length;
  mount.innerHTML =
    '<div class="filter-bar glass">' +
    filterFieldsForView(view) +
    `<span class="filter-count">${n} / ${total} sichtbar</span>` +
    '<button type="button" class="filter-reset" id="filterReset">Reset</button>' +
    "</div>";
  const vsSel = mount.querySelector("#filterVs");
  if (vsSel) vsSel.value = filters.vsFlag;
  const trendSel = mount.querySelector("#filterKillsTrend");
  if (trendSel) trendSel.value = filters.killsTrend;
  const steepSel = mount.querySelector("#filterKillsSteep");
  if (steepSel) steepSel.value = filters.killsSteep;
}

function renderAllViews() {
  renderOverview(document.getElementById("view-overview"));
  renderKills(document.getElementById("view-kills"));
  renderDonations(document.getElementById("view-donations"));
  renderVs(document.getElementById("view-vs"));
  renderGegner(document.getElementById("view-gegner"));
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

/** Attr-safe JSON for row sort payloads. */
function attrJson(obj) {
  return JSON.stringify(obj == null ? {} : obj)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function trendSortRank(t) {
  if (t === "up") return 2;
  if (t === "flat") return 1;
  return 0;
}

function steepSortRank(s) {
  if (s === "steep") return 3;
  if (s === "mild") return 2;
  if (s === "flat") return 1;
  return 0;
}

function vsFlagSortRank(flag) {
  const f = String(flag || "");
  if (f === "OK") return 2;
  if (/below/i.test(f)) return 0;
  return 1;
}

let tableSortBound = false;

function bindTableSortOnce() {
  if (tableSortBound) return;
  tableSortBound = true;
  document.body.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const table = th.closest("table.t");
    if (!table || !table.classList.contains("sortable-table")) return;
    const key = th.dataset.sortKey;
    if (!key) return;
    const prev = table.dataset.sortKey;
    let dir;
    if (prev === key) {
      dir = table.dataset.sortDir === "asc" ? "desc" : "asc";
    } else {
      dir = th.dataset.sortType === "num" ? "desc" : "asc";
    }
    table.dataset.sortKey = key;
    table.dataset.sortDir = dir;
    sortTableDom(table, key, dir);
  });
}

function sortTableDom(table, key, dir) {
  const tbody = table.tBodies[0];
  if (!tbody) return;
  const th = [...table.querySelectorAll("th.sortable")].find((h) => h.dataset.sortKey === key);
  const type = (th && th.dataset.sortType) || "str";
  const mult = dir === "asc" ? 1 : -1;
  const rows = [...tbody.rows];
  rows.sort((a, b) => {
    let sa = {};
    let sb = {};
    try {
      sa = JSON.parse(a.getAttribute("data-sort") || "{}");
    } catch (err) {
      sa = {};
    }
    try {
      sb = JSON.parse(b.getAttribute("data-sort") || "{}");
    } catch (err) {
      sb = {};
    }
    let av = sa[key];
    let bv = sb[key];
    if (type === "num") {
      const an = av == null || av === "" || Number.isNaN(Number(av)) ? null : Number(av);
      const bn = bv == null || bv === "" || Number.isNaN(Number(bv)) ? null : Number(bv);
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      if (an === bn) return 0;
      return (an - bn) * mult;
    }
    return String(av ?? "").localeCompare(String(bv ?? ""), "de", { sensitivity: "base" }) * mult;
  });
  for (const r of rows) tbody.appendChild(r);
  table.querySelectorAll("th.sortable").forEach((h) => {
    const on = h.dataset.sortKey === key;
    h.classList.toggle("sorted-asc", on && dir === "asc");
    h.classList.toggle("sorted-desc", on && dir === "desc");
    h.setAttribute("aria-sort", on ? (dir === "asc" ? "ascending" : "descending") : "none");
  });
}

/**
 * Interactive member/data table: click headers to sort.
 * Row fields are display HTML; optional row._sort holds comparable values per column key.
 */
function memberTable(columns, rows, extraClass) {
  bindTableSortOnce();
  const head = columns
    .map((c) => {
      const sortable = c.sortable !== false;
      const sortType = c.sortType || (c.class === "num" ? "num" : "str");
      const cls = [c.class || "", sortable ? "sortable" : ""].filter(Boolean).join(" ");
      if (!sortable) return `<th class="${esc(cls)}">${esc(c.label)}</th>`;
      return (
        `<th class="${esc(cls)}" data-sort-key="${esc(c.key)}" data-sort-type="${esc(sortType)}" ` +
        `role="columnheader" aria-sort="none" title="Klick: sortieren">` +
        `${esc(c.label)}<span class="sort-ind" aria-hidden="true"></span></th>`
      );
    })
    .join("");
  const body = rows
    .map((row) => {
      const cls = row._inactive ? ' class="inactive"' : "";
      const sortPayload = row._sort || {};
      return `<tr${cls} data-sort="${attrJson(sortPayload)}">${columns
        .map((c) => `<td class="${esc(c.class || "")}">${row[c.key]}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  const tbl = extraClass ? ` ${extraClass}` : "";
  return (
    `<div class="table-wrap"><table class="t sortable-table${tbl}">` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function matrixTable(block, opts) {
  if (!block || !block.columns || !block.rows) return "";
  const maxRows = opts && opts.maxRows != null ? opts.maxRows : 10000;
  const view = (opts && opts.view) || currentDashboardView();
  const cols = [{ key: "name", label: "Name", class: "name" }].concat(
    block.columns.map((c) => ({ key: c, label: c, class: "num" }))
  );
  let sourceRows = block.rows;
  if (!opts || opts.respectFilters !== false) {
    const allowed = filteredNameSet(view);
    sourceRows = sourceRows.filter((r) => allowed.has(normalizeName(r.name)));
  }
  const rows = sourceRows.slice(0, maxRows).map((r) => {
    const sort = { name: normalizeName(r.name) };
    const out = {
      name: `<span class="name">${esc(r.name)}</span>`,
      _sort: sort,
    };
    for (const c of block.columns) {
      const raw =
        r.values && r.values[c] != null
          ? r.values[c]
          : r.daily_scores && r.daily_scores[c];
      out[c] = fmtPts(raw);
      const n = raw == null || raw === "" ? null : Number(raw);
      sort[c] = Number.isFinite(n) ? n : null;
    }
    if (r.latest != null) {
      out.latest = fmtPts(r.latest);
      sort.latest = Number(r.latest);
    }
    if (r.weekly_avg != null) {
      out.weekly_avg = fmtPts(r.weekly_avg);
      sort.weekly_avg = Number(r.weekly_avg);
    }
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
    "</div>" +
    '<h2 class="hero-headline">DawN · <em>Ops Overview</em></h2>' +
    renderOverviewWidgets() +
    "</div></section>" +
    renderMissingStrip();
  bindOverviewControls(el);
}

/** Gegner-Allianz: Wochenlage aus VS Compare + Rangliste VS Opponent. */
function renderGegner(el) {
  const compare = sheetBlock("vs_compare");
  const opp = sheetBlock("vs_opponent");
  const days = vsCompareDaysSorted((compare && compare.days) || []);
  let dawnSum = 0;
  let oppSum = 0;
  let meetings = days.length;
  for (const d of days) {
    dawnSum += Number(d.dawn) || 0;
    oppSum += Number(d.opponent) || 0;
  }
  const delta = dawnSum - oppSum;
  const weekLabel = currentIsoWeekLabel();

  const dayRows = days.map((d) => {
    const win = /win/i.test(String(d.result || ""));
    const loss = /loss/i.test(String(d.result || ""));
    return {
      date: esc(d.date),
      result: esc(d.result || "—"),
      dawn: fmtPts(d.dawn),
      opponent: fmtPts(d.opponent),
      delta: fmtPts(d.delta),
      dawn_n: d.dawn_count != null ? String(d.dawn_count) : "—",
      opp_n: d.opp_count != null ? String(d.opp_count) : "—",
      _sort: {
        date: d.date || "",
        result: d.result || "",
        dawn: d.dawn,
        opponent: d.opponent,
        delta: d.delta,
        dawn_n: d.dawn_count,
        opp_n: d.opp_count,
      },
      _tone: win ? "win" : loss ? "loss" : "",
    };
  });

  const dayCols = [
    { key: "date", label: "Tag" },
    { key: "result", label: "Ergebnis" },
    { key: "dawn", label: "DawN", class: "num" },
    { key: "opponent", label: "Gegner", class: "num" },
    { key: "delta", label: "Δ", class: "num" },
    { key: "dawn_n", label: "DawN n", class: "num" },
    { key: "opp_n", label: "Gegner n", class: "num" },
  ];

  const oppRowsRaw = (opp && opp.rows) || [];
  const scored = oppRowsRaw
    .map((r) => {
      const vals = r.values || {};
      const cols = (opp.columns || []).filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c));
      let sum = 0;
      let n = 0;
      const byDay = {};
      for (const c of cols) {
        const v = vals[c];
        if (v == null || v === "") continue;
        const num = Number(v);
        if (!Number.isFinite(num)) continue;
        byDay[c] = num;
        sum += num;
        n += 1;
      }
      const latest = r.latest != null ? Number(r.latest) : sum;
      return { name: r.name, sum: Number.isFinite(latest) ? latest : sum, n, byDay };
    })
    .filter((x) => x.name && x.sum > 0)
    .sort((a, b) => b.sum - a.sum);

  const top = scored.slice(0, 15);
  const bottom = [...scored].sort((a, b) => a.sum - b.sum).slice(0, 10);
  const median =
    scored.length > 0 ? scored[Math.floor(scored.length / 2)].sum : null;
  const topShare =
    oppSum > 0 && top.length
      ? top.slice(0, 5).reduce((s, x) => s + x.sum, 0) / oppSum
      : null;

  const strengthBody =
    '<p class="sub">Höchste Tages-/Stand-Punkte der Gegner-Rangliste (aktueller Gegner)</p>' +
    (top.length
      ? memberTable(
          [
            { key: "rank", label: "#" },
            { key: "name", label: "Name" },
            { key: "pts", label: "Punkte", class: "num" },
          ],
          top.map((x, i) => ({
            rank: String(i + 1),
            name: `<span class="name">${esc(x.name)}</span>`,
            pts: fmtPts(x.sum),
            _sort: { rank: i + 1, name: normalizeName(x.name), pts: x.sum },
          })),
          "compact"
        )
      : '<p class="sub">Keine VS-Opponent-Daten.</p>');

  const weakBody =
    '<p class="sub">Niedrigste Punkte — mögliche schwache Slots</p>' +
    (bottom.length
      ? memberTable(
          [
            { key: "rank", label: "#" },
            { key: "name", label: "Name" },
            { key: "pts", label: "Punkte", class: "num" },
          ],
          bottom.map((x, i) => ({
            rank: String(i + 1),
            name: `<span class="name">${esc(x.name)}</span>`,
            pts: fmtPts(x.sum),
            _sort: { rank: i + 1, name: normalizeName(x.name), pts: x.sum },
          })),
          "compact"
        )
      : '<p class="sub">Keine Daten.</p>');

  const analysis =
    `<div class="meta-grid">` +
    `<div class="meta-chip"><span class="k">Treffen diese Woche</span><span class="v">${meetings}</span></div>` +
    `<div class="meta-chip"><span class="k">DawN Summe</span><span class="v">${fmtPts(dawnSum)}</span></div>` +
    `<div class="meta-chip"><span class="k">Gegner Summe</span><span class="v">${fmtPts(oppSum)}</span></div>` +
    `<div class="meta-chip"><span class="k">Δ</span><span class="v">${fmtPts(delta)}</span></div>` +
    `<div class="meta-chip"><span class="k">Gegner-Spieler</span><span class="v">${scored.length}</span></div>` +
    `<div class="meta-chip"><span class="k">Median Gegner</span><span class="v">${fmtPts(median)}</span></div>` +
    (topShare != null
      ? `<div class="meta-chip"><span class="k">Top-5-Anteil</span><span class="v">${fmtPct(
          topShare
        )}</span></div>`
      : "") +
    `</div>` +
    `<p class="sub">Mehrfach-Treffen: sobald mehrere VS-Tage / Wiederholungen vorliegen, werden Stärken·Schwächen hier verdichtet. Allianz-Tag folgt, sobald Capture ihn liefert.</p>`;

  el.innerHTML =
    '<section class="panel glass"><h2>Gegner</h2>' +
    `<p class="lead">${esc(weekLabel)} · Wochenlage gegen die aktuelle Gegner-Allianz</p>` +
    analysis +
    "<h3>Tage</h3>" +
    (dayRows.length
      ? memberTable(dayCols, dayRows, "compact")
      : '<p class="sub">Noch keine VS-Compare-Tage.</p>') +
    '<div class="widget-grid" style="margin-top:16px">' +
    `<article class="widget span-6 glass"><h3>Stärken</h3>${strengthBody}</article>` +
    `<article class="widget span-6 glass"><h3>Schwächen</h3>${weakBody}</article>` +
    "</div></section>";
}

function killsTrendBadge(m) {
  const t = String(m.kills_trend || "");
  if (t === "up") return '<span class="badge ok" title="gestiegen">↑</span>';
  if (t === "flat") return '<span class="badge off" title="gleichbleibend">→</span>';
  return '<span class="badge off" title="noch kein Vergleich">·</span>';
}

function killsSteepLabel(m) {
  const s = String(m.kills_steep || "");
  if (s === "steep") return '<span class="badge ok">steil</span>';
  if (s === "mild") return '<span class="badge warn">mittel</span>';
  if (s === "flat") {
    if (String(m.kills_trend) === "up") return '<span class="badge off">flach</span>';
    return '<span class="badge off">—</span>';
  }
  return "—";
}

function killsDeltaCell(m) {
  const d = m.kills_delta;
  if (d == null || Number.isNaN(Number(d))) return "—";
  const n = Number(d);
  if (n > 0) return `+${fmtPts(n)}`;
  return "±0";
}

function renderKills(el) {
  const cols = [
    { key: "role", label: "Rolle" },
    { key: "name", label: "Name" },
    { key: "stand", label: "Kills", class: "num" },
    { key: "delta", label: "Δ", class: "num" },
    { key: "trend", label: "Tendenz", sortType: "num" },
    { key: "steep", label: "Anstieg", sortType: "num" },
  ];
  const rows = sortedMembers(
    (a, b) => (Number(b.kills_abs) || 0) - (Number(a.kills_abs) || 0),
    "kills"
  ).map((m) => ({
    _inactive: !m.active,
    role: esc(m.role),
    name: `<span class="name">${esc(m.name)}</span>`,
    stand: m.kills_abs != null ? fmtPts(m.kills_abs) : "—",
    delta: killsDeltaCell(m),
    trend: killsTrendBadge(m),
    steep: killsSteepLabel(m),
    _sort: {
      role: m.role || "",
      name: normalizeName(m.name),
      stand: m.kills_abs != null ? Number(m.kills_abs) : null,
      delta: m.kills_delta != null ? Number(m.kills_delta) : null,
      trend: trendSortRank(m.kills_trend),
      steep: steepSortRank(m.kills_steep),
    },
  }));
  const lead = killsCompareReady()
    ? "Δ / Tendenz / Anstieg · Header sortieren · Filter oben"
    : "Spalten Δ / Tendenz / Anstieg bereit — Werte ab 2. KW-Spalte · Header sortieren";
  el.innerHTML =
    '<section class="panel glass"><h2>Kills</h2>' +
    `<p class="lead">${esc(lead)}</p>` +
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
  const rows = sortedMembers((a, b) => donationMetric(b) - donationMetric(a), "donations").map(
    (m) => ({
      _inactive: !m.active,
      role: esc(m.role),
      name: `<span class="name">${esc(m.name)}</span>`,
      donations: fmtNum(donationMetric(m)),
      activity: esc(m.activity_display || fmtPct(m.activity)),
      _sort: {
        role: m.role || "",
        name: normalizeName(m.name),
        donations: donationMetric(m),
        activity: m.activity != null ? Number(m.activity) : null,
      },
    })
  );
  const donDate = sheetLatestDateLabel("donations");
  el.innerHTML =
    '<section class="panel glass"><h2>Donations</h2>' +
    `<p class="lead">${
      donDate
        ? esc(`Erfasst bis ${donDate} · weitere Tage folgen · Header sortieren`)
        : "Noch keine Spenden-Spalten · Header sortieren"
    }</p>` +
    (block ? matrixTable(block, { view: "donations" }) : "") +
    "<h3>Mitglieder</h3>" +
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
    { key: "vs", label: "VS Flag", sortType: "num" },
  ];
  const rows = sortedMembers((a, b) => {
    const wa = memberVsWeekSum(a, dayLabs);
    const wb = memberVsWeekSum(b, dayLabs);
    return (wb == null ? -1 : wb) - (wa == null ? -1 : wa);
  }, "vs").map((m) => {
    const weekSum = memberVsWeekSum(m, dayLabs);
    const sort = {
      role: m.role || "",
      name: normalizeName(m.name),
      week_sum: weekSum,
      vs: vsFlagSortRank(m.vs_flag),
    };
    const out = {
      _inactive: !m.active,
      role: esc(m.role),
      name: `<span class="name">${esc(m.name)}</span>`,
      week_sum: fmtPts(weekSum),
      vs: vsBadge(m.vs_flag),
      _sort: sort,
    };
    for (const lab of dayLabs) {
      const pts = memberVsDayPoints(m, lab);
      out["d_" + lab] = fmtPts(pts);
      sort["d_" + lab] = pts;
    }
    return out;
  });
  const vsDate = sheetLatestDateLabel("vs");
  const dayNote = vsDate
    ? `Bisher ${vsDate}${dayLabs.length === 1 ? " (1 Tag)" : ` · ${dayLabs.length} Tage`} · weitere folgen`
    : "Noch keine VS-Tage";
  // VS tab: quote + day compare (no burn-up) + day columns + Wochensumme + Flag. No Champion / Activity.
  el.innerHTML =
    '<section class="panel glass"><h2>VS</h2>' +
    `<p class="lead">${esc(vsTabLead())}</p>` +
    `<p class="ops-stand">${esc(dayNote)}</p>` +
    renderVsMetaSummary() +
    (compareDays ? renderVsCompareDays(compareDays, { includeBurnup: false }) : "") +
    "<h3>Mitglieder</h3>" +
    '<p class="sub">Tagespunkte · Wochensumme · Flag · Header sortieren · Filter oben</p>' +
    memberTable(cols, rows) +
    "</section>";
}

function renderMasterTable(block, title, view) {
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
  const allowed = filteredNameSet(view || "events");
  const rows = block.rows
    .filter((r) => allowed.has(normalizeName(r.name)))
    .map((r) => {
      const thpNum = r.thp != null && r.thp !== "" ? Number(r.thp) : null;
      return {
        role: esc(r.role),
        name: `<span class="name">${esc(r.name)}</span>`,
        thp: esc(r.thp_display || fmtNum(r.thp)),
        team: esc(r.preferred_team || "—"),
        slot: esc(r.preferred_slot || "—"),
        registered: esc(
          r.registered_display || (r.registered === true ? "Yes" : r.registered === false ? "No" : "—")
        ),
        played: esc(r.played_display || (r.played === true ? "Yes" : r.played === false ? "No" : "—")),
        comment: esc(r.comment || "—"),
        _sort: {
          role: r.role || "",
          name: normalizeName(r.name),
          thp: Number.isFinite(thpNum) ? thpNum : null,
          team: r.preferred_team || "",
          slot: r.preferred_slot || "",
          registered: r.registered === true ? 1 : r.registered === false ? 0 : -1,
          played: r.played === true ? 1 : r.played === false ? 0 : -1,
          comment: r.comment || "",
        },
      };
    });
  if (!rows.length) return "";
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
      _sort: {
        name: normalizeName(e.name),
        level: e.level || "",
        result: e.result || "",
        max: e.max_participation || "",
        notes: e.notes || "",
      },
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
    const allowed = filteredNameSet("events");
    const rows = eventsBlock.members
      .filter((r) => allowed.has(normalizeName(r.name)))
      .map((r) => {
        const levelNum = r.trial_level != null && r.trial_level !== "" ? Number(r.trial_level) : null;
        const dmgRaw = String(r.damage || "").replace(/[^\d.-]/g, "");
        const dmgNum = dmgRaw ? Number(dmgRaw) : null;
        return {
          name: `<span class="name">${esc(r.name)}</span>`,
          difficulty: esc(r.difficulty || "—"),
          level: esc(r.trial_level || "—"),
          damage: esc(r.damage || "—"),
          _sort: {
            name: normalizeName(r.name),
            difficulty: r.difficulty || "",
            level: Number.isFinite(levelNum) ? levelNum : null,
            damage: Number.isFinite(dmgNum) ? dmgNum : null,
          },
        };
      });
    if (rows.length) {
      trialHtml =
        "<h3>Generals Trial · Teilnehmer (Events-Sheet)</h3>" + memberTable(cols, rows, "compact");
    }
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
  const rows = sortedMembers(
    (a, b) => String(a.name).localeCompare(String(b.name), "de"),
    "events"
  ).map((m) => {
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
      _sort: {
        role: m.role || "",
        name: normalizeName(m.name),
        events: m.events || "",
        ds: ds.registered === true ? 1 : ds.registered === false ? 0 : -1,
        cs: cs.registered === true ? 1 : cs.registered === false ? 0 : -1,
        trial: gt.level || "",
        team_ds: [ds.preferred_team, ds.preferred_slot].filter(Boolean).join(" "),
        team_cs: [cs.preferred_team, cs.preferred_slot].filter(Boolean).join(" "),
      },
    };
  });

  el.innerHTML =
    '<section class="panel glass"><h2>Events · DS / CS</h2>' +
    '<p class="lead">Dashboard-Spalten Events / DS / CS plus Master-Tabs und Generals-Trial aus dem Events-Sheet.</p>' +
    (chips ? `<div class="meta-grid">${chips}</div>` : "") +
    catalogHtml +
    trialHtml +
    renderMasterTable(dsBlock, "DS - Master", "events") +
    renderMasterTable(csBlock, "CS - Master", "events") +
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
  const rows = sortedMembers(
    (a, b) => (b.season_activity ?? 0) - (a.season_activity ?? 0),
    "season"
  ).map((m) => {
    const sort = {
      role: m.role || "",
      name: normalizeName(m.name),
      season: m.season_activity != null ? Number(m.season_activity) : null,
    };
    const out = {
      _inactive: !m.active,
      role: esc(m.role),
      name: `<span class="name">${esc(m.name)}</span>`,
      season: esc(m.season_display || fmtPct(m.season_activity)),
      _sort: sort,
    };
    for (const c of SEASON_CATS) {
      out["s_" + c.key] = seasonCatCell(m, c.key);
      sort["s_" + c.key] = memberSeasonPts(m, c.key);
    }
    return out;
  });
  // Season tab: four Sheet categories + Season Activity only. No CS/DS/Events/Activity.
  el.innerHTML =
    '<section class="panel glass"><h2>Season</h2>' +
    `<p class="lead">${
      hasPts
        ? "Assistance · Clean Up · Conquest · Defeat · Season %"
        : "Saison noch ohne Beiträge — Tabelle bereit, Spalten füllen sich mit den Sheet-Tabs"
    }</p>` +
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
    { key: "vs", label: "VS", sortType: "num" },
  ];
  const rows = sortedMembers((a, b) => (b.activity ?? 0) - (a.activity ?? 0), "activity").map(
    (m) => ({
      _inactive: !m.active,
      role: esc(m.role),
      name: `<span class="name">${esc(m.name)}</span>`,
      activity: esc(m.activity_display || fmtPct(m.activity)),
      kills: esc(m.kills || "—"),
      donations: fmtNum(m.donations),
      season: esc(m.season_display || fmtPct(m.season_activity)),
      vs: vsBadge(m.vs_flag),
      _sort: {
        role: m.role || "",
        name: normalizeName(m.name),
        activity: m.activity != null ? Number(m.activity) : null,
        kills: m.kills_abs != null ? Number(m.kills_abs) : null,
        donations: m.donations != null ? Number(m.donations) : null,
        season: m.season_activity != null ? Number(m.season_activity) : null,
        vs: vsFlagSortRank(m.vs_flag),
      },
    })
  );
  el.innerHTML =
    '<section class="panel glass"><h2>Activity Score</h2>' +
    '<p class="lead">Gewichteter Score aus dem Dashboard-Sheet (Kills, Spende, Season, VS + R4/R5-Bonus).</p>' +
    '<p class="sub">Header anklicken zum Sortieren · Filter oben</p>' +
    memberTable(cols, rows) +
    "</section>";
}

function championsFromEntry(entry) {
  if (entry && Array.isArray(entry.champions) && entry.champions.length) {
    return entry.champions.map(normalizeChampionRule);
  }
  if (entry && entry.champion) return [normalizeChampionRule(entry.champion)];
  return [{ type: "max_score" }];
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
  const champions = championsFromEntry(entry);
  return { year, week, mode, elevatedMin, champions };
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

function syncChampRuleType(card) {
  const type = card.querySelector(".cfg-champ-type").value;
  for (const block of card.querySelectorAll("[data-champ-type]")) {
    block.hidden = block.getAttribute("data-champ-type") !== type;
  }
}

function collectChampionsFromForm(el) {
  const cards = [...el.querySelectorAll("[data-champ-rule]")];
  if (!cards.length) throw new Error("Mindestens eine Champion-Regel");
  return cards.map((card, i) => {
    const type = card.querySelector(".cfg-champ-type").value;
    if (type === "day_min") {
      const dayMin = parsePointsInput(card.querySelector(".cfg-champ-day-min").value);
      if (!dayMin) throw new Error(`Regel ${i + 1}: Tagesminimum erforderlich`);
      return { type: "day_min", day_min: dayMin };
    }
    if (type === "save_exact_and_closest") {
      const dayTarget =
        parsePointsInput(card.querySelector(".cfg-champ-day-target").value) || VS_SAVE_MIN;
      const weekDays = [...card.querySelectorAll('input[name^="cfgChampWeekDay"]:checked')].map(
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
      const title = card.querySelector(".cfg-champ-title").value.trim();
      if (!title) throw new Error(`Regel ${i + 1}: Titel erforderlich (z. B. Bestes Outfit)`);
      const winners = [...card.querySelectorAll(".cfg-champ-winner:checked")].map((cb) => cb.value);
      const note = (card.querySelector(".cfg-champ-note")?.value || "").trim();
      const out = { type: "manual", title, winners };
      if (note) out.note = note;
      return out;
    }
    return { type: "max_score" };
  });
}

function renderChampRuleCardHtml(rule, idx, rosterNames) {
  const r = rule || { type: "max_score" };
  const type = r.type || "max_score";
  const dayChecks = ["mon", "tue", "wed", "thu", "fri", "sat"]
    .map((d) => {
      const checked = (r.week_days || ["mon", "tue", "wed", "thu"]).includes(d) ? " checked" : "";
      return (
        `<label class="cfg-day-check"><input type="checkbox" name="cfgChampWeekDay${idx}" value="${d}"${checked}>` +
        `${CHAMPION_DAY_LABEL_DE[d]}</label>`
      );
    })
    .join("");
  const selected = new Set(r.winners || []);
  const rosterHtml = rosterNames
    .map((name) => {
      const checked = selected.has(name) ? " checked" : "";
      return (
        `<label class="cfg-roster-check"><input type="checkbox" class="cfg-champ-winner" value="${esc(
          name
        )}"${checked}>${esc(name)}</label>`
      );
    })
    .join("");
  return (
    `<div class="cfg-champ-rule" data-champ-rule="${idx}">` +
    `<div class="cfg-champ-rule-head">` +
    `<strong>Regel ${idx + 1}</strong>` +
    `<button type="button" class="btn-ghost cfg-champ-remove" data-remove="${idx}">Entfernen</button>` +
    `</div>` +
    "<div><label>Typ</label>" +
    `<select class="cfg-champ-type">` +
    `<option value="max_score"${type === "max_score" ? " selected" : ""}>Höchste Punkte</option>` +
    `<option value="day_min"${type === "day_min" ? " selected" : ""}>Tagesminimum</option>` +
    `<option value="save_exact_and_closest"${
      type === "save_exact_and_closest" ? " selected" : ""
    }>Exact + nächste Summe</option>` +
    `<option value="manual"${type === "manual" ? " selected" : ""}>Nicht messbar (Outfit / Custom)</option>` +
    `</select></div>` +
    `<div data-champ-type="day_min"${type === "day_min" ? "" : " hidden"}>` +
    "<div><label>Tagesminimum</label>" +
    `<input class="cfg-champ-day-min" type="text" inputmode="numeric" placeholder="z. B. 7.2M" value="${esc(
      formatPointsInputValue(r.day_min)
    )}"></div></div>` +
    `<div data-champ-type="save_exact_and_closest"${
      type === "save_exact_and_closest" ? "" : " hidden"
    }>` +
    "<div><label>Tagesziel (Exact)</label>" +
    `<input class="cfg-champ-day-target" type="text" inputmode="numeric" placeholder="7200000" value="${esc(
      formatPointsInputValue(r.day_target) || "7.2M"
    )}"></div>` +
    '<p class="config-hint">Wochentage für Summe:</p>' +
    `<div class="cfg-day-row">${dayChecks}</div></div>` +
    `<div data-champ-type="manual"${type === "manual" ? "" : " hidden"}>` +
    "<div><label>Titel</label>" +
    `<input class="cfg-champ-title" type="text" placeholder="z. B. Bestes Outfit" value="${esc(
      r.title || ""
    )}"></div>` +
    '<p class="config-hint">Gewinner aus Active-Roster (nur Auswahl wird angezeigt):</p>' +
    `<div class="cfg-roster-grid">${rosterHtml || '<p class="sub">Kein Active-Roster geladen.</p>'}</div>` +
    "<div><label>Notiz (optional)</label>" +
    `<input class="cfg-champ-note" type="text" placeholder="optional" value="${esc(
      r.note || ""
    )}"></div></div>` +
    `</div>`
  );
}

function bindConfigForm(el, draft) {
  el.querySelector("#cfgMode").value = draft.mode;
  syncConfigModeBlocks(el);
  el.querySelector("#cfgMode").addEventListener("change", () => syncConfigModeBlocks(el));

  const list = el.querySelector("#cfgChampList");
  const rosterNames = activeRosterNames();

  const rebindRuleCards = () => {
    list.querySelectorAll("[data-champ-rule]").forEach((card) => {
      const sel = card.querySelector(".cfg-champ-type");
      if (sel && !sel.dataset.bound) {
        sel.dataset.bound = "1";
        sel.addEventListener("change", () => syncChampRuleType(card));
      }
      syncChampRuleType(card);
    });
    list.querySelectorAll(".cfg-champ-remove").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        const cards = list.querySelectorAll("[data-champ-rule]");
        if (cards.length <= 1) {
          showToast("Mindestens eine Regel behalten.", true);
          return;
        }
        btn.closest("[data-champ-rule]")?.remove();
        list.querySelectorAll("[data-champ-rule]").forEach((card, i) => {
          card.setAttribute("data-champ-rule", String(i));
          const head = card.querySelector(".cfg-champ-rule-head strong");
          if (head) head.textContent = `Regel ${i + 1}`;
        });
      });
    });
  };

  rebindRuleCards();

  el.querySelector("#cfgChampAddPoints")?.addEventListener("click", () => {
    const idx = list.querySelectorAll("[data-champ-rule]").length;
    list.insertAdjacentHTML(
      "beforeend",
      renderChampRuleCardHtml({ type: "max_score" }, idx, rosterNames)
    );
    rebindRuleCards();
  });
  el.querySelector("#cfgChampAddManual")?.addEventListener("click", () => {
    const idx = list.querySelectorAll("[data-champ-rule]").length;
    list.insertAdjacentHTML(
      "beforeend",
      renderChampRuleCardHtml({ type: "manual", title: "", winners: [] }, idx, rosterNames)
    );
    rebindRuleCards();
  });

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
      const champions = collectChampionsFromForm(el);
      const json = await postImportantLinksConfig({
        kind: "vs-week",
        year: draft.year,
        week: draft.week,
        mode,
        max: maxRaw,
        champions,
        champion: champions[0],
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
  const champions =
    Array.isArray(draft.champions) && draft.champions.length
      ? draft.champions
      : [{ type: "max_score" }];
  const rosterNames = activeRosterNames();
  const rulesHtml = champions
    .map((rule, i) => renderChampRuleCardHtml(rule, i, rosterNames))
    .join("");
  el.innerHTML =
    '<section class="panel glass"><h2>VS-Woche</h2>' +
    (loadError
      ? `<p class="config-status config-status-error">${esc(loadError)}</p>`
      : "") +
    '<form class="config-form" id="cfgForm">' +
    `<p class="config-week-label">Aktuelle Woche: <strong>${esc(weekLabel)}</strong></p>` +
    "<div><label for=\"cfgMode\">Modus</label>" +
    `<select id="cfgMode" name="mode"><option value="push">Push (ganze Woche)</option><option value="save">Save (Mo–Do)</option></select></div>` +
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
    '<p class="config-hint">Mehrere Regeln möglich: messbar (VS) und/oder nicht messbar (Outfit) mit Roster-Auswahl.</p>' +
    `<div id="cfgChampList">${rulesHtml}</div>` +
    '<div class="btn-row cfg-champ-add-row">' +
    '<button type="button" class="btn-ghost" id="cfgChampAddPoints">+ Punkte-Regel</button>' +
    '<button type="button" class="btn-ghost" id="cfgChampAddManual">+ Nicht messbar</button>' +
    "</div></fieldset>" +
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
    renderFilterBar();
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
