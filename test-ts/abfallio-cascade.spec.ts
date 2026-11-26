import { expect } from "chai";
import { isLocationComplete, parseIcs } from "../src-ts/lib/abfall-service.js";
import {
  cascadeLabel,
  isCascadeComplete,
  nextStep,
  parseLegacyForm,
  sanitizeCascadeState,
  v3FetchIcs,
} from "../src-ts/lib/abfallio-cascade.js";
import { mergeServiceMaps } from "../src-ts/lib/service-map-refresh.js";

const KEY = "248deacbb49b06e868d29cb53c8ef034";

/* Trimmed real responses (AWB Westerwaldkreis, legacy form API). */
const INIT_KOMMUNE =
  "<form><input type='hidden' name='f_posts_json[]' value='tok1'>" +
  "<select name='f_id_kommune'><option value='0'>Bitte wählen</option><option value='2430'>Ailertchen</option>" +
  "<option value='2292'>Alpenrod</option></select></form>";
const KOMMUNE_SET =
  "<input type='hidden' name='f_posts_json[]' value='tok2'>" +
  "<select name='f_id_strasse'><option value='0'>-</option><option value='4609'>Am Schwimmbad</option></select>";
const STRASSE_SET =
  "<input type='hidden' name='f_posts_json[]' value='tok3'>" +
  "<select name='f_id_strasse_hnr'><option value='4609'>Alle Hausnummern</option></select>";

function ymd(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("abfall.io address cascade", () => {
  const realFetch = globalThis.fetch;
  let handler: (url: string, init?: RequestInit) => Response;
  const calls: Array<{ url: string; body: string }> = [];

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : "" });
      return handler(url, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("parses hidden fields and selects of the legacy form (placeholder options dropped)", () => {
    const f = parseLegacyForm(INIT_KOMMUNE);
    expect(f.hidden).to.deep.equal({ "f_posts_json[]": "tok1" });
    expect(f.selects.f_id_kommune).to.deep.equal([
      { id: "2430", name: "Ailertchen" },
      { id: "2292", name: "Alpenrod" },
    ]);
  });

  it("legacy: Gemeinde first (issues #24/#25), then street, replaying every step with the token", async () => {
    handler = (url) => {
      const w = /waction=([a-z_]+)/.exec(url)?.[1];
      const body = w === "init" ? INIT_KOMMUNE : w === "auswahl_kommune_set" ? KOMMUNE_SET : w === "auswahl_strasse_set" ? STRASSE_SET : "";
      return new Response(body, { status: 200 });
    };
    const s1 = await nextStep(KEY, {});
    expect(s1).to.deep.include({ done: false, api: "legacy", level: "kommune" });
    const s2 = await nextStep(KEY, { api: "legacy", kommune: { id: "2430", name: "Ailertchen" } });
    expect(s2).to.deep.include({ done: false, level: "strasse" });
    // the kommune step carried the token from init and the chosen id
    const set = calls.find((c) => c.url.includes("auswahl_kommune_set"))!;
    expect(set.body).to.include("f_id_kommune=2430").and.include("tok1");
    const s3 = await nextStep(KEY, {
      api: "legacy",
      kommune: { id: "2430", name: "Ailertchen" },
      strasse: { id: "4609", name: "Am Schwimmbad" },
    });
    expect(s3).to.deep.include({ done: false, level: "hnr" });
  });

  it("detects a migrated key (401 legacy) and walks the v3 GraphQL API (issues #11/#22)", async () => {
    handler = (url, init) => {
      if (url.includes("waction=init")) return new Response("", { status: 401 });
      if (url.startsWith("https://api.abfall.io?key=")) {
        return new Response(JSON.stringify({ apiKey: "API", settings: { PUB_ABFALLTYPEN: [{ wasteType: "7", checked: true }] } }), { status: 200 });
      }
      const q = JSON.parse(String(init?.body)).query as string;
      if (q.includes("cities")) {
        return Response.json({ data: { cities: [{ id: "4176", name: "Steina", idHouseNumber: "1005", districtsCount: 1 }] } });
      }
      if (q.includes("appointments")) {
        return Response.json({ data: { appointments: [{ date: ymd(3), wasteType: { name: "Biotonne" } }] } });
      }
      return Response.json({ data: {} });
    };
    const s = await nextStep(KEY, {});
    expect(s).to.deep.include({ done: false, api: "v3", level: "kommune" });
    if (!s.done) expect(s.items[0]).to.deep.equal({ id: "4176", name: "Steina", house_id: "1005" });
    const done = await nextStep(KEY, { api: "v3", kommune: { id: "4176", name: "Steina" }, house_id: "1005" });
    expect(done).to.deep.include({ done: true, complete: true, house_id: "1005" });
    const ics = await v3FetchIcs(KEY, "1005");
    expect(parseIcs(ics, { language: "de" }).Biotonne.tage).to.equal(3);
    const gqlCall = calls.find((c) => c.body.includes("appointments"))!;
    expect(JSON.parse(gqlCall.body).variables).to.include({ idHouseNumber: "1005" });
  });

  it("explains a key rejected by both APIs", async () => {
    handler = () => new Response("", { status: 401 });
    let msg = "";
    try {
      await nextStep(KEY, {});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).to.match(/new abfall\.io API/);
  });

  it("state helpers: sanitise, completeness, label; old configs still complete", () => {
    expect(sanitizeCascadeState({ api: "x", kommune: { id: "1 2", name: "a" }, strasse: { id: "4609", name: "Am Schwimmbad" } })).to.deep.equal({
      strasse: { id: "4609", name: "Am Schwimmbad" },
    });
    expect(isCascadeComplete({ api: "legacy", strasse: { id: "1", name: "x" } })).to.equal(true);
    expect(isCascadeComplete({ api: "v3", kommune: { id: "1", name: "x" } })).to.equal(false);
    expect(
      cascadeLabel({ kommune: { id: "1", name: "Ailertchen" }, strasse: { id: "2", name: "Am Schwimmbad" }, hnr: { id: "2", name: "Alle Hausnummern" } }),
    ).to.equal("Ailertchen, Am Schwimmbad");
    const key = "a".repeat(32);
    expect(isLocationComplete({ service_key: key, location: { f_id_strasse: "5916abteistrasse" } })).to.equal(true);
    expect(isLocationComplete({ service_key: key, location: { api: "v3", house_id: "1005" } })).to.equal(true);
    expect(isLocationComplete({ service_key: key, location: { api: "v3" } })).to.equal(false);
  });

  it("service map: v3 entries replace legacy entries of the same operator", () => {
    const merged = mergeServiceMaps(
      [
        { title: "Entsorgungsbetriebe Essen", url: "u", service_id: "1".repeat(32) },
        { title: "AWB Westerwaldkreis", url: "u", service_id: "2".repeat(32) },
      ],
      [{ title: "Entsorgungsbetriebe Essen", url: "u", service_id: "3".repeat(32) }],
    );
    expect(merged.map((e) => e.service_id)).to.deep.equal(["2".repeat(32), "3".repeat(32)]);
  });
});
