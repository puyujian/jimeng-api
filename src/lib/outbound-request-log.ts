import axios from "axios";

import { getOutboundLogContext } from "@/lib/outbound-log-context.ts";
import logger from "@/lib/logger.ts";

const REGISTER_FLAG = "__jimengApiOutboundLoggerRegistered__";
const MAX_STRING_LENGTH = 400;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 12;
const VERBOSE_OUTBOUND_LOGS = process.env.JIMENG_VERBOSE_OUTBOUND_LOGS === "1";
let requestSequence = 0;
let requestGroupSequence = 0;

interface OutboundLogMeta {
  requestId?: string;
  groupId?: string | null;
  startedAt?: number;
  method?: string;
  url?: string;
  ability?: string | null;
  requestMode?: "legacy" | "pool" | null;
  accountId?: string | null;
  accountEmail?: string | null;
  accountLabel?: string | null;
  apiKeyId?: string | null;
  requestAttempt?: number;
  attemptLabel?: string | null;
  historyId?: string | null;
  requestKind?: string | null;
}

function nextRequestId() {
  requestSequence = (requestSequence + 1) % 1000000;
  return `req_${Date.now().toString(36)}_${requestSequence}`;
}

function nextRequestGroupId() {
  requestGroupSequence = (requestGroupSequence + 1) % 1000000;
  return `grp_${Date.now().toString(36)}_${requestGroupSequence}`;
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

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => summarizeValue(item, depth + 1, fieldName, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`...(${value.length - MAX_ARRAY_ITEMS} more)`);
    return items;
  }

  if (isBlob(value)) {
    return `[Blob type=${value.type || "unknown"} size=${value.size || 0}]`;
  }

  if (isFormData(value)) {
    const fields: any[] = [];
    let index = 0;
    for (const [key, fieldValue] of value.entries()) {
      if (index >= MAX_ARRAY_ITEMS) break;
      fields.push({
        key,
        value: summarizeValue(fieldValue, depth + 1, key, seen),
      });
      index += 1;
    }
    return {
      type: "FormData",
      fields,
      truncated: index < Array.from(value.keys()).length,
    };
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (depth >= 2) {
    const keys = Object.keys(value);
    return `[Object ${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",..." : ""}]`;
  }

  const result: Record<string, any> = {};
  const keys = Object.keys(value);
  keys.slice(0, MAX_OBJECT_KEYS).forEach((key) => {
    result[key] = summarizeValue(value[key], depth + 1, key, seen);
  });
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

function parseJsonLike(value: any) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractPath(url: string) {
  const raw = String(url || "");
  if (!raw) return "";
  try {
    return new URL(raw).pathname;
  } catch {
    return raw.split("?")[0];
  }
}

function resolveRequestKind(url: string) {
  const pathname = extractPath(url);
  if (pathname.includes("/mweb/v1/aigc_draft/generate")) return "提交任务";
  if (pathname.includes("/mweb/v1/get_history_by_ids")) return "轮询状态";
  if (pathname.includes("/commerce/v1/benefits/user_credit")) return "查询积分";
  if (pathname.includes("/commerce/v1/benefits/credit_receive")) return "领取积分";
  if (pathname.includes("/passport/account/info/v2")) return "校验账号";
  return "外部调用";
}

function resolveAccountLabel(meta: OutboundLogMeta) {
  return meta.accountLabel || meta.accountEmail || (meta.requestMode === "legacy" ? "直传令牌" : "未知账号");
}

function normalizeAttempt(value: any) {
  const attempt = Number(value || 0);
  if (!Number.isFinite(attempt) || attempt <= 0) return 0;
  return Math.floor(attempt);
}

function formatAttemptLabel(value: any) {
  const attempt = normalizeAttempt(value);
  return attempt > 0 ? `第 ${attempt} 次重试` : "首次请求";
}

function extractHistoryIdFromPayload(payload: any) {
  const normalized = parseJsonLike(payload);
  if (!normalized || typeof normalized !== "object") return null;
  if (Array.isArray(normalized.history_ids) && normalized.history_ids.length > 0) {
    return String(normalized.history_ids[0] || "").trim() || null;
  }
  return null;
}

function extractHistoryIdFromResponse(responseData: any) {
  const payload = parseJsonLike(responseData);
  if (!payload || typeof payload !== "object") return null;
  return (
    String(payload?.data?.aigc_data?.history_record_id || payload?.aigc_data?.history_record_id || "").trim() ||
    null
  );
}

function unwrapBusinessData(responseData: any) {
  const payload = parseJsonLike(responseData);
  if (!payload || typeof payload !== "object") return null;
  return typeof payload.data === "object" && payload.data != null ? payload.data : payload;
}

function findHistoryTaskInfo(responseData: any, historyId: string | null) {
  const payload = unwrapBusinessData(responseData);
  if (!payload || typeof payload !== "object") return null;
  if (historyId && payload[historyId] && typeof payload[historyId] === "object") {
    return payload[historyId];
  }
  return (
    Object.values(payload).find(
      (item) =>
        item &&
        typeof item === "object" &&
        ("status" in item || "task" in item || "item_list" in item),
    ) || null
  );
}

function mapGenerationStatusCode(statusCode: any) {
  const status = Number(statusCode);
  if (!Number.isFinite(status)) return null;
  if ([20, 42, 45].includes(status)) return "生成中";
  if ([10, 50].includes(status)) return "生成完成";
  if (status === 30) return "生成失败";
  return null;
}

function normalizeReasonText(value: any) {
  const text = String(value || "").trim();
  return text || null;
}

function extractFailureReason(requestKind: string, responseData: any, historyId: string | null) {
  const payload = parseJsonLike(responseData);
  const taskInfo = findHistoryTaskInfo(responseData, historyId);
  const task = taskInfo?.task && typeof taskInfo.task === "object" ? taskInfo.task : null;
  const genericCandidates = [
    payload?.errmsg,
    payload?.message,
    payload?.error_message,
    payload?.errorMessage,
    payload?.data?.errmsg,
    payload?.data?.message,
  ];

  if (requestKind === "提交任务" || requestKind === "轮询状态") {
    const taskCandidates = [
      taskInfo?.fail_reason,
      taskInfo?.failure_reason,
      taskInfo?.status_msg,
      taskInfo?.message,
      taskInfo?.error_message,
      taskInfo?.errorMessage,
      task?.fail_reason,
      task?.failure_reason,
      task?.status_msg,
      task?.message,
      task?.error_message,
      task?.errorMessage,
      ...genericCandidates,
    ];
    return taskCandidates.map(normalizeReasonText).find(Boolean) || null;
  }

  return genericCandidates.map(normalizeReasonText).find(Boolean) || null;
}

function deriveGenerationStatus(requestKind: string, responseData: any, historyId: string | null) {
  if (requestKind === "提交任务") {
    return {
      generationStatus: extractHistoryIdFromResponse(responseData) ? "生成中" : "",
      historyId: historyId || extractHistoryIdFromResponse(responseData),
      generationStatusCode: null,
    };
  }

  if (requestKind !== "轮询状态") {
    return {
      generationStatus: "",
      historyId,
      generationStatusCode: null,
    };
  }

  const taskInfo = findHistoryTaskInfo(responseData, historyId);
  const statusCode = Number(taskInfo?.status ?? taskInfo?.task?.status);
  return {
    generationStatus: mapGenerationStatusCode(statusCode) || "生成中",
    historyId,
    generationStatusCode: Number.isFinite(statusCode) ? statusCode : null,
  };
}

function extractFinishTime(responseData: any, historyId: string | null) {
  const taskInfo = findHistoryTaskInfo(responseData, historyId);
  const rawValue = Number(taskInfo?.task?.finish_time ?? taskInfo?.finish_time ?? 0);
  if (!Number.isFinite(rawValue) || rawValue <= 0) return null;
  return Math.floor(rawValue);
}

function buildContextMeta() {
  const context = getOutboundLogContext();
  if (!context) return {};
  return {
    ability: context.ability || null,
    requestMode: context.mode || null,
    accountId: context.accountId || null,
    accountEmail: context.accountEmail || null,
    accountLabel: context.accountLabel || context.accountEmail || null,
    apiKeyId: context.apiKeyId || null,
  } satisfies Partial<OutboundLogMeta>;
}

function getMeta(config: any) {
  const contextMeta = buildContextMeta();
  const existingMeta =
    config?.__outboundLogMeta && typeof config.__outboundLogMeta === "object"
      ? config.__outboundLogMeta
      : {};
  const url = String(existingMeta.url || resolveUrl(config));
  const historyId =
    String(existingMeta.historyId || extractHistoryIdFromPayload(config?.data) || "").trim() || null;
  const meta: OutboundLogMeta = {
    ...contextMeta,
    ...existingMeta,
    requestId: String(existingMeta.requestId || nextRequestId()),
    groupId: String(existingMeta.groupId || nextRequestGroupId()).trim() || null,
    startedAt: Number(existingMeta.startedAt || Date.now()),
    method: String(existingMeta.method || config?.method || "GET").toUpperCase(),
    url,
    requestAttempt: normalizeAttempt(existingMeta.requestAttempt),
    attemptLabel: String(existingMeta.attemptLabel || formatAttemptLabel(existingMeta.requestAttempt)),
    requestKind: String(existingMeta.requestKind || resolveRequestKind(url)),
    historyId,
    accountLabel: String(
      existingMeta.accountLabel || contextMeta.accountLabel || contextMeta.accountEmail || "",
    ).trim() || null,
  };
  config.__outboundLogMeta = meta;
  return meta;
}

function buildStartSummary(meta: OutboundLogMeta, config: any) {
  return {
    accountLabel: resolveAccountLabel(meta),
    ability: meta.ability || null,
    requestMode: meta.requestMode || null,
    groupId: meta.groupId || null,
    requestKind: meta.requestKind || resolveRequestKind(meta.url || resolveUrl(config)),
    historyId: meta.historyId || extractHistoryIdFromPayload(config?.data),
    attempt: normalizeAttempt(meta.requestAttempt),
    attemptLabel: meta.attemptLabel || formatAttemptLabel(meta.requestAttempt),
    generationStatus:
      meta.requestKind === "提交任务" || meta.requestKind === "轮询状态" ? "生成中" : null,
  };
}

function buildEndSummary(meta: OutboundLogMeta, response: any, duration: number) {
  const requestKind = meta.requestKind || resolveRequestKind(meta.url || "");
  const derivedHistoryId = meta.historyId || extractHistoryIdFromResponse(response?.data);
  const { generationStatus, generationStatusCode, historyId } = deriveGenerationStatus(
    requestKind,
    response?.data,
    derivedHistoryId,
  );
  const finishTime = extractFinishTime(response?.data, historyId);
  const responseStatus = Number(response?.status || 0) || null;
  const failureReason = extractFailureReason(requestKind, response?.data, historyId);
  const isTaskFailed = generationStatus === "生成失败";
  const resultStatus = responseStatus >= 400 || isTaskFailed ? "error" : "success";

  return {
    accountLabel: resolveAccountLabel(meta),
    ability: meta.ability || null,
    requestMode: meta.requestMode || null,
    groupId: meta.groupId || null,
    requestKind,
    historyId,
    attempt: normalizeAttempt(meta.requestAttempt),
    attemptLabel: meta.attemptLabel || formatAttemptLabel(meta.requestAttempt),
    durationMs: duration,
    httpStatus: responseStatus,
    httpStatusText: response?.statusText || "",
    resultStatus,
    generationStatus:
      generationStatus || (responseStatus >= 400 ? "生成失败" : null),
    generationStatusCode,
    finishTime,
    errorMessage: resultStatus === "error" ? failureReason || response?.statusText || "" : "",
  };
}

function buildErrorSummary(meta: OutboundLogMeta, error: any, duration: number) {
  const requestKind = meta.requestKind || resolveRequestKind(meta.url || "");
  const responseStatus = Number(error?.response?.status || 0) || null;
  const { generationStatus, generationStatusCode, historyId } = deriveGenerationStatus(
    requestKind,
    error?.response?.data,
    meta.historyId,
  );
  const failureReason = extractFailureReason(requestKind, error?.response?.data, historyId);

  return {
    accountLabel: resolveAccountLabel(meta),
    ability: meta.ability || null,
    requestMode: meta.requestMode || null,
    groupId: meta.groupId || null,
    requestKind,
    historyId,
    attempt: normalizeAttempt(meta.requestAttempt),
    attemptLabel: meta.attemptLabel || formatAttemptLabel(meta.requestAttempt),
    durationMs: duration,
    httpStatus: responseStatus,
    httpStatusText: error?.response?.statusText || "",
    resultStatus: "error",
    errorCode: error?.code || "UNKNOWN",
    errorMessage: failureReason || error?.message || "unknown error",
    generationStatus:
      generationStatus || (requestKind === "提交任务" || requestKind === "轮询状态" ? "生成失败" : null),
    generationStatusCode,
  };
}

function logRequest(config: any) {
  const meta = getMeta(config);
  logger.info(`[OUTBOUND][${meta.requestId}] -> ${meta.method} ${meta.url}`);
  logger.info(`[OUTBOUND][${meta.requestId}] start=${toLogString(buildStartSummary(meta, config))}`);

  if (!VERBOSE_OUTBOUND_LOGS) {
    return config;
  }

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
  const duration = Date.now() - Number(meta.startedAt || Date.now());
  const logFn =
    response.status >= 400
      ? logger.warn.bind(logger)
      : logger.info.bind(logger);
  logFn(
    `[OUTBOUND][${meta.requestId}] <- ${meta.method} ${meta.url} ${response.status} ${response.statusText || ""} ${duration}ms`,
  );
  logFn(
    `[OUTBOUND][${meta.requestId}] end=${toLogString(buildEndSummary(meta, response, duration))}`,
  );

  if (!VERBOSE_OUTBOUND_LOGS) {
    return response;
  }

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
  const duration = Date.now() - Number(meta.startedAt || Date.now());
  logger.error(
    `[OUTBOUND][${meta.requestId}] xx ${meta.method} ${meta.url} ${duration}ms code=${error?.code || "UNKNOWN"} message=${error?.message || "unknown error"}`,
  );
  logger.error(
    `[OUTBOUND][${meta.requestId}] end=${toLogString(buildErrorSummary(meta, error, duration))}`,
  );

  if (!VERBOSE_OUTBOUND_LOGS) {
    return Promise.reject(error);
  }

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
