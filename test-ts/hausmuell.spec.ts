import { expect } from "chai";
import { activeProvider, isLocationComplete, parseIcs, parseIcsDate } from "../src-ts/lib/abfall-service.js";
import {
  decodeBody,
  fetchHausmuellIcs,
  extractPortalDefaults,
  hausmuellLocationLabel,
  isHausmuellAddressComplete,
  isValidSubdomain,
  nextStep,
  normalizeHausmuellIcs,
  parseSearchResponse,
  repairDoubleUtf8,
  sanitizeHausmuellState,
} from "../src-ts/lib/hausmuell-service.js";
import { NoCollectionDatesError } from "../src-ts/lib/errors.js";
import type { HausmuellConfig } from "../src-ts/lib/types.js";

/* Response shapes as served by the three ATURIS frontend generations (trimmed). */
const OLD_ORTE =
  "<ul><li id = 'ort_18878'onClick='get_value(\"ort\",18878,0)'><span style = 'display:none;'>18878</span>" +
  "<span style = 'display:none;'>0</span><span>Schmalkalden</span><span style = 'display:none;'>16</span></li>" +
  "<li id = 'ort_19009'onClick='get_value(\"ort\",19009,91057)'><span style = 'display:none;'>19009</span>" +
  "<span style = 'display:none;'>91057</span><span>Belrieth</span><span style = 'display:none;'>0</span></li></ul>";
const NEW_ORTE =
  "<ul><li id = 'ort_1683'onClick='get_value(\"ort\",1683); event.stopPropagation();'>" +
  "<span style = 'display:none;'>1683</span><span>Albrechts</span></li></ul>";
const AZV_ORTE =
  "﻿<ul class=\"proposalList\"><li id=\"ort_23190\" onclick=\"get_value('ort', 23190, 0)\"><span>Amt Creuzburg</span></li></ul>";
const AZV_ORTSTEILE =
  "<ul class=\"proposalList\"><li id=\"ortsteil_23191\" onclick=\"get_value('ortsteil', 23191, 75067)\"><span>Buchenau</span></li></ul>";
const NO_ENTRY = "<ul class=\"proposalList\"><li>Kein Eintrag gefunden</li></ul>";

describe("hausmuell.info parsing", () => {
  it("reads id, egebiet and Ortsteil flag from the old frontend", () => {
    expect(parseSearchResponse(OLD_ORTE)).to.deep.equal([
      { id: "18878", name: "Schmalkalden", egebiet: "", has_ortsteile: true },
      { id: "19009", name: "Belrieth", egebiet: "91057", has_ortsteile: false },
    ]);
  });

  it("reads the newer frontend without egebiet / flag", () => {
    expect(parseSearchResponse(NEW_ORTE)).to.deep.equal([{ id: "1683", name: "Albrechts", egebiet: "" }]);
  });

  it("reads the AZV variant (double-quoted onclick, single-quoted args)", () => {
    expect(parseSearchResponse(AZV_ORTE)).to.deep.equal([{ id: "23190", name: "Amt Creuzburg", egebiet: "" }]);
    expect(parseSearchResponse(AZV_ORTSTEILE)[0]).to.include({ id: "23191", egebiet: "75067" });
  });

  it("skips hint entries without onclick and decodes entities", () => {
    expect(parseSearchResponse(NO_ENTRY)).to.deep.equal([]);
    const html = "<ul><li onClick='get_value(\"str\",5,7)'><span>M&ouml;ckers &amp; Co</span></li></ul>";
    expect(parseSearchResponse(html)[0].name).to.equal("Möckers & Co");
  });

  it("collects hidden defaults and switches all showBins toggles on", () => {
    const html =
      "<input type ='hidden' name='hidden_binSelection_rest' value='1'>" +
      "<input type='checkbox' name='showBinsRest'><input type='checkbox' name='showBinsBio' checked>" +
      "<input type='text' name='input_ort' value='Ort'>";
    expect(extractPortalDefaults(html)).to.deep.equal({
      hidden_binSelection_rest: "1",
      showBinsRest: "on",
      showBinsBio: "on",
    });
  });
});

describe("hausmuell.info encoding", () => {
  it("decodes UTF-8 and Latin-1 mixed in one body", () => {
    const buf = Buffer.concat([
      Buffer.from("SUMMARY:Restmüll\nLOCATION:Am Schlo", "utf-8"),
      Buffer.from([0xdf]), // Latin-1 "ß"
      Buffer.from("\n", "utf-8"),
    ]);
    expect(decodeBody(buf)).to.equal("SUMMARY:Restmüll\nLOCATION:Am Schloß\n");
  });

  it("repairs double-encoded UTF-8 only where it occurs", () => {
    expect(repairDoubleUtf8("RestmÃ¼ll / Grünschnitt")).to.equal("Restmüll / Grünschnitt");
  });

  it("normalises event titles for stable category keys", () => {
    const ics = [
      "SUMMARY:Entsorgung: Restabfall",
      "SUMMARY:verschobene Abholung: Bioabfall",
      "SUMMARY:Gelber Sack / Gelbe Tonne",
      "DESCRIPTION:Entsorgung: Restabfall",
    ].join("\r\n");
    expect(normalizeHausmuellIcs(ics)).to.equal(
      ["SUMMARY:Restabfall", "SUMMARY:Bioabfall", "SUMMARY:Gelber Sack - Gelbe Tonne", "DESCRIPTION:Entsorgung: Restabfall"].join("\r\n"),
    );
  });
});

describe("ICS timed DTSTART (hausmuell.info)", () => {
  it("parses all-day and timed values to the local day", () => {
    const d1 = parseIcsDate("20261202");
    const d2 = parseIcsDate("20261202T050000Z");
    const d3 = parseIcsDate("20261202T060000");
    for (const d of [d1, d2, d3]) {
      expect(d).to.not.equal(null);
      expect([d!.getFullYear(), d!.getMonth(), d!.getDate()]).to.deep.equal([2026, 11, 2]);
    }
    expect(parseIcsDate("garbage")).to.equal(null);
  });

  it("parseIcs accepts timed events", () => {
    const next = new Date();
    next.setDate(next.getDate() + 3);
    const ymd = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, "0")}${String(next.getDate()).padStart(2, "0")}`;
    const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${ymd}T050000Z\r\nSUMMARY:Papier\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const out = parseIcs(ics, { language: "de" });
    expect(out.Papier.tage).to.equal(3);
  });
});

describe("hausmuell.info config helpers", () => {
  it("validates subdomains strictly", () => {
    expect(isValidSubdomain("schmalkalden-meiningen")).to.equal(true);
    expect(isValidSubdomain("evil.example.com/")).to.equal(false);
    expect(isValidSubdomain("")).to.equal(false);
  });

  it("sanitises UI state (whitelist, numeric ids)", () => {
    const s = sanitizeHausmuellState({
      subdomain: "ew",
      ort: { id: "16702", name: "Arenshausen" },
      strasse: { id: "1; rm -rf /", name: "x" },
      egebiet: "18948",
      extra: "ignored",
    });
    expect(s).to.deep.equal({ subdomain: "ew", ort: { id: "16702", name: "Arenshausen" }, egebiet: "18948" });
  });

  it("treats egebiet or a street as a complete address", () => {
    expect(isHausmuellAddressComplete({ subdomain: "ew", egebiet: "1" })).to.equal(true);
    expect(isHausmuellAddressComplete({ subdomain: "ebkds", strasse: { id: "5", name: "x" } })).to.equal(true);
    expect(isHausmuellAddressComplete({ subdomain: "ebkds", ort: { id: "5", name: "x" } })).to.equal(false);
  });

  it("keeps old configs on abfall.io", () => {
    expect(activeProvider({})).to.equal("abfallio");
    expect(activeProvider({ provider: "hausmuell" })).to.equal("hausmuell");
    expect(isLocationComplete({ provider: "hausmuell", hausmuell: { subdomain: "ew", egebiet: "1" } })).to.equal(true);
    expect(isLocationComplete({ service_key: "a".repeat(32), location: { f_id_strasse: "1" } })).to.equal(true);
  });

  it("builds a readable location label (placeholder Ortsteil '-Stadt-' hidden)", () => {
    expect(
      hausmuellLocationLabel({
        ort: { id: "1", name: "Schmalkalden" },
        ortsteil: { id: "2", name: "-Stadt-" },
        strasse: { id: "3", name: "Altmarkt" },
        hnr: { id: "4", name: "5" },
      }),
    ).to.equal("Schmalkalden, Altmarkt 5");
  });
});

describe("hausmuell.info cascade (nextStep, stubbed HTTP)", () => {
  const realFetch = globalThis.fetch;
  let routes: Record<string, { status?: number; body: string }> = {};
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const file = /search\/([a-z_]+\.php)/.exec(url)?.[1] ?? "";
      const r = routes[file] ?? { status: 404, body: "" };
      return new Response(r.body, { status: r.status ?? 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("old frontend: stops as soon as the Ort carries an egebiet", async () => {
    routes = { "search_orte.php": { body: OLD_ORTE } };
    const s1 = await nextStep({ subdomain: "schmalkalden-meiningen" });
    expect(s1).to.include({ done: false, level: "ort" });
    const s2 = await nextStep({ subdomain: "schmalkalden-meiningen", ort: { id: "19009", name: "Belrieth" }, egebiet: "91057" });
    expect(s2).to.deep.equal({ done: true, complete: true });
  });

  it("old frontend: Ortsteil flag false skips straight to streets", async () => {
    routes = {
      "search_strassen.php": { body: "<ul><li onClick='get_value(\"str\",230665,18948)'><span>Am Anger</span></li></ul>" },
    };
    const s = await nextStep({ subdomain: "ew", ort: { id: "16702", name: "Arenshausen" }, ort_has_ortsteile: false });
    expect(s).to.include({ done: false, level: "strasse" });
    expect(calls.some((u) => u.includes("search_ortsteile"))).to.equal(false);
    // ids are sent in the query string as well (ew/wesel read them from there)
    expect(calls[0]).to.match(/ort_id=16702/);
  });

  it("AZV: no flag, egebiet 0 → offers Ortsteile", async () => {
    routes = { "search_ortsteile.php": { body: AZV_ORTSTEILE } };
    const s = await nextStep({ subdomain: "azv", ort: { id: "23190", name: "Amt Creuzburg" } });
    expect(s).to.include({ done: false, level: "ortsteil" });
  });

  it("newer frontend: no Ortsteil endpoint (404) → street → house number → done", async () => {
    routes = {
      "search_strassen.php": { body: "<ul><li onClick='get_value(\"str\",61201)'><span>Albrechts-Ort</span></li></ul>" },
      "search_hnr.php": { body: "<ul><li onClick='get_value(\"hnr\",973047)'><span>1002GA</span></li></ul>" },
    };
    const base = { subdomain: "ebkds", ort: { id: "1683", name: "Albrechts" } };
    expect(await nextStep(base)).to.include({ level: "strasse" });
    const withStreet = { ...base, strasse: { id: "61201", name: "Albrechts-Ort" } };
    expect(await nextStep(withStreet)).to.include({ level: "hnr" });
    expect(await nextStep({ ...withStreet, hnr: { id: "973047", name: "1002GA" } })).to.deep.equal({
      done: true,
      complete: true,
    });
  });

  it("reports an incomplete address when no streets exist", async () => {
    routes = { "search_strassen.php": { body: NO_ENTRY } };
    const s = await nextStep({ subdomain: "ew", ort: { id: "1", name: "X" }, ort_has_ortsteile: false });
    expect(s).to.deep.equal({ done: true, complete: false });
  });
});

describe("hausmuell.info ICS download (year end, stubbed HTTP)", () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let icsBody = "";
  let icsStatus = 200;
  let strassen = "<ul><li onClick='get_value(\"str\",230665,18948)'><span>Am Anger</span></li></ul>";
  const cfg: HausmuellConfig = {
    subdomain: "ew",
    ort: { id: "16702", name: "Arenshausen" },
    strasse: { id: "230665", name: "Am Anger" },
    egebiet: "18948",
    zusatz_id: "1",
  };
  const EVENT = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20270108\nSUMMARY:Restabfall\nEND:VEVENT\nEND:VCALENDAR";

  beforeEach(() => {
    calls.length = 0;
    icsStatus = 200;
    strassen = "<ul><li onClick='get_value(\"str\",230665,18948)'><span>Am Anger</span></li></ul>";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("ics/ics.php")) {
        const body = String(init?.body ?? "");
        // Ids changed by the portal: only the new egebiet returns dates.
        const text = body.includes("hidden_id_egebiet=777") ? EVENT : icsBody;
        return new Response(text, { status: icsStatus });
      }
      if (url.includes("search_orte.php")) {
        return new Response("<ul><li onClick='get_value(\"ort\",16702,0)'><span>Arenshausen</span></li></ul>");
      }
      if (url.includes("search_strassen.php")) return new Response(strassen);
      if (url.includes("search/")) return new Response("", { status: 404 });
      return new Response("<html></html>");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("empty calendar with unchanged ids → NoCollectionDatesError (not a fetch error)", async () => {
    icsBody = "BEGIN:VCALENDAR\nEND:VCALENDAR";
    let err: unknown;
    try {
      await fetchHausmuellIcs(cfg, new Date(2026, 11, 28));
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(NoCollectionDatesError);
    // one name lookup, no second download
    expect(calls.filter((u) => u.includes("ics/ics.php"))).to.have.length(2);
  });

  it("empty calendar but ids changed (portal re-import) → downloads again with the new ids", async () => {
    icsBody = "BEGIN:VCALENDAR\nEND:VCALENDAR";
    strassen = "<ul><li onClick='get_value(\"str\",999,777)'><span>Am Anger</span></li></ul>";
    const { config, ics } = await fetchHausmuellIcs(cfg, new Date(2026, 11, 28));
    expect(config.egebiet).to.equal("777");
    expect(ics).to.include("Restabfall");
  });

  it("HTTP errors propagate without re-resolving the address", async () => {
    icsStatus = 503;
    icsBody = "";
    let err: unknown;
    try {
      await fetchHausmuellIcs(cfg, new Date(2026, 11, 28));
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/status 503/);
    expect(err).to.not.be.instanceOf(NoCollectionDatesError);
    expect(calls.some((u) => u.includes("search_"))).to.equal(false);
  });
});
