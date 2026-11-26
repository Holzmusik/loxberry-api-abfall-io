export interface LocationConfig {
  f_id_kommune?: string;
  f_id_strasse?: string;
  f_id_strasse_hnr?: string;
  street_name?: string;
  hnr_name?: string;
}

export interface MqttConfig {
  enabled?: boolean;
  use_loxberry_broker?: boolean;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  topic_prefix?: string;
  retain?: boolean;
}

export interface MqttPublishStatus {
  ok: boolean;
  last: string;
  message?: string;
  topics_published?: number;
  broker?: string;
}

/** One chosen entry of the hausmuell.info address cascade. */
export interface HausmuellPick {
  id: string;
  name: string;
}

/** Address on an ATURIS hausmuell.info portal (`https://<subdomain>.hausmuell.info/`). */
export interface HausmuellConfig {
  subdomain?: string;
  ort?: HausmuellPick;
  ortsteil?: HausmuellPick;
  strasse?: HausmuellPick;
  hnr?: HausmuellPick;
  /** Entsorgungsgebiet id – the value that actually selects the calendar. */
  egebiet?: string;
  /** Cached `check_zusatz` result (front/back house); re-resolved when empty. */
  zusatz_id?: string;
}

/** One node chosen on portal.muellabfuhr-deutschland.de (district or location UUID). */
export interface MuellabfuhrPick {
  id: string;
  name: string;
}

/** Address on portal.muellabfuhr-deutschland.de. */
export interface MuellabfuhrConfig {
  /** District ("mandator"), e.g. { id: "7", name: "Landkreis Hildburghausen" }. */
  mandator?: MuellabfuhrPick;
  /** Chosen location nodes from the root down (Ort, Ortsteil, Straße); the last one is used. */
  path?: MuellabfuhrPick[];
  /** Fraction ids seen so far (needed for the next-year ICS export). */
  fraction_ids?: string[];
}

/** One chosen AWIDO node (place / street / house number, all UUIDs). */
export interface AwidoPick {
  id: string;
  name: string;
}

/** Address on an AWIDO (cubefour) customer. */
export interface AwidoConfig {
  /** Customer key, e.g. "awhas" (Landkreis Haßberge). */
  customer?: string;
  place?: AwidoPick;
  street?: AwidoPick;
  hnr?: AwidoPick;
}

/** One chosen offizium node (Gemeinde / Ortsteil, numeric ids). */
export interface OffiziumPick {
  id: string;
  name: string;
}

/** Address on an offizium "Abfuhr-Wecker" district (e.g. Landkreis Rhön-Grabfeld). */
export interface OffiziumConfig {
  instance?: string;
  city?: OffiziumPick;
  area?: OffiziumPick;
}

/** Which upstream delivers the schedule. Missing = `abfallio` (configs from before 1.6). */
export type ProviderId = "abfallio" | "hausmuell" | "muellabfuhr" | "awido" | "offizium";

export interface PluginConfig {
  provider?: ProviderId;
  hausmuell?: HausmuellConfig;
  muellabfuhr?: MuellabfuhrConfig;
  awido?: AwidoConfig;
  offizium?: OffiziumConfig;
  service_key?: string;
  /**
   * Optional https URL: JSON array of { title, url, service_id } or the upstream
   * `AbfallIO.py` from mampfes/hacs_waste_collection_schedule (default if unset).
   * Host must be on the GitHub allowlist.
   */
  service_map_url?: string;
  language?: string;
  location?: LocationConfig;
  fetch_interval_hours?: number;
  fetch_fuzz_minutes?: number;
  categories_filter?: string[];
  mqtt?: MqttConfig;
}

export interface WasteEntry {
  tage: number;
  datum: string;
  /** Localized weekday (UI / MQTT string). */
  wochentag: string;
  /**
   * ISO weekday number 1 = Monday … 7 = Sunday (Loxone-friendly; optional on old caches).
   */
  wochentag_num?: number;
}

export interface WasteData {
  timestamp: string;
  standort: string;
  location: string;
  termine: Record<string, WasteEntry>;
  next_fetch_due?: string;
  next_fetch_offset_minutes?: number;
  mqtt?: MqttPublishStatus;
}

export interface ApiStatus {
  cookie_status: string;
  cookie_created: string;
  cookie_expires: string;
  client_id: string;
  last_fetch: string;
  next_fetch_due: string;
  location: string;
  /** True if a 32-hex service key is stored. */
  has_region: boolean;
  /** Human name from service map, or short key hint if unknown. */
  region_title: string;
  /** True if a street (f_id_strasse) is stored. */
  has_street: boolean;
  location_api: string;
  termine_count: number;
  cached_data: Partial<WasteData> | Record<string, never>;
  api_mode: string;
  mqtt: MqttPublishStatus;
  /**
   * LoxBerry merged cron at `system/cron/cron.d/<FOLDER>` (see plugin `FOLDER` in `plugin.cfg`).
   * Omitted in dev or when $LBHOMEDIR / plugin id cannot be inferred.
   */
  install_cron?: {
    merged_cron_path: string;
    file_exists: boolean;
    /** True = unexpanded `REPLACELB*` in file (node would log MODULE_NOT_FOUND). */
    replacelb_placeholder_found: boolean;
    /** Cron invokes `run_fetch.sh` (runtime Node resolution) instead of a hard-coded binary. */
    uses_fetch_wrapper: boolean;
    /** Cron calls `fetch.cjs` via an absolute `…/node …/fetch.cjs` path. */
    hardcoded_node_invocation: boolean;
    /** Legacy cron likely broken when Node is not at the hard-coded path (see issue #12). */
    node_path_likely_broken: boolean;
  } | null;
  /** Which region list file is in use (bundled in plugin vs downloaded to user data). */
  service_map?: {
    source: "user" | "bundled" | "none";
    count: number;
  };
  /** False until the user has saved a 32-hex abfall.io service key in Settings. */
  service_key_configured?: boolean;
  /** Active upstream (`abfallio` default). */
  provider?: ProviderId;
}

export interface SearchItem {
  id: string;
  name: string;
}
