import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import APIException from "../src/lib/exceptions/APIException.ts";
import API_EX from "../src/api/consts/exceptions.ts";
import HaochiStateStore from "../src/haochi/storage/state-store.ts";
import AccountPoolService from "../src/haochi/services/account-pool-service.ts";
import { JimengErrorHandler } from "../src/lib/error-handler.ts";
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check: () => boolean, timeoutMs = 1500, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(intervalMs);
  }
  throw new Error("等待异步状态超时");
}

test("号池在账号失效且不做自动恢复时会切换到下一个账号但不拉黑", async (t) => {
  const { tempDir, store } = createTempStore("rotation-invalid");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({ email: "a@example.com", password: "p1", autoRefresh: false });
  const accountB = service.createAccount({ email: "b@example.com", password: "p2", autoRefresh: false });
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

test("号池在触发当日生成额度上限时自动切换并临时拉黑账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-daily-limit");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({ email: "limit-a@example.com", password: "p1" });
  const accountB = service.createAccount({ email: "limit-b@example.com", password: "p2" });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  const key = service.createApiKey({ name: "daily-limit-client" });

  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => {
      if (context.accountId === accountA.id) {
        JimengErrorHandler.handleApiResponse(
          {
            ret: "121101",
            errmsg: "Can't generate. Youve reached your daily generation limit.",
          },
          {
            context: "即梦API请求",
            operation: "请求",
          }
        );
      }
      return context.accountId;
    }
  );

  assert.equal(result, accountB.id);
  const failedAccount = service.listAccounts().find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, true);
  assert.equal(failedAccount?.status, "insufficient_credit");
  assert.ok(failedAccount?.blacklistReleaseAt);
  assert.match(failedAccount?.lastError || "", /121101|daily generation limit/i);
});

test("号池在命中 3018 permission denied 时会切换到下一个账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-permission-denied");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const accountA = service.createAccount({ email: "permission-a@example.com", password: "p1" });
  const accountB = service.createAccount({ email: "permission-b@example.com", password: "p2" });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  const key = service.createApiKey({ name: "permission-client" });

  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => {
      if (context.accountId === accountA.id) {
        JimengErrorHandler.handleApiResponse(
          {
            ret: "3018",
            errmsg: "permission denied",
          },
          {
            context: "即梦API请求",
            operation: "请求",
          }
        );
      }
      return context.accountId;
    }
  );

  assert.equal(result, accountB.id);
  const failedAccount = service.listAccounts().find((item) => item.id === accountA.id);
  assert.equal(failedAccount?.blacklisted, false);
  assert.equal(failedAccount?.status, "error");
  assert.match(failedAccount?.lastError || "", /3018|permission denied/i);
});

test("号池维护任务会每日检测已有 Session 的账号，并自动刷新可恢复的失效账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-maintenance-daily-check");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const invalidAccount = service.createAccount({
    email: "maintenance-invalid@example.com",
    password: "p1",
    sessionId: "bad-session",
    autoRefresh: true,
  });
  const healthyAccount = service.createAccount({
    email: "maintenance-healthy@example.com",
    password: "p2",
    sessionId: "mock-session-maintenance-healthy",
    autoRefresh: true,
  });

  await service.runMaintenance();

  const invalidAfter = service.listAccounts().find((item) => item.id === invalidAccount.id);
  const healthyAfter = service.listAccounts().find((item) => item.id === healthyAccount.id);
  assert.equal(invalidAfter?.status, "healthy");
  assert.equal(invalidAfter?.lastValidationStatus, "valid");
  assert.ok(invalidAfter?.lastLoginAt);
  assert.equal(healthyAfter?.status, "healthy");
  assert.equal(healthyAfter?.lastValidationStatus, "valid");
  assert.equal(healthyAfter?.lastLoginAt, null);
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

test("号池维护任务会跳过没有 Session 的账号，保留 idle 状态", async (t) => {
  const { tempDir, store } = createTempStore("rotation-maintenance-skip-idle");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const idleAccount = service.createAccount({
    email: "maintenance-idle@example.com",
    password: "p1",
    autoRefresh: true,
  });
  const healthyAccount = service.createAccount({
    email: "maintenance-session@example.com",
    password: "p2",
    sessionId: "mock-session-maintenance-session",
    autoRefresh: false,
  });

  await service.runMaintenance();

  const idleAfter = service.listAccounts().find((item) => item.id === idleAccount.id);
  const healthyAfter = service.listAccounts().find((item) => item.id === healthyAccount.id);
  assert.equal(idleAfter?.status, "idle");
  assert.equal(idleAfter?.lastValidationStatus, "unknown");
  assert.equal(idleAfter?.lastValidatedAt, null);
  assert.equal(healthyAfter?.status, "healthy");
  assert.equal(healthyAfter?.lastValidationStatus, "valid");
  assert.ok(healthyAfter?.lastValidatedAt);
});

test("总览统计会把所有异常状态归到失效中，并单独统计拉黑账号", (t) => {
  const { tempDir, store } = createTempStore("rotation-overview-invalid-buckets");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const healthy = service.createAccount({
    email: "overview-healthy@example.com",
    password: "p1",
    sessionId: "mock-session-overview-healthy",
  });
  const idle = service.createAccount({
    email: "overview-idle@example.com",
    password: "p2",
  });
  const disabled = service.createAccount({
    email: "overview-disabled@example.com",
    password: "p3",
    enabled: false,
  });
  const expired = service.createAccount({
    email: "overview-expired@example.com",
    password: "p4",
    sessionId: "mock-session-overview-expired",
  });
  const errored = service.createAccount({
    email: "overview-error@example.com",
    password: "p5",
    sessionId: "mock-session-overview-error",
  });
  const refreshing = service.createAccount({
    email: "overview-refreshing@example.com",
    password: "p6",
    sessionId: "mock-session-overview-refreshing",
  });
  const blacklisted = service.createAccount({
    email: "overview-blacklisted@example.com",
    password: "p7",
    sessionId: "mock-session-overview-blacklisted",
  });

  store.update((state) => {
    const expiredTarget = state.accounts.find((item) => item.id === expired.id);
    const errorTarget = state.accounts.find((item) => item.id === errored.id);
    const refreshingTarget = state.accounts.find((item) => item.id === refreshing.id);
    const blacklistedTarget = state.accounts.find((item) => item.id === blacklisted.id);
    if (expiredTarget) expiredTarget.status = "expired";
    if (errorTarget) errorTarget.status = "error";
    if (refreshingTarget) refreshingTarget.status = "refreshing";
    if (blacklistedTarget) {
      blacklistedTarget.blacklisted = true;
      blacklistedTarget.status = "insufficient_credit";
      blacklistedTarget.blacklistedReason = "1006";
    }
  });

  const overview = service.getOverview();

  assert.equal(overview.counts.accounts, 7);
  assert.equal(overview.counts.healthy, 1);
  assert.equal(overview.counts.invalid, 5);
  assert.equal(overview.counts.blacklisted, 1);
  assert.equal(overview.counts.withSession, 5);
  assert.deepEqual(overview.counts.invalidBreakdown, {
    idle: 1,
    refreshing: 1,
    expired: 1,
    invalid: 0,
    disabled: 1,
    error: 1,
  });
  assert.equal(overview.counts.healthy + overview.counts.invalid + overview.counts.blacklisted, 7);
  assert.equal(service.listAccounts().find((item) => item.id === healthy.id)?.status, "healthy");
});

test("号池启动时会把历史遗留 refreshing 状态恢复成稳态", async (t) => {
  const { tempDir, store } = createTempStore("rotation-recover-refreshing-on-start");
  const service = new AccountPoolService(store, createMockProvider());
  t.after(async () => {
    await service.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const healthyAccount = service.createAccount({
    email: "recover-healthy@example.com",
    password: "p1",
    sessionId: "mock-session-recover-healthy",
    autoRefresh: true,
  });
  const idleAccount = service.createAccount({
    email: "recover-idle@example.com",
    password: "p2",
    autoRefresh: true,
  });
  const expiredAccount = service.createAccount({
    email: "recover-expired@example.com",
    password: "p3",
    sessionId: "mock-session-recover-expired",
    autoRefresh: true,
  });

  store.update((state) => {
    const healthy = state.accounts.find((item) => item.id === healthyAccount.id);
    const idle = state.accounts.find((item) => item.id === idleAccount.id);
    const expired = state.accounts.find((item) => item.id === expiredAccount.id);
    const staleTimestamp = "2026-01-01T00:00:00.000Z";
    if (healthy) {
      healthy.status = "refreshing";
      healthy.lastValidationStatus = "valid";
      healthy.lastValidatedAt = staleTimestamp;
      healthy.sessionUpdatedAt = staleTimestamp;
    }
    if (idle) {
      idle.status = "refreshing";
    }
    if (expired) {
      expired.status = "refreshing";
      expired.lastValidationStatus = "invalid";
      expired.lastValidatedAt = staleTimestamp;
      expired.sessionUpdatedAt = staleTimestamp;
    }
  });

  service.start();

  const accounts = service.listAccounts();
  assert.equal(accounts.find((item) => item.id === healthyAccount.id)?.status, "healthy");
  assert.equal(accounts.find((item) => item.id === idleAccount.id)?.status, "idle");
  assert.equal(accounts.find((item) => item.id === expiredAccount.id)?.status, "expired");
});

test("号池在登录 provider 直接抛异常时不会永久卡在 refreshing", async (t) => {
  const { tempDir, store } = createTempStore("rotation-refresh-throw");
  const provider: LoginProvider = {
    name: "mock",
    async login() {
      throw new Error("浏览器启动失败");
    },
  };
  const service = new AccountPoolService(store, provider);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const account = service.createAccount({
    email: "refresh-throw@example.com",
    password: "p1",
    autoRefresh: true,
  });

  await assert.rejects(
    service.refreshAccountSession(account.id, "test"),
    /浏览器启动失败/
  );

  const failedAccount = service.listAccounts().find((item) => item.id === account.id);
  assert.equal(failedAccount?.status, "error");
  assert.match(failedAccount?.lastError || "", /浏览器启动失败/);
});

test("号池在登录失效时会先切换下一个账号，再后台异步刷新失败账号", async (t) => {
  const { tempDir, store } = createTempStore("rotation-refresh-background");
  const loginCountByEmail = new Map<string, number>();
  let notifyRefreshStarted: (() => void) | null = null;
  let releaseRefresh: (() => void) | null = null;
  const refreshStarted = new Promise<void>((resolve) => {
    notifyRefreshStarted = resolve;
  });
  const refreshBlocked = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const provider: LoginProvider = {
    name: "mock",
    async login(account: PoolAccount) {
      const current = (loginCountByEmail.get(account.email) || 0) + 1;
      loginCountByEmail.set(account.email, current);
      if (account.email === "refresh-a@example.com" && current === 2) {
        notifyRefreshStarted?.();
        await refreshBlocked;
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

  const accountA = service.createAccount({ email: "refresh-a@example.com", password: "p1" });
  const accountB = service.createAccount({ email: "refresh-b@example.com", password: "p2" });
  await service.refreshAccountSession(accountA.id, "test");
  await service.refreshAccountSession(accountB.id, "test");
  const key = service.createApiKey({ name: "refresh-background-client" });

  const attempted: string[] = [];
  const resultPromise = service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (_token, context) => {
      attempted.push(String(context.accountId));
      if (context.accountId === accountA.id) {
        throw new APIException(API_EX.API_TOKEN_EXPIRES, "登录失效");
      }
      return context.accountId;
    }
  );

  await refreshStarted;
  const result = await Promise.race([
    resultPromise,
    sleep(500).then(() => {
      throw new Error("请求被后台 Session 恢复阻塞");
    }),
  ]);

  assert.equal(result, accountB.id);
  assert.deepEqual(attempted, [accountA.id, accountB.id]);
  assert.equal(service.listAccounts().find((item) => item.id === accountA.id)?.status, "refreshing");

  releaseRefresh?.();
  await waitForCondition(
    () => service.listAccounts().find((item) => item.id === accountA.id)?.status === "healthy"
  );

  const refreshedAccount = service.listAccounts().find((item) => item.id === accountA.id);
  assert.equal(refreshedAccount?.blacklisted, false);
  assert.equal(refreshedAccount?.status, "healthy");
  assert.equal(loginCountByEmail.get("refresh-a@example.com"), 2);
});

test("号池在后台恢复失败时会继续切换到下一个账号", async (t) => {
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
  await waitForCondition(
    () => service.listAccounts().find((item) => item.id === accountA.id)?.status === "error"
  );
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

test("号池不会在分配前预校验 expired 账号，而是在请求失败后再切换", async (t) => {
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
    for (const target of state.accounts) {
      if (target.id !== invalidUnknown.id && target.id !== nextUnknown.id) continue;
      target.lastValidationStatus = "invalid";
      target.status = "expired";
      target.lastError = "Dreamina 会话已失效";
    }
  });
  const key = service.createApiKey({ name: "validate-unknown-client" });
  const attempted: string[] = [];

  const result = await service.runWithRequestToken(
    { headers: { "x-api-key": key.rawKey } },
    "images",
    async (token, context) => {
      attempted.push(String(context.accountId));
      if (token === "bad-session") {
        throw new APIException(API_EX.API_TOKEN_EXPIRES, "登录失效");
      }
      return context.accountId;
    }
  );

  assert.equal(result, nextUnknown.id);
  assert.deepEqual(attempted, [invalidUnknown.id, nextUnknown.id]);
  const failedAccount = service.listAccounts().find((item) => item.id === invalidUnknown.id);
  assert.equal(failedAccount?.lastValidationStatus, "invalid");
  assert.equal(failedAccount?.status, "invalid");
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

test("账号导出会生成可回导文本并跳过缺少密码和 Session 的账号", (t) => {
  const { tempDir, store } = createTempStore("rotation-export");
  const { tempDir: importTempDir, store: importStore } = createTempStore("rotation-export-import");
  const service = new AccountPoolService(store, createMockProvider());
  const importService = new AccountPoolService(importStore, createMockProvider());
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(importTempDir, { recursive: true, force: true }));

  service.createAccount({
    email: "export-a@example.com",
    password: "pass-a",
    proxy: "http://127.0.0.1:9001",
    notes: "节点A",
    sessionId: "jp-session-a",
  });
  service.createAccount({
    email: "export-b@example.com",
    password: "pass-b",
  });
  service.createAccount({
    email: "export-c@example.com",
    proxy: "socks5://127.0.0.1:1080",
    sessionId: "us-session-c",
  });
  service.createAccount({
    email: "export-d@example.com",
  });

  const exported = service.exportAccounts();
  assert.equal(exported.matchedCount, 4);
  assert.equal(exported.exportedCount, 3);
  assert.equal(exported.skippedCount, 1);
  assert.match(exported.fileName, /^haochi-accounts-all-\d{8}-\d{6}Z\.txt$/);
  assert.match(exported.content, /export-a@example\.com----pass-a----http:\/\/127\.0\.0\.1:9001----节点A----Sessionid=jp-session-a/);
  assert.match(exported.content, /# 跳过 export-d@example\.com: 缺少密码和 SessionID，无法按现有批量导入格式回填/);

  const reimported = importService.importAccounts({
    text: exported.content,
    enabled: true,
    autoRefresh: true,
    maxConcurrency: 2,
  });

  assert.equal(reimported.createdCount, 3);
  assert.equal(reimported.failedCount, 0);
  const accountA = reimported.items.find((item) => item.email === "export-a@example.com");
  const accountB = reimported.items.find((item) => item.email === "export-b@example.com");
  const accountC = reimported.items.find((item) => item.email === "export-c@example.com");
  assert.equal(accountA?.proxy, "http://127.0.0.1:9001");
  assert.equal(accountA?.region, "jp");
  assert.equal(accountA?.status, "healthy");
  assert.equal(accountB?.proxy, null);
  assert.equal(accountB?.status, "idle");
  assert.equal(accountC?.proxy, "socks5://127.0.0.1:1080");
  assert.equal(accountC?.region, "us");
  assert.equal(accountC?.status, "healthy");
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
