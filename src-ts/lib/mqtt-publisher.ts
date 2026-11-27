import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";
import type { MqttConfig, MqttPublishStatus, WasteData } from "./types.js";

export interface ResolvedBroker {
  host: string;
  port: number;
  user: string;
  password: string;
  source: string;
}

const DEFAULT_PREFIX = "loxberry/abfallio";

function nowTs(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Try to read LoxBerry's built-in MQTT broker credentials. LoxBerry 3 stores
 * the active MQTT broker config in `${LBHOMEDIR}/config/system/general.json`
 * under the "Mqtt" key. Older versions used several other locations as well,
 * which we still probe as a fallback. Returns the first match or null.
 */
export function loadLoxBerryBrokerCredentials(lbhomedir: string): ResolvedBroker | null {
  if (!lbhomedir) return null;

  const generalJson = path.join(lbhomedir, "config", "system", "general.json");
  try {
    if (fs.existsSync(generalJson)) {
      const raw = JSON.parse(fs.readFileSync(generalJson, "utf-8")) as Record<string, unknown>;
      const mqtt = (raw.Mqtt ?? raw.mqtt ?? raw.MQTT) as Record<string, unknown> | undefined;
      if (mqtt && typeof mqtt === "object") {
        const broker = readBrokerFields(mqtt);
        if (broker) {
          return { ...broker, source: generalJson };
        }
      }
    }
  } catch (err) {
    log.debug(`Could not parse ${generalJson}: ${String(err)}`);
  }

  const credentialFiles = [
    path.join(lbhomedir, "system", "storage", "mqtt", "cred.json"),
    path.join(lbhomedir, "data", "system", "storage", "mqtt", "cred.json"),
    path.join(lbhomedir, "data", "system", "mqtt", "cred.json"),
    path.join(lbhomedir, "data", "plugins", "mqttgateway", "cred.json"),
    path.join(lbhomedir, "config", "plugins", "mqttgateway", "cred.json"),
  ];
  for (const file of credentialFiles) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      const broker =
        readBrokerFields(raw) ??
        readBrokerFields((raw.Mqtt ?? raw.mqtt ?? {}) as Record<string, unknown>);
      if (broker) {
        return { ...broker, source: file };
      }
    } catch (err) {
      log.debug(`Could not parse ${file}: ${String(err)}`);
    }
  }

  for (const cfg of [
    path.join(lbhomedir, "config", "system", "general.cfg"),
    path.join(lbhomedir, "system", "general.cfg"),
  ]) {
    try {
      if (!fs.existsSync(cfg)) continue;
      const text = fs.readFileSync(cfg, "utf-8");
      const section = parseIniSection(text, "MQTT") ?? parseIniSection(text, "Mqtt");
      if (section) {
        const broker = readBrokerFields(section);
        if (broker) {
          return { ...broker, source: cfg };
        }
      }
    } catch (err) {
      log.debug(`Could not read ${cfg}: ${String(err)}`);
    }
  }

  return null;
}

function readBrokerFields(raw: Record<string, unknown>): Omit<ResolvedBroker, "source"> | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    lower[k.toLowerCase()] = v;
  }
  const hostRaw = lower.brokerhost ?? lower.host ?? lower.brokeraddress;
  if (!hostRaw) return null;
  let host = String(hostRaw);
  let port = Number(lower.brokerport ?? lower.port ?? 1883);
  if (host.includes(":")) {
    const [h, p] = host.split(":");
    host = h;
    if (p) port = Number(p);
  }
  if (!Number.isFinite(port)) port = 1883;
  const user = String(lower.brokeruser ?? lower.user ?? "");
  const password = String(lower.brokerpass ?? lower.pass ?? lower.password ?? "");
  return { host, port, user, password };
}

function parseIniSection(text: string, section: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  const out: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inSection = line.toLowerCase() === `[${section.toLowerCase()}]`;
      continue;
    }
    if (!inSection || line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface MqttPublishOptions {
  config: MqttConfig;
  data: WasteData;
  /** Category slugs published last time; topics of slugs no longer present are cleared. */
  previousSlugs?: string[];
  lbhomedir?: string;
  /**
   * Allows tests to inject a fake mqtt connection. Must accept the resolved options
   * (host, port, user, password) and return an object exposing publish + end methods.
   */
  connect?: (opts: ConnectArgs) => Promise<MqttClientLike>;
}

export interface ConnectArgs {
  host: string;
  port: number;
  user: string;
  password: string;
  clientId: string;
}

export interface MqttClientLike {
  publish(topic: string, payload: string, options: { retain: boolean; qos: 0 | 1 | 2 }): Promise<void>;
  end(): Promise<void>;
}

export function safeTopicSegment(value: string): string {
  if (!value) return "unknown";
  const stripped = value
    .replace(/ä/g, "ae")
    .replace(/Ä/g, "Ae")
    .replace(/ö/g, "oe")
    .replace(/Ö/g, "Oe")
    .replace(/ü/g, "ue")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return stripped !== "" ? stripped.toLowerCase() : "unknown";
}

/** Payload for "nothing" in list topics: an empty retained payload would delete the topic on the broker. */
export const NONE_PAYLOAD = "-";

/** Seconds between 1970-01-01 and 2009-01-01 (Loxone time base). */
const LOXONE_EPOCH_OFFSET_S = 1_230_768_000;

/** Sub-topics published per category (also cleared when a category disappears). */
export const CATEGORY_SUBTOPICS = [
  "days",
  "date",
  "weekday",
  "weekday_num",
  "category",
  "date_unix",
  "date_lox",
] as const;

/** `DD.MM.YYYY` → [year, monthIndex, day], or null. */
function splitDatum(datum: string): [number, number, number] | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(datum);
  return m ? [Number(m[3]), Number(m[2]) - 1, Number(m[1])] : null;
}

/** Unix seconds of local midnight of `datum`. */
export function datumToUnix(datum: string): number | null {
  const p = splitDatum(datum);
  return p ? Math.floor(new Date(p[0], p[1], p[2]).getTime() / 1000) : null;
}

/**
 * Loxone time of local midnight of `datum`: seconds since 2009-01-01 00:00 in *local* time
 * (Loxone does not count in UTC), so a virtual input can show it directly as a date.
 */
export function datumToLoxone(datum: string): number | null {
  const p = splitDatum(datum);
  return p ? Date.UTC(p[0], p[1], p[2]) / 1000 - LOXONE_EPOCH_OFFSET_S : null;
}

/** Unix seconds of the last successful fetch (older caches: parsed from `timestamp`). */
function lastSuccessUnix(data: WasteData): number {
  if (typeof data.last_success_unix === "number") return data.last_success_unix;
  const t = new Date((data.timestamp ?? "").replace(" ", "T")).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** Category slugs (topic segments) of a data set. */
export function categorySlugs(data: WasteData): string[] {
  return [...new Set(Object.keys(data.termine).map((n) => safeTopicSegment(n)))];
}

export function buildPublishMessages(
  prefix: string,
  data: WasteData,
): { topic: string; payload: string }[] {
  const safePrefix = prefix.replace(/\/+$/g, "");
  const messages: { topic: string; payload: string }[] = [];
  const push = (topic: string, payload: string): void => {
    messages.push({ topic: `${safePrefix}/${topic}`, payload });
  };
  // `state` mirrors the cache without internal bookkeeping (date lists, MQTT status).
  const { upcoming: _upcoming, mqtt: _mqtt, ...state } = data;
  push("state", JSON.stringify(state));
  push("last_fetch", data.timestamp);
  push("location", data.location);
  push("categories_count", String(Object.keys(data.termine).length));

  const status = data.status ?? "ok";
  const entries = Object.entries(data.termine);
  const namesIn = (days: number): string[] => entries.filter(([, e]) => e.tage === days).map(([n]) => n);
  const today = namesIn(0);
  const tomorrow = namesIn(1);
  push("status", status);
  push("ok", status === "error" ? "0" : "1");
  push("last_success_unix", String(lastSuccessUnix(data)));
  push("today", today.length > 0 ? today.join(", ") : NONE_PAYLOAD);
  push("today_any", today.length > 0 ? "1" : "0");
  push("tomorrow", tomorrow.length > 0 ? tomorrow.join(", ") : NONE_PAYLOAD);
  push("tomorrow_any", tomorrow.length > 0 ? "1" : "0");
  push("next_days", entries.length > 0 ? String(Math.min(...entries.map(([, e]) => e.tage))) : "-1");

  for (const [name, entry] of entries) {
    const base = `categories/${safeTopicSegment(name)}`;
    push(`${base}/days`, String(entry.tage));
    push(`${base}/date`, entry.datum);
    push(`${base}/weekday`, entry.wochentag);
    push(`${base}/weekday_num`, String(entry.wochentag_num ?? 0));
    push(`${base}/category`, name);
    push(`${base}/date_unix`, String(datumToUnix(entry.datum) ?? 0));
    push(`${base}/date_lox`, String(datumToLoxone(entry.datum) ?? 0));
  }
  return messages;
}

/**
 * Empty retained payloads for every sub-topic of categories that were published before but are
 * gone now (expired, filtered out, end of year) – removes them from the broker.
 */
export function buildClearMessages(
  prefix: string,
  previousSlugs: string[],
  currentSlugs: string[],
): { topic: string; payload: string }[] {
  const safePrefix = prefix.replace(/\/+$/g, "");
  const keep = new Set(currentSlugs);
  const out: { topic: string; payload: string }[] = [];
  for (const slug of new Set(previousSlugs)) {
    if (keep.has(slug)) continue;
    for (const sub of CATEGORY_SUBTOPICS) {
      out.push({ topic: `${safePrefix}/categories/${slug}/${sub}`, payload: "" });
    }
  }
  return out;
}

export async function publishWasteData(
  options: MqttPublishOptions,
): Promise<MqttPublishStatus> {
  const { config, data } = options;
  if (!config.enabled) {
    return { ok: false, last: nowTs(), message: "MQTT disabled" };
  }

  let host = (config.host ?? "").trim();
  let port = Number(config.port ?? 1883);
  let user = config.user ?? "";
  let password = config.password ?? "";
  let source = "manual";

  if (config.use_loxberry_broker !== false) {
    const lbhome = options.lbhomedir ?? process.env.LBHOMEDIR ?? "/opt/loxberry";
    const detected = loadLoxBerryBrokerCredentials(lbhome);
    if (detected) {
      if (!host) host = detected.host;
      if (!port || !Number.isFinite(port)) port = detected.port;
      if (!user) user = detected.user;
      if (!password) password = detected.password;
      source = detected.source;
    }
  }
  if (!host) host = "127.0.0.1";
  if (!Number.isFinite(port) || port <= 0) port = 1883;

  const prefix = config.topic_prefix?.trim() || DEFAULT_PREFIX;
  const retain = config.retain !== false;
  const currentSlugs = categorySlugs(data);
  const previousSlugs = options.previousSlugs ?? [];
  // Clearing only makes sense for retained topics (non-retained ones are not stored anyway).
  const clears = retain ? buildClearMessages(prefix, previousSlugs, currentSlugs) : [];
  const messages = [...buildPublishMessages(prefix, data), ...clears];

  const clientId = `abfallio_${Math.random().toString(16).slice(2, 10)}`;
  const connect = options.connect ?? defaultConnect;
  const broker = `mqtt://${host}:${port}`;
  let client: MqttClientLike | null = null;
  try {
    client = await connect({ host, port, user, password, clientId });
    for (const msg of messages) {
      await client.publish(msg.topic, msg.payload, {
        retain,
        qos: 1,
      });
    }
    const cleared = clears.length / CATEGORY_SUBTOPICS.length;
    log.info(
      `MQTT published ${messages.length - clears.length} topics to ${broker} (prefix='${prefix}', source=${source})` +
        (cleared > 0 ? `, cleared ${cleared} stale categories` : ""),
    );
    return {
      ok: true,
      last: nowTs(),
      topics_published: messages.length,
      broker,
      category_slugs: currentSlugs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`MQTT publish failed (${broker}): ${message}`);
    return {
      ok: false,
      last: nowTs(),
      message,
      broker,
      // Not sure what reached the broker: remember both so the next publish clears leftovers.
      category_slugs: [...new Set([...previousSlugs, ...currentSlugs])],
    };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore close errors
      }
    }
  }
}

async function defaultConnect(args: ConnectArgs): Promise<MqttClientLike> {
  const mqttModule = (await import("mqtt")) as unknown as {
    connectAsync: (
      url: string,
      opts?: { username?: string; password?: string; clientId?: string; connectTimeout?: number },
    ) => Promise<{
      publishAsync: (topic: string, payload: string, opts: { retain: boolean; qos: 0 | 1 | 2 }) => Promise<unknown>;
      endAsync: (force?: boolean) => Promise<void>;
    }>;
  };
  const url = `mqtt://${args.host}:${args.port}`;
  const native = await mqttModule.connectAsync(url, {
    username: args.user || undefined,
    password: args.password || undefined,
    clientId: args.clientId,
    connectTimeout: 8000,
  });
  return {
    publish: async (topic, payload, opts) => {
      await native.publishAsync(topic, payload, opts);
    },
    end: async () => {
      await native.endAsync(false);
    },
  };
}
