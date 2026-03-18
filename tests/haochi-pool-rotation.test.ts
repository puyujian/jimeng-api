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

test("号池在账号失效且自动续期后仍失败时会切换到下一个账号但不拉黑", async (t) => {
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
  const failedAccount = service.listAccounts().find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, false);
  assert.equal(failedAccount?.status, "invalid");
});

test("号池在积分耗尽时自动切换并临时拉黑耗尽账号", async (t) => {
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
  const failedAccount = service.listAccounts().find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, true);
  assert.equal(failedAccount?.status, "insufficient_credit");
  assert.ok(failedAccount?.blacklistReleaseAt);
});

test("号池维护任务会自动刷新已失效账号并恢复上线", async (t) => {
  const { tempDir, store } = createTempStore("rotation-maintenance-refresh-invalid");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const account = service.createAccount({
    email: "maintenance-invalid@example.com",
    password: "p1",
    sessionId: "bad-session",
    autoRefresh: true,
  });

  await service.validateAccountSession(account.id);
  const invalidAccount = service.listAccounts().find((item) => item.id === account.id);
  assert.equal(invalidAccount?.status, "expired");

  await service.runMaintenance();

  const refreshedAccount = service.listAccounts().find((item) => item.id === account.id);
  assert.equal(refreshedAccount?.blacklisted, false);
  assert.equal(refreshedAccount?.status, "healthy");
  assert.equal(refreshedAccount?.lastValidationStatus, "valid");
});

test("号池维护任务会在次日自动解除积分黑名单", async (t) => {
  const { tempDir, store } = createTempStore("rotation-maintenance-release-credit");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const account = service.createAccount({
    email: "maintenance-credit@example.com",
    password: "p1",
    sessionId: "mock-session-maintenance-credit",
    autoRefresh: true,
  });
  const past = new Date(Date.now() - 60_000).toISOString();

  store.update((state) => {
    const target = state.accounts.find((item) => item.id === account.id);
    if (!target) return;
    target.blacklisted = true;
    target.blacklistedReason = "1006 积分不足";
    target.blacklistedAt = past;
    target.blacklistReleaseAt = past;
    target.lastError = "1006 积分不足";
    target.status = "insufficient_credit";
  });

  await service.runMaintenance();

  const releasedAccount = service.listAccounts().find((item) => item.id === account.id);
  assert.equal(releasedAccount?.blacklisted, false);
  assert.equal(releasedAccount?.blacklistReleaseAt, null);
  assert.equal(releasedAccount?.status, "healthy");
});

test("号池在登录失效时会先自动续期当前账号再重试", async (t) => {
  const { tempDir, store } = createTempStore("rotation-refresh-current");
  let loginCount = 0;
  const provider: LoginProvider = {
    name: "mock",
    async login(account: PoolAccount) {
      loginCount += 1;
      const sessionid = `mock-session-${account.email}-${loginCount}`;
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
  const service = new AccountPoolService(store, provider);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const account = service.createAccount({ email: "refresh@example.com", password: "p1" });
  await service.refreshAccountSession(account.id, "test");
  const key = service.createApiKey({ name: "refresh-current-client" });

  let attemptCount = 0;
  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (token, context) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        throw new APIException(API_EX.API_TOKEN_EXPIRES, "登录失效");
      }
      assert.equal(context.accountId, account.id);
      return token;
    }
  );

  assert.match(result, /mock-session-refresh@example.com-2$/);
  assert.equal(attemptCount, 2);
  assert.equal(loginCount, 2);
  const refreshedAccount = service.listAccounts().find((item) => item.id === account.id);
  assert.equal(refreshedAccount?.blacklisted, false);
  assert.equal(refreshedAccount?.status, "healthy");
});

test("号池在自动续期失败时会继续切换到下一个账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-refresh-fallback");
  const loginCountByEmail = new Map<string, number>();
  const provider: LoginProvider = {
    name: "mock",
    async login(account: PoolAccount) {
      const current = (loginCountByEmail.get(account.email) || 0) + 1;
      loginCountByEmail.set(account.email, current);
      if (account.email === "fallback-a@example.com" && current > 1) {
        return {
          success: false,
          email: account.email,
          error: "未成功打开 Dreamina 登录界面",
          logs: [],
          timestamp: new Date().toISOString(),
        };
      }

      const sessionid = `mock-session-${account.email}-${current}`;
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
  const service = new AccountPoolService(store, provider);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({ email: "fallback-a@example.com", password: "p1" });
  const accountB = service.createAccount({ email: "fallback-b@example.com", password: "p2" });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  const key = service.createApiKey({ name: "refresh-fallback-client" });

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
  const failedAccount = service.listAccounts().find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, false);
  assert.equal(failedAccount?.status, "error");
});

test("号池会继续尝试直到候选账号耗尽，而不是被 maxRequestRetries 截断", async (t) => {
  const { tempDir, store } = createTempStore("rotation-all-candidates");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  store.update((state) => {
    state.settings.maxRequestRetries = 1;
  });

  const accounts = [
    service.createAccount({ email: "pool-a@example.com", password: "p1" }),
    service.createAccount({ email: "pool-b@example.com", password: "p2" }),
    service.createAccount({ email: "pool-c@example.com", password: "p3" }),
  ];
  for (const account of accounts) {
    await service.refreshAccountSession(account.id, "test");
  }
  const key = service.createApiKey({ name: "all-candidates-client" });

  const attempted: string[] = [];
  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => {
      attempted.push(String(context.accountId));
      if (context.accountId !== accounts[2].id) {
        throw new APIException(API_EX.API_TOKEN_EXPIRES, `登录失效:${context.accountId}`);
      }
      return context.accountId;
    }
  );

  assert.equal(result, accounts[2].id);
  assert.deepEqual(Array.from(new Set(attempted)), accounts.map((item) => item.id));
  assert.equal(attempted[attempted.length - 1], accounts[2].id);
});

test("号池优先选择当前 Session 已校验 valid 的账号，而不是过期的 stale-valid 标记", async (t) => {
  const { tempDir, store } = createTempStore("rotation-prioritize-valid");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const staleAccount = service.createAccount({
    email: "stale@example.com",
    password: "p1",
    sessionId: "mock-session-stale",
    autoRefresh: false,
  });
  store.update((state) => {
    const target = state.accounts.find((item) => item.id === staleAccount.id);
    if (!target) return;
    target.lastValidationStatus = "valid";
    target.lastValidatedAt = "2026-01-01T00:00:00.000Z";
    target.sessionUpdatedAt = "2026-01-01T00:10:00.000Z";
  });
  const validatedAccount = service.createAccount({ email: "valid@example.com", password: "p2" });
  await service.refreshAccountSession(validatedAccount.id, "test");

  store.update((state) => {
    const target = state.accounts.find((item) => item.id === validatedAccount.id);
    if (!target) return;
    target.lastUsedAt = new Date(Date.now() + 60_000).toISOString();
  });

  const key = service.createApiKey({ name: "prioritize-valid-client" });
  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => context.accountId
  );

  assert.equal(result, validatedAccount.id);
  const untouchedStale = service.listAccounts().find((item) => item.id === staleAccount.id);
  assert.equal(untouchedStale?.lastValidationStatus, "valid");
});

test("号池会优先选择失败率更低的健康账号，而不是历史失败很多的旧账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-prioritize-reliable");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const noisyAccount = service.createAccount({ email: "noisy@example.com", password: "p1" });
  const reliableAccount = service.createAccount({ email: "reliable@example.com", password: "p2" });
  await service.refreshAccountSession(noisyAccount.id, "test");
  await service.refreshAccountSession(reliableAccount.id, "test");

  store.update((state) => {
    const noisy = state.accounts.find((item) => item.id === noisyAccount.id);
    const reliable = state.accounts.find((item) => item.id === reliableAccount.id);
    if (noisy) {
      noisy.successCount = 14;
      noisy.failureCount = 36;
      noisy.lastError = "connect ECONNREFUSED 38.12.35.171:2260";
      noisy.lastUsedAt = "2026-01-01T00:00:00.000Z";
    }
    if (reliable) {
      reliable.successCount = 1;
      reliable.failureCount = 0;
      reliable.lastError = null;
      reliable.lastUsedAt = "2026-12-31T00:00:00.000Z";
    }
  });

  const key = service.createApiKey({ name: "reliable-client" });
  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => context.accountId
  );

  assert.equal(result, reliableAccount.id);
});

test("号池在同代理达到并发上限时会切换到其他代理账号", async (t) => {
  const previousProxyLimit = process.env.HAOCHI_PROXY_MAX_CONCURRENCY;
  process.env.HAOCHI_PROXY_MAX_CONCURRENCY = "1";
  t.after(() => {
    if (previousProxyLimit === undefined) {
      delete process.env.HAOCHI_PROXY_MAX_CONCURRENCY;
      return;
    }
    process.env.HAOCHI_PROXY_MAX_CONCURRENCY = previousProxyLimit;
  });

  const { tempDir, store } = createTempStore("rotation-proxy-cap");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({
    email: "proxy-cap-a@example.com",
    password: "p1",
    proxy: "http://127.0.0.1:9001",
  });
  const accountB = service.createAccount({
    email: "proxy-cap-b@example.com",
    password: "p2",
    proxy: "http://127.0.0.1:9001",
  });
  const accountC = service.createAccount({
    email: "proxy-cap-c@example.com",
    password: "p3",
    proxy: "http://127.0.0.1:9002",
  });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  await service.refreshAccountSession(accountC.id, "test");

  store.update((state) => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const targetB = state.accounts.find((item) => item.id === accountB.id);
    const targetC = state.accounts.find((item) => item.id === accountC.id);
    if (targetB) targetB.lastUsedAt = later;
    if (targetC) targetC.lastUsedAt = later;
  });

  const key = service.createApiKey({ name: "proxy-cap-client" });
  let releaseFirstRequest: (() => void) | null = null;
  const firstRequestReady = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });

  let resolveFirstSelection: ((value: string) => void) | null = null;
  const firstSelection = new Promise<string>((resolve) => {
    resolveFirstSelection = resolve;
  });

  const firstRequest = service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => {
      resolveFirstSelection?.(String(context.accountId));
      await firstRequestReady;
      return context.accountId;
    }
  );

  assert.equal(await firstSelection, accountA.id);

  const secondRequestResult = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => context.accountId
  );

  assert.equal(secondRequestResult, accountC.id);
  releaseFirstRequest?.();
  assert.equal(await firstRequest, accountA.id);
});

test("号池会跳过已标记 invalid 的账号并继续使用下一个候选", async (t) => {
  const { tempDir, store } = createTempStore("rotation-skip-invalid");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const invalidUnknown = service.createAccount({
    email: "invalid-unknown@example.com",
    password: null,
    sessionId: "bad-session",
    autoRefresh: false,
  });
  const nextUnknown = service.createAccount({
    email: "next-unknown@example.com",
    password: null,
    sessionId: "mock-session-next",
    autoRefresh: false,
  });
  store.update((state) => {
    const target = state.accounts.find((item) => item.id === invalidUnknown.id);
    if (!target) return;
    target.lastValidationStatus = "invalid";
    target.status = "expired";
    target.lastError = "Dreamina 会话已失效";
  });
  const key = service.createApiKey({ name: "validate-unknown-client" });

  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => context.accountId
  );

  assert.equal(result, nextUnknown.id);
  const failedAccount = service.listAccounts().find((item) => item.id === invalidUnknown.id);
  assert.equal(failedAccount?.lastValidationStatus, "invalid");
  assert.equal(failedAccount?.status, "expired");
});

test("号池在代理网络错误时会切换到下一个账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-network-fallback");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({ email: "network-a@example.com", password: "p1" });
  const accountB = service.createAccount({ email: "network-b@example.com", password: "p2" });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  const key = service.createApiKey({ name: "network-client" });

  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => {
      if (context.accountId === accountA.id) {
        throw new Error("Proxy connection ended before receiving CONNECT response");
      }
      return context.accountId;
    }
  );

  assert.equal(result, accountB.id);
  const failedAccount = service.listAccounts().find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, false);
  assert.equal(failedAccount?.status, "error");
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

test("批量导入支持第三段使用 Sessionid 标记且不误判为代理", async (t) => {
  const { tempDir, store } = createTempStore("rotation-import-session-tag");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const imported = service.importAccounts({
    text: "session-tag@example.com----pass-a----Sessionid=jp-session-tag",
    enabled: true,
    autoRefresh: false,
  });

  assert.equal(imported.createdCount, 1);
  assert.equal(imported.failedCount, 0);
  assert.equal(imported.items[0]?.proxy, null);
  assert.equal(imported.items[0]?.status, "healthy");

  const key = service.createApiKey({ name: "session-tag-client" });
  const token = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (currentToken) => currentToken
  );

  assert.equal(token, "jp-session-tag");
});

test("账号更新地区时会重写 sessionid 前缀且不会误清空已有 Session", async (t) => {
  const { tempDir, store } = createTempStore("rotation-region-update");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const created = service.createAccount({
    email: "region-update@example.com",
    password: "p1",
    sessionId: "raw-session-id",
    region: "jp",
  });
  assert.equal(created.region, "jp");

  const updated = service.updateAccount(created.id, {
    email: "region-update@example.com",
    region: "us",
    proxy: "http://127.0.0.1:9001",
    maxConcurrency: 2,
    enabled: true,
    autoRefresh: true,
    notes: "region-updated",
  });
  assert.equal(updated.region, "us");
  assert.equal(updated.status, "healthy");

  const key = service.createApiKey({ name: "region-update-client" });
  const token = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (currentToken) => currentToken
  );

  assert.equal(token, "http://127.0.0.1:9001@us-raw-session-id");
});

test("批量修改全部账号的代理和地区时兼容旧 session 前缀数据", (t) => {
  const { tempDir, store } = createTempStore("rotation-batch-region");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const legacyCn = service.createAccount({
    email: "legacy-cn@example.com",
    password: "p1",
    sessionId: "legacy-cn-session",
  });
  const legacyJp = service.createAccount({
    email: "legacy-jp@example.com",
    password: "p2",
    sessionId: "jp-legacy-jp-session",
  });
  service.createAccount({
    email: "no-session@example.com",
    password: "p3",
  });

  const updated = service.updateAccountsBatch({
    applyToAll: true,
    proxy: "http://127.0.0.1:9009",
    region: "sg",
  });
  assert.equal(updated.matchedCount, 3);
  assert.equal(updated.updatedCount, 3);
  assert.equal(updated.regionUpdatedCount, 2);
  assert.equal(updated.regionSkippedCount, 1);

  const items = service.listAccounts();
  const nextCn = items.find((item) => item.id === legacyCn.id);
  const nextJp = items.find((item) => item.id === legacyJp.id);
  const noSession = items.find((item) => item.email === "no-session@example.com");

  assert.equal(nextCn?.region, "sg");
  assert.equal(nextCn?.proxy, "http://127.0.0.1:9009");
  assert.equal(nextJp?.region, "sg");
  assert.equal(nextJp?.proxy, "http://127.0.0.1:9009");
  assert.equal(noSession?.region, "cn");
  assert.equal(noSession?.proxy, "http://127.0.0.1:9009");

  const deleted = service.deleteAccountsBatch({ applyToAll: true });
  assert.equal(deleted.deletedCount, 3);
  assert.equal(service.listAccounts().length, 0);
});

test("一键刷新失效账号 Session 会刷新 invalid/expired 账号并返回结果", async (t) => {
  const { tempDir, store } = createTempStore("rotation-refresh-invalid-batch");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const expiredAccount = service.createAccount({
    email: "expired-batch@example.com",
    password: "p1",
    sessionId: "bad-session",
    autoRefresh: false,
  });
  const blacklistedAccount = service.createAccount({
    email: "blacklisted-batch@example.com",
    password: "p2",
    sessionId: "bad-session-2",
    autoRefresh: false,
  });

  await service.validateAccountSession(expiredAccount.id);
  await service.validateAccountSession(blacklistedAccount.id);
  service.blacklistAccount(blacklistedAccount.id, "manual");

  const result = await service.refreshInvalidAccountsSessions();

  assert.equal(result.matchedCount, 1);
  assert.equal(result.refreshedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(result.refreshed[0]?.id, expiredAccount.id);
  const refreshed = service.listAccounts().find((item) => item.id === expiredAccount.id);
  const blacklisted = service.listAccounts().find((item) => item.id === blacklistedAccount.id);
  assert.equal(refreshed?.status, "healthy");
  assert.equal(blacklisted?.blacklisted, true);
});

test("一键校验全部账号会返回有效和失效统计", async (t) => {
  const { tempDir, store } = createTempStore("rotation-validate-all");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const validAccount = service.createAccount({
    email: "validate-ok@example.com",
    password: "p1",
    sessionId: "mock-session-valid",
  });
  const invalidAccount = service.createAccount({
    email: "validate-bad@example.com",
    password: "p2",
    sessionId: "bad-session",
  });
  const noSessionAccount = service.createAccount({
    email: "validate-empty@example.com",
    password: "p3",
  });

  const result = await service.validateAllAccountsSessions();

  assert.equal(result.matchedCount, 3);
  assert.equal(result.validCount, 1);
  assert.equal(result.invalidCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(result.results.find((item) => item.id === validAccount.id)?.valid, true);
  assert.equal(result.results.find((item) => item.id === invalidAccount.id)?.valid, false);
  assert.equal(result.results.find((item) => item.id === noSessionAccount.id)?.valid, false);
});

test("账号列表分页返回稳定页信息且按邮箱排序", (t) => {
  const { tempDir, store } = createTempStore("rotation-pagination");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  service.createAccount({ email: "delta@example.com", password: "p1" });
  service.createAccount({ email: "alpha@example.com", password: "p2" });
  service.createAccount({ email: "charlie@example.com", password: "p3" });
  service.createAccount({ email: "bravo@example.com", password: "p4" });

  const secondPage = service.listAccountsPage({ page: 2, pageSize: 2 });

  assert.equal(secondPage.total, 4);
  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.pageSize, 2);
  assert.equal(secondPage.totalPages, 2);
  assert.deepEqual(
    secondPage.items.map((item) => item.email),
    ["charlie@example.com", "delta@example.com"]
  );

  const overflowPage = service.listAccountsPage({ page: 99, pageSize: 2 });
  assert.equal(overflowPage.page, 2);

  const blacklisted = service.createAccount({ email: "blacklisted@example.com", password: "p5" });
  service.blacklistAccount(blacklisted.id, "manual");

  const healthyOnly = service.listAccountsPage({ page: 1, pageSize: 10, status: "healthy" });
  assert.equal(healthyOnly.total, 0);

  const blacklistedOnly = service.listAccountsPage({ page: 1, pageSize: 10, status: "blacklisted" });
  assert.equal(blacklistedOnly.total, 1);
  assert.equal(blacklistedOnly.items[0]?.email, "blacklisted@example.com");
});
