/**
 * Keep-alive script for PowerSync.
 *
 * PowerSync deprovisions Free-plan instances after a period with no deploy and
 * no client connection. A deploy resets the clock but reprocesses all sync
 * rules from scratch (expensive); a real client connection resets the clock
 * without triggering that reprocessing. This script opens a real client
 * connection to each configured instance, waits for the first sync checkpoint,
 * then disconnects.
 *
 * Authentication: PowerSync validates the client's JWT signature and standard
 * claims only - it never checks the token against Supabase's live user table.
 * So instead of signing in as a dedicated Supabase auth user, this script
 * self-signs a short-lived token (default 60s) using the source Supabase
 * project's legacy JWT secret - the same HS256 secret PowerSync already
 * trusts for real user sessions. The token carries a random `sub` that maps
 * to no row anywhere and no `tenant_id` claim, so it matches no sync bucket
 * and pulls no real data. Nothing is created in auth.users; nothing appears
 * in any user list. The token expires well before the script exits.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { PowerSyncDatabase, Schema } = require("@powersync/node");

const CONNECT_TIMEOUT_MS = 30000;
const TOKEN_TTL_SECONDS = 60;
const DEFAULT_CONFIG_PATH = path.join(__dirname, "powersync-instances.json");

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

function loadInstances() {
  if (process.env.POWERSYNC_INSTANCES) {
    return {
      source: "POWERSYNC_INSTANCES environment variable",
      instances: JSON.parse(process.env.POWERSYNC_INSTANCES),
    };
  }

  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return {
      source: path.basename(DEFAULT_CONFIG_PATH),
      instances: JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8")),
    };
  }

  throw new Error(
    "Missing POWERSYNC_INSTANCES and no powersync-instances.json file was found."
  );
}

function signKeepaliveToken(secret) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      role: "authenticated",
      aud: "authenticated",
      sub: crypto.randomUUID(),
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
    secret,
    { algorithm: "HS256" }
  );
}

async function pingInstance(instance, index, total) {
  const name = instance.name || `Instance ${index + 1}`;
  const endpoint = String(instance.endpoint || "").replace(/\/$/, "");
  const secretEnvVar = instance.jwtSecretEnv || "SUPABASE_LEGACY_JWT";
  const secret = process.env[secretEnvVar];

  console.log(`\n[${index + 1}/${total}] ${name}`);
  console.log("Endpoint:", endpoint);

  if (!endpoint) {
    throw new Error(`Missing endpoint for ${name}`);
  }
  if (!secret) {
    throw new Error(`Missing ${secretEnvVar} for ${name}`);
  }

  const dbFilename = `keepalive-${index}.db`;
  const db = new PowerSyncDatabase({
    schema: new Schema({}),
    database: { dbFilename },
  });

  try {
    const startTime = Date.now();

    await db.connect({
      fetchCredentials: async () => ({
        endpoint,
        token: signKeepaliveToken(secret),
        expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
      }),
      uploadData: async () => {
        // Never called: this connection carries no tenant claim, so it
        // matches no sync bucket and never accumulates local writes.
      },
    });

    await waitForFirstSyncOrTimeout(db, CONNECT_TIMEOUT_MS);

    if (!db.currentStatus.connected) {
      throw new Error("waitForFirstSync completed but the client reports not connected.");
    }

    const duration = Date.now() - startTime;
    console.log(`Connected and checkpoint acknowledged. Response time: ${duration}ms`);
  } finally {
    await db.disconnect().catch(() => {});
    await db.close().catch(() => {});
    try {
      fs.unlinkSync(dbFilename);
    } catch (error) {
      // best-effort cleanup; not fatal if the file is already gone
    }
  }
}

function waitForFirstSyncOrTimeout(db, timeoutMs) {
  // db.waitForFirstSync({ signal }) resolves once the signal fires, even if
  // nothing actually synced - it treats an abort as "stop waiting", not as a
  // failure. That would make a genuine timeout look like success. Race it
  // against a timer that actually rejects instead.
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out waiting for first sync after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([db.waitForFirstSync(), timeout]).finally(() => {
    clearTimeout(timeoutHandle);
  });
}

function isEnabled(instance) {
  return instance?.enabled !== false;
}

(async () => {
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let totalCount = 0;
  let instanceList = "";
  let configSource = "";
  let failedInstances = [];

  try {
    const loaded = loadInstances();
    const instances = loaded.instances;
    configSource = loaded.source;

    if (!Array.isArray(instances) || instances.length === 0) {
      throw new Error("POWERSYNC_INSTANCES must be a non-empty array of instance configurations.");
    }

    const enabledInstances = instances.filter(isEnabled);
    const skippedInstances = instances.filter((instance) => !isEnabled(instance));

    if (enabledInstances.length === 0) {
      throw new Error("POWERSYNC_INSTANCES does not contain any enabled instances.");
    }

    totalCount = enabledInstances.length;
    skipCount = skippedInstances.length;
    instanceList = enabledInstances
      .map((instance, index) => {
        const name = instance.name || `Instance ${index + 1}`;
        const endpoint = String(instance.endpoint || "").replace(/\/$/, "");
        return `${name} - ${endpoint}`;
      })
      .join(" | ");

    console.log("Pinging", totalCount, "PowerSync instance(s)...");
    console.log("Config source:", configSource);
    console.log("Instances:", instanceList);
    if (skipCount > 0) {
      console.log(
        "Skipped:",
        skippedInstances.map((instance, index) => instance.name || `Disabled Instance ${index + 1}`).join(" | ")
      );
    }
    console.log("Timestamp:", new Date().toISOString());
    console.log("-".repeat(60));

    for (let i = 0; i < enabledInstances.length; i++) {
      const name = enabledInstances[i].name || `Instance ${i + 1}`;
      try {
        await pingInstance(enabledInstances[i], i, enabledInstances.length);
        successCount++;
      } catch (error) {
        console.error("Failed:", error.message);
        failCount++;
        failedInstances.push({ name, error: error.message });
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
    setOutput("instance_list", instanceList);
    setOutput("config_source", configSource);
    setOutput("error_message", "");
    setOutput("failed_instances", JSON.stringify(failedInstances));

    if (failCount > 0) {
      process.exit(1);
    }

    console.log("\nAll PowerSync instances pinged successfully!");
  } catch (error) {
    console.error("\nFatal error:", error.message);
    console.error("Recommended POWERSYNC_INSTANCES example:");
    console.error(
      '[{"name":"My Instance","endpoint":"https://xxx.powersync.journeyapps.com","jwtSecretEnv":"SUPABASE_LEGACY_JWT"}]'
    );

    setOutput("success_count", successCount);
    setOutput("fail_count", failCount);
    setOutput("total_count", totalCount);
    setOutput("instance_list", instanceList);
    setOutput("config_source", configSource);
    setOutput("error_message", error.message);
    setOutput("failed_instances", JSON.stringify(failedInstances));
    process.exit(1);
  }
})();