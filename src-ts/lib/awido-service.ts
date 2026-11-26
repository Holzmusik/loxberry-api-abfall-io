/**
 * Fourth upstream: AWIDO (cubefour) — waste calendars of many German districts and towns,
 * often embedded in the operator's own website (e.g. awhas.de for Landkreis Haßberge).
 *
 * JSON web service (no account), every call takes the customer key as `client`:
 *   GET …/secure/getPlaces/client=<c>                       → [{ key, value }]   (Orte)
 *   GET …/secure/getGroupedStreets/<placeOid>?client=<c>     → [{ key, value }]   (Straßen / Bereiche)
 *   GET …/secure/getStreetAddons/<streetOid>?client=<c>      → [{ key, value }]   (Hausnummern; [{value:""}] = none)
 *   GET …/secure/getData/<oid>?fractions=&client=<c>         → { fracts[{snm,nm}], calendar[{dt,fr[],ad[]}] }
 * The calendar already spans the current and the next year. Entries with `ad: null` are public holidays.
 * Fallback for customers without JSON: …/Customer/<c>/KalenderICS.aspx?oid=…&jahr=…
 */
import { log } from "./logger.js";
import { pickupsToIcs, type MuellabfuhrPickup } from "./muellabfuhr-service.js";
import type { AwidoConfig, AwidoPick } from "./types.js";

const BASE = "https://awido.cubefour.de";
const API = `${BASE}/WebServices/Awido.Service.svc/secure`;
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0";

const CUSTOMER_RE = /^[a-z0-9-]{1,40}$/;
const OID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AwidoCustomer {
  customer: string;
  title: string;
  url: string;
}

/**
 * Customers verified live (getPlaces answers) in November 2026. Source: Home Assistant
 * `awido_de` SERVICE_MAP (deduplicated: Landkreis Ebersberg is listed there once per town),
 * plus Landkreis Haßberge (`awhas`, documented there only as a generic ICS example).
 */
export const AWIDO_CUSTOMERS: AwidoCustomer[] = [
  { customer: "awv-nordschwaben", title: "Abfall-Wirtschafts-Verband Nordschwaben", url: "https://www.awv-nordschwaben.de/" },
  { customer: "awb-altenburg", title: "Abfallwirtschaft Altenburger Land", url: "https://www.awb-altenburg.de/" },
  { customer: "awv-isar-inn", title: "Abfallwirtschaft Isar-Inn", url: "https://www.awv-isar-inn.de/" },
  { customer: "awld", title: "Abfallwirtschaft Lahn-Dill-Kreises", url: "https://www.awld.de/" },
  { customer: "awhas", title: "Abfallwirtschaft Landkreis Haßberge", url: "https://www.awhas.de/" },
  { customer: "rmk", title: "Abfallwirtschaft Rems-Murr (AWRM)", url: "https://www.abfallwirtschaft-rems-murr.de/" },
  { customer: "azv-hef-rof", title: "Abfallwirtschafts-Zweckverband des Landkreises Hersfeld-Rotenburg", url: "https://www.azv-hef-rof.de/" },
  { customer: "awb-ak", title: "Abfallwirtschaftsbetrieb Landkreis Altenkirchen", url: "https://www.awb-ak.de/" },
  { customer: "awb-duerkheim", title: "AWB Landkreis Bad Dürkheim", url: "http://awb.kreis-bad-duerkheim.de/" },
  { customer: "ffb", title: "AWB Landkreis Fürstenfeldbruck", url: "https://www.awb-ffb.de/" },
  { customer: "ebu", title: "EBU Ulm", url: "https://www.ebu-ulm.de/" },
  { customer: "unterhaching", title: "Gemeinde Unterhaching", url: "https://www.unterhaching.de/" },
  { customer: "ansbach", title: "Landkreis Ansbach", url: "https://www.landkreis-ansbach.de/" },
  { customer: "lra-ab", title: "Landkreis Aschaffenburg", url: "https://www.landkreis-aschaffenburg.de/" },
  { customer: "bgl", title: "Landkreis Berchtesgadener Land", url: "https://www.lra-bgl.de/" },
  { customer: "coburg", title: "Landkreis Coburg", url: "https://www.landkreis-coburg.de/" },
  { customer: "ebe", title: "Landkreis Ebersberg", url: "https://www.lra-ebe.de/" },
  { customer: "erding", title: "Landkreis Erding", url: "https://www.landkreis-erding.de/" },
  { customer: "fulda", title: "Landkreis Fulda", url: "https://www.landkreis-fulda.de/" },
  { customer: "lkgi", title: "Landkreis Gießen", url: "https://www.lkgi.de/" },
  { customer: "gifhorn", title: "Landkreis Gifhorn", url: "https://www.gifhorn.de/" },
  { customer: "gotha", title: "Landkreis Gotha", url: "https://www.landkreis-gotha.de/" },
  { customer: "kaw-guenzburg", title: "Landkreis Günzburg", url: "https://kaw.landkreis-guenzburg.de/" },
  { customer: "kelheim", title: "Landkreis Kelheim", url: "https://www.landkreis-kelheim.de/" },
  { customer: "kronach", title: "Landkreis Kronach", url: "https://www.landkreis-kronach.de/" },
  { customer: "kulmbach", title: "Landkreis Kulmbach", url: "https://www.landkreis-kulmbach.de/" },
  { customer: "lichtenfels", title: "Landkreis Lichtenfels", url: "https://www.lkr-lif.de/" },
  { customer: "lra-mue", title: "Landkreis Mühldorf a. Inn", url: "https://www.lra-mue.de/" },
  { customer: "rosenheim", title: "Landkreis Rosenheim", url: "https://www.abfall.landkreis-rosenheim.de/" },
  { customer: "roth", title: "Landkreis Roth", url: "https://www.landratsamt-roth.de/" },
  { customer: "lra-schweinfurt", title: "Landkreis Schweinfurt", url: "https://www.landkreis-schweinfurt.de" },
  { customer: "eww-suew", title: "Landkreis Südliche Weinstraße", url: "https://www.suedliche-weinstrasse.de/" },
  { customer: "kreis-tir", title: "Landkreis Tirschenreuth", url: "https://www.kreis-tir.de/" },
  { customer: "tuebingen", title: "Landkreis Tübingen", url: "https://www.abfall-kreis-tuebingen.de/" },
  { customer: "landkreisbetriebe", title: "Landkreisbetriebe Neuburg-Schrobenhausen", url: "https://www.landkreisbetriebe.de/" },
  { customer: "aic-fdb", title: "Landratsamt Aichach-Friedberg", url: "https://lra-aic-fdb.de/" },
  { customer: "lra-dah", title: "Landratsamt Dachau", url: "https://www.landratsamt-dachau.de/" },
  { customer: "lra-regensburg", title: "Landratsamt Regensburg", url: "https://www.landkreis-regensburg.de/" },
  { customer: "neustadt", title: "Neustadt a.d. Waldnaab", url: "https://www.neustadt.de/" },
  { customer: "pullach", title: "Pullach im Isartal", url: "https://www.pullach.de/" },
  { customer: "fulda-stadt", title: "Stadt Fulda", url: "https://www.fulda.de/" },
  { customer: "kaufbeuren", title: "Stadt Kaufbeuren", url: "https://www.kaufbeuren.de/" },
  { customer: "koenigstein", title: "Stadt Königstein im Taunus", url: "https://www.koenigstein.de/" },
  { customer: "memmingen", title: "Stadt Memmingen", url: "https://umwelt.memmingen.de/" },
  { customer: "regensburg", title: "Stadt Regensburg", url: "https://www.regensburg.de/" },
  { customer: "unterschleissheim", title: "Stadt Unterschleißheim", url: "https://www.unterschleissheim.de/" },
  { customer: "wgv", title: "WGV Recycling GmbH", url: "https://wgv-quarzbichl.de/" },
  { customer: "zaso", title: "Zweckverband Abfallwirtschaft Saale-Orla", url: "https://www.zaso-online.de/" },
  { customer: "zv-muc-so", title: "Zweckverband München-Südost", url: "https://www.zvmso.de/" },
];

export type AwidoLevel = "place" | "street" | "hnr";

export interface AwidoItem {
  id: string;
  name: string;
}

export interface AwidoState {
  customer?: string;
  place?: AwidoPick;
  street?: AwidoPick;
  hnr?: AwidoPick;
}

export type AwidoStep =
  | { done: false; level: AwidoLevel; items: AwidoItem[] }
  | { done: true; complete: boolean };

export function isValidCustomer(s: unknown): s is string {
  return typeof s === "string" && CUSTOMER_RE.test(s);
}

export function isValidOid(s: unknown): s is string {
  return typeof s === "string" && OID_RE.test(s);
}

export function customerTitle(customer: string | undefined): string {
  if (!customer) return "";
  return AWIDO_CUSTOMERS.find((c) => c.customer === customer)?.title ?? customer;
}

async function get(url: string, timeoutMs = 30_000): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal });
    return { text: await r.text(), status: r.status };
  } finally {
    clearTimeout(timer);
  }
}

async function getList(url: string): Promise<AwidoItem[]> {
  const { text, status } = await get(url);
  if (status !== 200) {
    throw new Error(`AWIDO request failed with status ${status}`);
  }
  const raw = JSON.parse(text) as Array<{ key?: unknown; value?: unknown }>;
  return raw
    .map((e) => ({ id: String(e.key ?? ""), name: String(e.value ?? "").trim() }))
    .filter((e) => isValidOid(e.id));
}

const enc = encodeURIComponent;

export async function listPlaces(customer: string): Promise<AwidoItem[]> {
  return (await getList(`${API}/getPlaces/client=${enc(customer)}`)).filter((e) => e.name !== "");
}

export async function listStreets(customer: string, placeOid: string): Promise<AwidoItem[]> {
  return (await getList(`${API}/getGroupedStreets/${placeOid}?client=${enc(customer)}`)).filter((e) => e.name !== "");
}

/** House numbers; empty when the street needs none (portal answers `[{ value: "" }]`). */
export async function listHouseNumbers(customer: string, streetOid: string): Promise<AwidoItem[]> {
  return (await getList(`${API}/getStreetAddons/${streetOid}?client=${enc(customer)}`)).filter((e) => e.name !== "");
}

/** Next level of the address cascade for the admin UI, or done. */
export async function nextStep(state: AwidoState): Promise<AwidoStep> {
  const c = state.customer;
  if (!isValidCustomer(c)) {
    throw new Error("Invalid AWIDO customer");
  }
  if (!state.place) {
    return { done: false, level: "place", items: await listPlaces(c) };
  }
  if (!state.street) {
    const streets = await listStreets(c, state.place.id);
    if (streets.length > 0) {
      return { done: false, level: "street", items: streets };
    }
    return { done: true, complete: false };
  }
  if (!state.hnr) {
    const hnrs = await listHouseNumbers(c, state.street.id);
    if (hnrs.length > 0) {
      return { done: false, level: "hnr", items: hnrs };
    }
  }
  return { done: true, complete: true };
}

function sanitizePick(v: unknown): AwidoPick | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { id, name } = v as Record<string, unknown>;
  if (!isValidOid(id)) return undefined;
  return { id, name: typeof name === "string" ? name.slice(0, 200) : "" };
}

/** Whitelist + validate state from the admin UI before it is used in requests or saved. */
export function sanitizeAwidoState(input: unknown): AwidoState {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: AwidoState = {};
  if (isValidCustomer(o.customer)) out.customer = o.customer;
  const place = sanitizePick(o.place);
  if (place) out.place = place;
  const street = place ? sanitizePick(o.street) : undefined;
  if (street) out.street = street;
  const hnr = street ? sanitizePick(o.hnr) : undefined;
  if (hnr) out.hnr = hnr;
  return out;
}

export function isAwidoAddressComplete(cfg: AwidoConfig | undefined): boolean {
  return !!cfg && isValidCustomer(cfg.customer) && isValidOid(cfg.street?.id);
}

export function awidoLocationLabel(cfg: AwidoConfig | undefined): string {
  if (!cfg) return "";
  const place = cfg.place?.name ?? "";
  const street = cfg.street?.name && cfg.street.name !== place ? cfg.street.name : "";
  const streetHnr = [street, cfg.hnr?.name].filter(Boolean).join(" ");
  return [place, streetHnr].filter(Boolean).join(", ");
}

interface AwidoData {
  fracts?: Array<{ snm?: string; nm?: string }>;
  calendar?: Array<{ dt?: string; fr?: string[] | null; ad?: unknown[] | null }>;
}

/** getData JSON → pickups (holidays, i.e. `ad: null`, skipped; fraction codes mapped to names). */
export function parseAwidoData(data: AwidoData): MuellabfuhrPickup[] {
  const names = new Map<string, string>();
  for (const f of data.fracts ?? []) {
    if (f.snm && f.nm) names.set(f.snm, f.nm.trim());
  }
  const out: MuellabfuhrPickup[] = [];
  for (const item of data.calendar ?? []) {
    if (item.ad == null || !item.fr || !item.dt) continue;
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(item.dt);
    if (!m) continue;
    for (const code of item.fr) {
      const name = names.get(code) ?? code;
      out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, fraction: { id: code, name } });
    }
  }
  return out;
}

/**
 * Download the schedule for the saved address (JSON; ICS export as fallback for customers
 * that do not serve JSON). Returns ICS text for the shared parser / cache / MQTT path.
 */
export async function fetchAwido(cfg: AwidoConfig, now = new Date()): Promise<{ ics: string; count: number }> {
  if (!isAwidoAddressComplete(cfg)) {
    throw new Error("AWIDO: no address saved – please select it on the Location tab.");
  }
  const c = cfg.customer!;
  const oid = cfg.hnr?.id ?? cfg.street!.id;

  const { text, status } = await get(`${API}/getData/${oid}?fractions=&client=${enc(c)}`);
  if (status === 200 && text.trim().startsWith("{")) {
    const pickups = parseAwidoData(JSON.parse(text) as AwidoData);
    log.info(`AWIDO ${c}: ${pickups.length} pickups (JSON)`);
    if (pickups.length > 0) {
      return { ics: pickupsToIcs(pickups), count: pickups.length };
    }
  } else {
    log.info(`AWIDO ${c}: getData status ${status}, falling back to ICS export`);
  }

  const parts: string[] = [];
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const qs = new URLSearchParams({ oid, jahr: String(year), fraktionen: "", reminder: "-1.17:00" });
    const r = await get(`${BASE}/Customer/${enc(c)}/KalenderICS.aspx?${qs.toString()}`);
    if (r.status === 200 && r.text.includes("VCALENDAR")) parts.push(r.text);
  }
  const ics = parts.join("\n");
  const count = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  log.info(`AWIDO ${c}: ${count} events (ICS)`);
  if (count === 0) {
    throw new Error("AWIDO returned no collection dates for this address.");
  }
  return { ics, count };
}
