import path from "path";

import fs from "fs-extra";

import config from "@/lib/config.ts";
import util from "@/lib/util.ts";

const OUTBOUND_MARKER = "[OUTBOUND]";
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 400;

type OutboundEntryStatus = "pending" | "success" | "error";

export interface OutboundLogQuery {
  date?: string | null;
  limit?: number;
  keyword?: string | null;
}

export interface OutboundLogEntry {
  taskKey: string;
  requestId: string;
  requestIds: string[];
  time: string | null;
  level: string;
  source: string;
  method: string;
  url: string;
  requestPath: string;
  requestKind: string;
  accountLabel: string;
  ability: string | null;
  requestMode: string | null;
  attempt: number;
  attemptLabel: string;
  status: OutboundEntryStatus;
  statusLabel: string;
  generationStatus: string;
  durationMs: number | null;
  httpStatus: number | null;
  httpStatusText: string;
  historyId: string | null;
  groupId: string | null;
  errorCode: string;
  errorMessage: string;
  rawLines: string[];
  detailText: string;
}

interface ParsedLogLine {
  time: string | null;
  level: string;
  source: string;
  message: string;
  raw: string;
}

interface MutableOutboundLogEntry extends Omit<OutboundLogEntry, "detailText"> {
  detailText?: string;
}

function normalizeDate(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return util.getDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("日志日期格式必须是 YYYY-MM-DD");
  }
  return raw;
}

function normalizeLimit(value?: number) {
  const limit = Number(value || DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function parseLogLine(raw: string): ParsedLogLine {
  const match = raw.match(/^\[(.+?)\]\[(.+?)\]\[(.+?)\]\s+(.*)$/);
  if (!match) {
    return {
      time: null,
      level: "unknown",
      source: "unknown",
      message: raw,
      raw,
    };
  }

  const [, time, level, source, message] = match;
  return {
    time,
    level,
    source,
    message,
    raw,
  };
}

function extractRequestId(message: string) {
  return message.match(/^\[OUTBOUND\]\[([^\]]+)\]\s+/)?.[1] || null;
}

function parseJsonPayload(raw: string) {
  try {
    return JSON.parse(raw);
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

function fallbackRequestKind(url: string) {
  const pathname = extractPath(url);
  if (pathname.includes("/mweb/v1/aigc_draft/generate")) return "提交任务";
  if (pathname.includes("/mweb/v1/get_history_by_ids")) return "轮询状态";
  if (pathname.includes("/commerce/v1/benefits/user_credit")) return "查询积分";
  if (pathname.includes("/commerce/v1/benefits/credit_receive")) return "领取积分";
  if (pathname.includes("/passport/account/info/v2")) return "校验账号";
  return "外部调用";
}

function createEntry(requestId: string): MutableOutboundLogEntry {
  return {
    taskKey: `request:${requestId}`,
    requestId,
    requestIds: [requestId],
    time: null,
    level: "unknown",
    source: "unknown",
    method: "",
    url: "",
    requestPath: "",
    requestKind: "外部调用",
    accountLabel: "未知账号",
    ability: null,
    requestMode: null,
    attempt: 0,
    attemptLabel: "首次请求",
    status: "pending",
    statusLabel: "请求中",
    generationStatus: "",
    durationMs: null,
    httpStatus: null,
    httpStatusText: "",
    historyId: null,
    groupId: null,
    errorCode: "",
    errorMessage: "",
    rawLines: [],
  };
}

function applySummaryPayload(entry: MutableOutboundLogEntry, payload: any) {
  if (!payload || typeof payload !== "object") return;
  if (payload.accountLabel) entry.accountLabel = String(payload.accountLabel);
  if (payload.ability) entry.ability = String(payload.ability);
  if (payload.requestMode) entry.requestMode = String(payload.requestMode);
  if (payload.groupId) entry.groupId = String(payload.groupId);
  if (payload.requestKind) entry.requestKind = String(payload.requestKind);
  if (payload.historyId) entry.historyId = String(payload.historyId);
  if (Number.isFinite(Number(payload.attempt))) entry.attempt = Math.max(0, Number(payload.attempt));
  if (payload.attemptLabel) entry.attemptLabel = String(payload.attemptLabel);
  if (payload.durationMs != null && Number.isFinite(Number(payload.durationMs))) {
    entry.durationMs = Number(payload.durationMs);
  }
  if (payload.httpStatus != null && Number.isFinite(Number(payload.httpStatus))) {
    entry.httpStatus = Number(payload.httpStatus);
  }
  if (payload.httpStatusText) entry.httpStatusText = String(payload.httpStatusText);
  if (payload.resultStatus === "success" || payload.resultStatus === "error") {
    entry.status = payload.resultStatus;
  }
  if (payload.generationStatus) entry.generationStatus = String(payload.generationStatus);
  if (payload.errorCode) entry.errorCode = String(payload.errorCode);
  if (payload.errorMessage) entry.errorMessage = String(payload.errorMessage);
}

function applyRequestLine(entry: MutableOutboundLogEntry, message: string) {
  const match = message.match(/^\[OUTBOUND\]\[[^\]]+\]\s+->\s+([A-Z]+)\s+(.+)$/);
  if (!match) return;
  entry.method = match[1];
  entry.url = match[2];
  entry.requestPath = extractPath(entry.url);
  entry.requestKind = fallbackRequestKind(entry.url);
}

function applyResponseLine(entry: MutableOutboundLogEntry, message: string) {
  const match = message.match(
    /^\[OUTBOUND\]\[[^\]]+\]\s+<-\s+([A-Z]+)\s+(.+?)\s+(\d{3})\s*(.*?)\s+(\d+)ms$/,
  );
  if (!match) return;
  entry.method = match[1];
  entry.url = match[2];
  entry.requestPath = extractPath(entry.url);
  entry.requestKind = fallbackRequestKind(entry.url);
  entry.httpStatus = Number(match[3]);
  entry.httpStatusText = String(match[4] || "").trim();
  entry.durationMs = Number(match[5]);
  entry.status = entry.httpStatus >= 400 ? "error" : "success";
}

function applyErrorLine(entry: MutableOutboundLogEntry, message: string) {
  const match = message.match(
    /^\[OUTBOUND\]\[[^\]]+\]\s+xx\s+([A-Z]+)\s+(.+?)\s+(\d+)ms\s+code=([^\s]+)\s+message=(.*)$/,
  );
  if (!match) return;
  entry.method = match[1];
  entry.url = match[2];
  entry.requestPath = extractPath(entry.url);
  entry.requestKind = fallbackRequestKind(entry.url);
  entry.durationMs = Number(match[3]);
  entry.status = "error";
  entry.errorCode = String(match[4] || "");
  entry.errorMessage = String(match[5] || "").trim();
}

function isTaskRequestKind(requestKind: string) {
  return requestKind === "提交任务" || requestKind === "轮询状态";
}

function shouldDisplayOutboundEntry(entry: OutboundLogEntry) {
  if (isTaskRequestKind(entry.requestKind)) return true;
  if (entry.historyId) return true;
  return (
    entry.generationStatus === "生成中" ||
    entry.generationStatus === "生成完成" ||
    entry.generationStatus === "生成失败"
  );
}

function compareLogTime(left: string | null, right: string | null) {
  return String(left || "").localeCompare(String(right || ""));
}

function resolveRequestGroupKey(entry: OutboundLogEntry) {
  if (entry.groupId) return `group:${entry.groupId}`;
  return `request:${entry.requestId}`;
}

function resolveTaskKey(entry: OutboundLogEntry) {
  if (entry.historyId && isTaskRequestKind(entry.requestKind)) {
    return `history:${entry.historyId}`;
  }
  return entry.taskKey || resolveRequestGroupKey(entry);
}

function copyLatestEntryFields(target: MutableOutboundLogEntry, source: OutboundLogEntry) {
  target.requestId = source.requestId;
  target.time = source.time;
  target.level = source.level;
  target.source = source.source;
  target.method = source.method;
  target.url = source.url;
  target.requestPath = source.requestPath;
  target.requestKind = source.requestKind;
  target.accountLabel = source.accountLabel;
  target.ability = source.ability;
  target.requestMode = source.requestMode;
  target.status = source.status;
  target.statusLabel = source.statusLabel;
  target.generationStatus = source.generationStatus;
  target.durationMs = source.durationMs;
  target.httpStatus = source.httpStatus;
  target.httpStatusText = source.httpStatusText;
  target.historyId = source.historyId;
  target.groupId = source.groupId;
  target.errorCode = source.errorCode;
  target.errorMessage = source.errorMessage;
}

function mergeEntriesByKey(entries: OutboundLogEntry[], resolveKey: (entry: OutboundLogEntry) => string) {
  const merged = new Map<string, MutableOutboundLogEntry>();

  for (const entry of entries) {
    const taskKey = resolveKey(entry);
    const existing = merged.get(taskKey);

    if (!existing) {
      merged.set(taskKey, {
        ...entry,
        taskKey,
        requestIds: [...entry.requestIds],
        rawLines: [...entry.rawLines],
      });
      continue;
    }

    entry.requestIds.forEach((requestId) => {
      if (!existing.requestIds.includes(requestId)) {
        existing.requestIds.push(requestId);
      }
    });
    existing.rawLines.push(...entry.rawLines);
    if (!existing.historyId && entry.historyId) existing.historyId = entry.historyId;
    if (!existing.groupId && entry.groupId) existing.groupId = entry.groupId;

    if (compareLogTime(entry.time, existing.time) >= 0) {
      copyLatestEntryFields(existing, entry);
      existing.taskKey = taskKey;
    }

    existing.attempt = Math.max(existing.attempt, entry.attempt);
    existing.attemptLabel = existing.attempt > 0 ? `第 ${existing.attempt} 次重试` : "首次请求";
    existing.detailText = existing.rawLines.join("\n");
  }

  return Array.from(merged.values()).map((entry) => ({
    ...entry,
    detailText: entry.rawLines.join("\n"),
  }));
}

function finalizeEntry(entry: MutableOutboundLogEntry): OutboundLogEntry {
  const statusLabel =
    entry.status === "success"
      ? "调用成功"
      : entry.status === "error"
        ? "调用失败"
        : "请求中";

  let generationStatus = entry.generationStatus;
  if (!generationStatus) {
    if (entry.requestKind === "提交任务" || entry.requestKind === "轮询状态") {
      generationStatus = entry.status === "error" ? "生成失败" : "生成中";
    } else if (entry.status === "success") {
      generationStatus = "调用成功";
    } else if (entry.status === "error") {
      generationStatus = "调用失败";
    } else {
      generationStatus = "请求中";
    }
  }

  return {
    ...entry,
    statusLabel,
    generationStatus,
    detailText: entry.rawLines.join("\n"),
  };
}

function buildEntries(lines: string[]) {
  const grouped = new Map<string, MutableOutboundLogEntry>();

  for (const rawLine of lines) {
    const parsed = parseLogLine(rawLine);
    const requestId = extractRequestId(parsed.message);
    if (!requestId) continue;

    const entry = grouped.get(requestId) || createEntry(requestId);
    if (!grouped.has(requestId)) grouped.set(requestId, entry);

    if (parsed.time) entry.time = parsed.time;
    if (parsed.level) entry.level = parsed.level;
    if (parsed.source) entry.source = parsed.source;
    entry.rawLines.push(parsed.raw);

    const summaryMatch = parsed.message.match(/^\[OUTBOUND\]\[[^\]]+\]\s+(start|end)=(.+)$/);
    if (summaryMatch) {
      const payload = parseJsonPayload(summaryMatch[2]);
      applySummaryPayload(entry, payload);
      continue;
    }

    if (parsed.message.includes(" -> ")) {
      applyRequestLine(entry, parsed.message);
      continue;
    }

    if (parsed.message.includes(" <- ")) {
      applyResponseLine(entry, parsed.message);
      continue;
    }

    if (parsed.message.includes(" xx ")) {
      applyErrorLine(entry, parsed.message);
    }
  }

  const requestEntries = Array.from(grouped.values())
    .map(finalizeEntry)
    .sort((a, b) => compareLogTime(a.time, b.time));

  const requestGroupEntries = mergeEntriesByKey(requestEntries, resolveRequestGroupKey).sort((a, b) =>
    compareLogTime(a.time, b.time),
  );
  return mergeEntriesByKey(requestGroupEntries, resolveTaskKey).sort((a, b) =>
    compareLogTime(b.time, a.time),
  );
}

function matchesKeyword(entry: OutboundLogEntry, keyword: string) {
  if (!keyword) return true;
  const haystack = [
    entry.requestId,
    entry.accountLabel,
    entry.ability || "",
    entry.requestMode || "",
    entry.requestKind,
    entry.method,
    entry.url,
    entry.requestPath,
    entry.statusLabel,
    entry.generationStatus,
    entry.historyId || "",
    entry.groupId || "",
    entry.requestIds.join("\n"),
    entry.errorCode,
    entry.errorMessage,
    entry.detailText,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

export default class AdminLogService {
  getOutboundLogs(query: OutboundLogQuery = {}) {
    const date = normalizeDate(query.date);
    const limit = normalizeLimit(query.limit);
    const keyword = String(query.keyword || "").trim();
    const fileName = `${date}.log`;
    const filePath = path.join(config.system.logDirPath, fileName);

    if (!fs.existsSync(filePath)) {
      return {
        available: false,
        kind: "outbound",
        date,
        fileName,
        limit,
        keyword,
        totalMatched: 0,
        returnedCount: 0,
        updatedAt: null,
        entries: [],
        emptyReason: "当日日志文件不存在，可能服务刚启动，或当前环境未写入本地日志。",
      };
    }

    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const entries = buildEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.includes(OUTBOUND_MARKER)),
    );

    const visibleEntries = entries.filter(shouldDisplayOutboundEntry);
    const filtered = keyword
      ? visibleEntries.filter((entry) => matchesKeyword(entry, keyword))
      : visibleEntries;
    const sliced = filtered.slice(0, limit);

    return {
      available: true,
      kind: "outbound",
      date,
      fileName,
      limit,
      keyword,
      totalMatched: filtered.length,
      returnedCount: sliced.length,
      updatedAt: stat.mtime.toISOString(),
      entries: sliced,
      emptyReason: filtered.length
        ? ""
        : keyword
          ? `没有匹配关键字“${keyword}”的外部调用日志`
          : "当前还没有生成任务日志",
    };
  }
}
