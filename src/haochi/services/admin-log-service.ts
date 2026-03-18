import path from "path";

import fs from "fs-extra";

import config from "@/lib/config.ts";
import util from "@/lib/util.ts";

const OUTBOUND_MARKER = "[OUTBOUND]";
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 400;

export interface OutboundLogQuery {
  date?: string | null;
  limit?: number;
  keyword?: string | null;
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

function parseLogLine(raw: string) {
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
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.includes(OUTBOUND_MARKER));

    const filtered = keyword
      ? lines.filter((line) => line.toLowerCase().includes(keyword.toLowerCase()))
      : lines;
    const sliced = filtered.slice(-limit);

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
      entries: sliced.map(parseLogLine),
      emptyReason: filtered.length
        ? ""
        : keyword
          ? `没有匹配关键字“${keyword}”的外部调用日志`
          : "当前还没有外部调用日志",
    };
  }
}
