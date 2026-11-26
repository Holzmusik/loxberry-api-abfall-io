/**
 * Third upstream: "Müllabfuhr Deutschland" customer portal (`https://portal.muellabfuhr-deutschland.de/`).
 *
 * JSON API (no account):
 *   GET /api-portal/mandators                                   → [{ id, name }]          (districts)
 *   GET /api-portal/mandators/<m>/config                        → { calendarRootLocationId, … }
 *   GET /api-portal/mandators/<m>/cal/location/<id>?includeChildren=true
 *                                                               → { id, name, isFinal, children[] }
 *   GET /api-portal/mandators/<m>/cal/location/<id>/pickups     → [{ date, fraction: { id, name } }]  (upcoming)
 *   GET /api-portal/mandators/<m>/cal/location/<id>/pickups/ics?year=Y&fractionIds=…  (whole year, ICS)
 *
 * The location tree is Ort → (Ortsteil) → (Straße); every node says whether it is final.
 * The district list is read live from the portal, so newly added districts appear automatically.
 */
import { log } from "./logger.js";
import type { MuellabfuhrConfig, MuellabfuhrPick } from "./types.js";

const API = "https://portal.muellabfuhr-deutschland.de/api-portal";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0";

const MANDATOR_RE = /^\d{1,9}$/;
const LOCATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRACTION_RE = /^\d{1,9}$/;

export interface MuellabfuhrMandator {
  id: string;
  name: string;
}

export interface MuellabfuhrNode {
  id: string;
  name: string;
  isFinal: boolean;
}

export interface MuellabfuhrPickup {
  /** YYYY-MM-DD */
  date: string;
  fraction: { id: string; name: string };
}

/** Address chosen so far in the admin UI. */
export interface MuellabfuhrState {
  mandator?: MuellabfuhrPick;
  /** Chosen nodes from the root downwards (Ort, Ortsteil, Straße …). */
  path?: MuellabfuhrPick[];
  /** True once the last path node is final. */
  final?: boolean;
}

export type MuellabfuhrStep =
  | { done: false; depth: number; items: MuellabfuhrNode[] }
  | { done: true; complete: boolean };

export function isValidMandatorId(s: unknown): s is string {
  return typeof s === "string" && MANDATOR_RE.test(s);
}

export function isValidLocationId(s: unknown): s is string {
  return typeof s === "string" && LOCATION_RE.test(s);
}

async function getJson<T>(path: string, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${path}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (r.status !== 200) {
      throw new Error(`muellabfuhr-deutschland.de ${path} failed with status ${r.status}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(path: string, timeoutMs = 30_000): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${path}`, { headers: { "User-Agent": UA }, signal: controller.signal });
    return { text: await r.text(), status: r.status };
  } finally {
    clearTimeout(timer);
  }
}

export async function listMandators(): Promise<MuellabfuhrMandator[]> {
  const raw = await getJson<Array<{ id: unknown; name: unknown }>>("/mandators");
  return raw
    .map((m) => ({ id: String(m.id ?? ""), name: String(m.name ?? "").trim() }))
    .filter((m) => isValidMandatorId(m.id) && m.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

async function rootLocationId(mandatorId: string): Promise<string> {
  const cfg = await getJson<{ calendarRootLocationId?: string; calendarActive?: boolean }>(
    `/mandators/${mandatorId}/config`,
  );
  if (cfg.calendarActive === false || !isValidLocationId(cfg.calendarRootLocationId)) {
    throw new Error("muellabfuhr-deutschland.de: this district has no collection calendar.");
  }
  return cfg.calendarRootLocationId;
}

export async function listChildren(mandatorId: string, locationId: string): Promise<MuellabfuhrNode[]> {
  const node = await getJson<{ children?: Array<{ id: unknown; name: unknown; isFinal: unknown }> }>(
    `/mandators/${mandatorId}/cal/location/${locationId}?includeChildren=true`,
  );
  return (node.children ?? [])
    .map((c) => ({ id: String(c.id ?? ""), name: String(c.name ?? "").trim(), isFinal: c.isFinal === true }))
    .filter((c) => isValidLocationId(c.id) && c.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/** Next level of the location tree for the admin UI, or done. */
export async function nextStep(state: MuellabfuhrState): Promise<MuellabfuhrStep> {
  const m = state.mandator?.id;
  if (!isValidMandatorId(m)) {
    throw new Error("Invalid district");
  }
  const path = state.path ?? [];
  if (path.length > 0 && state.final) {
    return { done: true, complete: true };
  }
  const parent = path.length > 0 ? path[path.length - 1].id : await rootLocationId(m);
  const items = await listChildren(m, parent);
  log.info(`muellabfuhr-deutschland.de mandator ${m} depth ${path.length}: ${items.length} entries`);
  if (items.length === 0) {
    // A non-final node without children cannot be refined further – the portal may still serve pickups for it.
    return { done: true, complete: path.length > 0 };
  }
  return { done: false, depth: path.length, items };
}

function sanitizePick(v: unknown, idOk: (s: unknown) => boolean): MuellabfuhrPick | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { id, name } = v as Record<string, unknown>;
  if (!idOk(id)) return undefined;
  return { id: String(id), name: typeof name === "string" ? name.slice(0, 200) : "" };
}

/** Whitelist + validate state from the admin UI before it is used in requests or saved. */
export function sanitizeMuellabfuhrState(input: unknown): MuellabfuhrState {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: MuellabfuhrState = {};
  const mandator = sanitizePick(o.mandator, isValidMandatorId);
  if (mandator) out.mandator = mandator;
  if (Array.isArray(o.path)) {
    const path: MuellabfuhrPick[] = [];
    for (const p of o.path.slice(0, 6)) {
      const pick = sanitizePick(p, isValidLocationId);
      if (!pick) break;
      path.push(pick);
    }
    if (path.length > 0) out.path = path;
  }
  if (typeof o.final === "boolean") out.final = o.final;
  return out;
}

export function isMuellabfuhrAddressComplete(cfg: MuellabfuhrConfig | undefined): boolean {
  return !!cfg && isValidMandatorId(cfg.mandator?.id) && (cfg.path?.length ?? 0) > 0 && isValidLocationId(cfg.path?.at(-1)?.id);
}

export function muellabfuhrLocationLabel(cfg: MuellabfuhrConfig | undefined): string {
  const names = (cfg?.path ?? []).map((p) => p.name).filter(Boolean);
  // "Bad Dürrenberg › Bad Dürrenberg › Straße" → drop consecutive duplicates
  return names.filter((n, i) => i === 0 || n !== names[i - 1]).join(", ");
}

/** "Biomüll (Friedrichshöhe)" → "Biomüll" (the ICS export appends the location name). */
export function stripLocationSuffix(summary: string, locationName: string): string {
  const s = summary.trim();
  const suffix = ` (${locationName.trim()})`;
  if (locationName.trim() && s.endsWith(suffix)) {
    return s.slice(0, -suffix.length).trim();
  }
  return s.replace(/\s+\([^()]*\)$/, "").trim();
}

/** Minimal reader for the portal's ICS export → pickups (date + fraction name). */
export function parsePortalIcs(ics: string, locationName: string): MuellabfuhrPickup[] {
  const out: MuellabfuhrPickup[] = [];
  let summary = "";
  let date = "";
  let inEvent = false;
  let inAlarm = false;
  for (const raw of ics.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      summary = "";
      date = "";
    } else if (line === "BEGIN:VALARM") {
      inAlarm = true;
    } else if (line === "END:VALARM") {
      inAlarm = false;
    } else if (line === "END:VEVENT") {
      if (inEvent && summary && date) {
        out.push({ date, fraction: { id: "", name: stripLocationSuffix(summary, locationName) } });
      }
      inEvent = false;
    } else if (inEvent && !inAlarm && /^SUMMARY[;:]/.test(line)) {
      summary = line.slice(line.indexOf(":") + 1);
    } else if (inEvent && !inAlarm && /^DTSTART[;:]/.test(line)) {
      const v = line.slice(line.indexOf(":") + 1);
      const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
      date = m ? `${m[1]}-${m[2]}-${m[3]}` : "";
    }
  }
  return out;
}

/** Single-line title; "gelbe Tonne/Leichtverpackungen" → "gelbe Tonne - Leichtverpackungen" (shared parser drops "/"). */
function icsEscape(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/\s*\/\s*/g, " - ")
    // The shared parser keeps only [A-Za-zäöüÄÖÜß0-9 -]: map what would otherwise vanish.
    .replace(/[–—‐]/g, "-")
    .replace(/[éèêë]/g, "e")
    .replace(/[áàâ]/g, "a")
    .replace(/[íìî]/g, "i")
    .replace(/[óòô]/g, "o")
    .replace(/[úùû]/g, "u")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Render pickups as a small all-day ICS so they run through the shared parser / cache / MQTT path. */
export function pickupsToIcs(pickups: MuellabfuhrPickup[]): string {
  const seen = new Set<string>();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//loxberry-abfallio//muellabfuhr-deutschland//DE"];
  for (const p of pickups) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.date);
    const name = p.fraction.name.trim();
    if (!m || !name) continue;
    const key = `${p.date}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push("BEGIN:VEVENT", `DTSTART;VALUE=DATE:${m[1]}${m[2]}${m[3]}`, `SUMMARY:${icsEscape(name)}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Download the schedule: upcoming pickups (JSON) plus the ICS export of the next year
 * (published around December; empty until then). The next-year export needs the fraction ids,
 * taken from the JSON pickups and remembered in the config for the days when no pickup is left.
 */
export async function fetchMuellabfuhr(
  cfg: MuellabfuhrConfig,
  now = new Date(),
): Promise<{ ics: string; config: MuellabfuhrConfig; count: number }> {
  if (!isMuellabfuhrAddressComplete(cfg)) {
    throw new Error("muellabfuhr-deutschland.de: no address saved – please select it on the Location tab.");
  }
  const m = cfg.mandator!.id;
  const loc = cfg.path!.at(-1)!;
  const base = `/mandators/${m}/cal/location/${loc.id}`;

  const raw = await getJson<Array<{ date?: unknown; fraction?: { id?: unknown; name?: unknown } }>>(`${base}/pickups`);
  const pickups: MuellabfuhrPickup[] = raw
    .map((p) => ({
      date: String(p.date ?? ""),
      fraction: { id: String(p.fraction?.id ?? ""), name: String(p.fraction?.name ?? "") },
    }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.fraction.name.trim() !== "");
  log.info(`muellabfuhr-deutschland.de ${m}/${loc.name}: ${pickups.length} upcoming pickups`);

  const fractionIds = [
    ...new Set([...(cfg.fraction_ids ?? []), ...pickups.map((p) => p.fraction.id)].filter((id) => FRACTION_RE.test(id))),
  ];

  const nextYear = now.getFullYear() + 1;
  if (fractionIds.length > 0) {
    const qs = new URLSearchParams({ year: String(nextYear) });
    for (const id of fractionIds) qs.append("fractionIds", id);
    try {
      const { text, status } = await getText(`${base}/pickups/ics?${qs.toString()}`);
      if (status === 200 && text.includes("VCALENDAR")) {
        const extra = parsePortalIcs(text, loc.name);
        log.info(`muellabfuhr-deutschland.de ${m}/${loc.name}: ${extra.length} pickups for ${nextYear}`);
        pickups.push(...extra);
      } else {
        log.debug(`muellabfuhr-deutschland.de ICS ${nextYear}: status ${status}`);
      }
    } catch (err) {
      log.debug(`muellabfuhr-deutschland.de ICS ${nextYear} failed: ${String(err)}`);
    }
  }

  if (pickups.length === 0) {
    throw new Error("muellabfuhr-deutschland.de returned no collection dates for this address.");
  }
  return { ics: pickupsToIcs(pickups), config: { ...cfg, fraction_ids: fractionIds }, count: pickups.length };
}
