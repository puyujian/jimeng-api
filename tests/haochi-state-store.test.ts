import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import HaochiStateStore from "../src/haochi/storage/state-store.ts";

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("显式环境变量会覆盖旧 state.json 中的号池设置并回写", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "haochi-state-store-"));
  const stateFile = path.join(tempDir, "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-03-19T00:00:00.000Z",
        settings: {
          sessionTtlMinutes: 360,
          maintenanceIntervalSeconds: 180,
          defaultAccountMaxConcurrency: 2,
          maxProxyConcurrency: 0,
          maxRequestRetries: 3,
          allowLegacyAuthorization: true,
          loginProvider: "dreamina",
        },
        admins: [],
        accounts: [],
        apiKeys: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  const previousInterval = process.env.HAOCHI_MAINTENANCE_INTERVAL_SECONDS;
  const previousProxyConcurrency = process.env.HAOCHI_PROXY_MAX_CONCURRENCY;
  const previousProvider = process.env.HAOCHI_LOGIN_PROVIDER;

  t.after(() => {
    setEnv("HAOCHI_MAINTENANCE_INTERVAL_SECONDS", previousInterval);
    setEnv("HAOCHI_PROXY_MAX_CONCURRENCY", previousProxyConcurrency);
    setEnv("HAOCHI_LOGIN_PROVIDER", previousProvider);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  process.env.HAOCHI_MAINTENANCE_INTERVAL_SECONDS = "600";
  process.env.HAOCHI_PROXY_MAX_CONCURRENCY = "2";
  process.env.HAOCHI_LOGIN_PROVIDER = "mock";

  const store = new HaochiStateStore(stateFile);
  const settings = store.read((state) => state.settings);

  assert.equal(settings.maintenanceIntervalSeconds, 600);
  assert.equal(settings.maxProxyConcurrency, 2);
  assert.equal(settings.loginProvider, "mock");

  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(persisted.settings.maintenanceIntervalSeconds, 600);
  assert.equal(persisted.settings.maxProxyConcurrency, 2);
  assert.equal(persisted.settings.loginProvider, "mock");
});
