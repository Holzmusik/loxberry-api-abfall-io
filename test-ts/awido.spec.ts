import { expect } from "chai";
import { activeProvider, isLocationComplete, parseIcs } from "../src-ts/lib/abfall-service.js";
import {
  AWIDO_CUSTOMERS,
  awidoLocationLabel,
  fetchAwido,
  isAwidoAddressComplete,
  nextStep,
  parseAwidoData,
  sanitizeAwidoState,
} from "../src-ts/lib/awido-service.js";
import { pickupsToIcs } from "../src-ts/lib/muellabfuhr-service.js";

const PLACE = "c910e58d-dbb9-4a4d-ad5d-197e9ff0ff06";
const STREET = "34da73cb-17e8-41a3-98b9-e06c72d267c6";
const HNR = "9a724a6a-c480-4b45-9108-198f1a6c5dc9";

function ymd(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

describe("AWIDO helpers", () => {
  it("ships a deduplicated customer list incl. Haßberge", () => {
    const keys = AWIDO_CUSTOMERS.map((c) => c.customer);
    expect(new Set(keys).size).to.equal(keys.length);
    expect(keys).to.include.members(["awhas", "gotha", "zaso", "awb-altenburg", "lra-schweinfurt"]);
  });

  it("maps getData JSON to pickups, skipping holidays (ad: null)", () => {
    const p = parseAwidoData({
      fracts: [
        { snm: "RM2", nm: "Restmüll 2-wöchentlich" },
        { snm: "PM", nm: "Problemmüll" },
      ],
      calendar: [
        { dt: "20260101", fr: null, ad: null },
        { dt: "20260331", fr: ["RM2", "PM"], ad: ["Zeil", "WH Zeil (15:30 - 16:30)"] },
      ],
    });
    expect(p).to.deep.equal([
      { date: "2026-03-31", fraction: { id: "RM2", name: "Restmüll 2-wöchentlich" } },
      { date: "2026-03-31", fraction: { id: "PM", name: "Problemmüll" } },
    ]);
  });

  it("keeps accented / dash characters readable for the shared parser", () => {
    const d = ymd(2);
    const ics = pickupsToIcs([
      { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, fraction: { id: "1", name: "ReparaturCafé" } },
      { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, fraction: { id: "2", name: "Biotonne 60–240 Liter" } },
    ]);
    expect(Object.keys(parseIcs(ics, { language: "de" })).sort()).to.deep.equal(["Biotonne 60-240 Liter", "ReparaturCafe"]);
  });

  it("sanitises UI state (customer key, UUIDs, order)", () => {
    expect(
      sanitizeAwidoState({ customer: "awhas", place: { id: PLACE, name: "Zeil am Main" }, street: { id: STREET, name: "x" }, evil: 1 }),
    ).to.deep.equal({ customer: "awhas", place: { id: PLACE, name: "Zeil am Main" }, street: { id: STREET, name: "x" } });
    // a street without a place is dropped; bad customer keys are dropped
    expect(sanitizeAwidoState({ customer: "../x", street: { id: STREET, name: "x" } })).to.deep.equal({});
  });

  it("completeness, label and provider dispatch", () => {
    const cfg = { customer: "awhas", place: { id: PLACE, name: "Zeil am Main" }, street: { id: STREET, name: "Zeil am Main" } };
    expect(isAwidoAddressComplete(cfg)).to.equal(true);
    expect(isAwidoAddressComplete({ customer: "awhas", place: { id: PLACE, name: "x" } })).to.equal(false);
    expect(awidoLocationLabel(cfg)).to.equal("Zeil am Main");
    expect(awidoLocationLabel({ ...cfg, street: { id: STREET, name: "Hauptstraße" }, hnr: { id: HNR, name: "5" } })).to.equal(
      "Zeil am Main, Hauptstraße 5",
    );
    expect(activeProvider({ provider: "awido" })).to.equal("awido");
    expect(isLocationComplete({ provider: "awido", awido: cfg })).to.equal(true);
  });
});

describe("AWIDO API flow (stubbed HTTP)", () => {
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

  it("place → street → (no house numbers) → done", async () => {
    routes = [
      [/getPlaces\/client=awhas$/, 200, JSON.stringify([{ key: PLACE, value: "Zeil am Main" }])],
      [new RegExp(`getGroupedStreets/${PLACE}\\?client=awhas`), 200, JSON.stringify([{ key: STREET, value: "Ortsteile" }])],
      [new RegExp(`getStreetAddons/${STREET}\\?client=awhas`), 200, JSON.stringify([{ key: STREET, value: "" }])],
    ];
    expect(await nextStep({ customer: "awhas" })).to.deep.include({ done: false, level: "place" });
    const withPlace = { customer: "awhas", place: { id: PLACE, name: "Zeil am Main" } };
    expect(await nextStep(withPlace)).to.deep.include({ done: false, level: "street" });
    expect(await nextStep({ ...withPlace, street: { id: STREET, name: "Ortsteile" } })).to.deep.equal({ done: true, complete: true });
  });

  it("offers house numbers when the street has some", async () => {
    routes = [[new RegExp(`getStreetAddons/${STREET}`), 200, JSON.stringify([{ key: HNR, value: "1" }])]];
    const s = await nextStep({ customer: "rmk", place: { id: PLACE, name: "x" }, street: { id: STREET, name: "y" } });
    expect(s).to.deep.include({ done: false, level: "hnr" });
  });

  it("fetches getData for the most specific oid and renders ICS", async () => {
    routes = [
      [new RegExp(`getData/${HNR}\\?fractions=&client=rmk`), 200,
        JSON.stringify({ fracts: [{ snm: "BIO", nm: "Biotonne" }], calendar: [{ dt: ymd(3), fr: ["BIO"], ad: ["x"] }] })],
    ];
    const { ics, count } = await fetchAwido({
      customer: "rmk",
      place: { id: PLACE, name: "x" },
      street: { id: STREET, name: "y" },
      hnr: { id: HNR, name: "1" },
    });
    expect(count).to.equal(1);
    expect(parseIcs(ics, { language: "de" }).Biotonne.tage).to.equal(3);
  });

  it("falls back to the ICS export when getData is not served", async () => {
    routes = [
      [/getData\//, 500, ""],
      [/KalenderICS\.aspx\?oid=/, 200, `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${ymd(5)}\r\nSUMMARY:Papier\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`],
    ];
    const { ics } = await fetchAwido({ customer: "awhas", place: { id: PLACE, name: "x" }, street: { id: STREET, name: "y" } });
    expect(parseIcs(ics, { language: "de" }).Papier.tage).to.equal(5);
  });
});
