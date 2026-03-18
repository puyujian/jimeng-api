import axios from "axios";

import logger from "@/lib/logger.ts";

const REGISTER_FLAG = "__jimengApiOutboundLoggerRegistered__";
const MAX_STRING_LENGTH = 400;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 12;
let requestSequence = 0;

function nextRequestId() {
  requestSequence = (requestSequence + 1) % 1000000;
  return `req_${Date.now().toString(36)}_${requestSequence}`;
}

function isSensitiveKey(key: string) {
  return /(authorization|cookie|token|session|sign|secret|password|api[-_]?key)/i.test(
    key,
  );
}

function truncateString(value: string) {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...(${value.length} chars)`;
}

function redactValue(value: any) {
  if (value == null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "[REDACTED]";
  if (text.length <= 8) return "[REDACTED]";
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function isFormData(value: any) {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

function isBlob(value: any) {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function summarizeValue(
  value: any,
  depth = 0,
  fieldName = "",
  seen = new WeakSet<object>(),
): any {
  if (value == null) return value;

  if (typeof value === "string") {
    return isSensitiveKey(fieldName)
      ? redactValue(value)
      : truncateString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof ArrayBuffer)
    return `[ArrayBuffer ${value.byteLength} bytes]`;
  if (ArrayBuffer.isView(value))
    return `[${value.constructor?.name || "TypedArray"} ${value.byteLength} bytes]`;
  if (isBlob(value))
    return `[Blob ${value.size} bytes type=${value.type || "unknown"}]`;
  if (value instanceof URLSearchParams)
    return `[URLSearchParams ${truncateString(value.toString())}]`;

  if (isFormData(value)) {
    const fields: any[] = [];
    let index = 0;
    for (const [key, fieldValue] of value.entries()) {
      if (index >= MAX_ARRAY_ITEMS) break;
      fields.push({
        key,
        value: summarizeValue(fieldValue, depth + 1, key, seen),
      });
      index++;
    }
    return {
      type: "FormData",
      fields,
      truncated: index < Array.from(value.keys()).length,
    };
  }

  if (typeof value === "function")
    return `[Function ${value.name || "anonymous"}]`;

  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (depth >= 2) {
    const keys = Object.keys(value);
    return `[Object ${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",..." : ""}]`;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => summarizeValue(item, depth + 1, fieldName, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  const result: Record<string, any> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = summarizeValue(value[key], depth + 1, key, seen);
  }
  if (keys.length > MAX_OBJECT_KEYS) {
    result.__truncatedKeys = keys.length - MAX_OBJECT_KEYS;
  }
  return result;
}

function summarizeHeaders(headers: any) {
  if (!headers) return undefined;
  const rawHeaders =
    headers && typeof headers.toJSON === "function"
      ? headers.toJSON()
      : headers;
  return summarizeValue(rawHeaders, 0, "headers");
}

function toLogString(value: any) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveUrl(config: any) {
  const baseURL = config?.baseURL || "";
  const url = config?.url || "";
  if (!baseURL) return String(url || "");
  if (/^https?:\/\//i.test(url)) return url;
  return `${String(baseURL).replace(/\/$/, "")}/${String(url).replace(/^\//, "")}`;
}

function getMeta(config: any) {
  if (!config.__outboundLogMeta) {
    config.__outboundLogMeta = {
      requestId: nextRequestId(),
      startedAt: Date.now(),
      method: String(config?.method || "GET").toUpperCase(),
      url: resolveUrl(config),
    };
  }
  return config.__outboundLogMeta;
}

function logRequest(config: any) {
  const meta = getMeta(config);
  logger.info(`[OUTBOUND][${meta.requestId}] -> ${meta.method} ${meta.url}`);

  const headers = summarizeHeaders(config.headers);
  if (headers && Object.keys(headers).length > 0) {
    logger.info(
      `[OUTBOUND][${meta.requestId}] headers=${toLogString(headers)}`,
    );
  }

  if (typeof config.params !== "undefined") {
    logger.info(
      `[OUTBOUND][${meta.requestId}] params=${toLogString(summarizeValue(config.params, 0, "params"))}`,
    );
  }

  if (typeof config.data !== "undefined") {
    logger.info(
      `[OUTBOUND][${meta.requestId}] data=${toLogString(summarizeValue(config.data, 0, "data"))}`,
    );
  }

  return config;
}

function logResponse(response: any) {
  const meta = getMeta(response.config || {});
  const duration = Date.now() - meta.startedAt;
  const logFn =
    response.status >= 400
      ? logger.warn.bind(logger)
      : logger.info.bind(logger);
  logFn(
    `[OUTBOUND][${meta.requestId}] <- ${meta.method} ${meta.url} ${response.status} ${response.statusText || ""} ${duration}ms`,
  );

  if (typeof response.data !== "undefined") {
    logFn(
      `[OUTBOUND][${meta.requestId}] response=${toLogString(summarizeValue(response.data, 0, "response"))}`,
    );
  }

  return response;
}

function logError(error: any) {
  const config = error?.config || {};
  const meta = getMeta(config);
  const duration = Date.now() - meta.startedAt;
  logger.error(
    `[OUTBOUND][${meta.requestId}] xx ${meta.method} ${meta.url} ${duration}ms code=${error?.code || "UNKNOWN"} message=${error?.message || "unknown error"}`,
  );

  if (error?.response) {
    logger.error(
      `[OUTBOUND][${meta.requestId}] response=${toLogString(summarizeValue(error.response.data, 0, "response"))}`,
    );
  }

  return Promise.reject(error);
}

const globalState = globalThis as Record<string, any>;

if (!globalState[REGISTER_FLAG]) {
  axios.interceptors.request.use(logRequest, logError);
  axios.interceptors.response.use(logResponse, logError);
  globalState[REGISTER_FLAG] = true;
  logger.info("[OUTBOUND] axios 外呼日志已启用");
}
