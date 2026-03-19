import API_EX from "@/api/consts/exceptions.ts";
import { getCredit, getTokenLiveStatus, receiveCredit } from "@/api/controllers/core.ts";
import SYSTEM_EX from "@/lib/consts/exceptions.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import Exception from "@/lib/exceptions/Exception.ts";
import logger from "@/lib/logger.ts";
import { runWithOutboundLogContext } from "@/lib/outbound-log-context.ts";
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
  PoolAccountRegion,
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

function buildOutboundContext(
  ability: PoolAbility,
  mode: "legacy" | "pool",
  options: {
    accountId?: string;
    accountEmail?: string | null;
    apiKeyId?: string;
  } = {}
) {
  return {
    ability,
    mode,
    accountId: options.accountId || null,
    accountEmail: options.accountEmail || null,
    accountLabel: options.accountEmail || (mode === "legacy" ? "直传令牌" : "未知账号"),
    apiKeyId: options.apiKeyId || null,
  };
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

function primaryToken(account: Pick<PoolAccount, "sessionTokens">) {
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

const REGION_PREFIX_MAP: Record<PoolAccountRegion, string> = {
  cn: "",
  us: "us-",
  hk: "hk-",
  jp: "jp-",
  sg: "sg-",
};

function extractRegionFromTokenValue(value: string | null | undefined): PoolAccountRegion | null {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("us-")) return "us";
  if (raw.startsWith("hk-")) return "hk";
  if (raw.startsWith("jp-")) return "jp";
  if (raw.startsWith("sg-")) return "sg";
  return null;
}

function resolveAccountRegion(account: Pick<PoolAccount, "sessionTokens">): PoolAccountRegion {
  return (
    extractRegionFromTokenValue(
      account.sessionTokens?.sessionid ||
        account.sessionTokens?.sessionid_ss ||
        account.sessionTokens?.sid_tt ||
        null
    ) || "cn"
  );
}

function normalizeAccountRegion(
  value: any,
  fallback: PoolAccountRegion = "cn"
): PoolAccountRegion {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "us" || normalized === "us-") return "us";
  if (normalized === "hk" || normalized === "hk-") return "hk";
  if (normalized === "jp" || normalized === "jp-") return "jp";
  if (normalized === "sg" || normalized === "sg-") return "sg";
  if (normalized === "cn" || normalized === "cn-") return "cn";
  return fallback;
}

const SHANGHAI_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function parseIsoMs(value: string | null | undefined) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function nextShanghaiMidnightIso(base = new Date()) {
  const parts = SHANGHAI_DAY_FORMATTER.formatToParts(base);
  const year = Number(parts.find((item) => item.type === "year")?.value || "0");
  const month = Number(parts.find((item) => item.type === "month")?.value || "0");
  const day = Number(parts.find((item) => item.type === "day")?.value || "0");
  return new Date(Date.UTC(year, month - 1, day + 1) - SHANGHAI_TZ_OFFSET_MS).toISOString();
}

function stripRegionPrefix(token: string | null | undefined) {
  return String(token || "")
    .trim()
    .replace(/^(us|hk|jp|sg)-/i, "");
}

function applyRegionToSessionValue(
  token: string | null | undefined,
  region: PoolAccountRegion
) {
  const raw = stripRegionPrefix(token);
  if (!raw) return null;
  return `${REGION_PREFIX_MAP[region]}${raw}`;
}

function applyRegionToSessionTokens(
  input: Partial<AccountSessionTokens> | null | undefined,
  region: PoolAccountRegion
) {
  const next = sanitizeSessionTokens(input);
  return sanitizeSessionTokens({
    ...next,
    sessionid: applyRegionToSessionValue(next.sessionid, region),
    sessionid_ss: applyRegionToSessionValue(next.sessionid_ss, region),
    sid_tt: applyRegionToSessionValue(next.sid_tt, region),
  });
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

function sanitizeExportField(value: string | null | undefined) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, " ")
    .replace(/----/g, " - - - - ")
    .trim();
}

function buildExportAccountLine(account: Pick<PoolAccount, "email" | "password" | "proxy" | "notes" | "sessionTokens">) {
  const email = sanitizeExportField(account.email);
  const password = typeof account.password === "string" ? sanitizeExportField(account.password) : "";
  const proxy = sanitizeExportField(account.proxy);
  const notes = sanitizeExportField(account.notes);
  const sessionId = sanitizeExportField(primaryToken(account));
  if (!password && !sessionId) return null;

  if (sessionId) {
    return [email, password, proxy, notes, `Sessionid=${sessionId}`].join("----");
  }
  if (notes) {
    return [email, password, proxy, notes].join("----");
  }
  if (proxy) {
    return [email, password, proxy].join("----");
  }
  return [email, password].join("----");
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

function validationStatusPriority(status: PoolAccount["lastValidationStatus"]) {
  switch (status) {
    case "valid":
      return 1;
    case "unknown":
      return 2;
    case "invalid":
      return 3;
    default:
      return 4;
  }
}

function effectiveValidationStatus(account: Pick<PoolAccount, "lastValidationStatus" | "lastValidatedAt" | "sessionUpdatedAt">) {
  if (account.lastValidationStatus !== "valid") {
    return account.lastValidationStatus;
  }

  const validatedAtMs = Date.parse(String(account.lastValidatedAt || ""));
  if (!Number.isFinite(validatedAtMs)) {
    return "unknown";
  }

  const sessionUpdatedAtMs = Date.parse(String(account.sessionUpdatedAt || ""));
  if (Number.isFinite(sessionUpdatedAtMs) && validatedAtMs < sessionUpdatedAtMs) {
    return "unknown";
  }

  return "valid";
}

function resolveSteadyAccountStatus(
  account: Pick<
    PoolAccount,
    "enabled" | "blacklisted" | "status" | "sessionTokens" | "lastValidationStatus" | "lastValidatedAt" | "sessionUpdatedAt"
  >
): AccountStatus {
  if (!account.enabled) return "disabled";
  if (account.blacklisted) {
    return account.status === "insufficient_credit" ? "insufficient_credit" : "blacklisted";
  }
  if (!primaryToken(account)) return "idle";
  if (
    account.status === "expired" ||
    account.status === "invalid" ||
    effectiveValidationStatus(account) === "invalid"
  ) {
    return "expired";
  }
  return "healthy";
}

type MaintenanceRefreshReason = "missing_session" | "invalid_session" | "expiring_session";

function maintenanceRefreshPriority(reason: MaintenanceRefreshReason) {
  switch (reason) {
    case "missing_session":
      return 1;
    case "invalid_session":
      return 2;
    case "expiring_session":
      return 3;
    default:
      return 9;
  }
}

function normalizedProxyKey(proxy: string | null | undefined) {
  return normalizeProxyUrl(proxy) || "";
}

function accountFailurePenalty(account: Pick<PoolAccount, "successCount" | "failureCount" | "lastError">) {
  const successCount = Math.max(0, Number(account.successCount || 0));
  const failureCount = Math.max(0, Number(account.failureCount || 0));
  const hasRecentError = Boolean(String(account.lastError || "").trim());
  if (successCount === 0 && failureCount === 0 && !hasRecentError) return 0;
  const total = successCount + failureCount;
  const failureRatePenalty = total > 0 ? (failureCount / total) * 100 : 0;
  const excessFailurePenalty = Math.max(0, failureCount - successCount) * 5;
  const recentErrorPenalty = hasRecentError ? 20 : 0;
  return failureRatePenalty + excessFailurePenalty + recentErrorPenalty;
}

type AccountListStatusFilter = "all" | "healthy" | "invalid" | "blacklisted";

function normalizeAccountListStatusFilter(value: any): AccountListStatusFilter {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "healthy") return "healthy";
  if (normalized === "invalid" || normalized === "expired") return "invalid";
  if (normalized === "blacklisted") return "blacklisted";
  return "all";
}

function matchesAccountStatusFilter(
  account: Pick<PoolAccount, "status" | "blacklisted">,
  filter: AccountListStatusFilter
) {
  if (filter === "healthy") {
    return !account.blacklisted && account.status === "healthy";
  }
  if (filter === "invalid") {
    return !account.blacklisted && ["invalid", "expired"].includes(account.status);
  }
  if (filter === "blacklisted") {
    return account.blacklisted || account.status === "blacklisted";
  }
  return true;
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
    this.#recoverStaleRefreshingAccounts();
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
    return this.store.read((state) => ({ ...state.settings }));
  }

  #recoverStaleRefreshingAccounts() {
    const staleAccounts = this.store.read((state) =>
      state.accounts
        .filter((item) => item.status === "refreshing" && !this.refreshTasks.has(item.id))
        .map((item) => ({
          id: item.id,
          email: item.email,
          nextStatus: resolveSteadyAccountStatus(item),
        })),
    );

    if (!staleAccounts.length) return;

    const staleById = new Map(staleAccounts.map((item) => [item.id, item]));
    this.store.update((state) => {
      for (const account of state.accounts) {
        const stale = staleById.get(account.id);
        if (!stale) continue;
        account.status = stale.nextStatus;
        account.updatedAt = nowIso();
      }
    });

    const preview = staleAccounts
      .slice(0, 5)
      .map((item) => `${item.email}->${item.nextStatus}`)
      .join(", ");
    const suffix = staleAccounts.length > 5 ? " ..." : "";
    logger.warn(
      `检测到 ${staleAccounts.length} 个陈旧 refreshing 状态，启动时已恢复为稳态: ${preview}${suffix}`
    );
  }

  #markRefreshFailure(accountId: string, reason: string) {
    const message = String(reason || "自动登录失败").trim() || "自动登录失败";
    this.store.update((state) => {
      const target = state.accounts.find((item) => item.id === accountId);
      if (!target) return;
      target.status = target.enabled ? "error" : "disabled";
      target.lastError = message;
      target.failureCount += 1;
      target.updatedAt = nowIso();
    });
    return message;
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
      region: resolveAccountRegion(account),
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
      blacklistReleaseAt: account.blacklistReleaseAt,
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

  #resolveBatchAccountIds(payload: any) {
    const state = this.store.read((current) => current);
    const applyToAll = parseBoolean(payload?.applyToAll, false);
    if (applyToAll) {
      return {
        applyToAll,
        ids: state.accounts.map((item) => item.id),
      };
    }

    const ids: string[] = Array.isArray(payload?.ids)
      ? Array.from(
          new Set(
            payload.ids
              .map((item: any) => String(item || "").trim())
              .filter(Boolean)
          )
        )
      : [];
    if (!ids.length) throw createHttpError("请先选择要批量处理的账号", 400);

    const accountIds = new Set(state.accounts.map((item) => item.id));
    const missingIds = ids.filter((id) => !accountIds.has(id));
    if (missingIds.length) {
      throw createHttpError(`以下账号不存在: ${missingIds.join(", ")}`, 404);
    }

    return {
      applyToAll,
      ids,
    };
  }

  #requireAccount(accountId: string) {
    const account = this.store.read(
      (state) => state.accounts.find((item) => item.id === accountId) || null,
    );
    if (!account) throw createHttpError("账号不存在", 404);
    return account;
  }

  #requireApiKey(apiKeyId: string) {
    const apiKey = this.store.read(
      (state) => state.apiKeys.find((item) => item.id === apiKeyId) || null,
    );
    if (!apiKey) throw createHttpError("API Key 不存在", 404);
    return apiKey;
  }

  #isSessionExpiring(account: PoolAccount, bufferMinutes = this.settings.sessionRefreshBufferMinutes) {
    const token = primaryToken(account);
    if (!token) return true;
    if (!account.sessionExpiresAt) return false;
    return new Date(account.sessionExpiresAt).getTime() <= Date.now() + bufferMinutes * 60 * 1000;
  }

  #maintenanceRefreshBufferMinutes() {
    const sessionBuffer = clampNumber(
      this.settings.sessionRefreshBufferMinutes,
      1,
      12 * 60,
      30
    );
    const maintenanceBuffer = clampNumber(
      this.settings.maintenanceRefreshBufferMinutes,
      1,
      12 * 60,
      Math.min(10, sessionBuffer)
    );
    return Math.min(sessionBuffer, maintenanceBuffer);
  }

  #maintenanceMaxRefreshPerRun() {
    return clampNumber(this.settings.maintenanceMaxRefreshPerRun, 1, 100, 6);
  }

  #getMaintenanceRefreshReason(account: PoolAccount): MaintenanceRefreshReason | null {
    if (!primaryToken(account)) return "missing_session";
    if (
      account.status === "expired" ||
      account.status === "invalid" ||
      effectiveValidationStatus(account) === "invalid"
    ) {
      return "invalid_session";
    }
    if (this.#isSessionExpiring(account, this.#maintenanceRefreshBufferMinutes())) {
      return "expiring_session";
    }
    return null;
  }

  getActiveLeaseCount(accountId: string) {
    return this.leaseMap.get(accountId)?.size || 0;
  }

  #buildProxyLeaseCounts(accounts: Pick<PoolAccount, "id" | "proxy">[]) {
    const counts = new Map<string, number>();
    for (const account of accounts) {
      const proxyKey = normalizedProxyKey(account.proxy);
      if (!proxyKey) continue;
      counts.set(proxyKey, (counts.get(proxyKey) || 0) + this.getActiveLeaseCount(account.id));
    }
    return counts;
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

    const proxyKey = normalizedProxyKey(account.proxy);
    if (proxyKey && this.settings.maxProxyConcurrency > 0) {
      const proxyLeaseCounts = this.#buildProxyLeaseCounts(
        this.store.read((state) => state.accounts),
      );
      if ((proxyLeaseCounts.get(proxyKey) || 0) >= this.settings.maxProxyConcurrency) {
        return null;
      }
    }

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

    if (/登录失效，自动刷新失败/i.test(message)) {
      return {
        retryable: true,
        blacklist: false,
        status: "error" as AccountStatus,
        reason: message,
      };
    }

    if (compare?.(API_EX.API_TOKEN_EXPIRES) || /登录失效|token已失效|session.*失效/i.test(message)) {
      return {
        retryable: true,
        blacklist: false,
        status: "invalid" as AccountStatus,
        reason: message || "Session 已失效",
        blacklistReleaseAt: null,
      };
    }

    if (
      /proxy connection ended before receiving connect response/i.test(message) ||
      /err_empty_response/i.test(message) ||
      /err_connection_closed/i.test(message) ||
      /econnreset/i.test(message) ||
      /failed to connect to upstream/i.test(message) ||
      /socket disconnected before secure tls connection was established/i.test(message)
    ) {
      return {
        retryable: true,
        blacklist: false,
        status: "error" as AccountStatus,
        reason: message || "代理或网络异常",
        blacklistReleaseAt: null,
      };
    }

    if (
      compare?.(API_EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS) ||
      /1006|121101/.test(message) ||
      /积分不足|credit|daily generation limit/i.test(message)
    ) {
      return {
        retryable: true,
        blacklist: true,
        status: "insufficient_credit" as AccountStatus,
        reason: message || "生成额度已耗尽",
        blacklistReleaseAt: nextShanghaiMidnightIso(),
      };
    }

    return {
      retryable: false,
      blacklist: false,
      status: "error" as AccountStatus,
      reason: message || "请求失败",
      blacklistReleaseAt: null,
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

  listAccountsPage(options: { page?: number; pageSize?: number; status?: any } = {}) {
    const statusFilter = normalizeAccountListStatusFilter(options.status);
    const items = this.listAccounts().filter((item) => matchesAccountStatusFilter(item, statusFilter));
    const pageSize = clampNumber(options.pageSize, 1, 100, 10);
    const total = items.length;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
    const page = clampNumber(options.page, 1, totalPages, 1);
    const start = (page - 1) * pageSize;

    return {
      items: items.slice(start, start + pageSize),
      page,
      pageSize,
      total,
      totalPages,
      status: statusFilter,
    };
  }

  exportAccounts(options: { status?: any } = {}) {
    const statusFilter = normalizeAccountListStatusFilter(options.status);
    const matchedAccounts = this.store
      .getState()
      .accounts.filter((item) => matchesAccountStatusFilter(item, statusFilter))
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((item) => this.#materializeAccount(item));

    const lines = [
      `# 好吃号池账号导出`,
      `# 导出时间: ${nowIso()}`,
      `# 可直接粘贴到后台“批量导入账号”，注释行会被自动忽略`,
    ];
    const skipped: Array<{ email: string; reason: string }> = [];
    let exportedCount = 0;

    for (const account of matchedAccounts) {
      const line = buildExportAccountLine(account);
      if (line) {
        lines.push(line);
        exportedCount += 1;
        continue;
      }
      const reason = "缺少密码和 SessionID，无法按现有批量导入格式回填";
      skipped.push({ email: account.email, reason });
      lines.push(`# 跳过 ${account.email}: ${reason}`);
    }

    if (!matchedAccounts.length) {
      lines.push("# 当前筛选下没有可导出的账号");
    }

    const fileTimestamp = nowIso()
      .replace(/\.\d+Z$/, "Z")
      .replace(/[:]/g, "")
      .replace(/-/g, "")
      .replace("T", "-");

    return {
      status: statusFilter,
      matchedCount: matchedAccounts.length,
      exportedCount,
      skippedCount: skipped.length,
      skipped,
      fileName: `haochi-accounts-${statusFilter}-${fileTimestamp}.txt`,
      content: lines.join("\n"),
    };
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
    const totalCapacity = state.accounts.reduce((sum, item) => sum + Number(item.maxConcurrency || 0), 0);

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
        totalCapacity,
      },
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
    const defaultRegion =
      payload?.defaultRegion !== undefined || payload?.region !== undefined
        ? normalizeAccountRegion(payload?.defaultRegion ?? payload?.region)
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
          if (defaultRegion !== null) nextPayload.region = defaultRegion;
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
            region: defaultRegion,
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
    const requestedRegion =
      payload?.region !== undefined
        ? normalizeAccountRegion(payload.region, extractRegionFromTokenValue(sessionId) || "cn")
        : extractRegionFromTokenValue(sessionId) || "cn";
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
      blacklistReleaseAt: null,
      lastError: null,
      lastLoginAt: null,
      lastValidatedAt: null,
      lastValidationStatus: "unknown",
      lastUsedAt: null,
      sessionUpdatedAt: sessionId ? now : null,
      sessionExpiresAt: sessionId ? this.#buildSessionExpiry() : null,
      sessionTokens: applyRegionToSessionTokens(
        {
          sessionid: sessionId || null,
          sessionid_ss: sessionId || null,
          sid_tt: sessionId || null,
        },
        requestedRegion
      ),
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
    const currentRegion = resolveAccountRegion(current);
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

      const explicitRegion =
        payload?.sessionId !== undefined
          ? extractRegionFromTokenValue(String(payload.sessionId || "").trim())
          : null;
      const nextRegion =
        payload?.region !== undefined
          ? normalizeAccountRegion(payload.region, currentRegion)
          : explicitRegion || currentRegion;

      if (payload?.clearSession) {
        account.sessionTokens = emptySessionTokens();
        account.sessionUpdatedAt = null;
        account.sessionExpiresAt = null;
        account.status = account.enabled ? "idle" : "disabled";
      } else if (payload?.sessionId !== undefined) {
        const sessionId = String(payload.sessionId || "").trim();
        account.sessionTokens = applyRegionToSessionTokens(
          {
            sessionid: sessionId || null,
            sessionid_ss: sessionId || null,
            sid_tt: sessionId || null,
          },
          nextRegion
        );
        account.sessionUpdatedAt = sessionId ? nowIso() : null;
        account.sessionExpiresAt = sessionId ? this.#buildSessionExpiry() : null;
        if (!account.blacklisted) account.status = sessionId ? "healthy" : account.enabled ? "idle" : "disabled";
      } else if (payload?.region !== undefined && primaryToken(account)) {
        account.sessionTokens = applyRegionToSessionTokens(account.sessionTokens, nextRegion);
      }

      if (payload?.blacklisted === false) {
        account.blacklisted = false;
        account.blacklistedReason = null;
        account.blacklistedAt = null;
        account.blacklistReleaseAt = null;
        if (account.enabled && primaryToken(account)) account.status = "healthy";
      }

      if (!account.enabled) account.status = "disabled";
      account.updatedAt = nowIso();
    });

    return this.#publicAccount(this.#requireAccount(accountId));
  }

  updateAccountsBatch(payload: any) {
    const { applyToAll, ids } = this.#resolveBatchAccountIds(payload);
    const hasProxyUpdate = payload?.proxy !== undefined;
    const hasRegionUpdate = payload?.region !== undefined;
    if (!hasProxyUpdate && !hasRegionUpdate) {
      throw createHttpError("请至少提供一个批量修改项", 400);
    }

    const nextProxy = hasProxyUpdate ? normalizeProxyUrl(payload.proxy) : null;
    const nextRegion = hasRegionUpdate ? normalizeAccountRegion(payload.region) : "cn";
    const selectedIds = new Set(ids);
    let updatedCount = 0;
    let regionUpdatedCount = 0;
    let regionSkippedCount = 0;

    this.store.update((state) => {
      for (const account of state.accounts) {
        if (!selectedIds.has(account.id)) continue;

        let touched = false;
        if (hasProxyUpdate) {
          account.proxy = nextProxy;
          touched = true;
        }

        if (hasRegionUpdate) {
          if (primaryToken(account)) {
            account.sessionTokens = applyRegionToSessionTokens(account.sessionTokens, nextRegion);
            regionUpdatedCount += 1;
            touched = true;
          } else {
            regionSkippedCount += 1;
          }
        }

        if (!touched) continue;
        account.updatedAt = nowIso();
        updatedCount += 1;
      }
    });

    return {
      applyToAll,
      matchedCount: ids.length,
      updatedCount,
      regionUpdatedCount,
      regionSkippedCount,
      proxyUpdated: hasProxyUpdate,
    };
  }

  deleteAccount(accountId: string) {
    this.store.update((state) => {
      state.accounts = state.accounts.filter((item) => item.id !== accountId);
    });
    this.leaseMap.delete(accountId);
    return { deleted: true };
  }

  deleteAccountsBatch(payload: any) {
    const { applyToAll, ids } = this.#resolveBatchAccountIds(payload);
    if (!ids.length) {
      return {
        applyToAll,
        deletedCount: 0,
      };
    }

    const selectedIds = new Set(ids);
    this.store.update((state) => {
      state.accounts = state.accounts.filter((item) => !selectedIds.has(item.id));
    });
    for (const id of ids) {
      this.leaseMap.delete(id);
    }
    return {
      applyToAll,
      deletedCount: ids.length,
    };
  }

  async refreshInvalidAccountsSessions() {
    const candidates = this.store
      .getState()
      .accounts.filter((item) => matchesAccountStatusFilter(item, "invalid"));

    const refreshed: Array<{ id: string; email: string }> = [];
    const errors: Array<{ id: string; email: string; error: string }> = [];

    for (const account of candidates) {
      try {
        await this.refreshAccountSession(account.id, "batch-refresh-invalid");
        refreshed.push({
          id: account.id,
          email: account.email,
        });
      } catch (error: any) {
        errors.push({
          id: account.id,
          email: account.email,
          error: error?.message || String(error),
        });
      }
    }

    return {
      matchedCount: candidates.length,
      refreshedCount: refreshed.length,
      failedCount: errors.length,
      refreshed,
      errors,
    };
  }

  async validateAllAccountsSessions() {
    const candidates = this.store.read((state) => state.accounts);
    const results: Array<{ id: string; email: string; valid: boolean; reason: string }> = [];
    const errors: Array<{ id: string; email: string; error: string }> = [];

    for (const account of candidates) {
      try {
        const result = await this.validateAccountSession(account.id);
        results.push({
          id: account.id,
          email: account.email,
          valid: Boolean(result.valid),
          reason: String(result.reason || ""),
        });
      } catch (error: any) {
        errors.push({
          id: account.id,
          email: account.email,
          error: error?.message || String(error),
        });
      }
    }

    return {
      matchedCount: candidates.length,
      validCount: results.filter((item) => item.valid).length,
      invalidCount: results.filter((item) => !item.valid).length,
      failedCount: errors.length,
      results,
      errors,
    };
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

      let result;
      try {
        result = await this.loginProvider.login(account);
      } catch (error: any) {
        const message = this.#markRefreshFailure(accountId, error?.message || String(error));
        throw createHttpError(message, 502);
      }

      if (!result.success || !result.sessionTokens || !result.sessionTokens.sessionid) {
        const message = this.#markRefreshFailure(accountId, result.error || "自动登录失败");
        throw createHttpError(message, 502);
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
        target.blacklistReleaseAt = null;
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
      target.blacklistReleaseAt = null;
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
      target.blacklistReleaseAt = null;
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
      .read((state) => state.apiKeys.find((item) => item.enabled && verifySecret(rawKey, item.secretHash)));
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

    let materialized = this.#materializeAccount(stored);
    const hasPrimaryToken = Boolean(primaryToken(materialized));
    const canAutoRecover = Boolean(materialized.password && materialized.autoRefresh);
    let validationStatus = effectiveValidationStatus(materialized);

    if (!hasPrimaryToken) {
      if (!canAutoRecover) {
        throw createHttpError(`账号 ${stored.email} 缺少 Session 且无法自动恢复`, 409);
      }
      await this.refreshAccountSession(accountId, trigger);
      return this.#materializeAccount(this.#requireAccount(accountId));
    }

    if (this.loginProvider.name !== "mock" && validationStatus === "unknown") {
      const validation = await this.validateAccountSession(accountId);
      materialized = this.#materializeAccount(this.#requireAccount(accountId));
      validationStatus = effectiveValidationStatus(materialized);
      if (!validation.valid) {
        if (!canAutoRecover) {
          throw createHttpError(`账号 ${stored.email} Session 已失效且无法自动恢复`, 409);
        }
      }
    }

    if (!this.#isSessionExpiring(materialized)) {
      if (validationStatus === "invalid") {
        if (!canAutoRecover) {
          throw createHttpError(`账号 ${stored.email} Session 已失效且无法自动恢复`, 409);
        }
      } else {
        return materialized;
      }
    }

    if (!canAutoRecover) {
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
        target.blacklistReleaseAt = classified.blacklistReleaseAt || null;
        target.status = classified.status;
      } else if (!target.blacklisted) {
        target.blacklistReleaseAt = null;
        target.status = classified.status;
      }
    });
    return classified;
  }

  #releaseExpiredBlacklistedAccounts() {
    const dueAccounts = this.store
      .read((state) =>
        state.accounts
          .filter((item) => item.blacklisted)
          .filter((item) => {
            const releaseAtMs = parseIsoMs(item.blacklistReleaseAt);
            return releaseAtMs !== null && releaseAtMs <= Date.now();
          })
          .map((item) => ({
            id: item.id,
            email: item.email,
          })),
      );

    if (!dueAccounts.length) return [];

    const dueIds = new Set(dueAccounts.map((item) => item.id));
    this.store.update((state) => {
      for (const account of state.accounts) {
        if (!dueIds.has(account.id)) continue;
        account.blacklisted = false;
        account.blacklistedReason = null;
        account.blacklistedAt = null;
        account.blacklistReleaseAt = null;
        account.lastError = null;
        account.status = account.enabled ? (primaryToken(account) ? "healthy" : "idle") : "disabled";
        account.updatedAt = nowIso();
      }
    });

    logger.info(
      `自动解除次日恢复黑名单账号: ${dueAccounts.map((item) => item.email).join(", ")}`
    );
    return dueAccounts;
  }

  async #retryCurrentAccountAfterRefresh<T>(
    accountId: string,
    ability: PoolAbility,
    apiKeyId: string,
    handler: (token: string, context: { mode: "legacy" | "pool"; accountId?: string; apiKeyId?: string }) => Promise<T>,
    error: any
  ) {
    const classified = this.#classifyAccountError(error);
    if (!classified.retryable || classified.status !== "invalid") {
      return {
        recovered: false,
        error,
      } as const;
    }

    const account = this.#materializeAccount(this.#requireAccount(accountId));
    if (!account.password || !account.autoRefresh) {
      return {
        recovered: false,
        error,
      } as const;
    }

    logger.warn(`账号 ${account.email} 命中登录失效，尝试自动刷新 Session 后重试`);

    try {
      await this.refreshAccountSession(accountId, `request-recover:${ability}`);
    } catch (refreshError: any) {
      logger.warn(
        `账号 ${account.email} 自动刷新重试失败，准备切换下一个账号: ${refreshError?.message || refreshError}`
      );
      const refreshMessage = refreshError?.message || String(refreshError || error || "自动刷新重试失败");
      return {
        recovered: false,
        error: new APIException(
          API_EX.API_TOKEN_EXPIRES,
          `登录失效，自动刷新失败: ${refreshMessage}`
        ),
      } as const;
    }

    const refreshed = this.#materializeAccount(this.#requireAccount(accountId));
    const nextToken = this.#buildRequestToken(refreshed);
    if (!nextToken) {
      return {
        recovered: false,
        error: new APIException(
          API_EX.API_TOKEN_EXPIRES,
          `登录失效，自动刷新后仍缺少可用 Session: ${refreshed.email}`
        ),
      } as const;
    }

    try {
      const result = await runWithOutboundLogContext(
        buildOutboundContext(ability, "pool", {
          accountId,
          accountEmail: refreshed.email,
          apiKeyId,
        }),
        () =>
          handler(nextToken, {
            mode: "pool",
            accountId,
            apiKeyId,
          })
      );
      await this.#markAccountSuccess(accountId);
      await this.#markApiKeyUsed(apiKeyId);
      logger.info(`账号 ${refreshed.email} 自动刷新后重试成功`);
      return {
        recovered: true,
        result,
      } as const;
    } catch (retryError: any) {
      logger.warn(
        `账号 ${refreshed.email} 自动刷新后再次请求失败，准备继续切换: ${retryError?.message || retryError}`
      );
      return {
        recovered: false,
        error: retryError,
      } as const;
    }
  }

  async #selectManagedAccount(ability: PoolAbility, excludedIds: Set<string>) {
    this.#releaseExpiredBlacklistedAccounts();
    const state = this.store.read((current) => current);
    const proxyLeaseCounts = this.#buildProxyLeaseCounts(state.accounts);
    const candidates = state.accounts
      .filter((item) => item.enabled && !item.blacklisted && !excludedIds.has(item.id))
      .sort((a, b) => {
        const leaseDiff = this.getActiveLeaseCount(a.id) - this.getActiveLeaseCount(b.id);
        if (leaseDiff !== 0) return leaseDiff;
        const proxyLeaseDiff =
          (proxyLeaseCounts.get(normalizedProxyKey(a.proxy)) || 0) -
          (proxyLeaseCounts.get(normalizedProxyKey(b.proxy)) || 0);
        if (proxyLeaseDiff !== 0) return proxyLeaseDiff;
        const statusDiff = statusPriority(a.status) - statusPriority(b.status);
        if (statusDiff !== 0) return statusDiff;
        const validationDiff =
          validationStatusPriority(effectiveValidationStatus(a)) -
          validationStatusPriority(effectiveValidationStatus(b));
        if (validationDiff !== 0) return validationDiff;
        const reliabilityDiff = accountFailurePenalty(a) - accountFailurePenalty(b);
        if (reliabilityDiff !== 0) return reliabilityDiff;
        const successDiff = Number(b.successCount || 0) - Number(a.successCount || 0);
        if (successDiff !== 0) return successDiff;
        const recentErrorDiff = Number(Boolean(a.lastError)) - Number(Boolean(b.lastError));
        if (recentErrorDiff !== 0) return recentErrorDiff;
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
      return runWithOutboundLogContext(buildOutboundContext(ability, "legacy"), () =>
        handler(token, { mode: "legacy" })
      );
    }

    if (!managedApiKey.enabled) throw createHttpError("API Key 已禁用", 403);
    if (!managedApiKey.allowedAbilities.includes(ability)) {
      throw createHttpError(`API Key 无权访问 ${ability} 能力`, 403);
    }

    const triedIds = new Set<string>();
    let lastError: any = null;
    const candidateCount = this.store
      .read((state) => state.accounts.filter((item) => item.enabled && !item.blacklisted).length);
    const maxAttempts = Math.max(1, this.settings.maxRequestRetries, candidateCount);

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
        const result = await runWithOutboundLogContext(
          buildOutboundContext(ability, "pool", {
            accountId: selected.account.id,
            accountEmail: selected.account.email,
            apiKeyId: managedApiKey.id,
          }),
          () =>
            handler(token, {
              mode: "pool",
              accountId: selected.account.id,
              apiKeyId: managedApiKey.id,
            })
        );
        await this.#markAccountSuccess(selected.account.id);
        await this.#markApiKeyUsed(managedApiKey.id);
        return result;
      } catch (error: any) {
        lastError = error;
        const recovered = await this.#retryCurrentAccountAfterRefresh(
          selected.account.id,
          ability,
          managedApiKey.id,
          handler,
          error
        );
        if (recovered.recovered) {
          return recovered.result;
        }

        lastError = recovered.error;
        const classified = await this.#markAccountFailure(selected.account.id, recovered.error);
        triedIds.add(selected.account.id);
        if (!classified.retryable) throw recovered.error;
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
      this.#releaseExpiredBlacklistedAccounts();
      const refreshLimit = this.#maintenanceMaxRefreshPerRun();
      const candidates = this.store
        .read((state) =>
          state.accounts
            .filter((item) => item.enabled && item.autoRefresh && !item.blacklisted)
            .map((item) => this.#materializeAccount(item))
            .filter((item) => Boolean(item.password))
            .filter((item) => this.getActiveLeaseCount(item.id) === 0)
            .map((item) => ({
              account: item,
              reason: this.#getMaintenanceRefreshReason(item),
              sessionExpiresAtMs: parseIsoMs(item.sessionExpiresAt),
              lastLoginAtMs: parseIsoMs(item.lastLoginAt),
              updatedAtMs: parseIsoMs(item.updatedAt),
            }))
            .filter(
              (
                item
              ): item is {
                account: PoolAccount;
                reason: MaintenanceRefreshReason;
                sessionExpiresAtMs: number | null;
                lastLoginAtMs: number | null;
                updatedAtMs: number | null;
              } => item.reason !== null
            )
            .sort((a, b) => {
              const priorityDiff =
                maintenanceRefreshPriority(a.reason) - maintenanceRefreshPriority(b.reason);
              if (priorityDiff !== 0) return priorityDiff;
              const expiresDiff =
                (a.sessionExpiresAtMs ?? Number.MIN_SAFE_INTEGER) -
                (b.sessionExpiresAtMs ?? Number.MIN_SAFE_INTEGER);
              if (expiresDiff !== 0) return expiresDiff;
              const loginDiff =
                (a.lastLoginAtMs ?? Number.MIN_SAFE_INTEGER) -
                (b.lastLoginAtMs ?? Number.MIN_SAFE_INTEGER);
              if (loginDiff !== 0) return loginDiff;
              const updatedDiff =
                (a.updatedAtMs ?? Number.MIN_SAFE_INTEGER) -
                (b.updatedAtMs ?? Number.MIN_SAFE_INTEGER);
              if (updatedDiff !== 0) return updatedDiff;
              return a.account.email.localeCompare(b.account.email);
            }),
        )
        .slice(0, refreshLimit);

      if (!candidates.length) return;

      const totalPending = this.store.read((state) =>
        state.accounts
          .filter((item) => item.enabled && item.autoRefresh && !item.blacklisted)
          .map((item) => this.#materializeAccount(item))
          .filter((item) => Boolean(item.password))
          .filter((item) => this.getActiveLeaseCount(item.id) === 0)
          .filter((item) => this.#getMaintenanceRefreshReason(item) !== null).length
      );
      if (totalPending > candidates.length) {
        logger.info(
          `维护任务待刷新账号 ${totalPending} 个，本轮限流处理 ${candidates.length} 个，剩余 ${totalPending - candidates.length} 个留待后续轮次`
        );
      }

      for (const candidate of candidates) {
        try {
          await this.refreshAccountSession(candidate.account.id, "maintenance");
        } catch (error: any) {
          logger.warn(`维护任务刷新账号 ${candidate.account.email} 失败: ${error?.message || error}`);
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
