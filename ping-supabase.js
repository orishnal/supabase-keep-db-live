/**
 * Local and CI keepalive script for multiple Supabase projects.
 *
 * Recommended mode: invoke a Postgres-backed RPC function via PostgREST.
 * Legacy fallback: ping the REST API root. This confirms reachability but may
 * not count as meaningful database activity for Supabase pause prevention.
 */

const fs = require("fs");
const path = require("path");

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const DEFAULT_CONFIG_PATH = path.join(__dirname, "supabase-configs.json");

try {
  require("dotenv").config();
} catch (error) {
  // dotenv is optional outside local development.
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const safe = String(value ?? "").replace(/\r?\n/g, " ");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${safe}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeaders(key, extraHeaders = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "User-Agent": "github-actions-supabase-keepalive",
    Accept: "application/json",
    ...extraHeaders,
  };
}

function loadConfigs() {
  if (process.env.SUPABASE_CONFIGS) {
    return {
      source: "SUPABASE_CONFIGS environment variable",
      configs: JSON.parse(process.env.SUPABASE_CONFIGS),
    };
  }

  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return {
      source: path.basename(DEFAULT_CONFIG_PATH),
      configs: JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8")),
    };
  }

  throw new Error(
    "Missing SUPABASE_CONFIGS and no supabase-configs.json file was found."
  );
}

async function invokeRpc(url, key, rpcName, rpcBody) {
  return fetch(`${url}/rest/v1/rpc/${encodeURIComponent(rpcName)}`, {
    method: "POST",
    headers: getHeaders(key, {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    }),
    body: JSON.stringify(rpcBody ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function pingRestRoot(url, key) {
  return fetch(`${url}/rest/v1/`, {
    method: "GET",
    headers: getHeaders(key),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function pingConfig(config, index, total) {
  const dbName = config.name || `Database ${index + 1}`;
  const url = String(config.url || "").replace(/\/$/, "");
  const key = config.key;
  const rpcName = typeof config.rpc === "string" ? config.rpc.trim() : "";
  const rpcBody = config.rpcBody;

  if (!url || !key) {
    throw new Error(`Missing url or key for ${dbName}`);
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`\n[${index + 1}/${total}] ${dbName}`);
      console.log("URL:", url);
      console.log(`Attempt: ${attempt}/${MAX_RETRIES}`);

      const startTime = Date.now();
      const response = rpcName
        ? await invokeRpc(url, key, rpcName, rpcBody)
        : await pingRestRoot(url, key);
      const duration = Date.now() - startTime;

      if (!response.ok) {
        const body = (await response.text()).slice(0, 400);
        throw new Error(
          `${rpcName ? `RPC ${rpcName}` : "REST root ping"} returned ${response.status}${body ? `: ${body}` : ""}`
        );
      }

      if (rpcName) {
        console.log(`Mode: rpc (${rpcName})`);
      } else {
        console.log("Mode: legacy-rest-root");
        console.log("Warning: REST root reachability may not count as database activity.");
      }
      console.log(`Success! Status: ${response.status} Response time: ${duration}ms`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed: ${error.message}`);

      if (attempt < MAX_RETRIES) {
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError || new Error(`Ping failed for ${dbName}`);
}

function isEnabled(config) {
  return config?.enabled !== false;
}

(async () => {
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let totalCount = 0;
  let projectList = "";
  let configSource = "";

  try {
    const loaded = loadConfigs();
    const configs = loaded.configs;
    configSource = loaded.source;

    if (!Array.isArray(configs) || configs.length === 0) {
      throw new Error("SUPABASE_CONFIGS must be a non-empty array of database configurations.");
    }

    const enabledConfigs = configs.filter(isEnabled);
    const skippedConfigs = configs.filter((config) => !isEnabled(config));

    if (enabledConfigs.length === 0) {
      throw new Error("SUPABASE_CONFIGS does not contain any enabled database configurations.");
    }

    totalCount = enabledConfigs.length;
    skipCount = skippedConfigs.length;
    projectList = enabledConfigs
      .map((config, index) => {
        const name = config.name || `Database ${index + 1}`;
        const url = String(config.url || "").replace(/\/$/, "");
        const mode = config.rpc ? `rpc:${config.rpc}` : "legacy-rest-root";
        return `${name} - ${url} - ${mode}`;
      })
      .join(" | ");

    console.log("Pinging", totalCount, "database(s)...");
    console.log("Config source:", configSource);
    console.log("Projects:", projectList);
    if (skipCount > 0) {
      console.log(
        "Skipped:",
        skippedConfigs.map((config, index) => config.name || `Disabled Database ${index + 1}`).join(" | ")
      );
    }
    console.log("Timestamp:", new Date().toISOString());
    console.log("-".repeat(60));

    for (let i = 0; i < enabledConfigs.length; i++) {
      try {
        await pingConfig(enabledConfigs[i], i, enabledConfigs.length);
        successCount++;
      } catch (error) {
        console.error("Failed:", error.message);
        failCount++;
      }
    }

    console.log("\n" + "-".repeat(60));
    console.log("Summary:");
    console.log("  Successful:", successCount);
    console.log("  Failed:", failCount);
    console.log("  Total:", totalCount);
    console.log("  Skipped:", skipCount);

    setOutput("success_count", successCount);
    setOutput("fail_count", failCount);
    setOutput("total_count", totalCount);
    setOutput("project_list", projectList);
    setOutput("config_source", configSource);
    setOutput("error_message", "");

    if (failCount > 0) {
      process.exit(1);
    }

    console.log("\nAll databases pinged successfully!");
  } catch (error) {
    console.error("\nFatal error:", error.message);
    console.error("Recommended SUPABASE_CONFIGS example:");
    console.error(
      '[{"name":"My DB","url":"https://xxx.supabase.co","key":"your-key","rpc":"keepalive_ping"}]'
    );

    setOutput("success_count", successCount);
    setOutput("fail_count", failCount);
    setOutput("total_count", totalCount);
    setOutput("project_list", projectList);
    setOutput("config_source", configSource);
    setOutput("error_message", error.message);
    process.exit(1);
  }
})();
