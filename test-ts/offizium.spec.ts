import { expect } from "chai";
import { activeProvider, isLocationComplete, parseIcs } from "../src-ts/lib/abfall-service.js";
import {
  areasOf,
  citiesOf,
  fetchOffizium,
  isOffiziumAddressComplete,
  nextStep,
  offiziumLocationLabel,
  pickupsFor,
  sanitizeOffiziumState,
  wasteTypesOf,
  type OffiziumWebshow,
} from "../src-ts/lib/offizium-service.js";

function iso(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Trimmed shape of the real webshow response (Landkreis Rhön-Grabfeld). */
const DATA: OffiziumWebshow = {
  mdiv: {
    config: {
      cities: [
        { id: "3", name: "Bad Neustadt" },
        { id: "1", name: "Aubstadt" },
      ],
      areas: [
        { id: "16", name: "Altstadt", city_id: "3" },
        { id: "17", name: "Brendlorenzen", city_id: "3" },
        { id: "2", name: "Aubstadt", city_id: "1" },
      ],
      abfall_types: {
        normal: [
          { id: "9", name: "Restmüll" },
          { id: "10", name: "Bio" },
        ],
        special: [
          { id: "1", name: "Problemmüll" },
          { id: "20", name: "Wertstoffzentrum Bad Neustadt" },
        ],
      },
    },
  },
  abfall_dates: [
    { date: iso(2), abfall_city_id: 3, abfall_area_id: 16, abfall_type_id: 9 },
    { date: iso(4), abfall_city_id: 3, abfall_area_id: 16, abfall_type_id: 1 },
    { date: iso(1), abfall_city_id: 3, abfall_area_id: 16, abfall_type_id: 20 }, // opening hours → skipped
    { date: iso(1), abfall_city_id: 3, abfall_area_id: 17, abfall_type_id: 10 }, // other Ortsteil
  ],
};

describe("offizium Abfuhr-Wecker", () => {
  it("lists Gemeinden sorted and Ortsteile per Gemeinde", () => {
    expect(citiesOf(DATA).map((c) => c.name)).to.deep.equal(["Aubstadt", "Bad Neustadt"]);
    expect(areasOf(DATA, "3").map((a) => a.name)).to.deep.equal(["Altstadt", "Brendlorenzen"]);
  });

  it("drops recycling-centre opening hours from the waste types", () => {
    expect([...wasteTypesOf(DATA).values()]).to.deep.equal(["Restmüll", "Bio", "Problemmüll"]);
  });

  it("filters dates by Gemeinde + Ortsteil (ids may be numbers in the JSON)", () => {
    const p = pickupsFor(DATA, "3", "16");
    expect(p.map((x) => x.fraction.name)).to.deep.equal(["Restmüll", "Problemmüll"]);
  });

  it("cascade: Gemeinde → Ortsteil → done", async () => {
    const load = async () => DATA;
    expect(await nextStep({ instance: "rhoen-grabfeld" }, load)).to.deep.include({ done: false, level: "city" });
    expect(await nextStep({ instance: "rhoen-grabfeld", city: { id: "3", name: "Bad Neustadt" } }, load)).to.deep.include({
      done: false,
      level: "area",
    });
    expect(
      await nextStep({ instance: "rhoen-grabfeld", city: { id: "3", name: "" }, area: { id: "16", name: "" } }, load),
    ).to.deep.equal({ done: true, complete: true });
  });

  it("fetch renders ICS for the shared parser", async () => {
    const cfg = { instance: "rhoen-grabfeld", city: { id: "3", name: "Bad Neustadt" }, area: { id: "16", name: "Altstadt" } };
    const { ics, count } = await fetchOffizium(cfg, async () => DATA);
    expect(count).to.equal(2);
    const t = parseIcs(ics, { language: "de" });
    expect(t["Restmüll"].tage).to.equal(2);
    expect(t["Problemmüll"].tage).to.equal(4);
  });

  it("sanitises state, completeness, label and dispatch", () => {
    expect(sanitizeOffiziumState({ instance: "evil", city: { id: "3", name: "x" } })).to.deep.equal({ city: { id: "3", name: "x" } });
    const cfg = { instance: "rhoen-grabfeld", city: { id: "3", name: "Bad Neustadt" }, area: { id: "16", name: "Altstadt" } };
    expect(isOffiziumAddressComplete(cfg)).to.equal(true);
    expect(offiziumLocationLabel(cfg)).to.equal("Bad Neustadt, Altstadt");
    expect(offiziumLocationLabel({ ...cfg, area: { id: "2", name: "Bad Neustadt" } })).to.equal("Bad Neustadt");
    expect(activeProvider({ provider: "offizium" })).to.equal("offizium");
    expect(isLocationComplete({ provider: "offizium", offizium: cfg })).to.equal(true);
  });
});
