import API_EX from "@/api/consts/exceptions.ts";
import { getCredit, getTokenLiveStatus, receiveCredit } from "@/api/controllers/core.ts";
import SYSTEM_EX from "@/lib/consts/exceptions.ts";
import Exception from "@/lib/exceptions/Exception.ts";
import logger from "@/lib/logger.ts";
import HaochiStateStore from "@/haochi/storage/state-store.ts";
import type {
  AccountLease,
  AccountSessionTokens,
  AccountStatus,
  ApiKeyRecord,
  EncryptedPayload,
  HaochiSettings,
  LoginProvider,
  PoolAbility,
  PoolAccount,
} from "@/haochi/types.ts";
import {
  ALL_ABILITIES,
  clampNumber,
  createSecretHash,
  decryptString,
  encryptString,
  isEncryptedPayload,
  isEncryptionEnabled,
  maskSecret,
  nowIso,
  parseBoolean,
  randomId,
  randomToken,
  verifySecret,
} from "@/haochi/utils/crypto.ts";
import {
  attachProxyToToken,
  maskProxyUrl,
  normalizeProxyUrl,
} from "@/haochi/utils/proxy.ts";

function createHttpError(message: string, statusCode = 400) {
  return new Exception(SYSTEM_EX.SYSTEM_REQUEST_VALIDATION_ERROR, message).setHTTPStatusCode(statusCode);
}

function emptySessionTokens(): AccountSessionTokens {
  return {
    sessionid: null,
    sessionid_ss: null,
    sid_tt: null,
    msToken: null,
    passport_csrf_token: null,
    passport_csrf_token_default: null,
    s_v_web_id: null,
    _tea_web_id: null,
  };
}

function primaryToken(account: PoolAccount) {
  return (
    account.sessionTokens?.sessionid ||
    account.sessionTokens?.sessionid_ss ||
    account.sessionTokens?.sid_tt ||
    null
  );
}

function normalizeAllowedAbilities(value: any) {
  const incoming = Array.isArray(value) ? value : [];
  const normalized = incoming
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item): item is PoolAbility =>
      (ALL_ABILITIES as string[]).includes(item)
    );
  return normalized.length > 0
    ? (Array.from(new Set(normalized)) as PoolAbility[])
    : (["images", "videos", "chat"] as PoolAbility[]);
}

function sanitizeSessionTokens(input: Partial<AccountSessionTokens> | null | undefined) {
  const base = emptySessionTokens();
  const next = input || {};
  return {
    ...base,
    sessionid: next.sessionid || null,
    sessionid_ss: next.sessionid_ss || null,
    sid_tt: next.sid_tt || null,
    msToken: next.msToken || null,
    passport_csrf_token: next.passport_csrf_token || null,
    passport_csrf_token_default: next.passport_csrf_token_default || null,
    s_v_web_id: next.s_v_web_id || null,
    _tea_web_id: next._tea_web_id || null,
  };
}

function detectImportDelimiter(line: string) {
  for (const delimiter of ["----", "\t", "|", ","]) {
    if (line.includes(delimiter)) return delimiter;
  }
  return null;
}

function extractTaggedSessionId(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const matched = raw.match(/^session[\s_-]*id\s*[:=]\s*(.+)$/i);
  if (!matched) return null;
  const sessionId = matched[1]?.trim();
  return sessionId || null;
}

function parseImportedAccountLine(rawLine: string) {
  const delimiter = detectImportDelimiter(rawLine);
  if (!delimiter) {
    throw new Error("无法识别导入分隔符，请使用 ----、制表符、竖线或逗号");
  }

  const parts = rawLine.split(delimiter).map((item) => item.trim());
  if (parts.length < 2) {
    throw new Error("每行至少需要提供邮箱和密码");
  }

  const [email, password = "", thirdField = "", fourthField = "", fifthField = ""] = parts;
  if (!email) throw new Error("账号邮箱不能为空");
  const thirdSessionId = extractTaggedSessionId(thirdField);
  const fourthSessionId = extractTaggedSessionId(fourthField);
  const fifthSessionId = extractTaggedSessionId(fifthField);

  let proxy = thirdField;
  let notes = fourthField;
  let sessionId = fifthSessionId || fifthField;
  let hasProxyField = parts.length >= 3;
  let hasNotesField = parts.length >= 4;
  let hasSessionField = parts.length >= 5;

  if (thirdSessionId) {
    proxy = "";
    notes = "";
    sessionId = thirdSessionId;
    hasProxyField = false;
    hasNotesField = false;
    hasSessionField = true;
  } else if (fourthSessionId) {
    notes = "";
    sessionId = fourthSessionId;
    hasNotesField = false;
    hasSessionField = true;
  } else if (fifthSessionId) {
    sessionId = fifthSessionId;
    hasSessionField = true;
  }

  if (!password && !sessionId) {
    throw new Error("每行至少需要提供密码或 SessionID");
  }

  return {
    email,
    password,
    proxy,
    notes,
    sessionId,
    hasProxyField,
    hasNotesField,
    hasSessionField,
  };
}

function statusPriority(status: AccountStatus) {
  switch (status) {
    case "healthy":
      return 1;
    case "idle":
      return 2;
    case "expired":
      return 3;
    case "error":
      return 4;
    case "invalid":
      return 5;
    case "insufficient_credit":
      return 6;
    case "blacklisted":
      return 7;
    case "disabled":
      return 8;
    case "refreshing":
      return 9;
    default:
      return 10;
  }
}

export default class AccountPoolService {
  readonly store: HaochiStateStore;
  readonly loginProvider: LoginProvider;
  readonly leaseMap = new Map<string, Map<string, AccountLease>>();
  readonly refreshTasks = new Map<string, Promise<any>>();
  maintenanceTimer: NodeJS.Timeout | null = null;
  maintenanceRunning = false;

  constructor(store: HaochiStateStore, loginProvider: LoginProvider) {
    this.store = store;
    this.loginProvider = loginProvider;
  }

  start() {
    if (this.maintenanceTimer) return;
    const intervalMs = this.settings.maintenanceIntervalSeconds * 1000;
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenance();
    }, intervalMs);
    this.maintenanceTimer.unref?.();
    logger.info(
      `号池维护任务已启动: provider=${this.loginProvider.name}, interval=${this.settings.maintenanceIntervalSeconds}s`
    );
  }

  async stop() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    await this.loginProvider.close?.();
  }

  get settings(): HaochiSettings {
    return this.store.getState().settings;
  }

  #resolveStoredPassword(password: PoolAccount["password"]) {
    if (!password) return null;
    if (typeof password === "string") return password;
    if (isEncryptedPayload(password) && isEncryptionEnabled(this.store.encryptionSecret)) {
      try {
        return decryptString(password as EncryptedPayload, this.store.encryptionSecret);
      } catch {
        return null;
      }
    }
    return null;
  }

  #resolveStoredApiKeyValue(secretValue: ApiKeyRecord["secretValue"]) {
    if (!secretValue) return null;
    if (typeof secretValue === "string") return secretValue;
    if (isEncryptedPayload(secretValue) && isEncryptionEnabled(this.store.encryptionSecret)) {
      try {
        return decryptString(secretValue as EncryptedPayload, this.store.encryptionSecret);
      } catch {
        return null;
      }
    }
    return null;
  }

  #storePassword(password: string | null | undefined) {
    const raw = String(password || "").trim();
    if (!raw) return null;
    if (isEncryptionEnabled(this.store.encryptionSecret)) {
      return encryptString(raw, this.store.encryptionSecret);
    }
    return raw;
  }

  #storeApiKeyValue(secretValue: string | null | undefined) {
    const raw = String(secretValue || "").trim();
    if (!raw) return null;
    if (isEncryptionEnabled(this.store.encryptionSecret)) {
      return encryptString(raw, this.store.encryptionSecret);
    }
    return raw;
  }

  #publicAccount(account: PoolAccount) {
    const locked =
      isEncryptedPayload(account.password) && !isEncryptionEnabled(this.store.encryptionSecret);
    return {
      id: account.id,
      email: account.email,
      proxy: normalizeProxyUrl(account.proxy),
      proxyPreview: maskProxyUrl(account.proxy) || null,
      enabled: account.enabled,
      autoRefresh: account.autoRefresh,
      maxConcurrency: account.maxConcurrency,
      notes: account.notes,
      status: account.status,
      blacklisted: account.blacklisted,
      blacklistedReason: account.blacklistedReason,
      blacklistedAt: account.blacklistedAt,
      lastError: account.lastError,
      lastLoginAt: account.lastLoginAt,
      lastValidatedAt: account.lastValidatedAt,
      lastValidationStatus: account.lastValidationStatus,
      lastUsedAt: account.lastUsedAt,
      sessionUpdatedAt: account.sessionUpdatedAt,
      sessionExpiresAt: account.sessionExpiresAt,
      sessionIdPreview: maskSecret(primaryToken(account), 8, 6),
      hasPassword: !!account.password,
      passwordLocked: locked,
      userInfo: account.userInfo,
      successCount: account.successCount,
      failureCount: account.failureCount,
      activeLeases: this.getActiveLeaseCount(account.id),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  #publicApiKey(record: ApiKeyRecord) {
    const rawKey = this.#resolveStoredApiKeyValue(record.secretValue);
    const rawKeyLocked =
      isEncryptedPayload(record.secretValue) && !isEncryptionEnabled(this.store.encryptionSecret);
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      enabled: record.enabled,
      allowedAbilities: record.allowedAbilities,
      rawKey,
      rawKeyLocked,
      keyPreview: record.keyPreview,
      lastUsedAt: record.lastUsedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  #materializeAccount(account: PoolAccount): PoolAccount {
    return {
      ...account,
      password: this.#resolveStoredPassword(account.password),
      proxy: normalizeProxyUrl(account.proxy),
      sessionTokens: sanitizeSessionTokens(account.sessionTokens),
    };
  }

  #buildRequestToken(account: PoolAccount) {
    return attachProxyToToken(primaryToken(account), account.proxy);
  }

  #requireAccount(accountId: string) {
    const account =
      this.store
        .getState()
        .accounts.find((item) => item.id === accountId) || null;
    if (!account) throw createHttpError("账号不存在", 404);
    return account;
  }

  #requireApiKey(apiKeyId: string) {
    const apiKey =
      this.store
        .getState()
        .apiKeys.find((item) => item.id === apiKeyId) || null;
    if (!apiKey) throw createHttpError("API Key 不存在", 404);
    return apiKey;
  }

  #isSessionExpiring(account: PoolAccount, bufferMinutes = this.settings.sessionRefreshBufferMinutes) {
    const token = primaryToken(account);
    if (!token) return true;
    if (!account.sessionExpiresAt) return false;
    return new Date(account.sessionExpiresAt).getTime() <= Date.now() + bufferMinutes * 60 * 1000;
  }

  getActiveLeaseCount(accountId: string) {
    return this.leaseMap.get(accountId)?.size || 0;
  }

  #acquireLease(account: PoolAccount, ability: PoolAbility) {
    const maxConcurrency = clampNumber(
      account.maxConcurrency,
      1,
      50,
      this.settings.defaultAccountMaxConcurrency
    );
    const current = this.leaseMap.get(account.id) || new Map<string, AccountLease>();
    if (current.size >= maxConcurrency) return null;

    const leaseId = randomId("lease");
    current.set(leaseId, {
      leaseId,
      accountId: account.id,
      startedAt: nowIso(),
      ability,
    });
    this.leaseMap.set(account.id, current);
    return {
      leaseId,
      release: () => {
        const leases = this.leaseMap.get(account.id);
        if (!leases) return;
        leases.delete(leaseId);
        if (leases.size === 0) this.leaseMap.delete(account.id);
      },
    };
  }

  #classifyAccountError(error: any) {
    const message = String(error?.message || error || "");
    const compare = typeof error?.compare === "function" ? error.compare.bind(error) : null;

    if (compare?.(API_EX.API_TOKEN_EXPIRES) || /登录失效|token已失效|session.*失效/i.test(message)) {
      return {
        retryable: true,
        blacklist: true,
        status: "invalid" as AccountStatus,
        reason: message || "Session 已失效",
      };
    }

    if (
      compare?.(API_EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS) ||
      /1006/.test(message) ||
      /积分不足|credit/i.test(message)
    ) {
      return {
        retryable: true,
        blacklist: true,
        status: "insufficient_credit" as AccountStatus,
        reason: message || "积分不足",
      };
    }

    return {
      retryable: false,
      blacklist: false,
      status: "error" as AccountStatus,
      reason: message || "请求失败",
    };
  }

  #buildSessionExpiry() {
    return new Date(Date.now() + this.settings.sessionTtlMinutes * 60 * 1000).toISOString();
  }

  listAccounts() {
    return this.store
      .getState()
      .accounts.map((item) => this.#publicAccount(item))
      .sort((a, b) => a.email.localeCompare(b.email));
  }

  listApiKeys() {
    return this.store
      .getState()
      .apiKeys.map((item) => this.#publicApiKey(item))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getOverview() {
    const state = this.store.getState();
    const healthy = state.accounts.filter((item) => item.status === "healthy" && !item.blacklisted).length;
    const blacklisted = state.accounts.filter((item) => item.blacklisted).length;
    const withSession = state.accounts.filter((item) => !!primaryToken(item)).length;
    const activeLeases = Array.from(this.leaseMap.values()).reduce((sum, item) => sum + item.size, 0);

    return {
      settings: state.settings,
      loginProvider: this.loginProvider.name,
      counts: {
        accounts: state.accounts.length,
        apiKeys: state.apiKeys.length,
        healthy,
        blacklisted,
        withSession,
        activeLeases,
      },
      accounts: this.listAccounts(),
      apiKeys: this.listApiKeys(),
    };
  }

  importAccounts(payload: any) {
    const text = String(payload?.text || "").replace(/\r\n/g, "\n");
    if (!text.trim()) throw createHttpError("批量导入内容不能为空", 400);

    const overwriteExisting = parseBoolean(payload?.overwriteExisting, true);
    const defaultProxy =
      payload?.defaultProxy !== undefined || payload?.proxy !== undefined
        ? normalizeProxyUrl(payload?.defaultProxy ?? payload?.proxy)
        : null;
    const defaultEnabled = parseBoolean(payload?.enabled, true);
    const defaultAutoRefresh = parseBoolean(payload?.autoRefresh, true);
    const defaultMaxConcurrency = clampNumber(
      payload?.maxConcurrency,
      1,
      20,
      this.settings.defaultAccountMaxConcurrency
    );

    const items: ReturnType<AccountPoolService["listAccounts"]> = [];
    const errors: Array<{ line: number; raw: string; error: string }> = [];
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    const lines = text
      .split("\n")
      .map((raw, index) => ({
        line: index + 1,
        raw,
        trimmed: raw.trim(),
      }))
      .filter((item) => item.trimmed && !item.trimmed.startsWith("#") && !item.trimmed.startsWith("//"));

    if (!lines.length) throw createHttpError("批量导入内容不能为空", 400);

    for (const entry of lines) {
      try {
        const parsed = parseImportedAccountLine(entry.trimmed);
        const existing = this.store
          .getState()
          .accounts.find((item) => item.email.toLowerCase() === parsed.email.toLowerCase());
        const proxyValue = parsed.hasProxyField ? parsed.proxy : defaultProxy;

        if (existing) {
          if (!overwriteExisting) {
            skippedCount += 1;
            errors.push({
              line: entry.line,
              raw: entry.raw,
              error: "账号已存在，已跳过",
            });
            continue;
          }

          const nextPayload: Record<string, any> = {
            email: parsed.email,
            enabled: defaultEnabled,
            autoRefresh: defaultAutoRefresh,
            maxConcurrency: defaultMaxConcurrency,
          };
          if (parsed.password) nextPayload.password = parsed.password;
          if (parsed.hasProxyField || defaultProxy !== null) nextPayload.proxy = proxyValue;
          if (parsed.hasNotesField) nextPayload.notes = parsed.notes;
          if (parsed.hasSessionField && parsed.sessionId) nextPayload.sessionId = parsed.sessionId;
          items.push(this.updateAccount(existing.id, nextPayload));
          updatedCount += 1;
          continue;
        }

        items.push(
          this.createAccount({
            email: parsed.email,
            password: parsed.password,
            sessionId: parsed.sessionId,
            proxy: proxyValue,
            notes: parsed.notes,
            enabled: defaultEnabled,
            autoRefresh: defaultAutoRefresh,
            maxConcurrency: defaultMaxConcurrency,
          })
        );
        createdCount += 1;
      } catch (error: any) {
        errors.push({
          line: entry.line,
          raw: entry.raw,
          error: error?.message || String(error),
        });
      }
    }

    return {
      totalLines: lines.length,
      createdCount,
      updatedCount,
      skippedCount,
      failedCount: errors.length,
      items,
      errors,
    };
  }

  createAccount(payload: any) {
    const email = String(payload?.email || "").trim();
    if (!email) throw createHttpError("账号邮箱不能为空", 400);
    const existing = this.store
      .getState()
      .accounts.find((item) => item.email.toLowerCase() === email.toLowerCase());
    if (existing) throw createHttpError("账号已存在", 409);

    const now = nowIso();
    const sessionId = String(payload?.sessionId || "").trim();
    const enabled = parseBoolean(payload?.enabled, true);
    const account: PoolAccount = {
      id: randomId("account"),
      email,
      password: this.#storePassword(payload?.password),
      proxy: normalizeProxyUrl(payload?.proxy),
      enabled,
      autoRefresh: parseBoolean(payload?.autoRefresh, true),
      maxConcurrency: clampNumber(
        payload?.maxConcurrency,
        1,
        20,
        this.settings.defaultAccountMaxConcurrency
      ),
      notes: String(payload?.notes || "").trim(),
      status: enabled ? (sessionId ? "healthy" : "idle") : "disabled",
      blacklisted: false,
      blacklistedReason: null,
      blacklistedAt: null,
      lastError: null,
      lastLoginAt: null,
      lastValidatedAt: null,
      lastValidationStatus: "unknown",
      lastUsedAt: null,
      sessionUpdatedAt: sessionId ? now : null,
      sessionExpiresAt: sessionId ? this.#buildSessionExpiry() : null,
      sessionTokens: sanitizeSessionTokens({
        sessionid: sessionId || null,
        sessionid_ss: sessionId || null,
        sid_tt: sessionId || null,
      }),
      userInfo: null,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.store.update((state) => {
      state.accounts.push(account);
    });
    return this.#publicAccount(account);
  }

  updateAccount(accountId: string, payload: any) {
    const current = this.#requireAccount(accountId);
    const nextEmail = String(payload?.email || current.email).trim();
    if (!nextEmail) throw createHttpError("账号邮箱不能为空", 400);
    const duplicated = this.store
      .getState()
      .accounts.find(
        (item) => item.id !== accountId && item.email.toLowerCase() === nextEmail.toLowerCase()
      );
    if (duplicated) throw createHttpError("账号邮箱重复", 409);

    this.store.update((state) => {
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account) return;

      account.email = nextEmail;
      if (payload?.proxy !== undefined) {
        account.proxy = normalizeProxyUrl(payload.proxy);
      }
      account.enabled =
        payload?.enabled === undefined ? account.enabled : parseBoolean(payload.enabled, account.enabled);
      account.autoRefresh =
        payload?.autoRefresh === undefined
          ? account.autoRefresh
          : parseBoolean(payload.autoRefresh, account.autoRefresh);
      account.maxConcurrency = clampNumber(
        payload?.maxConcurrency,
        1,
        20,
        account.maxConcurrency || this.settings.defaultAccountMaxConcurrency
      );
      account.notes = payload?.notes === undefined ? account.notes : String(payload.notes || "").trim();

      if (payload?.clearPassword) account.password = null;
      else if (payload?.password !== undefined && String(payload.password).trim()) {
        account.password = this.#storePassword(payload.password);
      }

      if (payload?.clearSession) {
        account.sessionTokens = emptySessionTokens();
        account.sessionUpdatedAt = null;
        account.sessionExpiresAt = null;
        account.status = account.enabled ? "idle" : "disabled";
      } else if (payload?.sessionId !== undefined) {
        const sessionId = String(payload.sessionId || "").trim();
        account.sessionTokens = sanitizeSessionTokens({
          sessionid: sessionId || null,
          sessionid_ss: sessionId || null,
          sid_tt: sessionId || null,
        });
        account.sessionUpdatedAt = sessionId ? nowIso() : null;
        account.sessionExpiresAt = sessionId ? this.#buildSessionExpiry() : null;
        if (!account.blacklisted) account.status = sessionId ? "healthy" : account.enabled ? "idle" : "disabled";
      }

      if (payload?.blacklisted === false) {
        account.blacklisted = false;
        account.blacklistedReason = null;
        account.blacklistedAt = null;
        if (account.enabled && primaryToken(account)) account.status = "healthy";
      }

      if (!account.enabled) account.status = "disabled";
      account.updatedAt = nowIso();
    });

    return this.#publicAccount(this.#requireAccount(accountId));
  }

  deleteAccount(accountId: string) {
    this.store.update((state) => {
      state.accounts = state.accounts.filter((item) => item.id !== accountId);
    });
    this.leaseMap.delete(accountId);
    return { deleted: true };
  }

  async refreshAccountSession(accountId: string, source = "manual") {
    if (this.refreshTasks.has(accountId)) return this.refreshTasks.get(accountId);

    const task = (async () => {
      const stored = this.#requireAccount(accountId);
      const account = this.#materializeAccount(stored);
      if (!account.password) {
        throw createHttpError("当前账号没有可用密码，无法自动登录刷新 Session", 400);
      }

      this.store.update((state) => {
        const target = state.accounts.find((item) => item.id === accountId);
        if (!target) return;
        target.status = "refreshing";
        target.updatedAt = nowIso();
      });

      const result = await this.loginProvider.login(account);
      if (!result.success || !result.sessionTokens || !result.sessionTokens.sessionid) {
        this.store.update((state) => {
          const target = state.accounts.find((item) => item.id === accountId);
          if (!target) return;
          target.status = target.enabled ? "error" : "disabled";
          target.lastError = result.error || "自动登录失败";
          target.failureCount += 1;
          target.updatedAt = nowIso();
        });
        throw createHttpError(result.error || "自动登录失败", 502);
      }

      this.store.update((state) => {
        const target = state.accounts.find((item) => item.id === accountId);
        if (!target) return;
        target.sessionTokens = sanitizeSessionTokens(result.sessionTokens);
        target.userInfo = result.userInfo || null;
        target.sessionUpdatedAt = nowIso();
        target.sessionExpiresAt = this.#buildSessionExpiry();
        target.lastLoginAt = nowIso();
        target.lastValidatedAt = nowIso();
        target.lastValidationStatus = "valid";
        target.lastError = null;
        target.blacklisted = false;
        target.blacklistedReason = null;
        target.blacklistedAt = null;
        target.status = target.enabled ? "healthy" : "disabled";
        target.updatedAt = nowIso();
      });

      logger.info(`账号 ${stored.email} 刷新 Session 成功，来源=${source}`);
      return {
        account: this.#publicAccount(this.#requireAccount(accountId)),
        logs: result.logs,
      };
    })().finally(() => {
      this.refreshTasks.delete(accountId);
    });

    this.refreshTasks.set(accountId, task);
    return task;
  }

  async validateAccountSession(accountId: string) {
    const account = this.#materializeAccount(this.#requireAccount(accountId));
    const token = this.#buildRequestToken(account);
    if (!token) {
      this.store.update((state) => {
        const target = state.accounts.find((item) => item.id === accountId);
        if (!target) return;
        target.lastValidatedAt = nowIso();
        target.lastValidationStatus = "invalid";
        if (!target.blacklisted) target.status = target.enabled ? "expired" : "disabled";
        target.updatedAt = nowIso();
      });
      return {
        valid: false,
        reason: "当前账号没有可用 SessionID",
        account: this.#publicAccount(this.#requireAccount(accountId)),
      };
    }

    let valid = false;
    let reason = "Session 校验通过";
    if (this.loginProvider.name === "mock") {
      valid = String(primaryToken(account) || "").startsWith("mock-session-");
      if (!valid) reason = "Mock Session 不合法";
    } else {
      try {
        valid = await getTokenLiveStatus(token);
        if (!valid) reason = "Dreamina 会话已失效";
      } catch (error: any) {
        valid = false;
        reason = error?.message || "校验 Session 失败";
      }
    }

    this.store.update((state) => {
      const target = state.accounts.find((item) => item.id === accountId);
      if (!target) return;
      target.lastValidatedAt = nowIso();
      target.lastValidationStatus = valid ? "valid" : "invalid";
      if (!target.blacklisted) {
        target.status = valid
          ? target.enabled
            ? "healthy"
            : "disabled"
          : target.enabled
            ? "expired"
            : "disabled";
      }
      target.lastError = valid ? null : reason;
      target.updatedAt = nowIso();
    });

    return {
      valid,
      reason,
      account: this.#publicAccount(this.#requireAccount(accountId)),
    };
  }

  blacklistAccount(accountId: string, reason: string) {
    this.store.update((state) => {
      const target = state.accounts.find((item) => item.id === accountId);
      if (!target) return;
      target.blacklisted = true;
      target.blacklistedReason = String(reason || "已手动拉黑").trim();
      target.blacklistedAt = nowIso();
      target.status = "blacklisted";
      target.updatedAt = nowIso();
    });
    return this.#publicAccount(this.#requireAccount(accountId));
  }

  unblacklistAccount(accountId: string) {
    this.store.update((state) => {
      const target = state.accounts.find((item) => item.id === accountId);
      if (!target) return;
      target.blacklisted = false;
      target.blacklistedReason = null;
      target.blacklistedAt = null;
      target.status = target.enabled ? (primaryToken(target) ? "healthy" : "idle") : "disabled";
      target.updatedAt = nowIso();
    });
    return this.#publicAccount(this.#requireAccount(accountId));
  }

  createApiKey(payload: any) {
    const name = String(payload?.name || "").trim();
    if (!name) throw createHttpError("API Key 名称不能为空", 400);

    const rawKey = `haochi_${randomToken(24)}`;
    const now = nowIso();
    const record: ApiKeyRecord = {
      id: randomId("key"),
      name,
      description: String(payload?.description || "").trim(),
      enabled: parseBoolean(payload?.enabled, true),
      allowedAbilities: normalizeAllowedAbilities(payload?.allowedAbilities),
      secretHash: createSecretHash(rawKey),
      secretValue: this.#storeApiKeyValue(rawKey),
      keyPreview: `${rawKey.slice(0, 10)}...${rawKey.slice(-6)}`,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.store.update((state) => {
      state.apiKeys.push(record);
    });

    return {
      apiKey: this.#publicApiKey(record),
      rawKey,
    };
  }

  updateApiKey(apiKeyId: string, payload: any) {
    this.store.update((state) => {
      const target = state.apiKeys.find((item) => item.id === apiKeyId);
      if (!target) return;
      if (payload?.name !== undefined) target.name = String(payload.name || "").trim() || target.name;
      if (payload?.description !== undefined) target.description = String(payload.description || "").trim();
      if (payload?.enabled !== undefined) target.enabled = parseBoolean(payload.enabled, target.enabled);
      if (payload?.allowedAbilities !== undefined) {
        target.allowedAbilities = normalizeAllowedAbilities(payload.allowedAbilities);
      }
      target.updatedAt = nowIso();
    });
    return this.#publicApiKey(this.#requireApiKey(apiKeyId));
  }

  rotateApiKey(apiKeyId: string) {
    const rawKey = `haochi_${randomToken(24)}`;
    this.store.update((state) => {
      const target = state.apiKeys.find((item) => item.id === apiKeyId);
      if (!target) return;
      target.secretHash = createSecretHash(rawKey);
      target.secretValue = this.#storeApiKeyValue(rawKey);
      target.keyPreview = `${rawKey.slice(0, 10)}...${rawKey.slice(-6)}`;
      target.updatedAt = nowIso();
    });

    return {
      apiKey: this.#publicApiKey(this.#requireApiKey(apiKeyId)),
      rawKey,
    };
  }

  deleteApiKey(apiKeyId: string) {
    this.store.update((state) => {
      state.apiKeys = state.apiKeys.filter((item) => item.id !== apiKeyId);
    });
    return { deleted: true };
  }

  hasCredential(headers: Record<string, any>) {
    return !!(
      String(headers?.authorization || "").trim() ||
      String(headers?.["x-api-key"] || "").trim()
    );
  }

  isManagedApiKeyRequest(headers: Record<string, any>) {
    return !!this.#extractManagedApiKeyCandidate(headers);
  }

  #resolveManagedApiKey(headers: Record<string, any>) {
    const rawKey = this.#extractManagedApiKeyCandidate(headers);
    if (!rawKey) return null;

    const apiKey = this.store
      .getState()
      .apiKeys.find((item) => item.enabled && verifySecret(rawKey, item.secretHash));
    if (!apiKey) return null;

    const storedRawKey = this.#resolveStoredApiKeyValue(apiKey.secretValue);
    if (storedRawKey !== rawKey) {
      this.store.update((state) => {
        const target = state.apiKeys.find((item) => item.id === apiKey.id);
        if (!target) return;
        target.secretValue = this.#storeApiKeyValue(rawKey);
      });
      return this.#requireApiKey(apiKey.id);
    }

    return apiKey;
  }

  #extractManagedApiKeyCandidate(headers: Record<string, any>) {
    const xApiKey = String(headers?.["x-api-key"] || "").trim();
    if (xApiKey) return xApiKey;

    const authHeader = String(headers?.authorization || "").trim();
    if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
    const bearerValue = authHeader.slice(7).trim();
    if (!bearerValue || bearerValue.includes(",")) return null;
    return bearerValue.startsWith("haochi_") ? bearerValue : null;
  }

  #pickLegacyToken(authorizationHeader: string) {
    const raw = String(authorizationHeader || "").replace(/^Bearer\s+/i, "").trim();
    const tokens = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (tokens.length === 0) throw createHttpError("缺少 Authorization 凭据", 401);
    const index = Math.floor(Math.random() * tokens.length);
    return tokens[index];
  }

  async #ensureAccountReady(accountId: string, trigger: string) {
    const stored = this.#requireAccount(accountId);
    if (!stored.enabled) throw createHttpError(`账号 ${stored.email} 已禁用`, 403);
    if (stored.blacklisted) throw createHttpError(`账号 ${stored.email} 已被拉黑`, 409);

    const materialized = this.#materializeAccount(stored);
    if (!this.#isSessionExpiring(materialized) && materialized.lastValidationStatus !== "invalid") {
      return materialized;
    }

    if (!materialized.password) {
      if (!primaryToken(materialized)) {
        throw createHttpError(`账号 ${stored.email} 缺少 Session 且没有密码，无法自动恢复`, 409);
      }
      return materialized;
    }

    await this.refreshAccountSession(accountId, trigger);
    return this.#materializeAccount(this.#requireAccount(accountId));
  }

  async #markAccountSuccess(accountId: string) {
    this.store.update((state) => {
      const target = state.accounts.find((item) => item.id === accountId);
      if (!target) return;
      target.successCount += 1;
      target.lastUsedAt = nowIso();
      target.lastError = null;
      if (!target.blacklisted) target.status = target.enabled ? "healthy" : "disabled";
      target.updatedAt = nowIso();
    });
  }

  async #markApiKeyUsed(apiKeyId: string) {
    this.store.update((state) => {
      const target = state.apiKeys.find((item) => item.id === apiKeyId);
      if (!target) return;
      target.lastUsedAt = nowIso();
      target.updatedAt = nowIso();
    });
  }

  async #markAccountFailure(accountId: string, error: any) {
    const classified = this.#classifyAccountError(error);
    this.store.update((state) => {
      const target = state.accounts.find((item) => item.id === accountId);
      if (!target) return;
      target.failureCount += 1;
      target.lastError = classified.reason;
      target.updatedAt = nowIso();
      if (classified.blacklist) {
        target.blacklisted = true;
        target.blacklistedAt = nowIso();
        target.blacklistedReason = classified.reason;
        target.status = classified.status;
      } else if (!target.blacklisted) {
        target.status = classified.status;
      }
    });
    return classified;
  }

  async #selectManagedAccount(ability: PoolAbility, excludedIds: Set<string>) {
    const candidates = this.store
      .getState()
      .accounts.filter((item) => item.enabled && !item.blacklisted && !excludedIds.has(item.id))
      .sort((a, b) => {
        const leaseDiff = this.getActiveLeaseCount(a.id) - this.getActiveLeaseCount(b.id);
        if (leaseDiff !== 0) return leaseDiff;
        const statusDiff = statusPriority(a.status) - statusPriority(b.status);
        if (statusDiff !== 0) return statusDiff;
        return String(a.lastUsedAt || "").localeCompare(String(b.lastUsedAt || ""));
      });

    for (const candidate of candidates) {
      try {
        const ready = await this.#ensureAccountReady(candidate.id, `request:${ability}`);
        const lease = this.#acquireLease(ready, ability);
        if (!lease) continue;
        return {
          account: ready,
          lease,
        };
      } catch (error: any) {
        logger.warn(`账号 ${candidate.email} 暂不可用，跳过: ${error?.message || error}`);
      }
    }
    return null;
  }

  async runWithRequestToken<T>(
    request: { headers: Record<string, any> },
    ability: PoolAbility,
    handler: (token: string, context: { mode: "legacy" | "pool"; accountId?: string; apiKeyId?: string }) => Promise<T>
  ): Promise<T> {
    const managedApiKeyAttempt = this.isManagedApiKeyRequest(request.headers);
    const managedApiKey = this.#resolveManagedApiKey(request.headers);
    if (managedApiKeyAttempt && !managedApiKey) {
      throw createHttpError("API Key 无效或已失效", 401);
    }
    if (!managedApiKey) {
      const authorization = String(request.headers?.authorization || "").trim();
      if (!authorization) throw createHttpError("缺少 Authorization 或 X-API-Key", 401);
      if (!this.settings.allowLegacyAuthorization) {
        throw createHttpError("当前实例已禁用直接透传 Authorization，请改用外部 API Key", 403);
      }
      const token = this.#pickLegacyToken(authorization);
      return handler(token, { mode: "legacy" });
    }

    if (!managedApiKey.enabled) throw createHttpError("API Key 已禁用", 403);
    if (!managedApiKey.allowedAbilities.includes(ability)) {
      throw createHttpError(`API Key 无权访问 ${ability} 能力`, 403);
    }

    const triedIds = new Set<string>();
    let lastError: any = null;
    const maxAttempts = Math.max(1, this.settings.maxRequestRetries);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selected = await this.#selectManagedAccount(ability, triedIds);
      if (!selected) break;

      const token = this.#buildRequestToken(selected.account);
      if (!token) {
        selected.lease.release();
        triedIds.add(selected.account.id);
        continue;
      }

      try {
        const result = await handler(token, {
          mode: "pool",
          accountId: selected.account.id,
          apiKeyId: managedApiKey.id,
        });
        await this.#markAccountSuccess(selected.account.id);
        await this.#markApiKeyUsed(managedApiKey.id);
        return result;
      } catch (error: any) {
        lastError = error;
        const classified = await this.#markAccountFailure(selected.account.id, error);
        triedIds.add(selected.account.id);
        if (!classified.retryable) throw error;
      } finally {
        selected.lease.release();
      }
    }

    throw lastError || createHttpError("没有可用账号可供当前请求使用", 503);
  }

  async runMaintenance() {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      const accounts = this.store
        .getState()
        .accounts.filter((item) => item.enabled && item.autoRefresh && !item.blacklisted);
      for (const account of accounts) {
        const materialized = this.#materializeAccount(account);
        if (!materialized.password) continue;
        if (!this.#isSessionExpiring(materialized)) continue;
        if (this.getActiveLeaseCount(account.id) > 0) continue;

        try {
          await this.refreshAccountSession(account.id, "maintenance");
        } catch (error: any) {
          logger.warn(`维护任务刷新账号 ${account.email} 失败: ${error?.message || error}`);
        }
      }
    } finally {
      this.maintenanceRunning = false;
    }
  }

  async getManagedTokenPoints(request: { headers: Record<string, any> }) {
    return this.runWithRequestToken(request, "token", async (token) => {
      return [
        {
          token: "managed",
          points: await getCredit(token),
        },
      ];
    });
  }

  async receiveManagedTokenCredits(request: { headers: Record<string, any> }) {
    return this.runWithRequestToken(request, "token", async (token) => {
      const currentCredit = await getCredit(token);
      let received = false;
      let credits = currentCredit;
      let error: string | null = null;
      if (currentCredit.totalCredit <= 0) {
        try {
          await receiveCredit(token);
          credits = await getCredit(token);
          received = true;
        } catch (receiveError: any) {
          error = receiveError?.message || String(receiveError);
        }
      }
      return [
        {
          token: "managed",
          credits,
          received,
          error,
        },
      ];
    });
  }
}
