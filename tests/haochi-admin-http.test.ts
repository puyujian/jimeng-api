import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
async function waitForServer(port: number, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`);
      if (response.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("等待测试服务器启动超时");
}

async function stopProcess(child: ReturnType<typeof spawn>) {
  if (!child.pid || child.killed) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("close", () => resolve());
  });
  child.kill();
  const gracefulResult = await Promise.race([
    exited.then(() => "exited"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1200)),
  ]);
  if (gracefulResult === "timeout" && process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    await exited.catch(() => undefined);
  }
}

async function httpJson(port: number, pathname: string, options: RequestInit = {}, cookie = "") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload };
}

test("号池管理后台 HTTP 链路可用", { concurrency: false }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "haochi-http-"));
  const stateFile = path.join(tempDir, "state.json");
  const port = 5217;

  const child = spawn(
    process.execPath,
    [path.resolve(repoRoot, "dist/index.js"), `--port=${port}`],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SERVER_PORT: String(port),
        HAOCHI_LOGIN_PROVIDER: "mock",
        HAOCHI_STATE_PATH: stateFile,
      },
      stdio: "ignore",
    }
  );

  t.after(async () => {
    await stopProcess(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(port);

  const adminPage = await fetch(`http://127.0.0.1:${port}/admin`);
  const adminHtml = await adminPage.text();
  assert.equal(adminPage.status, 200);
  assert.match(adminHtml, /Dreamina Account Pool/);
  const stylesAssetPath = adminHtml.match(/href="([^"]*\/admin\/assets\/styles\.css\?v=[^"]+)"/)?.[1];
  const scriptAssetPath = adminHtml.match(/src="([^"]*\/admin\/assets\/app\.js\?v=[^"]+)"/)?.[1];
  assert.ok(stylesAssetPath, "管理后台首页应返回带版本戳的 styles.css");
  assert.ok(scriptAssetPath, "管理后台首页应返回带版本戳的 app.js");

  const adminScript = await fetch(`http://127.0.0.1:${port}${scriptAssetPath}`);
  assert.equal(adminScript.status, 200);
  assert.equal(adminScript.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const unauthorized = await httpJson(
    port,
    "/api/admin/accounts",
    {
      method: "POST",
      body: JSON.stringify({ email: "demo@example.com" }),
    }
  );
  assert.equal(unauthorized.response.status, 401);

  const unauthorizedExport = await httpJson(port, "/api/admin/accounts/export");
  assert.equal(unauthorizedExport.response.status, 401);

  const login = await httpJson(port, "/api/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "ChangeMe123!" }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie") || "";
  assert.match(cookie, /haochi_admin_session/);

  const createdAccount = await httpJson(
    port,
    "/api/admin/accounts",
    {
      method: "POST",
      body: JSON.stringify({
        email: "demo@example.com",
        password: "password-123",
        maxConcurrency: 3,
        autoRefresh: true,
        enabled: true,
      }),
    },
    cookie
  );
  assert.equal(createdAccount.response.status, 200);
  const accountId = createdAccount.payload.item.id;

  const refreshed = await httpJson(
    port,
    `/api/admin/accounts/${accountId}/refresh-session`,
    { method: "POST" },
    cookie
  );
  assert.equal(refreshed.response.status, 200);
  assert.ok(Array.isArray(refreshed.payload.logs));

  const validated = await httpJson(
    port,
    `/api/admin/accounts/${accountId}/validate-session`,
    { method: "POST" },
    cookie
  );
  assert.equal(validated.response.status, 200);
  assert.equal(validated.payload.valid, true);

  const updatedAccount = await httpJson(
    port,
    `/api/admin/accounts/${accountId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        email: "demo@example.com",
        proxy: "http://127.0.0.1:7001",
        region: "jp",
        maxConcurrency: 3,
        autoRefresh: true,
        enabled: true,
        notes: "jp-account",
      }),
    },
    cookie
  );
  assert.equal(updatedAccount.response.status, 200);
  assert.equal(updatedAccount.payload.item.region, "jp");
  assert.equal(updatedAccount.payload.item.status, "healthy");

  const importedAccounts = await httpJson(
    port,
    "/api/admin/accounts/import",
    {
      method: "POST",
      body: JSON.stringify({
        text: [
          "batch-a@example.com----pass-a----http://127.0.0.1:9001----节点A",
          "batch-b@example.com----pass-b",
          "batch-c@example.com----pass-c----Sessionid=jp-session-c",
        ].join("\n"),
        defaultProxy: "socks5://127.0.0.1:1080",
        maxConcurrency: 4,
        enabled: true,
        autoRefresh: false,
      }),
    },
    cookie
  );
  assert.equal(importedAccounts.response.status, 200);
  assert.equal(importedAccounts.payload.createdCount, 3);
  assert.equal(importedAccounts.payload.failedCount, 0);
  const importedA = importedAccounts.payload.items.find((item: any) => item.email === "batch-a@example.com");
  const importedB = importedAccounts.payload.items.find((item: any) => item.email === "batch-b@example.com");
  const importedC = importedAccounts.payload.items.find((item: any) => item.email === "batch-c@example.com");
  assert.equal(importedA.proxy, "http://127.0.0.1:9001");
  assert.equal(importedB.proxy, "socks5://127.0.0.1:1080");
  assert.equal(importedC.proxy, "socks5://127.0.0.1:1080");
  assert.equal(importedC.status, "healthy");
  assert.equal(importedC.region, "jp");

  const pagedAccounts = await httpJson(port, "/api/admin/accounts?page=1&page_size=2", {}, cookie);
  assert.equal(pagedAccounts.response.status, 200);
  assert.equal(pagedAccounts.payload.total, 4);
  assert.equal(pagedAccounts.payload.page, 1);
  assert.equal(pagedAccounts.payload.pageSize, 2);
  assert.equal(pagedAccounts.payload.totalPages, 2);
  assert.equal("password" in pagedAccounts.payload.items[0], false);
  assert.equal("sessionTokens" in pagedAccounts.payload.items[0], false);
  assert.equal(typeof pagedAccounts.payload.items[0].hasPassword, "boolean");
  assert.equal(typeof pagedAccounts.payload.items[0].passwordLocked, "boolean");
  assert.deepEqual(
    pagedAccounts.payload.items.map((item: any) => item.email),
    ["batch-a@example.com", "batch-b@example.com"]
  );

  const blacklistedAccount = await httpJson(
    port,
    `/api/admin/accounts/${importedA.id}/blacklist`,
    {
      method: "POST",
      body: JSON.stringify({ reason: "manual" }),
    },
    cookie
  );
  assert.equal(blacklistedAccount.response.status, 200);

  const invalidatedAccount = await httpJson(
    port,
    `/api/admin/accounts/${importedB.id}/validate-session`,
    { method: "POST" },
    cookie
  );
  assert.equal(invalidatedAccount.response.status, 200);
  assert.equal(invalidatedAccount.payload.valid, false);

  const healthyOnly = await httpJson(port, "/api/admin/accounts?status=healthy&page=1&page_size=10", {}, cookie);
  assert.equal(healthyOnly.response.status, 200);
  assert.equal(healthyOnly.payload.total, 2);
  assert.deepEqual(
    healthyOnly.payload.items.map((item: any) => item.email),
    ["batch-c@example.com", "demo@example.com"]
  );

  const invalidOnly = await httpJson(port, "/api/admin/accounts?status=invalid&page=1&page_size=10", {}, cookie);
  assert.equal(invalidOnly.response.status, 200);
  assert.equal(invalidOnly.payload.total, 1);
  assert.equal(invalidOnly.payload.items[0].id, importedB.id);

  const blacklistedOnly = await httpJson(
    port,
    "/api/admin/accounts?status=blacklisted&page=1&page_size=10",
    {},
    cookie
  );
  assert.equal(blacklistedOnly.response.status, 200);
  assert.equal(blacklistedOnly.payload.total, 1);
  assert.equal(blacklistedOnly.payload.items[0].id, importedA.id);

  const refreshedInvalid = await httpJson(
    port,
    "/api/admin/accounts/batch/refresh-invalid-session",
    { method: "POST" },
    cookie
  );
  assert.equal(refreshedInvalid.response.status, 200);
  assert.equal(refreshedInvalid.payload.matchedCount, 1);
  assert.equal(refreshedInvalid.payload.refreshedCount, 1);
  assert.equal(refreshedInvalid.payload.failedCount, 0);
  assert.equal(refreshedInvalid.payload.refreshed[0].id, importedB.id);

  const invalidAfterRefresh = await httpJson(
    port,
    "/api/admin/accounts?status=invalid&page=1&page_size=10",
    {},
    cookie
  );
  assert.equal(invalidAfterRefresh.response.status, 200);
  assert.equal(invalidAfterRefresh.payload.total, 0);

  const validatedAll = await httpJson(
    port,
    "/api/admin/accounts/batch/validate-session",
    { method: "POST" },
    cookie
  );
  assert.equal(validatedAll.response.status, 200);
  assert.equal(validatedAll.payload.matchedCount, 4);
  assert.equal(validatedAll.payload.validCount, 1);
  assert.equal(validatedAll.payload.invalidCount, 3);
  assert.equal(validatedAll.payload.failedCount, 0);

  const batchUpdated = await httpJson(
    port,
    "/api/admin/accounts/batch/update",
    {
      method: "POST",
      body: JSON.stringify({
        ids: [accountId, importedB.id, importedC.id],
        proxy: "http://127.0.0.1:9009",
        region: "us",
      }),
    },
    cookie
  );
  assert.equal(batchUpdated.response.status, 200);
  assert.equal(batchUpdated.payload.matchedCount, 3);
  assert.equal(batchUpdated.payload.updatedCount, 3);
  assert.equal(batchUpdated.payload.regionUpdatedCount, 3);
  assert.equal(batchUpdated.payload.regionSkippedCount, 0);

  const afterBatch = await httpJson(port, "/api/admin/accounts?page=1&page_size=10", {}, cookie);
  assert.equal(afterBatch.response.status, 200);
  const batchAccount = afterBatch.payload.items.find((item: any) => item.id === accountId);
  const batchImportedB = afterBatch.payload.items.find((item: any) => item.id === importedB.id);
  const batchImportedC = afterBatch.payload.items.find((item: any) => item.id === importedC.id);
  assert.equal(batchAccount.proxy, "http://127.0.0.1:9009");
  assert.equal(batchAccount.region, "us");
  assert.equal(batchImportedB.proxy, "http://127.0.0.1:9009");
  assert.equal(batchImportedB.region, "us");
  assert.equal(batchImportedC.proxy, "http://127.0.0.1:9009");
  assert.equal(batchImportedC.region, "us");

  const exportedAccounts = await httpJson(port, "/api/admin/accounts/export", {}, cookie);
  assert.equal(exportedAccounts.response.status, 200);
  assert.equal(exportedAccounts.payload.matchedCount, 4);
  assert.equal(exportedAccounts.payload.exportedCount, 4);
  assert.equal(exportedAccounts.payload.skippedCount, 0);
  assert.match(exportedAccounts.payload.fileName, /^haochi-accounts-all-\d{8}-\d{6}Z\.txt$/);
  assert.match(
    exportedAccounts.payload.content,
    /demo@example\.com----password-123----http:\/\/127\.0\.0\.1:9009----jp-account----Sessionid=us-mock-session-[a-z0-9]+/
  );
  assert.match(
    exportedAccounts.payload.content,
    /batch-c@example\.com----pass-c----http:\/\/127\.0\.0\.1:9009--------Sessionid=us-session-c/
  );

  const createdKey = await httpJson(
    port,
    "/api/admin/api-keys",
    {
      method: "POST",
      body: JSON.stringify({
        name: "integration-client",
        description: "test",
        allowedAbilities: ["images", "chat", "token"],
      }),
    },
    cookie
  );
  assert.equal(createdKey.response.status, 200);
  assert.match(createdKey.payload.rawKey, /^haochi_/);
  assert.equal(createdKey.payload.apiKey.rawKey, createdKey.payload.rawKey);
  const apiKeyId = createdKey.payload.apiKey.id;

  const rotatedKey = await httpJson(
    port,
    `/api/admin/api-keys/${apiKeyId}/rotate`,
    { method: "POST" },
    cookie
  );
  assert.equal(rotatedKey.response.status, 200);
  assert.notEqual(rotatedKey.payload.rawKey, createdKey.payload.rawKey);

  const oldKeyPoints = await httpJson(port, "/token/points", {
    method: "POST",
    body: JSON.stringify({}),
    headers: {
      "X-API-Key": createdKey.payload.rawKey,
    },
  });
  assert.equal(oldKeyPoints.response.status, 401);
  assert.equal(oldKeyPoints.payload.message, "API Key 无效或已失效");

  const listedKeys = await httpJson(port, "/api/admin/api-keys", {}, cookie);
  assert.equal(listedKeys.response.status, 200);
  assert.equal(listedKeys.payload.items[0].rawKey, rotatedKey.payload.rawKey);

  const overview = await httpJson(port, "/api/admin/overview", {}, cookie);
  assert.equal(overview.response.status, 200);
  assert.equal(overview.payload.counts.accounts, 4);
  assert.equal(overview.payload.counts.apiKeys, 1);
  assert.equal(typeof overview.payload.counts.invalid, "number");
  assert.equal(typeof overview.payload.counts.invalidBreakdown, "object");
  assert.equal(
    overview.payload.counts.healthy + overview.payload.counts.invalid + overview.payload.counts.blacklisted,
    overview.payload.counts.accounts
  );
  assert.equal(overview.payload.counts.totalCapacity, 15);
  assert.equal(overview.payload.apiKeys[0].rawKey, rotatedKey.payload.rawKey);
  assert.equal(overview.payload.accounts, undefined);

  const outboundLogs = await httpJson(port, "/api/admin/logs/outbound?limit=20", {}, cookie);
  assert.equal(outboundLogs.response.status, 200);
  assert.equal(outboundLogs.payload.kind, "outbound");
  assert.ok(Array.isArray(outboundLogs.payload.entries));
  assert.equal(typeof outboundLogs.payload.fileName, "string");
  assert.equal(typeof outboundLogs.payload.totalMatched, "number");

  const batchDeleted = await httpJson(
    port,
    "/api/admin/accounts/batch/delete",
    {
      method: "POST",
      body: JSON.stringify({
        ids: [importedA.id, importedB.id],
      }),
    },
    cookie
  );
  assert.equal(batchDeleted.response.status, 200);
  assert.equal(batchDeleted.payload.deletedCount, 2);

  const deletedKey = await httpJson(
    port,
    `/api/admin/api-keys/${apiKeyId}`,
    { method: "DELETE" },
    cookie
  );
  assert.equal(deletedKey.response.status, 200);

  const deletedKeyPoints = await httpJson(port, "/token/points", {
    method: "POST",
    body: JSON.stringify({}),
    headers: {
      "X-API-Key": rotatedKey.payload.rawKey,
    },
  });
  assert.equal(deletedKeyPoints.response.status, 401);
  assert.equal(deletedKeyPoints.payload.message, "API Key 无效或已失效");

  const deletedAccount = await httpJson(
    port,
    `/api/admin/accounts/${accountId}`,
    { method: "DELETE" },
    cookie
  );
  assert.equal(deletedAccount.response.status, 200);

  const remainingAccounts = await httpJson(port, "/api/admin/accounts?page=1&page_size=10", {}, cookie);
  assert.equal(remainingAccounts.response.status, 200);
  assert.equal(remainingAccounts.payload.total, 1);
  assert.equal(remainingAccounts.payload.items[0].id, importedC.id);
});
