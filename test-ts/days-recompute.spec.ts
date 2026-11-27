import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "chai";
import {
  buildTermine,
  calendarDaysBetween,
  collectIcsDates,
  parseIcs,
  recordFetchFailure,
  refreshCachedData,
  retryBackoffHours,
  shouldFetch,
} from "../src-ts/lib/abfall-service.js";
import {
  buildClearMessages,
  buildPublishMessages,
  CATEGORY_SUBTOPICS,
  datumToLoxone,
  datumToUnix,
  NONE_PAYLOAD,
} from "../src-ts/lib/mqtt-publisher.js";
import type { PluginConfig, WasteData } from "../src-ts/lib/types.js";

function ics(events: [string, string][]): string {
  const body = events
    .map(([summary, day]) => `BEGIN:VEVENT\nDTSTART;VALUE=DATE:${day}\nSUMMARY:${summary}\nEND:VEVENT`)
    .join("\n");
  return `BEGIN:VCALENDAR\n${body}\nEND:VCALENDAR\n`;
}

/** Run a block with a fixed process time zone (DST behaviour must not depend on the CI machine). */
function withTimeZone(tz: string): void {
  let old: string | undefined;
  before(() => {
    old = process.env.TZ;
    process.env.TZ = tz;
  });
  after(() => {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  });
}

describe("days calculation across DST (Europe/Berlin)", () => {
  withTimeZone("Europe/Berlin");

  it("time zone switch is effective in this process", () => {
    // 29.03.2026 is the last Sunday in March: only 23 hours long in Berlin.
    const start = new Date(2026, 2, 29).getTime();
    const end = new Date(2026, 2, 30).getTime();
    expect((end - start) / 3600_000).to.equal(23);
  });

  it("counts calendar days, not 24 h blocks, over the switch to summer time", () => {
    expect(calendarDaysBetween(new Date(2026, 2, 29, 0, 0), new Date(2026, 2, 30))).to.equal(1);
    expect(calendarDaysBetween(new Date(2026, 2, 28, 0, 30), new Date(2026, 2, 30))).to.equal(2);
    expect(calendarDaysBetween(new Date(2026, 9, 24, 23, 59), new Date(2026, 9, 26))).to.equal(2);
    expect(calendarDaysBetween(new Date(2026, 2, 30, 12), new Date(2026, 2, 30))).to.equal(0);
  });

  it("parseIcs: tomorrow stays 1 on the 23 h day (was 0 = 'today' before the fix)", () => {
    const out = parseIcs(ics([["Restmuell", "20260330"]]), { now: new Date(2026, 2, 29, 8, 0) });
    expect(out.Restmuell.tage).to.equal(1);
  });
});

describe("collectIcsDates / buildTermine", () => {
  it("keeps all upcoming days per category, sorted and unique, dropping past ones", () => {
    const text = ics([
      ["Papier", "20261210"],
      ["Papier", "20261126"],
      ["Papier", "20261203"],
      ["Papier", "20261203"],
      ["Bio", "20261120"],
    ]);
    const days = collectIcsDates(text, new Date(2026, 10, 27, 10));
    expect(days).to.deep.equal({ Papier: ["2026-12-03", "2026-12-10"] });
  });

  it("recomputes the next date after midnight and drops expired categories", () => {
    const upcoming = { Papier: ["2026-11-27", "2026-12-11"], Bio: ["2026-11-27"], Rest: ["2026-11-30"] };
    const day1 = buildTermine(upcoming, new Date(2026, 10, 27, 6), "de");
    expect(day1.termine.Papier).to.include({ tage: 0, datum: "27.11.2026", wochentag: "Freitag", wochentag_num: 5 });
    const day2 = buildTermine(day1.upcoming, new Date(2026, 10, 28, 0, 17), "de");
    expect(Object.keys(day2.termine)).to.deep.equal(["Rest", "Papier"]);
    expect(day2.termine.Papier).to.include({ tage: 13, datum: "11.12.2026" });
    expect(day2.termine.Rest.tage).to.equal(2);
    expect(day2.upcoming).to.deep.equal({ Papier: ["2026-12-11"], Rest: ["2026-11-30"] });
  });
});

describe("MQTT Loxone topics", () => {
  const data: WasteData = {
    timestamp: "2026-11-27 06:00:00",
    standort: "X",
    location: "X",
    termine: {
      Papier: { tage: 1, datum: "28.11.2026", wochentag: "Samstag", wochentag_num: 6 },
      "Gelber Sack": { tage: 1, datum: "28.11.2026", wochentag: "Samstag", wochentag_num: 6 },
      Bio: { tage: 4, datum: "01.12.2026", wochentag: "Dienstag", wochentag_num: 2 },
    },
    status: "ok",
    last_success_unix: 1795755600,
    upcoming: { Papier: ["2026-11-28"] },
  };
  const byTopic = (msgs: { topic: string; payload: string }[]) =>
    Object.fromEntries(msgs.map((m) => [m.topic.replace(/^p\//, ""), m.payload]));

  it("publishes today/tomorrow lists, flags, next_days and the watchdog topics", () => {
    const t = byTopic(buildPublishMessages("p", data));
    expect(t.tomorrow).to.equal("Papier, Gelber Sack");
    expect(t.tomorrow_any).to.equal("1");
    expect(t.today).to.equal(NONE_PAYLOAD);
    expect(t.today_any).to.equal("0");
    expect(t.next_days).to.equal("1");
    expect(t.ok).to.equal("1");
    expect(t.status).to.equal("ok");
    expect(t.last_success_unix).to.equal("1795755600");
    expect(t["categories/gelber_sack/date_unix"]).to.equal(String(datumToUnix("28.11.2026")));
    expect(t["categories/gelber_sack/date_lox"]).to.equal(String(datumToLoxone("28.11.2026")));
    // internal bookkeeping stays out of the state JSON
    expect(JSON.parse(t.state)).to.not.have.property("upcoming");
  });

  it("no categories: '-' instead of an empty payload (would delete the retained topic), next_days -1", () => {
    const t = byTopic(buildPublishMessages("p", { ...data, termine: {}, status: "no_future_dates" }));
    expect(t.tomorrow).to.equal(NONE_PAYLOAD);
    expect(t.next_days).to.equal("-1");
    expect(t.ok).to.equal("1");
    expect(t.status).to.equal("no_future_dates");
  });

  it("ok = 0 on error; last_success_unix falls back to the timestamp of old caches", () => {
    const { last_success_unix: _drop, ...old } = data;
    const t = byTopic(buildPublishMessages("p", { ...old, status: "error" }));
    expect(t.ok).to.equal("0");
    expect(t.last_success_unix).to.equal(String(Math.floor(new Date("2026-11-27T06:00:00").getTime() / 1000)));
  });

  it("Loxone time counts local seconds since 2009-01-01", () => {
    expect(datumToLoxone("01.01.2009")).to.equal(0);
    expect(datumToLoxone("02.01.2009")).to.equal(86400);
    expect(datumToLoxone("garbage")).to.equal(null);
  });

  it("clears every sub-topic of categories that disappeared", () => {
    const clears = buildClearMessages("p/", ["papier", "bio", "rest"], ["papier"]);
    expect(clears).to.have.length(2 * CATEGORY_SUBTOPICS.length);
    expect(clears.every((m) => m.payload === "")).to.equal(true);
    expect(clears.map((m) => m.topic)).to.include("p/categories/rest/days");
    expect(clears.map((m) => m.topic)).to.not.include("p/categories/papier/days");
  });
});

describe("hourly recompute and failure handling (cache file)", () => {
  let tempRoot = "";
  let cacheFile = "";
  const env: Record<string, string | undefined> = {};
  const config: PluginConfig = {
    service_key: "0123456789abcdef0123456789abcdef",
    location: { f_id_kommune: "1", f_id_strasse: "1" },
    fetch_interval_hours: 6,
    language: "de",
  };

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "abfallio-days-"));
    const dataDir = path.join(tempRoot, "data", "plugins", "abfallio");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, "log", "plugins", "abfallio"), { recursive: true });
    cacheFile = path.join(dataDir, "abfall_data.json");
    env.LBHOMEDIR = process.env.LBHOMEDIR;
    env.LBPPLUGINDIR = process.env.LBPPLUGINDIR;
    process.env.LBHOMEDIR = tempRoot;
    process.env.LBPPLUGINDIR = "abfallio";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const write = (d: Partial<WasteData>): void => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ timestamp: "2026-11-27 06:00:00", standort: "X", location: "X", termine: {}, ...d }),
    );
  };
  const read = (): WasteData => JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as WasteData;

  it("rewrites days after midnight without touching the fetch timestamp", async () => {
    write({
      termine: { Papier: { tage: 1, datum: "28.11.2026", wochentag: "Samstag", wochentag_num: 6 } },
      upcoming: { Papier: ["2026-11-28", "2026-12-12"], Bio: ["2026-11-27"] },
    });
    await refreshCachedData(config, new Date(2026, 10, 28, 0, 17));
    const c = read();
    expect(c.termine.Papier.tage).to.equal(0);
    expect(c.timestamp).to.equal("2026-11-27 06:00:00");
    expect(c.upcoming).to.deep.equal({ Papier: ["2026-11-28", "2026-12-12"] });

    await refreshCachedData(config, new Date(2026, 10, 29, 0, 17));
    expect(read().termine.Papier).to.include({ tage: 13, datum: "12.12.2026" });
  });

  it("caches from before 'upcoming' existed are recomputed from their datum", async () => {
    write({ termine: { Rest: { tage: 3, datum: "30.11.2026", wochentag: "Montag", wochentag_num: 1 } } });
    await refreshCachedData(config, new Date(2026, 10, 28, 9));
    expect(read().termine.Rest.tage).to.equal(2);
    expect(read().upcoming).to.deep.equal({ Rest: ["2026-11-30"] });
  });

  it("records failures with backoff 1 h, 2 h, 4 h … capped at the interval", async () => {
    expect([1, 2, 3, 4, 5].map((n) => retryBackoffHours(n, 6))).to.deep.equal([1, 2, 4, 6, 6]);
    write({ upcoming: { Rest: ["2026-11-30"] } });
    await recordFetchFailure(config, new Error("portal down"), new Date(2026, 10, 28, 10, 17));
    let c = read();
    expect(c).to.include({ status: "error", error: "portal down", failed_attempts: 1, last_attempt: "2026-11-28 10:17:00" });
    expect(c.termine.Rest.tage).to.equal(2);
    expect(shouldFetch(config, false, new Date(2026, 10, 28, 10, 50))).to.equal(false);
    expect(shouldFetch(config, false, new Date(2026, 10, 28, 11, 17))).to.equal(true);

    await recordFetchFailure(config, new Error("again"), new Date(2026, 10, 28, 11, 17));
    c = read();
    expect(c.failed_attempts).to.equal(2);
    expect(shouldFetch(config, false, new Date(2026, 10, 28, 12, 17))).to.equal(false);
    expect(shouldFetch(config, false, new Date(2026, 10, 28, 13, 17))).to.equal(true);
  });
});
