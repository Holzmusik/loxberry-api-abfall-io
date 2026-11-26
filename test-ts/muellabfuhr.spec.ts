import { expect } from "chai";
import { activeProvider, isLocationComplete, parseIcs } from "../src-ts/lib/abfall-service.js";
import {
  fetchMuellabfuhr,
  isMuellabfuhrAddressComplete,
  muellabfuhrLocationLabel,
  nextStep,
  parsePortalIcs,
  pickupsToIcs,
  sanitizeMuellabfuhrState,
  stripLocationSuffix,
} from "../src-ts/lib/muellabfuhr-service.js";

const ROOT = "39051770-a5d6-4f0a-9c5c-6c08fb1f1d6a";
const ORT = "ad326d54-61ab-4291-8fb8-26af4f266f63";
const STR = "a094c408-16a5-4b8c-9f1b-f2319fd6a9ed";

function ymd(offsetDays: number): { iso: string; compact: string } {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { iso, compact: iso.replace(/-/g, "") };
}

describe("muellabfuhr-deutschland.de helpers", () => {
  it("strips the location suffix the ICS export appends", () => {
    expect(stripLocationSuffix("Biomüll (Friedrichshöhe)", "Friedrichshöhe")).to.equal("Biomüll");
    expect(stripLocationSuffix("Papier (Irgendwo)", "Anders")).to.equal("Papier");
    expect(stripLocationSuffix("Restabfall", "X")).to.equal("Restabfall");
  });

  it("reads the portal ICS (SUMMARY;LANGUAGE=…, VALUE=DATE, VALARM ignored)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY;LANGUAGE=de-de:gelbe Tonne/Leichtverpackungen (Friedrichshöhe)",
      "DTSTART;VALUE=DATE:20270114",
      "BEGIN:VALARM",
      "DESCRIPTION:gelbe Tonne/Leichtverpackungen (Friedrichshöhe)",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parsePortalIcs(ics, "Friedrichshöhe")).to.deep.equal([
      { date: "2027-01-14", fraction: { id: "", name: "gelbe Tonne/Leichtverpackungen" } },
    ]);
  });

  it("renders pickups as ICS the shared parser understands (dedup, '/' kept readable)", () => {
    const d = ymd(4);
    const ics = pickupsToIcs([
      { date: d.iso, fraction: { id: "7001", name: "gelbe Tonne/Leichtverpackungen" } },
      { date: d.iso, fraction: { id: "7001", name: "gelbe Tonne/Leichtverpackungen" } },
      { date: "bogus", fraction: { id: "1", name: "x" } },
    ]);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).to.equal(1);
    const t = parseIcs(ics, { language: "de" });
    expect(Object.keys(t)).to.deep.equal(["gelbe Tonne - Leichtverpackungen"]);
    expect(t["gelbe Tonne - Leichtverpackungen"].tage).to.equal(4);
  });

  it("sanitises UI state (numeric district, UUID path)", () => {
    const s = sanitizeMuellabfuhrState({
      mandator: { id: "35", name: "Saalekreis" },
      path: [{ id: ORT, name: "Bad Dürrenberg" }, { id: "../../etc", name: "x" }, { id: STR, name: "y" }],
      final: true,
      junk: 1,
    });
    expect(s).to.deep.equal({ mandator: { id: "35", name: "Saalekreis" }, path: [{ id: ORT, name: "Bad Dürrenberg" }], final: true });
    expect(sanitizeMuellabfuhrState({ mandator: { id: "7; rm", name: "x" } })).to.deep.equal({});
  });

  it("completeness, label and provider dispatch", () => {
    const cfg = { mandator: { id: "35", name: "Saalekreis" }, path: [{ id: ORT, name: "Bad Dürrenberg" }, { id: STR, name: "Bad Dürrenberg" }] };
    expect(isMuellabfuhrAddressComplete(cfg)).to.equal(true);
    expect(isMuellabfuhrAddressComplete({ mandator: { id: "35", name: "" } })).to.equal(false);
    expect(muellabfuhrLocationLabel(cfg)).to.equal("Bad Dürrenberg");
    expect(activeProvider({ provider: "muellabfuhr" })).to.equal("muellabfuhr");
    expect(isLocationComplete({ provider: "muellabfuhr", muellabfuhr: cfg })).to.equal(true);
  });
});

describe("muellabfuhr-deutschland.de API flow (stubbed HTTP)", () => {
  const realFetch = globalThis.fetch;
  let routes: Array<[RegExp, number, string]> = [];
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = routes.find(([re]) => re.test(url));
      return hit ? new Response(hit[2], { status: hit[1] }) : new Response("", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("walks from the root until a final node", async () => {
    routes = [
      [/\/mandators\/35\/config$/, 200, JSON.stringify({ calendarActive: true, calendarRootLocationId: ROOT })],
      [new RegExp(`/location/${ROOT}\\?`), 200, JSON.stringify({ children: [{ id: ORT, name: "Bad Dürrenberg", isFinal: false }] })],
      [new RegExp(`/location/${ORT}\\?`), 200, JSON.stringify({ children: [{ id: STR, name: "Am Markt", isFinal: true }] })],
    ];
    const s0 = await nextStep({ mandator: { id: "35", name: "Saalekreis" } });
    expect(s0).to.deep.include({ done: false, depth: 0 });
    const s1 = await nextStep({ mandator: { id: "35", name: "" }, path: [{ id: ORT, name: "Bad Dürrenberg" }] });
    expect(s1).to.deep.include({ done: false, depth: 1 });
    const s2 = await nextStep({ mandator: { id: "35", name: "" }, path: [{ id: ORT, name: "" }, { id: STR, name: "" }], final: true });
    expect(s2).to.deep.equal({ done: true, complete: true });
  });

  it("merges upcoming JSON pickups with the next-year ICS and remembers fraction ids", async () => {
    const soon = ymd(2);
    routes = [
      [new RegExp(`/location/${STR}/pickups/ics\\?`), 200,
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY;LANGUAGE=de-de:Papier (Am Markt)\r\nDTSTART;VALUE=DATE:20990105\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"],
      [new RegExp(`/location/${STR}/pickups$`), 200,
        JSON.stringify([{ date: soon.iso, fraction: { id: "7002", name: "Restabfall" } }])],
    ];
    const cfg = { mandator: { id: "35", name: "Saalekreis" }, path: [{ id: STR, name: "Am Markt" }] };
    const { ics, config, count } = await fetchMuellabfuhr(cfg);
    expect(count).to.equal(2);
    expect(config.fraction_ids).to.deep.equal(["7002"]);
    expect(calls.some((u) => /pickups\/ics\?year=\d{4}&fractionIds=7002/.test(u))).to.equal(true);
    const t = parseIcs(ics, { language: "de" });
    expect(Object.keys(t).sort()).to.deep.equal(["Papier", "Restabfall"]);
  });

  it("fails clearly when the portal has no dates", async () => {
    routes = [[new RegExp(`/location/${STR}/pickups$`), 200, "[]"]];
    let err = "";
    try {
      await fetchMuellabfuhr({ mandator: { id: "7", name: "" }, path: [{ id: STR, name: "X" }] });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).to.match(/no collection dates/);
  });
});
