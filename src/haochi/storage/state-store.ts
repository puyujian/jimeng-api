import path from "path";

import fs from "fs-extra";

import logger from "@/lib/logger.ts";
import type { HaochiSettings, HaochiState } from "@/haochi/types.ts";
import { clampNumber, deepClone, nowIso } from "@/haochi/utils/crypto.ts";

function defaultSettings(): HaochiSettings {
  return {
    sessionTtlMinutes: clampNumber(process.env.HAOCHI_SESSION_TTL_MINUTES, 30, 24 * 60, 360),
    sessionRefreshBufferMinutes: clampNumber(
      process.env.HAOCHI_SESSION_REFRESH_BUFFER_MINUTES,
      5,
      12 * 60,
      30
    ),
    maintenanceIntervalSeconds: clampNumber(
      process.env.HAOCHI_MAINTENANCE_INTERVAL_SECONDS,
      15,
      3600,
      180
    ),
    defaultAccountMaxConcurrency: clampNumber(
      process.env.HAOCHI_ACCOUNT_MAX_CONCURRENCY,
      1,
      20,
      2
    ),
    maxProxyConcurrency: clampNumber(process.env.HAOCHI_PROXY_MAX_CONCURRENCY, 0, 20, 0),
    maxRequestRetries: clampNumber(process.env.HAOCHI_MAX_REQUEST_RETRIES, 1, 10, 3),
    allowLegacyAuthorization: process.env.HAOCHI_ALLOW_LEGACY_AUTHORIZATION !== "0",
    loginProvider: String(process.env.HAOCHI_LOGIN_PROVIDER || "dreamina").trim().toLowerCase(),
  };
}

function buildDefaultState(): HaochiState {
  return {
    version: 1,
    updatedAt: nowIso(),
    settings: defaultSettings(),
    admins: [],
    accounts: [],
    apiKeys: [],
  };
}

function normalizeState(raw: Partial<HaochiState> | null | undefined): HaochiState {
  const base = buildDefaultState();
  const state = raw || {};
  return {
    version: Number(state.version || base.version),
    updatedAt: state.updatedAt || base.updatedAt,
    settings: {
      ...base.settings,
      ...(state.settings || {}),
    },
    admins: Array.isArray(state.admins) ? state.admins : [],
    accounts: Array.isArray(state.accounts) ? state.accounts : [],
    apiKeys: Array.isArray(state.apiKeys) ? state.apiKeys : [],
  };
}

export default class HaochiStateStore {
  #state: HaochiState | null = null;
  readonly filePath: string;
  readonly encryptionSecret: string;

  constructor(filePath?: string) {
    this.filePath = filePath
      ? path.resolve(filePath)
      : path.resolve(process.env.HAOCHI_STATE_PATH || "data/haochi/state.json");
    this.encryptionSecret = String(
      process.env.HAOCHI_ACCOUNT_SECRET ||
        process.env.DREAMINA_ACCOUNT_CACHE_SECRET ||
        process.env.ACCOUNT_CACHE_SECRET ||
        ""
    );
  }

  #loadInternal() {
    if (this.#state) return this.#state;
    if (!fs.existsSync(this.filePath)) {
      this.#state = buildDefaultState();
      this.#persist(this.#state);
      logger.warn(`号池状态文件不存在，已初始化: ${this.filePath}`);
      return this.#state;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.#state = normalizeState(raw.trim() ? JSON.parse(raw) : null);
    } catch (error: any) {
      logger.error(`读取号池状态文件失败，已回退默认状态: ${error?.message || error}`);
      this.#state = buildDefaultState();
      this.#persist(this.#state);
    }
    return this.#state;
  }

  #persist(state: HaochiState) {
    const normalized = normalizeState(state);
    normalized.updatedAt = nowIso();
    fs.ensureDirSync(path.dirname(this.filePath));
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf8");
    fs.moveSync(tempPath, this.filePath, { overwrite: true });
    this.#state = normalized;
  }

  getState() {
    return deepClone(this.#loadInternal());
  }

  saveState(nextState: HaochiState) {
    this.#persist(nextState);
    return this.getState();
  }

  update(mutator: (draft: HaochiState) => void) {
    const draft = this.getState();
    mutator(draft);
    return this.saveState(draft);
  }
}
