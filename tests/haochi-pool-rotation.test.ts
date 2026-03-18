import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import APIException from "../src/lib/exceptions/APIException.ts";
import API_EX from "../src/api/consts/exceptions.ts";
import HaochiStateStore from "../src/haochi/storage/state-store.ts";
import AccountPoolService from "../src/haochi/services/account-pool-service.ts";
import type { LoginProvider, PoolAccount } from "../src/haochi/types.ts";

function createTempStore(name: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `haochi-${name}-`));
  const stateFile = path.join(tempDir, "state.json");
  return {
    tempDir,
    store: new HaochiStateStore(stateFile),
  };
}

function createMockProvider(): LoginProvider {
  return {
    name: "mock",
    async login(account: PoolAccount) {
      const sessionid = `mock-session-${account.email}`;
      return {
        success: true,
        email: account.email,
        userInfo: { email: account.email, nickName: account.email, userId: account.id },
        sessionTokens: {
          sessionid,
          sessionid_ss: sessionid,
          sid_tt: sessionid,
          msToken: null,
          passport_csrf_token: null,
          passport_csrf_token_default: null,
          s_v_web_id: null,
          _tea_web_id: null,
        },
        allCookies: { sessionid },
        logs: [],
        timestamp: new Date().toISOString(),
      };
    },
  };
}

test("号池在账号失效时自动切换并拉黑失效账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-invalid");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({ email: "a@example.com", password: "p1" });
  const accountB = service.createAccount({ email: "b@example.com", password: "p2" });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  const key = service.createApiKey({ name: "rotation-client" });

  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => {
      if (context.accountId === accountA.id) {
        throw new APIException(API_EX.API_TOKEN_EXPIRES, "登录失效");
      }
      return context.accountId;
    }
  );

  assert.equal(result, accountB.id);
  const overview = service.getOverview();
  const failedAccount = overview.accounts.find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, true);
  assert.equal(failedAccount?.status, "invalid");
});

test("号池在积分耗尽时自动切换并拉黑耗尽账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-credit");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({ email: "credit-a@example.com", password: "p1" });
  const accountB = service.createAccount({ email: "credit-b@example.com", password: "p2" });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  const key = service.createApiKey({ name: "credit-client" });

  const result = await service.runWithRequestToken(
    { headers: { authorization: `Bearer ${key.rawKey}` } },
    "videos",
    async (_token, context) => {
      if (context.accountId === accountA.id) {
        throw new APIException(API_EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, "1006 积分不足");
      }
      return context.accountId;
    }
  );

  assert.equal(result, accountB.id);
  const overview = service.getOverview();
  const failedAccount = overview.accounts.find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, true);
  assert.equal(failedAccount?.status, "insufficient_credit");
});

test("无效 API Key 不应回退到 legacy Authorization 分支", async (t) => {
  const { tempDir, store } = createTempStore("rotation-invalid-key");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      service.runWithRequestToken(
        { headers: { "x-api-key": "haochi_invalid_key" } },
        "images",
        async () => "unexpected"
      ),
    (error: any) => {
      assert.equal(error?.httpStatusCode, 401);
      assert.equal(error?.message, "API Key 无效或已失效");
      return true;
    }
  );

  await assert.rejects(
    () =>
      service.runWithRequestToken(
        { headers: { authorization: "Bearer haochi_invalid_key" } },
        "chat",
        async () => "unexpected"
      ),
    (error: any) => {
      assert.equal(error?.httpStatusCode, 401);
      assert.equal(error?.message, "API Key 无效或已失效");
      return true;
    }
  );
});

test("批量导入支持代理并在调度请求时自动拼接到 token", async (t) => {
  const { tempDir, store } = createTempStore("rotation-import-proxy");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const imported = service.importAccounts({
    text: [
      "proxy-a@example.com----pass-a----http://127.0.0.1:9001----节点A----jp-session-a",
      "proxy-b@example.com----pass-b",
    ].join("\n"),
    defaultProxy: "socks5://127.0.0.1:1080",
    maxConcurrency: 4,
    enabled: true,
    autoRefresh: true,
  });

  assert.equal(imported.createdCount, 2);
  assert.equal(imported.failedCount, 0);

  const accountA = imported.items.find((item) => item.email === "proxy-a@example.com");
  const accountB = imported.items.find((item) => item.email === "proxy-b@example.com");
  assert.equal(accountA?.proxy, "http://127.0.0.1:9001");
  assert.equal(accountB?.proxy, "socks5://127.0.0.1:1080");

  const key = service.createApiKey({ name: "proxy-client" });
  store.update((state) => {
    const target = state.apiKeys.find((item) => item.id === key.apiKey.id);
    if (target) target.secretValue = null;
  });

  const token = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (currentToken) => currentToken
  );

  assert.equal(token, "http://127.0.0.1:9001@jp-session-a");
  assert.equal(service.listApiKeys()[0].rawKey, key.rawKey);
});
