/**
 * Second upstream: ATURIS "hausmuell.info" waste calendars (`https://<subdomain>.hausmuell.info/`).
 *
 * Address cascade (each step optional depending on the portal / municipality):
 *   Ort → Ortsteil → Straße → Hausnummer → (Zusatz)
 * Every search result may already carry the final "Entsorgungsgebiet" id (`egebiet`);
 * once it is known, the ICS export (`ics/ics.php`) returns the calendar for the address.
 *
 * Portals run different versions of the ATURIS frontend, so ids are read from the
 * `onClick='get_value("<level>", <id>[, <egebiet>])'` handler rather than fixed span
 * positions (same approach as the Home Assistant `hausmuell_info` source).
 */
import { foldForSearch } from "./fold-for-search.js";
import { log } from "./logger.js";
import type { HausmuellConfig, HausmuellPick } from "./types.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0";

export interface HausmuellProvider {
  subdomain: string;
  title: string;
  url: string;
}

/**
 * Portals verified to answer the standard `search/*.php` + `ics/ics.php` endpoints.
 * Not included: `asc` (ASR Chemnitz, different proxy-based flow), `erfurt` (moved off the platform).
 */
export const HAUSMUELL_PROVIDERS: HausmuellProvider[] = [
  { subdomain: "azv", title: "Abfallwirtschaftszweckverband Wartburgkreis (AZV)", url: "https://www.azv-wak-ea.de/" },
  { subdomain: "boerde", title: "Landkreis Börde AöR (KsB)", url: "https://www.ks-boerde.de/" },
  { subdomain: "ew", title: "Eichsfeldwerke GmbH", url: "https://www.eichsfeldwerke.de/" },
  { subdomain: "ebkds", title: "Eigenbetrieb Kommunalwirtschaftliche Dienstleistungen Suhl (EBKDS)", url: "https://www.ebkds.de/" },
  { subdomain: "schmalkalden-meiningen", title: "Kreiswerke Schmalkalden-Meiningen GmbH", url: "https://www.kwsm.de/" },
  { subdomain: "wesel", title: "ASG Wesel", url: "https://www.asg-wesel.de/" },
];

export type HausmuellLevel = "ort" | "ortsteil" | "strasse" | "hnr";

export interface HausmuellSearchItem {
  id: string;
  name: string;
  /** Entsorgungsgebiet id if this pick already determines the calendar ("0"/"" = not yet). */
  egebiet: string;
  /**
   * Older portals flag Orte that are split into Ortsteile (hidden span after the name).
   * `undefined` = portal does not say (newer frontend: no Ortsteil level).
   */
  has_ortsteile?: boolean;
}

/** Parent ids the next search level needs (as chosen so far). */
export interface HausmuellParents {
  ort_id?: string;
  ortsteil_id?: string;
  str_id?: string;
}

const LEVEL_ENDPOINT: Record<HausmuellLevel, { file: string; input: string }> = {
  ort: { file: "search_orte.php", input: "input_ort" },
  ortsteil: { file: "search_ortsteile.php", input: "input_ortsteil" },
  strasse: { file: "search_strassen.php", input: "input_str" },
  hnr: { file: "search_hnr.php", input: "input_hnr" },
};

const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/;

export function isValidSubdomain(s: string | undefined): s is string {
  return typeof s === "string" && SUBDOMAIN_RE.test(s);
}

export function hausmuellBaseUrl(subdomain: string): string {
  if (!isValidSubdomain(subdomain)) {
    throw new Error(`Invalid hausmuell.info subdomain: ${String(subdomain)}`);
  }
  return `https://${subdomain}.hausmuell.info/`;
}

export function providerTitle(subdomain: string | undefined): string {
  if (!subdomain) return "";
  return HAUSMUELL_PROVIDERS.find((p) => p.subdomain === subdomain)?.title ?? `${subdomain}.hausmuell.info`;
}

async function httpRequest(
  url: string,
  body?: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "User-Agent": UA,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
      signal: controller.signal,
    });
    const buf = Buffer.from(await response.arrayBuffer());
    return { text: decodeBody(buf), status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Portals answer in UTF-8, older ones in ISO-8859-1 — and some ICS exports mix both in one
 * file (event titles UTF-8, echoed street name Latin-1), or contain UTF-8 encoded twice
 * ("Ã¼" instead of "ü"). Decode valid UTF-8 sequences as UTF-8 and every other byte as
 * Latin-1, then repair double encoding.
 */
export function decodeBody(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    const len = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 1;
    if (b >= 0x80 && len > 1 && i + len <= buf.length) {
      let valid = true;
      for (let k = 1; k < len; k += 1) {
        if ((buf[i + k] & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
      }
      if (valid) {
        out += buf.subarray(i, i + len).toString("utf-8");
        i += len;
        continue;
      }
    }
    out += String.fromCharCode(b); // ASCII, or a lone Latin-1 byte
    i += 1;
  }
  return repairDoubleUtf8(out);
}

/** "RestmÃ¼ll" → "Restmüll" (only the affected 2-char sequences, rest of the text untouched). */
export function repairDoubleUtf8(text: string): string {
  return text.replace(/[Â-ß][\u0080-¿]/g, (pair) => {
    const fixed = Buffer.from(pair, "latin1").toString("utf-8");
    return fixed.length === 1 && fixed !== "�" ? fixed : pair;
  });
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[e] ?? m;
  });
}

/**
 * Parse a `<ul><li …onClick='get_value("ort",18878,0)'><span…>…</span></li>…</ul>` search response.
 * Entries without an onClick handler ("Keinen Eintrag gefunden", hints) are skipped.
 */
export function parseSearchResponse(html: string): HausmuellSearchItem[] {
  const out: HausmuellSearchItem[] = [];
  const liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null = liRe.exec(html);
  while (m) {
    const attrs = m[1];
    const inner = m[2];
    const onclick = /onclick\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    const call = onclick ? /get_value\s*\(([^)]*)\)/i.exec(onclick[2]) : null;
    if (call) {
      const args = call[1].split(",").map((a) => a.trim().replace(/^["']|["']$/g, ""));
      const ids = args.slice(1).filter((a) => /^\d+$/.test(a));
      // Visible label = last <span> that is not display:none (older portals hide ids in spans).
      const spans = [...inner.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)];
      const isHidden = (s: RegExpMatchArray): boolean => /display\s*:\s*none/i.test(s[1]);
      let nameIdx = -1;
      spans.forEach((s, idx) => {
        if (!isHidden(s)) nameIdx = idx;
      });
      const rawName = (nameIdx >= 0 ? spans[nameIdx][2] : inner).replace(/<[^>]*>/g, "");
      const name = decodeEntities(rawName).replace(/\s+/g, " ").trim();
      const flagSpan = nameIdx >= 0 ? spans.slice(nameIdx + 1).find((s) => isHidden(s)) : undefined;
      const flag = flagSpan ? flagSpan[2].trim() : "";
      if (ids.length > 0 && name) {
        const item: HausmuellSearchItem = { id: ids[0], name, egebiet: ids[1] && ids[1] !== "0" ? ids[1] : "" };
        if (/^\d+$/.test(flag)) {
          item.has_ortsteile = flag !== "0";
        }
        out.push(item);
      }
    }
    m = liRe.exec(html);
  }
  return out;
}

/** Hidden/default form fields of the portal start page plus all `showBins*` fraction toggles switched on. */
export function extractPortalDefaults(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const type = (/\btype\s*=\s*["']?([a-z]+)/i.exec(tag)?.[1] ?? "text").toLowerCase();
    if (/^showBins/i.test(name)) {
      fields[name] = "on";
    } else if (type === "hidden") {
      fields[name] = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    }
  }
  return fields;
}

function baseArgs(): Record<string, string> {
  return {
    hidden_kalenderart: "privat",
    ort_id: "0",
    str_id: "0",
    hidden_id_ort: "0",
    hidden_id_ortsteil: "0",
    hidden_id_str: "0",
    hidden_id_hnr: "0",
    hidden_id_egebiet: "0",
  };
}

/**
 * List entries of one cascade level. `query` may be empty: portals then return the full list
 * (all Orte, all streets of an Ortsteil, …), which the admin UI filters client-side.
 */
export async function searchLevel(
  subdomain: string,
  level: HausmuellLevel,
  parents: HausmuellParents,
  query = "",
): Promise<HausmuellSearchItem[]> {
  const ep = LEVEL_ENDPOINT[level];
  const ortId = parents.ortsteil_id && parents.ortsteil_id !== "0" ? parents.ortsteil_id : (parents.ort_id ?? "0");
  const body: Record<string, string> = {
    ...baseArgs(),
    [ep.input]: query,
    input: query,
    ort_id: ortId,
    str_id: parents.str_id ?? "0",
    hnr_id: "0",
    input_hnr: level === "hnr" ? query : "",
  };
  // Some portals (ew, wesel) read the ids from the query string, others from the POST body: send both.
  const qs = new URLSearchParams({ input: query, ort_id: body.ort_id, str_id: body.str_id, hnr_id: "0" });
  const url = `${hausmuellBaseUrl(subdomain)}search/${ep.file}?${qs.toString()}`;
  const { text, status } = await httpRequest(url, body);
  if (status === 404) {
    // Level not offered by this portal version (e.g. no Ortsteile on the newer frontend).
    log.info(`hausmuell.info ${subdomain} has no ${level} search (404)`);
    return [];
  }
  if (status !== 200) {
    throw new Error(`hausmuell.info search ${level} failed with status ${status}`);
  }
  const items = parseSearchResponse(text);
  log.info(`hausmuell.info ${subdomain} ${level} search '${query}': ${items.length} results`);
  return items;
}

/** Address chosen so far in the admin UI (same shape as the saved config). */
export type HausmuellState = HausmuellConfig & {
  /** Ortsteil flag of the chosen Ort, if the portal reports one. */
  ort_has_ortsteile?: boolean;
};

export type HausmuellStep =
  | { done: false; level: HausmuellLevel; items: HausmuellSearchItem[] }
  | { done: true; complete: boolean };

/**
 * Decide which cascade level the user has to fill next and return its full list.
 * Handles the three ATURIS frontend generations:
 *  - egebiet in results (schmalkalden-meiningen, ew, wesel, azv): stop as soon as it is known;
 *  - Ortsteil flag after the name (schmalkalden-meiningen, ew, wesel) vs. none (azv: try Ortsteile);
 *  - no egebiet / no Ortsteile at all (ebkds, boerde): Ort → Straße → Hausnummer.
 */
export async function nextStep(state: HausmuellState): Promise<HausmuellStep> {
  const sub = state.subdomain ?? "";
  if (!isValidSubdomain(sub)) {
    throw new Error("Invalid hausmuell.info subdomain");
  }
  if (!state.ort) {
    return { done: false, level: "ort", items: await searchLevel(sub, "ort", {}) };
  }
  if (state.egebiet) {
    return { done: true, complete: true };
  }
  const ortId = state.ort.id;
  if (!state.ortsteil && !state.strasse && state.ort_has_ortsteile !== false) {
    const ots = await searchLevel(sub, "ortsteil", { ort_id: ortId });
    if (ots.length > 0) {
      return { done: false, level: "ortsteil", items: ots };
    }
  }
  if (!state.strasse) {
    const streets = await searchLevel(sub, "strasse", { ort_id: ortId, ortsteil_id: state.ortsteil?.id });
    if (streets.length > 0) {
      return { done: false, level: "strasse", items: streets };
    }
    return { done: true, complete: false };
  }
  if (!state.hnr) {
    const hnrs = await searchLevel(sub, "hnr", { ort_id: state.ortsteil?.id ?? ortId, str_id: state.strasse.id });
    if (hnrs.length > 0) {
      return { done: false, level: "hnr", items: hnrs };
    }
  }
  return { done: true, complete: isHausmuellAddressComplete(state) };
}

function sanitizePick(v: unknown): HausmuellPick | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { id, name } = v as Record<string, unknown>;
  if (typeof id !== "string" || !/^\d{1,12}$/.test(id)) return undefined;
  return { id, name: typeof name === "string" ? name.slice(0, 200) : "" };
}

/**
 * Whitelist + validate an address coming from the admin UI / ajax.php before it is used
 * in requests or written to the config file.
 */
export function sanitizeHausmuellState(input: unknown): HausmuellState {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: HausmuellState = {};
  if (typeof o.subdomain === "string" && isValidSubdomain(o.subdomain)) out.subdomain = o.subdomain;
  for (const k of ["ort", "ortsteil", "strasse", "hnr"] as const) {
    const p = sanitizePick(o[k]);
    if (p) out[k] = p;
  }
  if (typeof o.egebiet === "string" && /^\d{1,12}$/.test(o.egebiet)) out.egebiet = o.egebiet;
  if (typeof o.ort_has_ortsteile === "boolean") out.ort_has_ortsteile = o.ort_has_ortsteile;
  return out;
}

/** Pick the entry whose folded name equals `name`, else the first one containing it. */
export function pickByName(items: HausmuellSearchItem[], name: string): HausmuellSearchItem | undefined {
  const q = foldForSearch(name.trim());
  return items.find((i) => foldForSearch(i.name) === q) ?? items.find((i) => foldForSearch(i.name).includes(q));
}

/**
 * Optional "Zusatz" (front/back house, company) step. Returns the zusatz id the ICS export
 * expects, or the house-number id when the portal has none.
 */
async function resolveZusatz(subdomain: string, args: Record<string, string>): Promise<string> {
  try {
    const { text, status } = await httpRequest(`${hausmuellBaseUrl(subdomain)}search/check_zusatz.php`, args);
    if (status === 200) {
      const span = /<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(text);
      const id = span ? span[1].replace(/<[^>]*>/g, "").trim() : "";
      if (/^\d+$/.test(id)) return id;
    }
  } catch (err) {
    log.debug(`hausmuell.info check_zusatz failed: ${String(err)}`);
  }
  return args.hidden_id_hnr ?? "0";
}

function pickId(p: HausmuellPick | undefined): string {
  return p?.id && /^\d+$/.test(p.id) ? p.id : "0";
}

/** Form arguments for the ICS export from a saved configuration. */
export function exportArgs(cfg: HausmuellConfig, egebiet: string): Record<string, string> {
  const ortId = pickId(cfg.ort);
  const ortsteilId = cfg.ortsteil ? pickId(cfg.ortsteil) : ortId;
  return {
    ...baseArgs(),
    input_ort: cfg.ort?.name ?? "",
    input_ortsteil: cfg.ortsteil?.name ?? "",
    input_str: cfg.strasse?.name ?? "",
    input_hnr: cfg.hnr?.name ?? "",
    ort_id: ortsteilId,
    str_id: pickId(cfg.strasse),
    hidden_id_ort: ortId,
    hidden_id_ortsteil: ortsteilId,
    hidden_id_str: pickId(cfg.strasse),
    hidden_id_hnr: pickId(cfg.hnr),
    hidden_id_egebiet: egebiet,
    hidden_send_btn: "ics",
  };
}

/**
 * Re-resolve ids from the saved names (ids can change when a portal re-imports its data,
 * typically at the turn of the year). Returns the updated config.
 */
export async function reresolveByNames(cfg: HausmuellConfig): Promise<HausmuellConfig> {
  const sub = cfg.subdomain ?? "";
  const next: HausmuellConfig = { ...cfg };
  let egebiet = "";
  const step = async (level: HausmuellLevel, pick: HausmuellPick | undefined, parents: HausmuellParents) => {
    if (!pick?.name) return undefined;
    const found = pickByName(await searchLevel(sub, level, parents, pick.name), pick.name);
    if (!found) {
      throw new Error(`hausmuell.info: '${pick.name}' (${level}) not found any more – please re-select the address.`);
    }
    if (found.egebiet) egebiet = found.egebiet;
    return { id: found.id, name: found.name };
  };
  next.ort = await step("ort", cfg.ort, {});
  const ortId = next.ort?.id;
  next.ortsteil = await step("ortsteil", cfg.ortsteil, { ort_id: ortId });
  next.strasse = await step("strasse", cfg.strasse, { ort_id: ortId, ortsteil_id: next.ortsteil?.id });
  next.hnr = await step("hnr", cfg.hnr, { ort_id: next.ortsteil?.id ?? ortId, str_id: next.strasse?.id });
  if (!egebiet && !next.strasse) {
    throw new Error("hausmuell.info: address does not resolve to a collection area – please re-select the address.");
  }
  next.egebiet = egebiet;
  return next;
}

/**
 * Whether a saved address is enough for the ICS export: older portals need the
 * Entsorgungsgebiet id, newer ones (no egebiet in search results) at least a street.
 */
export function isHausmuellAddressComplete(cfg: HausmuellConfig | undefined): boolean {
  return !!cfg && isValidSubdomain(cfg.subdomain) && (!!cfg.egebiet || !!cfg.strasse?.id);
}

const ICS_ERROR_MARKER = "Bitte geben Sie Ihre Daten korrekt an";

/**
 * Normalise ATURIS event titles: drop "Entsorgung:" and "verschobene Abholung:" prefixes so that
 * moved collections still count towards their base category (stable Loxone/MQTT keys), and turn
 * "Gelber Sack / Gelbe Tonne" into "Gelber Sack - Gelbe Tonne" (the shared ICS parser drops "/").
 */
export function normalizeHausmuellIcs(ics: string): string {
  return ics.replace(/^(SUMMARY[^:\r\n]*:)(.*)$/gim, (_m, head: string, value: string) => {
    let v = value.trim();
    for (let i = 0; i < 3; i += 1) {
      const stripped = v.replace(/^(entsorgung|verschobene abholung|verschoben)\s*:\s*/i, "");
      if (stripped === v) break;
      v = stripped;
    }
    v = v.replace(/\s*\/\s*/g, " - ").replace(/\s{2,}/g, " ");
    return `${head}${v}`;
  });
}

function countEvents(ics: string): number {
  return (ics.match(/BEGIN:VEVENT/g) ?? []).length;
}

/**
 * Download the calendar for the saved address: current year plus next year
 * (the next year is usually published in December; until then it is simply empty).
 */
export async function fetchHausmuellIcs(cfg: HausmuellConfig, now = new Date()): Promise<{ ics: string; config: HausmuellConfig }> {
  const sub = cfg.subdomain ?? "";
  const base = hausmuellBaseUrl(sub);
  let working: HausmuellConfig = { ...cfg };

  const home = await httpRequest(base);
  const defaults = home.status === 200 ? extractPortalDefaults(home.text) : {};

  const download = async (c: HausmuellConfig): Promise<string> => {
    if (!isHausmuellAddressComplete(c)) {
      throw new Error("hausmuell.info: no address saved – please select the address on the Location tab.");
    }
    const args = { ...defaults, ...exportArgs(c, c.egebiet || "0") };
    args.hidden_id_zusatz = c.zusatz_id || (await resolveZusatz(sub, args));
    const parts: string[] = [];
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
      const { text, status } = await httpRequest(`${base}ics/ics.php`, { ...args, hiddenYear: String(year) });
      if (status !== 200) {
        throw new Error(`hausmuell.info ICS export failed with status ${status}`);
      }
      if (text.includes("VCALENDAR")) {
        parts.push(text);
        log.info(`hausmuell.info ${sub}: ${countEvents(text)} events for ${year}`);
      } else if (text.includes(ICS_ERROR_MARKER)) {
        throw new Error("hausmuell.info rejected the address (\"Bitte geben Sie Ihre Daten korrekt an\").");
      }
    }
    return parts.join("\n");
  };

  let ics = "";
  try {
    ics = await download(working);
  } catch (err) {
    log.warn(`hausmuell.info export with saved ids failed (${String(err)}); re-resolving address by name`);
  }
  if (countEvents(ics) === 0) {
    working = await reresolveByNames(working);
    working.zusatz_id = "";
    ics = await download(working);
  }
  if (countEvents(ics) === 0) {
    throw new Error("hausmuell.info returned no collection dates for this address.");
  }
  return { ics: normalizeHausmuellIcs(ics), config: working };
}

export function hausmuellLocationLabel(cfg: HausmuellConfig | undefined): string {
  if (!cfg) return "";
  const ortsteil = cfg.ortsteil?.name && !/^-.*-$/.test(cfg.ortsteil.name) ? cfg.ortsteil.name : "";
  const place = [cfg.ort?.name, ortsteil].filter(Boolean).join(" / ");
  const street = [cfg.strasse?.name, cfg.hnr?.name].filter(Boolean).join(" ");
  return [place, street].filter(Boolean).join(", ");
}
