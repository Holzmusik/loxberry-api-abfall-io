/**
 * Address selection and download for api.abfall.io customers, covering both API generations:
 *
 * - **legacy** (form API, `POST api.abfall.io?key=…&modus=…&waction=…`): many customers start with a
 *   municipality select (`f_id_kommune`), some add a district (`f_id_bezirk`), then street and house number.
 *   Every step must be submitted (`auswahl_*_set`) so that the hidden `f_posts_json[]` token carries the
 *   server-side state the final `export_ics` needs. The original plugin only handled "street first" and showed
 *   municipalities as streets (issues #24, #25).
 * - **v3** (GraphQL, `GET api.abfall.io?key=…` → `{ apiKey }`, then `widgets.abfall.io/graphql`): customers
 *   that migrated answer 401 on the legacy endpoint or return JSON on init (issues #11, #22). Address:
 *   city → (district) → street → house number; any level may already carry the final `idHouseNumber`.
 *
 * The admin UI walks the levels with {@link nextStep}; the state is stateless on the server side and every
 * step replays the previous ones (a handful of small requests, only while the user clicks through).
 */
import { log } from "./logger.js";
import { pickupsToIcs, type MuellabfuhrPickup } from "./muellabfuhr-service.js";

const API_URL = "https://api.abfall.io";
const GQL_URL = "https://widgets.abfall.io/graphql";
const MODUS_KEY = "d6c5855a62cf32a4dadbc2831f0f295f";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0";
const KEY_RE = /^[a-f0-9]{32}$/;

export type AbfallioApi = "legacy" | "v3";
export type AbfallioLevel = "kommune" | "bezirk" | "strasse" | "hnr";

export interface AbfallioPick {
  id: string;
  name: string;
}

export interface AbfallioItem extends AbfallioPick {
  /** v3: the pick already identifies the address (no further level needed). */
  house_id?: string;
}

/** Address chosen so far (and, once saved, stored in `config.location`). */
export interface AbfallioCascadeState {
  api?: AbfallioApi;
  kommune?: AbfallioPick;
  bezirk?: AbfallioPick;
  strasse?: AbfallioPick;
  hnr?: AbfallioPick;
  /** v3: final idHouseNumber. */
  house_id?: string;
}

export type AbfallioStep =
  | { done: false; api: AbfallioApi; level: AbfallioLevel; items: AbfallioItem[] }
  | { done: true; api: AbfallioApi; complete: boolean; house_id?: string };

async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams } = {},
  timeoutMs = 30_000,
): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: controller.signal });
    return { text: await r.text(), status: r.status };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ legacy form API */

export interface LegacyForm {
  hidden: Record<string, string>;
  selects: Record<string, AbfallioPick[]>;
}

/** Hidden inputs and `<select>` options of a legacy form response ("0"/empty placeholder options dropped). */
export function parseLegacyForm(html: string): LegacyForm {
  const hidden: Record<string, string> = {};
  for (const tag of html.match(/<input\b[^>]*type=["']hidden["'][^>]*>/gi) ?? []) {
    const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
    if (name) hidden[name] = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
  }
  const selects: Record<string, AbfallioPick[]> = {};
  for (const m of html.matchAll(/<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    selects[m[1]] = [...m[2].matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>([^<]*)/gi)]
      .map((o) => ({ id: o[1].trim(), name: o[2].replace(/\s+/g, " ").trim() }))
      .filter((o) => o.id !== "" && o.id !== "0" && o.name !== "");
  }
  return { hidden, selects };
}

async function legacyPost(key: string, waction: string, args: Record<string, string>): Promise<{ text: string; status: number }> {
  const qs = new URLSearchParams({ key, modus: MODUS_KEY, waction });
  return request(`${API_URL}?${qs.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(args),
  });
}

/**
 * Replay the legacy form up to the given state. Returns the accumulated form args (hidden token + chosen ids)
 * and the selects offered by the last response.
 */
async function legacyReplay(key: string, state: AbfallioCascadeState): Promise<{ args: Record<string, string>; form: LegacyForm }> {
  const init = await legacyPost(key, "init", {});
  if (init.status !== 200) {
    throw new Error(`abfall.io init failed with status ${init.status}`);
  }
  let form = parseLegacyForm(init.text);
  let args: Record<string, string> = { ...form.hidden };
  const steps: Array<[keyof AbfallioCascadeState, string, string]> = [
    ["kommune", "f_id_kommune", "auswahl_kommune_set"],
    ["bezirk", "f_id_bezirk", "auswahl_bezirk_set"],
    ["strasse", "f_id_strasse", "auswahl_strasse_set"],
    ["hnr", "f_id_strasse_hnr", "auswahl_hnr_set"],
  ];
  for (const [k, field, waction] of steps) {
    const pick = state[k] as AbfallioPick | undefined;
    if (!pick) continue;
    args[field] = pick.id;
    const r = await legacyPost(key, waction, args);
    if (r.status !== 200) {
      throw new Error(`abfall.io ${waction} failed with status ${r.status}`);
    }
    form = parseLegacyForm(r.text);
    args = { ...args, ...form.hidden };
  }
  return { args, form };
}

const LEGACY_LEVELS: Array<[AbfallioLevel, string]> = [
  ["kommune", "f_id_kommune"],
  ["bezirk", "f_id_bezirk"],
  ["strasse", "f_id_strasse"],
  ["hnr", "f_id_strasse_hnr"],
];

async function legacyNextStep(key: string, state: AbfallioCascadeState): Promise<AbfallioStep> {
  const { form } = await legacyReplay(key, state);
  for (const [level, field] of LEGACY_LEVELS) {
    if (state[level]) continue;
    const items = form.selects[field];
    if (items && items.length > 0) {
      return { done: false, api: "legacy", level, items };
    }
  }
  return { done: true, api: "legacy", complete: !!state.strasse };
}

/** Download the legacy ICS export for a saved (stepped) address. */
export async function legacyFetchIcs(key: string, state: AbfallioCascadeState, now = new Date()): Promise<string> {
  const { args } = await legacyReplay(key, state);
  const later = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
  const ymd = (d: Date): string =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const r = await legacyPost(key, "export_ics", {
    ...args,
    f_zeitraum: `${ymd(now)}-${ymd(later)}`,
    f_abfallarten_index_max: "0",
    f_abfallarten: "",
  });
  if (r.status !== 200 || !r.text.includes("VCALENDAR")) {
    throw new Error(`abfall.io export failed (status ${r.status})`);
  }
  // Some customers append HTML warnings (<b>…) to the ICS body.
  return r.text.replace(/<br[^\n]*|<b[^\n]*/gi, "");
}

/* ------------------------------------------------------------------ v3 GraphQL API */

interface V3Config {
  apiKey: string;
  wasteTypes: string[];
}

async function v3Config(key: string): Promise<V3Config | null> {
  const r = await request(`${API_URL}?key=${key}`);
  if (r.status !== 200 || !r.text.trim().startsWith("{")) return null;
  const cfg = JSON.parse(r.text) as { apiKey?: string; settings?: { PUB_ABFALLTYPEN?: Array<{ wasteType?: string; checked?: boolean }> } };
  if (!cfg.apiKey) return null;
  const wasteTypes = (cfg.settings?.PUB_ABFALLTYPEN ?? []).filter((w) => w.checked && w.wasteType).map((w) => String(w.wasteType));
  return { apiKey: cfg.apiKey, wasteTypes };
}

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await request(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-abfallplus-api-key": apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const body = JSON.parse(r.text) as { data?: T; errors?: unknown };
  if (r.status !== 200 || body.errors || !body.data) {
    throw new Error(`abfall.io GraphQL error (status ${r.status}): ${JSON.stringify(body.errors ?? "").slice(0, 200)}`);
  }
  return body.data;
}

type V3Node = { id: string; name: string; idHouseNumber?: string | null; districtsCount?: number };

const toItems = (nodes: V3Node[]): AbfallioItem[] =>
  nodes
    .map((n) => ({ id: String(n.id), name: String(n.name ?? "").trim(), ...(n.idHouseNumber ? { house_id: String(n.idHouseNumber) } : {}) }))
    .filter((n) => n.id !== "" && n.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name, "de"));

async function v3NextStep(apiKey: string, state: AbfallioCascadeState): Promise<AbfallioStep> {
  if (state.house_id) {
    return { done: true, api: "v3", complete: true, house_id: state.house_id };
  }
  if (!state.kommune) {
    const d = await gql<{ cities: V3Node[] }>(apiKey, "query($query:String){cities(query:$query){id name idHouseNumber districtsCount}}", { query: "" });
    return { done: false, api: "v3", level: "kommune", items: toItems(d.cities) };
  }
  if (!state.bezirk && !state.strasse) {
    const d = await gql<{ city: { districts: V3Node[] } | null }>(apiKey, "query($cityId:ID!){city(id:$cityId){districts{id name idHouseNumber}}}", { cityId: state.kommune.id });
    const districts = toItems(d.city?.districts ?? []);
    // A single district that merely repeats the city adds no information — skip it.
    if (districts.length > 1) {
      return { done: false, api: "v3", level: "bezirk", items: districts };
    }
  }
  if (!state.strasse) {
    const parent = state.bezirk ? "district" : "city";
    const d = await gql<Record<string, { streets: V3Node[] } | null>>(
      apiKey,
      `query($id:ID!){${parent}(id:$id){streets{id name idHouseNumber}}}`,
      { id: state.bezirk?.id ?? state.kommune.id },
    );
    const streets = toItems(d[parent]?.streets ?? []);
    if (streets.length > 0) {
      return { done: false, api: "v3", level: "strasse", items: streets };
    }
    return { done: true, api: "v3", complete: false };
  }
  const d = await gql<{ street: { houseNumbers: V3Node[] } | null }>(
    apiKey,
    "query($streetId:ID!,$idDistrict:ID){street(id:$streetId){houseNumbers(idDistrict:$idDistrict){id name}}}",
    { streetId: state.strasse.id, idDistrict: state.bezirk?.id ?? null },
  );
  const hnrs = (d.street?.houseNumbers ?? []).map((h) => ({ id: String(h.id), name: String(h.name ?? "").trim(), house_id: String(h.id) }));
  if (hnrs.length === 1) {
    return { done: true, api: "v3", complete: true, house_id: hnrs[0].house_id };
  }
  return hnrs.length > 0 ? { done: false, api: "v3", level: "hnr", items: hnrs } : { done: true, api: "v3", complete: false };
}

/** Collection dates for a v3 idHouseNumber (default waste types of the customer, next ~13 months). */
export async function v3FetchIcs(key: string, houseId: string, now = new Date()): Promise<string> {
  const cfg = await v3Config(key);
  if (!cfg) {
    throw new Error("abfall.io rejected the service key for the v3 API.");
  }
  const later = new Date(now.getTime() + 400 * 24 * 3600 * 1000);
  const iso = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const d = await gql<{ appointments: Array<{ date: string; wasteType: { id?: string; name: string } }> }>(
    cfg.apiKey,
    "query($idHouseNumber:ID!,$wasteTypes:[ID],$dateMin:Date,$dateMax:Date,$showInactive:Boolean){appointments(idHouseNumber:$idHouseNumber,wasteTypes:$wasteTypes,dateMin:$dateMin,dateMax:$dateMax,showInactive:$showInactive){date wasteType{name}}}",
    {
      idHouseNumber: houseId,
      wasteTypes: cfg.wasteTypes.length ? cfg.wasteTypes : null,
      dateMin: iso(now),
      dateMax: iso(later),
      showInactive: false,
    },
  );
  const pickups: MuellabfuhrPickup[] = (d.appointments ?? []).map((a) => ({
    date: String(a.date).slice(0, 10),
    fraction: { id: "", name: a.wasteType?.name ?? "" },
  }));
  log.info(`abfall.io v3: ${pickups.length} appointments for idHouseNumber ${houseId}`);
  if (pickups.length === 0) {
    throw new Error("abfall.io returned no collection dates for this address.");
  }
  return pickupsToIcs(pickups);
}

/* ------------------------------------------------------------------ dispatch */

/** Which API generation a service key belongs to (or null when abfall.io rejects it on both). */
export async function detectApi(key: string): Promise<{ api: AbfallioApi; v3?: V3Config } | null> {
  const legacy = await legacyPost(key, "init", {});
  if (legacy.status === 200 && !legacy.text.trim().startsWith("{")) {
    return { api: "legacy" };
  }
  const v3 = await v3Config(key);
  return v3 ? { api: "v3", v3 } : null;
}

export async function nextStep(key: string, state: AbfallioCascadeState): Promise<AbfallioStep> {
  if (!KEY_RE.test(key)) {
    throw new Error("No valid service key configured");
  }
  if (state.api === "legacy") return legacyNextStep(key, state);
  if (state.api === "v3") {
    const cfg = await v3Config(key);
    if (!cfg) throw new Error("abfall.io rejected the service key for the v3 API.");
    return v3NextStep(cfg.apiKey, state);
  }
  const det = await detectApi(key);
  if (!det) {
    throw new Error(
      "abfall.io rejects this service key. The operator has probably moved to the new abfall.io API with a new key — " +
        "look up the current key on the operator's waste calendar page (browser network tab, request to api.abfall.io?key=…).",
    );
  }
  log.info(`abfall.io key uses the ${det.api} API`);
  return det.api === "legacy" ? legacyNextStep(key, { ...state, api: "legacy" }) : v3NextStep(det.v3!.apiKey, { ...state, api: "v3" });
}

function sanitizePick(v: unknown): AbfallioPick | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { id, name } = v as Record<string, unknown>;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) return undefined;
  return { id, name: typeof name === "string" ? name.slice(0, 200) : "" };
}

export function sanitizeCascadeState(input: unknown): AbfallioCascadeState {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: AbfallioCascadeState = {};
  if (o.api === "legacy" || o.api === "v3") out.api = o.api;
  for (const k of ["kommune", "bezirk", "strasse", "hnr"] as const) {
    const p = sanitizePick(o[k]);
    if (p) out[k] = p;
  }
  if (typeof o.house_id === "string" && /^\d{1,12}$/.test(o.house_id)) out.house_id = o.house_id;
  return out;
}

/** Saved address is usable: legacy needs a street, v3 the idHouseNumber. */
export function isCascadeComplete(state: AbfallioCascadeState): boolean {
  return state.api === "v3" ? !!state.house_id : state.api === "legacy" ? !!state.strasse : false;
}

export function cascadeLabel(state: AbfallioCascadeState): string {
  const place = [state.kommune?.name, state.bezirk?.name].filter(Boolean);
  const dedup = place.filter((n, i) => i === 0 || n !== place[i - 1]).join(" / ");
  const hnr = state.hnr?.name && !/^alle\b/i.test(state.hnr.name) ? state.hnr.name : "";
  const street = [state.strasse?.name, hnr].filter(Boolean).join(" ");
  return [dedup, street].filter(Boolean).join(", ");
}
