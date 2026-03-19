export type PoolAbility = "images" | "videos" | "chat" | "token";
export type PoolAccountRegion = "cn" | "us" | "hk" | "jp" | "sg";

export type AccountStatus =
  | "idle"
  | "healthy"
  | "refreshing"
  | "expired"
  | "invalid"
  | "insufficient_credit"
  | "blacklisted"
  | "disabled"
  | "error";

export interface EncryptedPayload {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  data: string;
}

export interface SecretHashPayload {
  salt: string;
  hash: string;
}

export interface AdminUser {
  id: string;
  username: string;
  passwordHash: SecretHashPayload;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  needsPasswordChange: boolean;
}

export interface AccountUserInfo {
  userId?: string | null;
  nickName?: string | null;
  email?: string | null;
}

export interface AccountSessionTokens {
  sessionid: string | null;
  sessionid_ss: string | null;
  sid_tt: string | null;
  msToken: string | null;
  passport_csrf_token: string | null;
  passport_csrf_token_default: string | null;
  s_v_web_id: string | null;
  _tea_web_id: string | null;
}

export interface PoolAccount {
  id: string;
  email: string;
  password: string | EncryptedPayload | null;
  proxy: string | null;
  enabled: boolean;
  autoRefresh: boolean;
  maxConcurrency: number;
  notes: string;
  status: AccountStatus;
  blacklisted: boolean;
  blacklistedReason: string | null;
  blacklistedAt: string | null;
  blacklistReleaseAt: string | null;
  lastError: string | null;
  lastLoginAt: string | null;
  lastValidatedAt: string | null;
  lastValidationStatus: "unknown" | "valid" | "invalid";
  lastUsedAt: string | null;
  sessionUpdatedAt: string | null;
  sessionExpiresAt: string | null;
  sessionTokens: AccountSessionTokens;
  userInfo: AccountUserInfo | null;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  allowedAbilities: PoolAbility[];
  secretHash: SecretHashPayload;
  secretValue?: string | EncryptedPayload | null;
  keyPreview: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HaochiSettings {
  sessionTtlMinutes: number;
  maintenanceIntervalSeconds: number;
  defaultAccountMaxConcurrency: number;
  maxProxyConcurrency: number;
  maxRequestRetries: number;
  allowLegacyAuthorization: boolean;
  loginProvider: string;
}

export interface HaochiState {
  version: number;
  updatedAt: string;
  settings: HaochiSettings;
  admins: AdminUser[];
  accounts: PoolAccount[];
  apiKeys: ApiKeyRecord[];
}

export interface LoginProgressEntry {
  time: string;
  message: string;
}

export interface LoginResult {
  success: boolean;
  email: string;
  userInfo?: AccountUserInfo | null;
  sessionTokens?: AccountSessionTokens;
  allCookies?: Record<string, string>;
  error?: string;
  logs: LoginProgressEntry[];
  timestamp: string;
}

export interface LoginProvider {
  readonly name: string;
  login(account: PoolAccount, onProgress?: (message: string) => void): Promise<LoginResult>;
  close?(): Promise<void>;
}

export interface AdminSession {
  token: string;
  userId: string;
  username: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface AccountLease {
  leaseId: string;
  accountId: string;
  startedAt: string;
  ability: PoolAbility;
}
