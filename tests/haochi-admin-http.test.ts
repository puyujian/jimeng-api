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

  const unauthorized = await httpJson(
    port,
    "/api/admin/accounts",
    {
      method: "POST",
      body: JSON.stringify({ email: "demo@example.com" }),
    }
  );
  assert.equal(unauthorized.response.status, 401);

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

  const createdKey = await httpJson(
    port,
    "/api/admin/api-keys",
    {
      method: "POST",
      body: JSON.stringify({
        name: "integration-client",
        description: "test",
        allowedAbilities: ["images", "chat"],
      }),
    },
    cookie
  );
  assert.equal(createdKey.response.status, 200);
  assert.match(createdKey.payload.rawKey, /^haochi_/);
  const apiKeyId = createdKey.payload.apiKey.id;

  const rotatedKey = await httpJson(
    port,
    `/api/admin/api-keys/${apiKeyId}/rotate`,
    { method: "POST" },
    cookie
  );
  assert.equal(rotatedKey.response.status, 200);
  assert.notEqual(rotatedKey.payload.rawKey, createdKey.payload.rawKey);

  const overview = await httpJson(port, "/api/admin/overview", {}, cookie);
  assert.equal(overview.response.status, 200);
  assert.equal(overview.payload.counts.accounts, 1);
  assert.equal(overview.payload.counts.apiKeys, 1);

  const deletedKey = await httpJson(
    port,
    `/api/admin/api-keys/${apiKeyId}`,
    { method: "DELETE" },
    cookie
  );
  assert.equal(deletedKey.response.status, 200);

  const deletedAccount = await httpJson(
    port,
    `/api/admin/accounts/${accountId}`,
    { method: "DELETE" },
    cookie
  );
  assert.equal(deletedAccount.response.status, 200);
});
