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
      30,
    ),
    maintenanceIntervalSeconds: clampNumber(
      process.env.HAOCHI_MAINTENANCE_INTERVAL_SECONDS,
      15,
      3600,
      180,
    ),
    defaultAccountMaxConcurrency: clampNumber(
      process.env.HAOCHI_ACCOUNT_MAX_CONCURRENCY,
      1,
      20,
      2,
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

export interface HaochiStatePersistOptions {
  immediate?: boolean;
}

export default class HaochiStateStore {
  #state: HaochiState | null = null;
  #dirty = false;
  #persistTimer: NodeJS.Timeout | null = null;
  readonly filePath: string;
  readonly encryptionSecret: string;
  readonly persistDelayMs: number;

  constructor(filePath?: string) {
    this.filePath = filePath
      ? path.resolve(filePath)
      : path.resolve(process.env.HAOCHI_STATE_PATH || "data/haochi/state.json");
    this.encryptionSecret = String(
      process.env.HAOCHI_ACCOUNT_SECRET ||
        process.env.DREAMINA_ACCOUNT_CACHE_SECRET ||
        process.env.ACCOUNT_CACHE_SECRET ||
        "",
    );
    this.persistDelayMs = clampNumber(process.env.HAOCHI_STATE_FLUSH_INTERVAL_MS, 0, 60000, 1000);
  }

  #buildSnapshot(state: HaochiState) {
    const normalized = normalizeState(state);
    normalized.updatedAt = nowIso();
    return normalized;
  }

  #writeSnapshot(snapshot: HaochiState) {
    fs.ensureDirSync(path.dirname(this.filePath));
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
    fs.moveSync(tempPath, this.filePath, { overwrite: true });
    this.#state = snapshot;
    this.#dirty = false;
  }

  #schedulePersist(immediate = false) {
    if (immediate || this.persistDelayMs === 0) {
      this.flushSync();
      return;
    }
    if (this.#persistTimer) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.flushSync();
    }, this.persistDelayMs);
    this.#persistTimer.unref?.();
  }

  #loadInternal() {
    if (this.#state) return this.#state;
    if (!fs.existsSync(this.filePath)) {
      this.#state = buildDefaultState();
      this.#dirty = true;
      this.flushSync();
      logger.warn(`号池状态文件不存在，已初始化: ${this.filePath}`);
      return this.#state;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.#state = normalizeState(raw.trim() ? JSON.parse(raw) : null);
      this.#dirty = false;
    } catch (error: any) {
      logger.error(`读取号池状态文件失败，已回退默认状态: ${error?.message || error}`);
      this.#state = buildDefaultState();
      this.#dirty = true;
      this.flushSync();
    }
    return this.#state;
  }

  flushSync() {
    const current = this.#loadInternal();
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    if (!this.#dirty) return;
    this.#writeSnapshot(this.#buildSnapshot(current));
  }

  read<T>(reader: (state: Readonly<HaochiState>) => T): T {
    return reader(this.#loadInternal());
  }

  getState() {
    return deepClone(this.#loadInternal());
  }

  saveState(nextState: HaochiState, options: HaochiStatePersistOptions = {}) {
    this.#state = this.#buildSnapshot(nextState);
    this.#dirty = true;
    this.#schedulePersist(options.immediate === true);
    return this.getState();
  }

  update(mutator: (draft: HaochiState) => void, options: HaochiStatePersistOptions = {}) {
    const draft = this.#loadInternal();
    mutator(draft);
    this.#state = this.#buildSnapshot(draft);
    this.#dirty = true;
    this.#schedulePersist(options.immediate === true);
    return this.getState();
  }
}
