/**
 * Fifth upstream: offizium "Abfuhr-Wecker" (sqronline.de), the waste module of offizium's municipal
 * web platform. Known user: Landkreis Rhön-Grabfeld (abfallinfo-rhoen-grabfeld.de — the website itself
 * only offers a PDF, the app/"Abfuhr-Wecker" uses this API).
 *
 * One request returns everything for the district:
 *   GET https://<host>/api/modules/abfall/webshow?module_division_uuid=<uuid>
 *   → { mdiv.config: { cities[{id,name}], areas[{id,name,city_id}], abfall_types{normal[],special[]} },
 *       abfall_dates[{ date: "YYYY-MM-DD", abfall_city_id, abfall_area_id, abfall_type_id }] }
 * (~2.8 MB, dates up to the end of the next year). "special" types other than hazardous-waste collections
 * are recycling-centre opening hours and are skipped.
 */
import { log } from "./logger.js";
import { pickupsToIcs, type MuellabfuhrPickup } from "./muellabfuhr-service.js";
import type { OffiziumConfig, OffiziumPick } from "./types.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0";
const ID_RE = /^\d{1,9}$/;

export interface OffiziumInstance {
  id: string;
  title: string;
  url: string;
  host: string;
  division: string;
}

/** Districts on the platform. Only Rhön-Grabfeld is known (Home Assistant `landkreis_rhoen_grabfeld`). */
export const OFFIZIUM_INSTANCES: OffiziumInstance[] = [
  {
    id: "rhoen-grabfeld",
    title: "Landkreis Rhön-Grabfeld",
    url: "https://www.abfallinfo-rhoen-grabfeld.de/",
    host: "aht1gh-api.sqronline.de",
    division: "fde08d95-111b-11ef-bbd4-b2fd53c2005a",
  },
];

export type OffiziumLevel = "city" | "area";

export interface OffiziumItem {
  id: string;
  name: string;
}

export interface OffiziumState {
  instance?: string;
  city?: OffiziumPick;
  area?: OffiziumPick;
}

export type OffiziumStep =
  | { done: false; level: OffiziumLevel; items: OffiziumItem[] }
  | { done: true; complete: boolean };

interface WebshowType {
  id?: unknown;
  name?: unknown;
}

export interface OffiziumWebshow {
  mdiv?: {
    config?: {
      cities?: Array<{ id?: unknown; name?: unknown }>;
      areas?: Array<{ id?: unknown; name?: unknown; city_id?: unknown }>;
      abfall_types?: { normal?: WebshowType[]; special?: WebshowType[] };
    };
  };
  abfall_dates?: Array<{ date?: unknown; abfall_city_id?: unknown; abfall_area_id?: unknown; abfall_type_id?: unknown }>;
}

export function findInstance(id: string | undefined): OffiziumInstance | undefined {
  return OFFIZIUM_INSTANCES.find((i) => i.id === id);
}

export async function loadWebshow(inst: OffiziumInstance, timeoutMs = 60_000): Promise<OffiziumWebshow> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://${inst.host}/api/modules/abfall/webshow?module_division_uuid=${encodeURIComponent(inst.division)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal });
    if (r.status !== 200) {
      throw new Error(`offizium ${inst.id} request failed with status ${r.status}`);
    }
    return (await r.json()) as OffiziumWebshow;
  } finally {
    clearTimeout(timer);
  }
}

const byName = (a: OffiziumItem, b: OffiziumItem): number => a.name.localeCompare(b.name, "de");

export function citiesOf(data: OffiziumWebshow): OffiziumItem[] {
  return (data.mdiv?.config?.cities ?? [])
    .map((c) => ({ id: String(c.id ?? ""), name: String(c.name ?? "").trim() }))
    .filter((c) => ID_RE.test(c.id) && c.name !== "")
    .sort(byName);
}

export function areasOf(data: OffiziumWebshow, cityId: string): OffiziumItem[] {
  return (data.mdiv?.config?.areas ?? [])
    .filter((a) => String(a.city_id ?? "") === cityId)
    .map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? "").trim() }))
    .filter((a) => ID_RE.test(a.id) && a.name !== "")
    .sort(byName);
}

/** Waste types to report: all "normal" ones plus special ones that are not recycling-centre opening hours. */
export function wasteTypesOf(data: OffiziumWebshow): Map<string, string> {
  const types = new Map<string, string>();
  const cfg = data.mdiv?.config?.abfall_types;
  for (const t of cfg?.normal ?? []) {
    if (t.id != null && t.name) types.set(String(t.id), String(t.name).trim());
  }
  for (const t of cfg?.special ?? []) {
    const name = String(t.name ?? "").trim();
    if (t.id != null && name && !/wertstoff/i.test(name)) types.set(String(t.id), name);
  }
  return types;
}

export function pickupsFor(data: OffiziumWebshow, cityId: string, areaId: string): MuellabfuhrPickup[] {
  const types = wasteTypesOf(data);
  const out: MuellabfuhrPickup[] = [];
  for (const e of data.abfall_dates ?? []) {
    if (String(e.abfall_city_id ?? "") !== cityId || String(e.abfall_area_id ?? "") !== areaId) continue;
    const typeId = String(e.abfall_type_id ?? "");
    const name = types.get(typeId);
    const date = String(e.date ?? "").slice(0, 10);
    if (name && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      out.push({ date, fraction: { id: typeId, name } });
    }
  }
  return out;
}

/** Next level for the admin UI (Gemeinde → Ortsteil), or done. */
export async function nextStep(state: OffiziumState, load = loadWebshow): Promise<OffiziumStep> {
  const inst = findInstance(state.instance);
  if (!inst) {
    throw new Error("Unknown offizium district");
  }
  if (state.city && state.area) {
    return { done: true, complete: true };
  }
  const data = await load(inst);
  if (!state.city) {
    return { done: false, level: "city", items: citiesOf(data) };
  }
  const areas = areasOf(data, state.city.id);
  return areas.length > 0 ? { done: false, level: "area", items: areas } : { done: true, complete: false };
}

function sanitizePick(v: unknown): OffiziumPick | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { id, name } = v as Record<string, unknown>;
  if (typeof id !== "string" || !ID_RE.test(id)) return undefined;
  return { id, name: typeof name === "string" ? name.slice(0, 200) : "" };
}

export function sanitizeOffiziumState(input: unknown): OffiziumState {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: OffiziumState = {};
  if (typeof o.instance === "string" && findInstance(o.instance)) out.instance = o.instance;
  const city = sanitizePick(o.city);
  if (city) out.city = city;
  const area = city ? sanitizePick(o.area) : undefined;
  if (area) out.area = area;
  return out;
}

export function isOffiziumAddressComplete(cfg: OffiziumConfig | undefined): boolean {
  return !!cfg && !!findInstance(cfg.instance) && !!cfg.city?.id && !!cfg.area?.id;
}

export function offiziumLocationLabel(cfg: OffiziumConfig | undefined): string {
  if (!cfg) return "";
  const city = cfg.city?.name ?? "";
  const area = cfg.area?.name && cfg.area.name !== city ? cfg.area.name : "";
  return [city, area].filter(Boolean).join(", ");
}

export async function fetchOffizium(cfg: OffiziumConfig, load = loadWebshow): Promise<{ ics: string; count: number }> {
  const inst = findInstance(cfg.instance);
  if (!inst || !isOffiziumAddressComplete(cfg)) {
    throw new Error("offizium: no address saved – please select it on the Location tab.");
  }
  const data = await load(inst);
  const pickups = pickupsFor(data, cfg.city!.id, cfg.area!.id);
  log.info(`offizium ${inst.id} ${offiziumLocationLabel(cfg)}: ${pickups.length} pickups`);
  if (pickups.length === 0) {
    throw new Error("offizium returned no collection dates for this address.");
  }
  return { ics: pickupsToIcs(pickups), count: pickups.length };
}
