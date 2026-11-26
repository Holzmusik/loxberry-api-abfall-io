#!/usr/bin/env node
import {
  clearLog,
  fetchData,
  getLog,
  getStatus,
  loadConfig,
  saveConfig,
  searchHnr,
  searchStreet,
} from "../lib/abfall-service.js";
import {
  HAUSMUELL_PROVIDERS,
  isHausmuellAddressComplete,
  isValidSubdomain,
  nextStep,
  sanitizeHausmuellState,
} from "../lib/hausmuell-service.js";
import {
  AWIDO_CUSTOMERS,
  isAwidoAddressComplete,
  nextStep as awNextStep,
  sanitizeAwidoState,
} from "../lib/awido-service.js";
import {
  isMuellabfuhrAddressComplete,
  listMandators,
  nextStep as mfNextStep,
  sanitizeMuellabfuhrState,
} from "../lib/muellabfuhr-service.js";
import { refreshServiceMapToUserFile } from "../lib/service-map-refresh.js";
import { decodeShellQueryArg } from "../lib/shell-query-arg.js";
import { searchServiceRegions } from "../lib/service-map.js";

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) {
    process.stdout.write(`Usage: ${process.argv[1]} <command> [args]\n`);
    process.stdout.write(
      "Commands: search_street <q>, search_hnr <street_id>, search_service <q>, refresh_service_map [url], " +
        "hm_providers, hm_step <state_json>, hm_save <state_json>, mf_mandators, mf_step <state_json>, " +
        "mf_save <state_json>, aw_customers, aw_step <state_json>, aw_save <state_json>, set_provider <id>, " +
        "fetch, status, log\n",
    );
    process.exit(1);
  }

  if (command === "search_street") {
    const raw = args[0] ?? "";
    const query = decodeShellQueryArg(raw);
    if (!query) {
      printJson({ error: "Missing search query" });
      process.exit(1);
    }
    printJson(await searchStreet(query));
    return;
  }

  if (command === "search_service") {
    const query = decodeShellQueryArg(args[0] ?? "");
    printJson(searchServiceRegions(query));
    return;
  }

  if (command === "refresh_service_map") {
    const url = args[0] ?? "";
    const result = await refreshServiceMapToUserFile(loadConfig(), url || undefined);
    printJson(result);
    if (!result.success) {
      process.exit(1);
    }
    return;
  }

  if (command === "hm_providers") {
    printJson(HAUSMUELL_PROVIDERS);
    return;
  }

  if (command === "hm_step") {
    // hm_step b64:<HausmuellState JSON> → next cascade level with its full list, or done.
    const raw = decodeShellQueryArg(args[0] ?? "");
    const state = sanitizeHausmuellState(raw ? JSON.parse(raw) : {});
    if (!isValidSubdomain(state.subdomain)) {
      printJson({ error: "Invalid subdomain" });
      process.exit(1);
    }
    printJson(await nextStep(state));
    return;
  }

  if (command === "hm_save") {
    // hm_save b64:<HausmuellState JSON> → store address and switch provider to hausmuell.info
    const raw = decodeShellQueryArg(args[0] ?? "");
    const { ort_has_ortsteile: _flag, ...address } = sanitizeHausmuellState(raw ? JSON.parse(raw) : {});
    if (!isHausmuellAddressComplete(address)) {
      printJson({ success: false, error: "Address incomplete" });
      process.exit(1);
    }
    const prev = loadConfig();
    const sameRegion = prev.provider === "hausmuell" && prev.hausmuell?.subdomain === address.subdomain;
    saveConfig({
      ...prev,
      provider: "hausmuell",
      hausmuell: address,
      // Category names differ per portal; a stale filter would hide every category.
      ...(sameRegion ? {} : { categories_filter: [] }),
    });
    printJson({ success: true, filter_cleared: !sameRegion && (prev.categories_filter?.length ?? 0) > 0 });
    return;
  }

  if (command === "mf_mandators") {
    printJson(await listMandators());
    return;
  }

  if (command === "mf_step") {
    // mf_step b64:<MuellabfuhrState JSON> → next level of the location tree, or done.
    const raw = decodeShellQueryArg(args[0] ?? "");
    const state = sanitizeMuellabfuhrState(raw ? JSON.parse(raw) : {});
    if (!state.mandator) {
      printJson({ error: "Invalid district" });
      process.exit(1);
    }
    printJson(await mfNextStep(state));
    return;
  }

  if (command === "mf_save") {
    const raw = decodeShellQueryArg(args[0] ?? "");
    const { mandator, path } = sanitizeMuellabfuhrState(raw ? JSON.parse(raw) : {});
    const address = { mandator, path };
    if (!isMuellabfuhrAddressComplete(address)) {
      printJson({ success: false, error: "Address incomplete" });
      process.exit(1);
    }
    const prev = loadConfig();
    const sameRegion = prev.provider === "muellabfuhr" && prev.muellabfuhr?.mandator?.id === mandator?.id;
    saveConfig({
      ...prev,
      provider: "muellabfuhr",
      muellabfuhr: address,
      ...(sameRegion ? {} : { categories_filter: [] }),
    });
    printJson({ success: true, filter_cleared: !sameRegion && (prev.categories_filter?.length ?? 0) > 0 });
    return;
  }

  if (command === "aw_customers") {
    printJson(AWIDO_CUSTOMERS);
    return;
  }

  if (command === "aw_step") {
    // aw_step b64:<AwidoState JSON> → next level (place / street / hnr) with its list, or done.
    const raw = decodeShellQueryArg(args[0] ?? "");
    const state = sanitizeAwidoState(raw ? JSON.parse(raw) : {});
    if (!state.customer) {
      printJson({ error: "Invalid AWIDO customer" });
      process.exit(1);
    }
    printJson(await awNextStep(state));
    return;
  }

  if (command === "aw_save") {
    const raw = decodeShellQueryArg(args[0] ?? "");
    const address = sanitizeAwidoState(raw ? JSON.parse(raw) : {});
    if (!isAwidoAddressComplete(address)) {
      printJson({ success: false, error: "Address incomplete" });
      process.exit(1);
    }
    const prev = loadConfig();
    const sameRegion = prev.provider === "awido" && prev.awido?.customer === address.customer;
    saveConfig({
      ...prev,
      provider: "awido",
      awido: address,
      ...(sameRegion ? {} : { categories_filter: [] }),
    });
    printJson({ success: true, filter_cleared: !sameRegion && (prev.categories_filter?.length ?? 0) > 0 });
    return;
  }

  if (command === "set_provider") {
    const provider = args[0];
    if (provider !== "abfallio" && provider !== "hausmuell" && provider !== "muellabfuhr" && provider !== "awido") {
      printJson({ success: false, error: "Unknown provider" });
      process.exit(1);
    }
    saveConfig({ ...loadConfig(), provider });
    printJson({ success: true });
    return;
  }

  if (command === "search_hnr") {
    const streetId = args[0];
    if (!streetId) {
      printJson({ error: "Missing street_id" });
      process.exit(1);
    }
    printJson(await searchHnr(streetId));
    return;
  }

  if (command === "register") {
    printJson({
      success: true,
      client: "(not needed - using api.abfall.io)",
      expires: "n/a",
    });
    return;
  }

  if (command === "fetch") {
    printJson(await fetchData());
    return;
  }

  if (command === "status") {
    printJson(getStatus());
    return;
  }

  if (command === "log") {
    const lines = args[0] ? Number.parseInt(args[0], 10) : 100;
    process.stdout.write(getLog(Number.isFinite(lines) ? lines : 100));
    return;
  }

  if (command === "clear_log") {
    clearLog();
    printJson({ success: true });
    return;
  }

  if (command === "save_config") {
    const cfgJson = args[0] ?? "";
    const cfg = cfgJson ? JSON.parse(cfgJson) : JSON.parse(await readStdin());
    const existing = loadConfig();
    saveConfig({ ...existing, ...cfg });
    printJson({ success: true });
    return;
  }

  printJson({ error: `Unknown command: ${command}` });
  process.exit(1);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

main().catch((err) => {
  printJson({ error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
