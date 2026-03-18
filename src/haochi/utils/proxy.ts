export interface ParsedProxyConfig {
  normalized: string;
  server: string;
  username: string | null;
  password: string | null;
}

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks5:",
]);

export function normalizeProxyUrl(value: any): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("代理地址格式不正确");
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("仅支持 http/https/socks4/socks5 代理");
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error("代理地址必须包含主机和端口");
  }

  const auth =
    parsed.username || parsed.password
      ? `${decodeURIComponent(parsed.username)}${
          parsed.password ? `:${decodeURIComponent(parsed.password)}` : ""
        }@`
      : "";
  return `${parsed.protocol}//${auth}${parsed.host}`;
}

export function maskProxyUrl(value: any): string {
  const normalized = normalizeProxyUrl(value);
  if (!normalized) return "";

  const parsed = new URL(normalized);
  const auth = parsed.username || parsed.password ? "***@" : "";
  return `${parsed.protocol}//${auth}${parsed.host}`;
}

export function parseProxyConfig(value: any): ParsedProxyConfig | null {
  const normalized = normalizeProxyUrl(value);
  if (!normalized) return null;

  const parsed = new URL(normalized);
  return {
    normalized,
    server: `${parsed.protocol}//${parsed.host}`,
    username: parsed.username ? decodeURIComponent(parsed.username) : null,
    password: parsed.password ? decodeURIComponent(parsed.password) : null,
  };
}

export function attachProxyToToken(token: string | null | undefined, proxyUrl: any): string | null {
  const rawToken = String(token || "").trim();
  if (!rawToken) return null;
  const normalizedProxy = normalizeProxyUrl(proxyUrl);
  return normalizedProxy ? `${normalizedProxy}@${rawToken}` : rawToken;
}
