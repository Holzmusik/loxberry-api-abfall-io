import fs from "node:fs";
import { log } from "./logger.js";
import { isNoCollectionDatesError } from "./errors.js";
import { publishWasteData, safeTopicSegment } from "./mqtt-publisher.js";
import { readMergedCronInstallProbe, resolvePaths } from "./paths.js";
import { foldForSearch } from "./fold-for-search.js";
import {
  fetchHausmuellIcs,
  hausmuellLocationLabel,
  isHausmuellAddressComplete,
  isValidSubdomain,
  providerTitle,
} from "./hausmuell-service.js";
import {
  fetchMuellabfuhr,
  isMuellabfuhrAddressComplete,
  isValidMandatorId,
  muellabfuhrLocationLabel,
} from "./muellabfuhr-service.js";
import { awidoLocationLabel, customerTitle, fetchAwido, isAwidoAddressComplete, isValidCustomer } from "./awido-service.js";
import { fetchOffizium, findInstance, isOffiziumAddressComplete, offiziumLocationLabel } from "./offizium-service.js";
import { cascadeLabel, isCascadeComplete, legacyFetchIcs, v3FetchIcs } from "./abfallio-cascade.js";
import { getServiceMapSourceInfo, loadServiceMap, titleForServiceKey } from "./service-map.js";
import type {
  ApiStatus,
  FetchStatus,
  LocationConfig,
  MqttPublishStatus,
  PluginConfig,
  ProviderId,
  SearchItem,
  WasteData,
  WasteEntry,
} from "./types.js";

const DEFAULT_FETCH_INTERVAL_HOURS = 6;
const DEFAULT_FETCH_FUZZ_MINUTES = 30;
/** Enforced server-friendly minimum: users cannot poll the upstream more often than this (UI + config). */
export const MIN_FETCH_INTERVAL_HOURS = 6;

const API_URL = "https://api.abfall.io";

/**
 * 32-hex abfall.io service key; empty if the user has not set a region yet (no built-in default).
 */
export function configuredServiceKey(cfg: PluginConfig): string {
  return (cfg.service_key ?? "").trim().toLowerCase();
}

function normalizedFetchIntervalHours(h: number | undefined): number {
  const v = h ?? DEFAULT_FETCH_INTERVAL_HOURS;
  return Math.max(MIN_FETCH_INTERVAL_HOURS, Math.min(168, v));
}
const MODUS_KEY = "d6c5855a62cf32a4dadbc2831f0f295f";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0";

function getPaths() {
  return resolvePaths();
}

export function loadConfig(): PluginConfig {
  const { configFile } = getPaths();
  if (!fs.existsSync(configFile)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configFile, "utf-8")) as PluginConfig;
}

export function saveConfig(cfg: PluginConfig): void {
  const { configFile, configDir } = getPaths();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf-8");
}

async function apiPost(
  params: Record<string, string>,
  data: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<{ text: string; status: number }> {
  const url = `${API_URL}?${new URLSearchParams(params).toString()}`;
  const body = new URLSearchParams(data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
    return { text: await response.text(), status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const regex = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  const nameRegex = /name=["']([^"']+)["']/i;
  const valueRegex = /value=["']([^"']*)["']/i;
  for (const tag of html.match(regex) ?? []) {
    const nameMatch = tag.match(nameRegex);
    if (!nameMatch) continue;
    const valueMatch = tag.match(valueRegex);
    fields[nameMatch[1]] = valueMatch ? valueMatch[1] : "";
  }
  return fields;
}

export function extractStreetOptions(html: string): SearchItem[] {
  const selectMatch = html.match(/<select[^>]*name=["'][^"']*f_id_strasse[^"']*["'][^>]*>([\s\S]*?)<\/select>/i);
  const content = selectMatch ? selectMatch[1] : html;
  const optionRegex = /<option[^>]*value=["']([^"']+)["'][^>]*>([^<]*)<\/option>/gi;
  const out: SearchItem[] = [];
  let match: RegExpExecArray | null = optionRegex.exec(content);
  while (match) {
    const id = match[1].trim();
    const name = match[2].trim();
    if (id && id !== "0" && name) {
      out.push({ id, name });
    }
    match = optionRegex.exec(content);
  }
  return out;
}

export { foldForSearch };

async function initSession(key: string): Promise<{ hiddenFields: Record<string, string>; html: string }> {
  const { text, status } = await apiPost({
    key,
    modus: MODUS_KEY,
    waction: "init",
  });
  if (status !== 200) {
    throw new Error(`API init failed with status ${status}`);
  }
  const hiddenFields = extractHiddenFields(text);
  log.info(`API init: ${Object.keys(hiddenFields).length} hidden fields, ${text.length} chars`);
  return { hiddenFields, html: text };
}

export type ServiceKeyRequiredError = { error: "service_key_required" };

export async function searchStreet(
  query: string,
  config = loadConfig(),
): Promise<SearchItem[] | ServiceKeyRequiredError> {
  const key = configuredServiceKey(config);
  if (!key) {
    return { error: "service_key_required" };
  }
  const { html } = await initSession(key);
  const options = extractStreetOptions(html);
  const q = foldForSearch(query);
  const results = options.filter((street) => foldForSearch(street.name).includes(q));
  log.info(`Street search '${query}': ${results.length} results from ${options.length} total`);
  return results;
}

export async function searchHnr(
  streetId: string,
  config = loadConfig(),
): Promise<SearchItem[] | ServiceKeyRequiredError> {
  const key = configuredServiceKey(config);
  if (!key) {
    return { error: "service_key_required" };
  }
  const { hiddenFields } = await initSession(key);
  try {
    const { text, status } = await apiPost(
      { key, modus: MODUS_KEY, waction: "street_hnr" },
      { ...hiddenFields, f_id_strasse: streetId },
    );
    if (status === 200 && text.trim()) {
      const optionRegex = /<option[^>]*value=["']([^"']+)["'][^>]*>([^<]+)/gi;
      const results: SearchItem[] = [];
      let match: RegExpExecArray | null = optionRegex.exec(text);
      while (match) {
        const id = match[1].trim();
        const name = match[2].trim();
        if (id && id !== "0") {
          results.push({ id, name });
        }
        match = optionRegex.exec(text);
      }
      if (results.length > 0) {
        log.info(`HNR for street ${streetId}: ${results.length} options`);
        return results;
      }
    }
  } catch (err) {
    log.debug(`HNR lookup failed: ${String(err)}`);
  }
  return [{ id: "__not_needed__", name: "House number selection not required" }];
}

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_DE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

/** ISO-8601 weekday: Monday = 1 … Sunday = 7. */
function isoWeekdayMon1ToSun7(d: Date): number {
  const dow = d.getDay();
  return dow === 0 ? 7 : dow;
}

function localizedWeekdayName(lang: string | undefined, d: Date): string {
  const l = (lang || "en").toLowerCase();
  if (l.startsWith("de")) {
    return WEEKDAYS_DE[d.getDay()] ?? "";
  }
  return WEEKDAYS_EN[d.getDay()] ?? "";
}

export interface ParseIcsOptions {
  /** Plugin language, e.g. "de" or "en" (from config). Affects weekday names only. */
  language?: string;
  /** Reference time for "days until" (default: now). */
  now?: Date;
}

/**
 * ICS DTSTART value → local calendar day. Accepts `YYYYMMDD` (all-day, abfall.io) and
 * `YYYYMMDDTHHMMSS[Z]` (timed events, e.g. hausmuell.info: `20261202T050000Z`).
 * UTC times are converted to the local day first.
 */
export function parseIcsDate(dateStr: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(dateStr);
  if (!m) {
    return null;
  }
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (hh !== undefined && z) {
    const utc = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss ?? 0)));
    return new Date(utc.getFullYear(), utc.getMonth(), utc.getDate());
  }
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

/**
 * Whole calendar days from `from` to `to` (local dates). Counted on the calendar date parts,
 * so DST days with 23 h / 25 h do not shift the result (plain ms / 86 400 000 is one day short
 * across the switch to summer time).
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** Local calendar day as `YYYY-MM-DD`. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` (cache) or `DD.MM.YYYY` (`datum`) → local midnight; null if malformed. */
export function parseDay(s: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const de = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (de) return new Date(Number(de[3]), Number(de[2]) - 1, Number(de[1]));
  return null;
}

/** Category key used everywhere (cache, filter, MQTT) for an ICS SUMMARY. */
function categoryKey(summary: string): string {
  return summary.replace(/[^a-zA-ZäöüÄÖÜß0-9 -]/g, "").trim();
}

/**
 * All collection days per category from an ICS text, as sorted unique `YYYY-MM-DD` lists.
 * Days before `now` (local date) are dropped.
 */
export function collectIcsDates(icsText: string, now: Date = new Date()): Record<string, string[]> {
  const today = isoDay(now);
  const sets: Record<string, Set<string>> = {};
  let currentSummary = "";
  let currentDate: Date | null = null;

  for (const lineRaw of icsText.split("\n")) {
    const line = lineRaw.trim();
    if (line.startsWith("SUMMARY:")) {
      currentSummary = line.slice(8).trim();
    } else if (line.startsWith("DTSTART")) {
      const dateStr = line.split(":").at(-1)?.trim() ?? "";
      currentDate = parseIcsDate(dateStr);
    } else if (line === "END:VEVENT") {
      if (currentSummary && currentDate) {
        const day = isoDay(currentDate);
        const key = categoryKey(currentSummary);
        if (key && day >= today) {
          (sets[key] ??= new Set()).add(day);
        }
      }
      currentSummary = "";
      currentDate = null;
    }
  }
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Next collection per category relative to `now`, from a `collectIcsDates`-style map.
 * Expired days are dropped from the returned `upcoming`; categories without any upcoming
 * day are dropped entirely. `termine` is sorted by days ascending.
 */
export function buildTermine(
  upcoming: Record<string, string[]>,
  now: Date = new Date(),
  language?: string,
): { termine: Record<string, WasteEntry>; upcoming: Record<string, string[]> } {
  const today = isoDay(now);
  const pruned: Record<string, string[]> = {};
  const entries: [string, WasteEntry][] = [];
  for (const [name, days] of Object.entries(upcoming)) {
    const future = [...new Set(days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today))].sort();
    if (future.length === 0) continue;
    pruned[name] = future;
    const date = parseDay(future[0])!;
    entries.push([
      name,
      {
        tage: calendarDaysBetween(now, date),
        datum: `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`,
        wochentag: localizedWeekdayName(language, date),
        wochentag_num: isoWeekdayMon1ToSun7(date),
      },
    ]);
  }
  entries.sort((a, b) => a[1].tage - b[1].tage);
  return { termine: Object.fromEntries(entries), upcoming: pruned };
}

export function parseIcs(icsText: string, options?: ParseIcsOptions): Record<string, WasteEntry> {
  const now = options?.now ?? new Date();
  const { termine } = buildTermine(collectIcsDates(icsText, now), now, options?.language);
  log.info(`Parsed ICS: ${Object.keys(termine).length} upcoming categories`);
  return termine;
}

/**
 * If categories_filter in config is non-empty, only keep those category keys
 * (name match after {@link foldForSearch}; empty / missing filter = all).
 */
export function pickFilteredTermine<T>(
  termine: Record<string, T>,
  filter: string[] | undefined,
): Record<string, T> {
  if (!filter || filter.length === 0) {
    return termine;
  }
  const want = new Set(
    filter.map((s) => foldForSearch(s)).filter((s) => s.length > 0),
  );
  return Object.fromEntries(
    Object.entries(termine).filter(([name]) => want.has(foldForSearch(name))),
  );
}

function nowTimestamp(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function inferKommuneFromStreetId(streetId: string): string {
  const match = /^(\d+)/.exec(streetId);
  return match ? match[1] : "";
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  abfallio: "api.abfall.io",
  hausmuell: "hausmuell.info",
  muellabfuhr: "muellabfuhr-deutschland.de",
  awido: "AWIDO (cubefour)",
  offizium: "Abfuhr-Wecker (offizium)",
};

/** Active upstream; configs written before the provider switch existed are abfall.io. */
export function activeProvider(cfg: PluginConfig): ProviderId {
  const p = cfg.provider;
  return p === "hausmuell" || p === "muellabfuhr" || p === "awido" || p === "offizium" ? p : "abfallio";
}

/** True once the chosen upstream has everything it needs to download a calendar. */
export function isLocationComplete(cfg: PluginConfig): boolean {
  switch (activeProvider(cfg)) {
    case "hausmuell":
      return isHausmuellAddressComplete(cfg.hausmuell);
    case "muellabfuhr":
      return isMuellabfuhrAddressComplete(cfg.muellabfuhr);
    case "awido":
      return isAwidoAddressComplete(cfg.awido);
    case "offizium":
      return isOffiziumAddressComplete(cfg.offizium);
    default:
      return configuredServiceKey(cfg) !== "" && isAbfallioAddressSaved(cfg.location);
  }
}

/** abfall.io address: stepped/v3 selection (since 1.6) or the original street-first one. */
function isAbfallioAddressSaved(loc: LocationConfig | undefined): boolean {
  if (!loc) return false;
  if (loc.api) return isCascadeComplete(loc);
  return !!loc.f_id_strasse;
}

/**
 * Download the calendar from the active upstream, cache it and publish it.
 * - Upstream has no dates (yet): cached with status `no_future_dates` – not an error.
 * - Any other failure: recorded in the cache (status `error`, retry backoff, still-upcoming
 *   cached dates recomputed and published with `ok` = 0), then rethrown.
 */
export async function fetchData(config = loadConfig()): Promise<WasteData> {
  try {
    switch (activeProvider(config)) {
      case "hausmuell":
        return await fetchHausmuellData(config);
      case "muellabfuhr":
        return await fetchMuellabfuhrData(config);
      case "awido":
        return await fetchAwidoData(config);
      case "offizium":
        return await fetchOffiziumData(config);
      default:
        return await fetchAbfallioData(config);
    }
  } catch (err) {
    if (isNoCollectionDatesError(err)) {
      log.warn(`${err.message} Treating as 'no_future_dates' (no error, regular fetch interval).`);
      return finalizeAndCache(config, "", locationLabel(config));
    }
    try {
      await recordFetchFailure(config, err);
    } catch (recordErr) {
      log.warn(`Could not record the fetch failure: ${String(recordErr)}`);
    }
    throw err;
  }
}

/** Human-readable address of the active upstream (same as shown on the Status tab). */
export function locationLabel(cfg: PluginConfig): string {
  switch (activeProvider(cfg)) {
    case "hausmuell":
      return hausmuellLocationLabel(cfg.hausmuell);
    case "muellabfuhr":
      return muellabfuhrLocationLabel(cfg.muellabfuhr ?? {});
    case "awido":
      return awidoLocationLabel(cfg.awido ?? {});
    case "offizium":
      return offiziumLocationLabel(cfg.offizium ?? {});
    default: {
      const loc = cfg.location ?? {};
      return loc.api ? cascadeLabel(loc) : `${loc.street_name ?? ""} ${loc.hnr_name ?? ""}`.trim();
    }
  }
}

async function fetchOffiziumData(config: PluginConfig): Promise<WasteData> {
  const of = config.offizium ?? {};
  if (!isOffiziumAddressComplete(of)) {
    throw new Error("No Abfuhr-Wecker address configured. On the Location tab, choose the district and your address.");
  }
  log.info(`Fetching data from offizium Abfuhr-Wecker: ${findInstance(of.instance)?.title} / ${offiziumLocationLabel(of)}`);
  const { ics } = await fetchOffizium(of);
  return finalizeAndCache(config, ics, offiziumLocationLabel(of));
}

async function fetchAwidoData(config: PluginConfig): Promise<WasteData> {
  const aw = config.awido ?? {};
  if (!isAwidoAddressComplete(aw)) {
    throw new Error("No AWIDO address configured. On the Location tab, choose the operator and select your address.");
  }
  log.info(`Fetching data from AWIDO: ${customerTitle(aw.customer)} / ${awidoLocationLabel(aw)}`);
  const { ics } = await fetchAwido(aw);
  return finalizeAndCache(config, ics, awidoLocationLabel(aw));
}

async function fetchMuellabfuhrData(config: PluginConfig): Promise<WasteData> {
  const mf = config.muellabfuhr ?? {};
  if (!isMuellabfuhrAddressComplete(mf)) {
    throw new Error(
      "No muellabfuhr-deutschland.de address configured. On the Location tab, choose the district and select your address.",
    );
  }
  log.info(`Fetching data from portal.muellabfuhr-deutschland.de: ${mf.mandator?.name} / ${muellabfuhrLocationLabel(mf)}`);
  const { ics, config: updated } = await fetchMuellabfuhr(mf);
  if ((updated.fraction_ids ?? []).join(",") !== (mf.fraction_ids ?? []).join(",")) {
    saveConfig({ ...loadConfig(), muellabfuhr: updated });
  }
  return finalizeAndCache(config, ics, muellabfuhrLocationLabel(mf));
}

async function fetchHausmuellData(config: PluginConfig): Promise<WasteData> {
  const hm = config.hausmuell ?? {};
  if (!isHausmuellAddressComplete(hm)) {
    throw new Error(
      "No hausmuell.info address configured. On the Location tab, choose the portal and select your address.",
    );
  }
  log.info(`Fetching ICS data from ${hm.subdomain}.hausmuell.info: egebiet=${hm.egebiet}`);
  const { ics, config: resolved } = await fetchHausmuellIcs(hm);
  if (resolved.egebiet !== hm.egebiet || resolved.zusatz_id !== hm.zusatz_id || resolved.strasse?.id !== hm.strasse?.id) {
    log.info(`hausmuell.info ids changed (egebiet ${hm.egebiet} -> ${resolved.egebiet}); saving updated address`);
    saveConfig({ ...loadConfig(), hausmuell: resolved });
  }
  return finalizeAndCache(config, ics, hausmuellLocationLabel(resolved));
}

async function fetchAbfallioData(config: PluginConfig): Promise<WasteData> {
  const loc = config.location ?? {};
  const key = configuredServiceKey(config);
  if (!key) {
    throw new Error(
      "No service key configured. In the admin UI, open Settings, choose your waste region (or enter the 32-character key), save, then set your address on the Location tab.",
    );
  }
  if (loc.api) {
    if (!isCascadeComplete(loc)) {
      throw new Error("No address configured. Please select your address on the Location tab.");
    }
    log.info(`Fetching abfall.io (${loc.api} API): ${cascadeLabel(loc)}`);
    const ics = loc.api === "v3" ? await v3FetchIcs(key, loc.house_id ?? "") : await legacyFetchIcs(key, loc);
    return finalizeAndCache(config, ics, cascadeLabel(loc));
  }
  let fIdKommune = loc.f_id_kommune ?? "";
  const fIdStrasse = loc.f_id_strasse ?? "";
  const fIdStrasseHnr = loc.f_id_strasse_hnr ?? "";

  if (!fIdStrasse) {
    throw new Error("No street configured. Please set up location first.");
  }
  if (!fIdKommune) {
    fIdKommune = inferKommuneFromStreetId(fIdStrasse);
    if (!fIdKommune) {
      throw new Error("No municipality ID configured. Please save a location that includes a municipality.");
    }
  }

  const { hiddenFields } = await initSession(key);
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
  const dateKey = (d: Date): string =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const args: Record<string, string> = {
    ...hiddenFields,
    f_id_kommune: fIdKommune,
    f_id_strasse: fIdStrasse,
    f_zeitraum: `${dateKey(now)}-${dateKey(oneYear)}`,
    f_abfallarten_index_max: "0",
    f_abfallarten: "",
  };
  if (fIdStrasseHnr && fIdStrasseHnr !== "__not_needed__") {
    args.f_id_strasse_hnr = fIdStrasseHnr;
  }

  log.info(`Fetching ICS data: kommune=${fIdKommune}, strasse=${fIdStrasse}, hnr=${fIdStrasseHnr || "(none)"}`);
  const { text, status } = await apiPost(
    { key, modus: MODUS_KEY, waction: "export_ics" },
    args,
  );
  if (status !== 200) {
    throw new Error(`ICS export failed with status ${status}`);
  }
  if (!text.includes("VCALENDAR")) {
    throw new Error(`Response is not ICS data: ${text.slice(0, 200)}`);
  }

  const streetName = loc.street_name ?? `Street ${fIdStrasse}`;
  const hnrName = loc.hnr_name ?? "";
  return finalizeAndCache(config, text, `${streetName} ${hnrName}`.trim());
}

/** Shared tail for every upstream: collect dates, apply filter, write cache, publish MQTT. */
async function finalizeAndCache(config: PluginConfig, text: string, location: string, now = new Date()): Promise<WasteData> {
  const previous = readCache();
  const rawUpcoming = collectIcsDates(text, now);
  let upcoming = pickFilteredTermine(rawUpcoming, config.categories_filter);
  const rawCount = Object.keys(rawUpcoming).length;
  if (Object.keys(upcoming).length === 0 && rawCount > 0) {
    log.warn(
      `Category filter excluded all ${rawCount} ICS categories; cache will be empty until the filter matches names in the feed.`,
    );
  }
  const status: FetchStatus = rawCount === 0 ? "no_future_dates" : "ok";
  if (status === "no_future_dates") {
    log.warn("Upstream delivered no upcoming collection dates (next year probably not published yet).");
    // Keep dates of the same address that are still ahead (portal glitch, partial year export).
    if (previous && previous.location === location) {
      const kept = pickFilteredTermine(cachedUpcoming(previous), config.categories_filter);
      const stillAhead = buildTermine(kept, now).upcoming;
      if (Object.keys(stillAhead).length > 0) {
        log.info(`Keeping ${Object.keys(stillAhead).length} cached categories that are still upcoming.`);
        upcoming = stillAhead;
      }
    }
  }
  const built = buildTermine(upcoming, now, config.language);

  const intervalHours = normalizedFetchIntervalHours(config.fetch_interval_hours);
  const fuzzMinutes = Math.max(0, config.fetch_fuzz_minutes ?? DEFAULT_FETCH_FUZZ_MINUTES);
  const offsetMinutes = fuzzMinutes === 0 ? 0 : Math.round((Math.random() * 2 - 1) * fuzzMinutes);
  const dueAt = new Date(now.getTime() + intervalHours * 3600 * 1000 + offsetMinutes * 60 * 1000);
  const ts = nowTimestamp(now);

  const result: WasteData = {
    timestamp: ts,
    standort: location,
    location,
    termine: built.termine,
    next_fetch_due: formatTimestamp(dueAt),
    next_fetch_offset_minutes: offsetMinutes,
    upcoming: built.upcoming,
    status,
    last_success_unix: Math.floor(now.getTime() / 1000),
    last_attempt: ts,
    failed_attempts: 0,
    recomputed_at: ts,
  };
  log.info(
    `Caching ${Object.keys(result.termine).length} categories (status ${status}), ` +
      `next due ${result.next_fetch_due} (offset ${offsetMinutes}min)`,
  );
  return writeCacheAndPublish(config, result, previous);
}

/** Parsed cache file, or null if missing / unreadable. */
function readCache(): WasteData | null {
  const { cacheFile } = getPaths();
  try {
    if (!fs.existsSync(cacheFile)) return null;
    const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as WasteData;
    return data && typeof data === "object" ? data : null;
  } catch (err) {
    log.warn(`Could not read cache ${cacheFile}: ${String(err)}`);
    return null;
  }
}

/** Upcoming days of a cache; caches from before `upcoming` existed only know the next day per category. */
function cachedUpcoming(data: Partial<WasteData>): Record<string, string[]> {
  if (data.upcoming && typeof data.upcoming === "object") return data.upcoming;
  const out: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(data.termine ?? {})) {
    const d = parseDay(entry?.datum ?? "");
    if (d) out[name] = [isoDay(d)];
  }
  return out;
}

async function writeCacheAndPublish(config: PluginConfig, data: WasteData, previous: WasteData | null): Promise<WasteData> {
  const { cacheFile, dataDir } = getPaths();
  fs.mkdirSync(dataDir, { recursive: true });
  const previousSlugs =
    previous?.mqtt?.category_slugs ?? Object.keys(previous?.termine ?? {}).map((n) => safeTopicSegment(n));
  delete data.mqtt;
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");
  log.info(`Data cached to ${cacheFile}`);
  if (config.mqtt?.enabled) {
    data.mqtt = await publishWasteData({ config: config.mqtt, data, previousSlugs });
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");
  }
  return data;
}

/**
 * Hourly run without an upstream request: recompute `days` from the cached dates (after midnight
 * they would otherwise be one too high until the next fetch), drop expired dates, and publish
 * when something changed or the last MQTT publish failed. Returns the (possibly updated) cache.
 */
export async function refreshCachedData(config = loadConfig(), now = new Date()): Promise<WasteData | null> {
  const cached = readCache();
  if (!cached || !cached.termine) return null;
  const source = pickFilteredTermine(cachedUpcoming(cached), config.categories_filter);
  const { termine, upcoming } = buildTermine(source, now, config.language);
  const changed = JSON.stringify(termine) !== JSON.stringify(cached.termine) || !cached.upcoming;
  const mqttRetry = !!config.mqtt?.enabled && cached.mqtt?.ok !== true;
  if (!changed && !mqttRetry) {
    return cached;
  }
  log.info(
    `Recomputing days from cache without upstream request (${Object.keys(termine).length} categories` +
      `${changed ? "" : ", unchanged - retrying MQTT publish"})`,
  );
  return writeCacheAndPublish(config, { ...cached, termine, upcoming, recomputed_at: nowTimestamp(now) }, cached);
}

/** Retry delay after `failures` consecutive failed fetches: 1 h, 2 h, 4 h, … capped at the fetch interval. */
export function retryBackoffHours(failures: number, intervalHours: number): number {
  return Math.min(intervalHours, 2 ** Math.max(0, failures - 1));
}

/**
 * Record a failed fetch: status `error`, attempt counter for the backoff, cached dates
 * recomputed for today and published (with `ok` = 0) so Loxone keeps correct days.
 */
export async function recordFetchFailure(config: PluginConfig, err: unknown, now = new Date()): Promise<WasteData> {
  const cached = readCache();
  const ts = nowTimestamp(now);
  const base: WasteData = cached ?? { timestamp: "", standort: "", location: locationLabel(config), termine: {} };
  const source = pickFilteredTermine(cachedUpcoming(base), config.categories_filter);
  const { termine, upcoming } = buildTermine(source, now, config.language);
  const failures = (base.status === "error" ? base.failed_attempts ?? 0 : 0) + 1;
  const retryH = retryBackoffHours(failures, normalizedFetchIntervalHours(config.fetch_interval_hours));
  const message = err instanceof Error ? err.message : String(err);
  log.warn(
    `Fetch failed (attempt ${failures}); serving ${Object.keys(termine).length} cached categories, next retry in ~${retryH} h`,
  );
  return writeCacheAndPublish(
    config,
    {
      ...base,
      termine,
      upcoming,
      status: "error",
      error: message.slice(0, 500),
      last_attempt: ts,
      failed_attempts: failures,
      recomputed_at: ts,
    },
    cached,
  );
}

function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function getStatus(): ApiStatus {
  const cfg = loadConfig();
  const loc = cfg.location ?? {};
  const { cacheFile } = getPaths();
  let cachedData: Partial<WasteData> | Record<string, never> = {};
  if (fs.existsSync(cacheFile)) {
    cachedData = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Partial<WasteData>;
  }
  const cached = cachedData as Partial<WasteData>;
  const mqttStatus: MqttPublishStatus = cached.mqtt ?? { ok: false, last: "" };

  const sm = getServiceMapSourceInfo();
  const provider = activeProvider(cfg);
  const key = configuredServiceKey(cfg);
  let has_region: boolean;
  let region_title: string;
  let has_street: boolean;
  let location: string;
  if (provider === "hausmuell") {
    const hm = cfg.hausmuell ?? {};
    has_region = isValidSubdomain(hm.subdomain);
    region_title = has_region ? providerTitle(hm.subdomain) : "";
    has_street = isHausmuellAddressComplete(hm);
    location = hausmuellLocationLabel(hm);
  } else if (provider === "muellabfuhr") {
    const mf = cfg.muellabfuhr ?? {};
    has_region = isValidMandatorId(mf.mandator?.id);
    region_title = has_region ? mf.mandator?.name || `#${mf.mandator?.id}` : "";
    has_street = isMuellabfuhrAddressComplete(mf);
    location = muellabfuhrLocationLabel(mf);
  } else if (provider === "awido") {
    const aw = cfg.awido ?? {};
    has_region = isValidCustomer(aw.customer);
    region_title = has_region ? customerTitle(aw.customer) : "";
    has_street = isAwidoAddressComplete(aw);
    location = awidoLocationLabel(aw);
  } else if (provider === "offizium") {
    const of = cfg.offizium ?? {};
    const inst = findInstance(of.instance);
    has_region = !!inst;
    region_title = inst?.title ?? "";
    has_street = isOffiziumAddressComplete(of);
    location = offiziumLocationLabel(of);
  } else {
    has_region = key.length > 0;
    const map = loadServiceMap();
    region_title = has_region ? titleForServiceKey(key, map) ?? `${key.slice(0, 8)}…` : "";
    has_street = isAbfallioAddressSaved(loc);
    location = loc.api ? cascadeLabel(loc) : `${loc.street_name ?? ""} ${loc.hnr_name ?? ""}`.trim();
  }
  return {
    cookie_status: "not_needed",
    cookie_created: "",
    cookie_expires: "",
    client_id: `(${PROVIDER_LABEL[provider]} - no registration)`,
    last_fetch: cached.timestamp ?? "",
    next_fetch_due: cached.next_fetch_due ?? "",
    location,
    has_region,
    region_title,
    has_street,
    location_api: cached.standort ?? "",
    termine_count: Object.keys(cached.termine ?? {}).length,
    cached_data: cachedData,
    /** Single upstream; value is for display. Schedules are fetched as an ICS calendar in the background. */
    api_mode: PROVIDER_LABEL[provider],
    mqtt: mqttStatus,
    install_cron: readMergedCronInstallProbe(),
    service_map: { source: sm.source, count: sm.count },
    service_key_configured: configuredServiceKey(cfg) !== "",
    provider,
  };
}

export function getLog(lines = 100): string {
  const { logFile } = getPaths();
  if (!fs.existsSync(logFile)) return "";
  const allLines = fs.readFileSync(logFile, "utf-8").split(/\r?\n/);
  return `${allLines.slice(-lines).join("\n")}\n`.trim();
}

export function clearLog(): void {
  const { logFile, logDir } = getPaths();
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logFile, "", "utf-8");
}

export function shouldFetch(config: PluginConfig, force: boolean, now: Date = new Date()): boolean {
  if (force) {
    return true;
  }
  if (!isLocationComplete(config)) {
    return false;
  }
  const { cacheFile } = getPaths();
  if (!fs.existsSync(cacheFile)) {
    return true;
  }
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Partial<WasteData>;
    const intervalHours = normalizedFetchIntervalHours(config.fetch_interval_hours);
    if (cached.status === "error" && cached.last_attempt) {
      const failures = cached.failed_attempts ?? 1;
      const backoffH = retryBackoffHours(failures, intervalHours);
      // 5 min slack: the hourly cron at :17 must not miss a retry that is due a few seconds later.
      const retryAt =
        new Date(cached.last_attempt.replace(" ", "T")).getTime() + backoffH * 3600 * 1000 - 5 * 60 * 1000;
      if (now.getTime() < retryAt) {
        log.info(`Skipping fetch: last attempt ${cached.last_attempt} failed (${failures}x), retry backoff ${backoffH}h`);
        return false;
      }
      return true;
    }
    const lastTs = cached.timestamp ?? "";
    if (!lastTs) return true;
    const lastDate = new Date(lastTs.replace(" ", "T"));
    const fuzzMinutes = Math.max(0, config.fetch_fuzz_minutes ?? DEFAULT_FETCH_FUZZ_MINUTES);
    const offsetMinutes = cached.next_fetch_offset_minutes ?? 0;
    const dueAt = new Date(
      lastDate.getTime() + intervalHours * 3600 * 1000 + offsetMinutes * 60 * 1000,
    );
    if (now.getTime() < dueAt.getTime()) {
      const minutesRemaining = Math.round((dueAt.getTime() - now.getTime()) / 60000);
      log.info(
        `Skipping fetch: last=${lastTs}, interval=${intervalHours}h, fuzz=±${fuzzMinutes}min, ` +
          `offset=${offsetMinutes}min, next due in ~${minutesRemaining} min`,
      );
      return false;
    }
  } catch {
    return true;
  }
  return true;
}
