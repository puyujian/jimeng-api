import EX from "@/lib/consts/exceptions.ts";
import Exception from "@/lib/exceptions/Exception.ts";
import logger from "@/lib/logger.ts";
import type {
  AdminSession,
  AdminUser,
} from "@/haochi/types.ts";
import HaochiStateStore from "@/haochi/storage/state-store.ts";
import {
  createSecretHash,
  nowIso,
  parseCookieHeader,
  randomId,
  serializeCookie,
  verifySecret,
} from "@/haochi/utils/crypto.ts";

function createAuthError(message: string, statusCode = 401) {
  return new Exception(EX.SYSTEM_REQUEST_VALIDATION_ERROR, message).setHTTPStatusCode(statusCode);
}

function toPublicUser(admin: AdminUser) {
  return {
    id: admin.id,
    username: admin.username,
    lastLoginAt: admin.lastLoginAt,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
    needsPasswordChange: admin.needsPasswordChange,
  };
}

export default class AdminAuthService {
  readonly cookieName = String(process.env.HAOCHI_ADMIN_COOKIE_NAME || "haochi_admin_session");
  readonly sessionHours = Number(process.env.HAOCHI_ADMIN_SESSION_HOURS || 12) || 12;
  readonly defaultUsername = String(process.env.HAOCHI_ADMIN_USERNAME || "admin").trim() || "admin";
  readonly defaultPassword = String(process.env.HAOCHI_ADMIN_PASSWORD || "ChangeMe123!");
  readonly store: HaochiStateStore;
  readonly sessions = new Map<string, AdminSession>();

  constructor(store: HaochiStateStore) {
    this.store = store;
  }

  ensureBootstrapAdmin() {
    const state = this.store.getState();
    if (state.admins.length > 0) return;

    const now = nowIso();
    state.admins.push({
      id: randomId("admin"),
      username: this.defaultUsername,
      passwordHash: createSecretHash(this.defaultPassword),
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      needsPasswordChange: !process.env.HAOCHI_ADMIN_PASSWORD,
    });
    this.store.saveState(state);

    if (!process.env.HAOCHI_ADMIN_PASSWORD) {
      logger.warn(
        `已初始化默认管理员账号 ${this.defaultUsername} / ${this.defaultPassword}，请首次登录后立即修改密码`
      );
    } else {
      logger.info(`已初始化管理员账号: ${this.defaultUsername}`);
    }
  }

  #getAdminByUsername(username: string) {
    const normalized = String(username || "").trim();
    return this.store
      .getState()
      .admins.find((item) => item.username === normalized) || null;
  }

  #getAdminById(userId: string) {
    return this.store
      .getState()
      .admins.find((item) => item.id === userId) || null;
  }

  #createSession(admin: AdminUser) {
    const expiresAt = new Date(Date.now() + this.sessionHours * 60 * 60 * 1000).toISOString();
    const session: AdminSession = {
      token: randomId("session"),
      userId: admin.id,
      username: admin.username,
      expiresAt,
      lastSeenAt: nowIso(),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  buildSessionCookie(token: string) {
    return serializeCookie(this.cookieName, token, {
      httpOnly: true,
      maxAge: this.sessionHours * 60 * 60,
      sameSite: "Lax",
      secure: process.env.HAOCHI_COOKIE_SECURE === "1",
    });
  }

  buildClearCookie() {
    return serializeCookie(this.cookieName, "", {
      httpOnly: true,
      maxAge: 0,
      sameSite: "Lax",
      secure: process.env.HAOCHI_COOKIE_SECURE === "1",
    });
  }

  login(username: string, password: string) {
    this.ensureBootstrapAdmin();
    const admin = this.#getAdminByUsername(username);
    if (!admin || !verifySecret(password, admin.passwordHash)) {
      throw createAuthError("用户名或密码错误", 401);
    }

    const session = this.#createSession(admin);
    this.store.update((state) => {
      const current = state.admins.find((item) => item.id === admin.id);
      if (!current) return;
      current.lastLoginAt = nowIso();
      current.updatedAt = nowIso();
    });
    return {
      session,
      user: toPublicUser(this.#getAdminById(admin.id) || admin),
    };
  }

  logout(cookieHeader?: string | null) {
    const cookies = parseCookieHeader(cookieHeader);
    const token = cookies[this.cookieName];
    if (token) this.sessions.delete(token);
  }

  getCurrentUser(cookieHeader?: string | null) {
    const cookies = parseCookieHeader(cookieHeader);
    const token = cookies[this.cookieName];
    if (!token) return null;

    const session = this.sessions.get(token);
    if (!session) return null;

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }

    session.lastSeenAt = nowIso();
    session.expiresAt = new Date(Date.now() + this.sessionHours * 60 * 60 * 1000).toISOString();
    this.sessions.set(token, session);

    const admin = this.#getAdminById(session.userId);
    if (!admin) {
      this.sessions.delete(token);
      return null;
    }
    return {
      session,
      user: toPublicUser(admin),
    };
  }

  requireUser(cookieHeader?: string | null) {
    const current = this.getCurrentUser(cookieHeader);
    if (!current) throw createAuthError("请先登录后再操作", 401);
    return current;
  }

  changePassword(userId: string, currentPassword: string, nextPassword: string) {
    const admin = this.#getAdminById(userId);
    if (!admin) throw createAuthError("管理员不存在", 404);
    if (!verifySecret(currentPassword, admin.passwordHash)) {
      throw createAuthError("当前密码不正确", 400);
    }
    if (String(nextPassword || "").trim().length < 8) {
      throw createAuthError("新密码至少需要 8 位", 400);
    }

    this.store.update((state) => {
      const target = state.admins.find((item) => item.id === userId);
      if (!target) return;
      target.passwordHash = createSecretHash(nextPassword);
      target.updatedAt = nowIso();
      target.needsPasswordChange = false;
    });

    return {
      user: toPublicUser(this.#getAdminById(userId) || admin),
    };
  }
}
