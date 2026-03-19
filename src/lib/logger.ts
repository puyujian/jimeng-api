import path from "path";
import _util from "util";

import "colors";
import _ from "lodash";
import fs from "fs-extra";
import { format as dateFormat } from "date-fns";

import config from "./config.ts";
import util from "./util.ts";

const isVercelEnv = process.env.VERCEL;
const LOG_BUFFER_MAX_BYTES = Math.max(
  256 * 1024,
  Number(process.env.JIMENG_LOG_BUFFER_MAX_BYTES || 8 * 1024 * 1024) || 8 * 1024 * 1024,
);
const LOG_CAPTURE_SOURCE = process.env.JIMENG_LOG_CAPTURE_SOURCE === "1";

function createUnknownSource() {
  return { name: "app", codeLine: 0, codeColumn: 0 };
}

class LogWriter {
  #buffers = [];
  #bufferedBytes = 0;
  #timer = null;
  #dropNoticePending = false;
  #writing = false;

  constructor() {
    if (isVercelEnv) return;
    fs.ensureDirSync(config.system.logDirPath);
    this.#schedule(config.system.logWriteInterval);
  }

  #getLogFilePath() {
    return path.join(config.system.logDirPath, `/${util.getDateString()}.log`);
  }

  #resetBufferState() {
    this.#buffers = [];
    this.#bufferedBytes = 0;
    this.#dropNoticePending = false;
  }

  #makeRoom(nextBufferSize) {
    if (nextBufferSize <= 0) return;

    let droppedBytes = 0;
    while (
      this.#buffers.length > 0 &&
      this.#bufferedBytes + nextBufferSize > LOG_BUFFER_MAX_BYTES
    ) {
      const dropped = this.#buffers.shift();
      droppedBytes += dropped?.length || 0;
      this.#bufferedBytes -= dropped?.length || 0;
    }

    if (droppedBytes <= 0 || this.#dropNoticePending) return;

    const notice = Buffer.from(
      `[${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")}][warning][logger.ts<0,0>] 日志缓冲区已满，已丢弃 ${droppedBytes} 字节旧日志\n`,
    );
    while (
      this.#buffers.length > 0 &&
      this.#bufferedBytes + nextBufferSize + notice.length > LOG_BUFFER_MAX_BYTES
    ) {
      const dropped = this.#buffers.shift();
      this.#bufferedBytes -= dropped?.length || 0;
    }

    if (this.#bufferedBytes + nextBufferSize + notice.length <= LOG_BUFFER_MAX_BYTES) {
      this.#buffers.push(notice);
      this.#bufferedBytes += notice.length;
      this.#dropNoticePending = true;
    }
  }

  #snapshotBuffers() {
    if (!this.#buffers.length) return null;
    const snapshot = Buffer.concat(this.#buffers);
    this.#resetBufferState();
    return snapshot;
  }

  #schedule(delayMs) {
    if (isVercelEnv) return;
    if (this.#timer) {
      if (delayMs > 0) return;
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#drain();
    }, Math.max(0, delayMs));
    this.#timer.unref?.();
  }

  async #drain() {
    if (this.#writing) return;
    const snapshot = this.#snapshotBuffers();
    if (!snapshot?.length) {
      this.#schedule(config.system.logWriteInterval);
      return;
    }

    this.#writing = true;
    try {
      await this.write(snapshot);
    } catch (err) {
      console.error("Log write error:", err);
    } finally {
      this.#writing = false;
      this.#schedule(this.#buffers.length ? 0 : config.system.logWriteInterval);
    }
  }

  push(content) {
    if (isVercelEnv) return;
    let buffer = Buffer.from(content);
    if (buffer.length > LOG_BUFFER_MAX_BYTES) {
      buffer = buffer.subarray(buffer.length - LOG_BUFFER_MAX_BYTES);
    }
    this.#makeRoom(buffer.length);
    this.#buffers.push(buffer);
    this.#bufferedBytes += buffer.length;
    this.#schedule(
      this.#bufferedBytes >= Math.floor(LOG_BUFFER_MAX_BYTES / 2)
        ? 0
        : config.system.logWriteInterval,
    );
  }

  writeSync(buffer) {
    if (isVercelEnv || !buffer?.length) return;
    fs.appendFileSync(this.#getLogFilePath(), buffer);
  }

  async write(buffer) {
    if (isVercelEnv || !buffer?.length) return;
    await fs.appendFile(this.#getLogFilePath(), buffer);
  }

  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const snapshot = this.#snapshotBuffers();
    if (!snapshot?.length) return;
    this.writeSync(snapshot);
  }

  destroy() {
    this.flush();
  }
}

class LogText {
  level;
  text;
  source;
  time = new Date();

  constructor(level, ...params) {
    this.level = level;
    this.text = _util.format.apply(null, params);
    this.source = LOG_CAPTURE_SOURCE ? this.#getStackTopCodeInfo() : createUnknownSource();
  }

  #getStackTopCodeInfo() {
    const unknownInfo = createUnknownSource();
    const stack = new Error().stack;
    if (!stack) return unknownInfo;
    const stackArray = stack.split("\n");
    const text = stackArray[4];
    if (!text) return unknownInfo;
    const match = text.match(/at (.+) \((.+)\)/) || text.match(/at (.+)/);
    if (!match || !_.isString(match[2] || match[1])) return unknownInfo;
    const temp = match[2] || match[1];
    const _match = temp.match(/([a-zA-Z0-9_\-\.]+)\:(\d+)\:(\d+)$/);
    if (!_match) return unknownInfo;
    const [, scriptPath, codeLine, codeColumn] = _match;
    return {
      name: scriptPath ? scriptPath.replace(/.js$/, "") : "unknown",
      path: scriptPath || null,
      codeLine: parseInt(codeLine || "0", 10),
      codeColumn: parseInt(codeColumn || "0", 10),
    };
  }

  toString() {
    return `[${dateFormat(this.time, "yyyy-MM-dd HH:mm:ss.SSS")}][${this.level}][${this.source.name}<${this.source.codeLine},${this.source.codeColumn}>] ${this.text}`;
  }
}

class Logger {
  config = {};
  static Level = {
    Success: "success",
    Info: "info",
    Log: "log",
    Debug: "debug",
    Warning: "warning",
    Error: "error",
    Fatal: "fatal",
  };
  static LevelColor = {
    [Logger.Level.Success]: "green",
    [Logger.Level.Info]: "brightCyan",
    [Logger.Level.Debug]: "white",
    [Logger.Level.Warning]: "brightYellow",
    [Logger.Level.Error]: "brightRed",
    [Logger.Level.Fatal]: "red",
  };
  static LevelPriority = {
    [Logger.Level.Fatal]: 1,
    [Logger.Level.Error]: 2,
    [Logger.Level.Warning]: 3,
    [Logger.Level.Success]: 4,
    [Logger.Level.Info]: 5,
    [Logger.Level.Log]: 6,
    [Logger.Level.Debug]: 7,
  };
  #writer;

  constructor() {
    this.#writer = new LogWriter();
  }

  #checkLevel(level) {
    const currentLevelPriority = Logger.LevelPriority[config.system.log_level] || 99;
    const levelPriority = Logger.LevelPriority[level];
    return levelPriority <= currentLevelPriority;
  }

  #write(level, consoleMethod, ...params) {
    if (!this.#checkLevel(level)) return;
    const content = new LogText(level, ...params).toString();
    consoleMethod(content[Logger.LevelColor[level]]);
    this.#writer.push(content + "\n");
  }

  header() {
    this.#writer.writeSync(
      Buffer.from(
        `\n\n===================== LOG START ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`,
      ),
    );
  }

  footer() {
    this.#writer.flush();
    this.#writer.writeSync(
      Buffer.from(
        `\n\n===================== LOG END ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`,
      ),
    );
  }

  success(...params) {
    this.#write(Logger.Level.Success, console.info, ...params);
  }

  info(...params) {
    this.#write(Logger.Level.Info, console.info, ...params);
  }

  debug(...params) {
    if (!config.system.debug) return;
    this.#write(Logger.Level.Debug, console.debug, ...params);
  }

  warn(...params) {
    this.#write(Logger.Level.Warning, console.warn, ...params);
  }

  error(...params) {
    this.#write(Logger.Level.Error, console.error, ...params);
  }

  destroy() {
    this.#writer.destroy();
  }

  destory() {
    this.destroy();
  }
}

export default new Logger();
