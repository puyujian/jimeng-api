import logger from "@/lib/logger.ts";
import { STATUS_CODE_MAP, POLLING_CONFIG } from "@/api/consts/common.ts";
import { handlePollingTimeout, handleGenerationFailure } from "@/lib/error-handler.ts";
import { abortableDelay, isAbortError, throwIfAborted } from "@/lib/abort.ts";

const SMART_POLLER_VERBOSE = process.env.JIMENG_SMART_POLLER_VERBOSE === "1";
const SMART_POLLER_PROGRESS_LOG_INTERVAL_SECONDS = Math.max(
  30,
  Number(process.env.JIMENG_SMART_POLLER_PROGRESS_LOG_INTERVAL_SECONDS || 60) || 60,
);

export interface PollingStatus {
  status: number;
  failCode?: string;
  itemCount: number;
  finishTime?: number;
  historyId?: string;
}

export interface PollingOptions {
  maxPollCount?: number;
  pollInterval?: number;
  stableRounds?: number;
  timeoutSeconds?: number;
  expectedItemCount?: number;
  type?: "image" | "video";
  signal?: AbortSignal;
}

export interface PollingResult {
  status: number;
  failCode?: string;
  itemCount: number;
  elapsedTime: number;
  pollCount: number;
  exitReason: string;
}

export class SmartPoller {
  private pollCount = 0;
  private startTime = Date.now();
  private lastItemCount = 0;
  private stableItemCountRounds = 0;
  private lastLoggedStatusKey = "";
  private lastProgressLoggedAt = 0;
  private options: Required<Omit<PollingOptions, "signal">> & { signal?: AbortSignal };

  constructor(options: PollingOptions = {}) {
    this.options = {
      maxPollCount: options.maxPollCount ?? POLLING_CONFIG.MAX_POLL_COUNT,
      pollInterval: options.pollInterval ?? POLLING_CONFIG.POLL_INTERVAL,
      stableRounds: options.stableRounds ?? POLLING_CONFIG.STABLE_ROUNDS,
      timeoutSeconds: options.timeoutSeconds ?? POLLING_CONFIG.TIMEOUT_SECONDS,
      expectedItemCount: options.expectedItemCount ?? 4,
      type: options.type ?? "image",
      signal: options.signal,
    };
  }

  private getStatusName(status: number): string {
    return STATUS_CODE_MAP[status] || `UNKNOWN(${status})`;
  }

  private getSmartInterval(status: number): number {
    const baseInterval = this.options.pollInterval;

    switch (status) {
      case 20:
        return baseInterval;
      case 42:
        return baseInterval * 1.2;
      case 45:
        return baseInterval * 1.5;
      case 50:
        return baseInterval * 0.5;
      case 10:
      case 30:
        return 0;
      default:
        return baseInterval;
    }
  }

  private shouldExitPolling(pollingStatus: PollingStatus): { shouldExit: boolean; reason: string } {
    const { status, itemCount } = pollingStatus;
    const elapsedTime = Math.round((Date.now() - this.startTime) / 1000);

    if (itemCount === this.lastItemCount) {
      this.stableItemCountRounds++;
    } else {
      this.stableItemCountRounds = 0;
      this.lastItemCount = itemCount;
    }

    if (status === 10 || status === 50) {
      return { shouldExit: true, reason: "任务成功完成" };
    }

    if (status === 30) {
      return { shouldExit: true, reason: "任务失败" };
    }

    if (itemCount >= this.options.expectedItemCount && (status === 10 || status === 50)) {
      return {
        shouldExit: true,
        reason: `已获得完整结果集(${itemCount}/${this.options.expectedItemCount})`,
      };
    }

    if (this.stableItemCountRounds >= this.options.stableRounds && itemCount > 0) {
      return { shouldExit: true, reason: `结果数量稳定(${this.stableItemCountRounds}轮)` };
    }

    if (this.pollCount >= this.options.maxPollCount) {
      return { shouldExit: true, reason: "轮询次数超限" };
    }

    if (elapsedTime >= this.options.timeoutSeconds && itemCount > 0) {
      return { shouldExit: true, reason: "时间超限但已有结果" };
    }

    return { shouldExit: false, reason: "" };
  }

  private logPollProgress(status: PollingStatus, elapsedTime: number) {
    const statusName = this.getStatusName(status.status);
    const statusKey = [
      status.status,
      status.failCode || "",
      status.itemCount,
      status.finishTime || 0,
      this.stableItemCountRounds,
    ].join(":");

    if (SMART_POLLER_VERBOSE) {
      logger.debug(
        `轮询 ${this.pollCount}/${this.options.maxPollCount}: status=${status.status}(${statusName}), failCode=${status.failCode || "none"}, items=${status.itemCount}, elapsed=${elapsedTime}s, finish_time=${status.finishTime || 0}, stable=${this.stableItemCountRounds}/${this.options.stableRounds}`,
      );
      return;
    }

    if (status.itemCount > 0 && status.itemCount !== this.lastItemCount) {
      logger.info(
        `检测到${this.options.type === "image" ? "图片" : "视频"}生成: 数量=${status.itemCount}, 状态=${statusName}`,
      );
    }

    const now = Date.now();
    const shouldLog =
      statusKey !== this.lastLoggedStatusKey ||
      now - this.lastProgressLoggedAt >=
        SMART_POLLER_PROGRESS_LOG_INTERVAL_SECONDS * 1000;

    if (!shouldLog) return;

    this.lastLoggedStatusKey = statusKey;
    this.lastProgressLoggedAt = now;
    logger.info(
      `${this.options.type === "image" ? "图像" : "视频"}轮询进度: 第 ${this.pollCount}/${this.options.maxPollCount} 次, 状态=${statusName}, 结果=${status.itemCount}, 已等待=${elapsedTime}s`,
    );
  }

  async poll<T>(
    pollFunction: () => Promise<{ status: PollingStatus; data: T }>,
    historyId?: string,
  ): Promise<{ result: PollingResult; data: T }> {
    throwIfAborted(this.options.signal, "轮询已取消");
    logger.info(
      `开始智能轮询: historyId=${historyId || "N/A"}, 最大轮询次数=${this.options.maxPollCount}, 期望结果数=${this.options.expectedItemCount}`,
    );

    let lastData: T;
    let lastStatus: PollingStatus = { status: 20, itemCount: 0 };

    while (true) {
      throwIfAborted(this.options.signal, "轮询已取消");
      this.pollCount++;
      const elapsedTime = Math.round((Date.now() - this.startTime) / 1000);

      try {
        const { status, data } = await pollFunction();
        lastStatus = status;
        lastData = data;

        const { shouldExit, reason } = this.shouldExitPolling(status);

        if (shouldExit) {
          logger.info(
            `退出轮询: ${reason}, 最终${this.options.type === "image" ? "图片" : "视频"}数量=${status.itemCount}`,
          );

          if (status.status === 30) {
            handleGenerationFailure(
              status.status,
              status.failCode,
              historyId,
              this.options.type,
              status.itemCount,
            );
          }

          if (reason === "轮询次数超限" || reason === "时间超限但已有结果") {
            handlePollingTimeout(
              this.pollCount,
              this.options.maxPollCount,
              elapsedTime,
              status.status,
              status.itemCount,
              historyId,
            );
          }

          break;
        }

        if (![20, 42, 45, 10, 30, 50].includes(status.status)) {
          logger.warn(
            `检测到未知状态码 ${status.status}(${this.getStatusName(status.status)})，继续轮询等待生成...`,
          );
        }

        this.logPollProgress(status, elapsedTime);

        const nextInterval = this.getSmartInterval(status.status);
        if (nextInterval > 0) {
          await abortableDelay(nextInterval, this.options.signal, "轮询等待已取消");
        }
      } catch (error: any) {
        if (isAbortError(error) || this.options.signal?.aborted) {
          throw error;
        }

        const retryableErrorCodes = [
          "ECONNABORTED",
          "ETIMEDOUT",
          "ECONNRESET",
          "ENOTFOUND",
          "ECONNREFUSED",
          "EAI_AGAIN",
          "EPIPE",
          "ENETUNREACH",
          "EHOSTUNREACH",
        ];
        const errorMessage = String(error?.message || "");
        const isRetryableError =
          retryableErrorCodes.includes(error?.code) ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("network") ||
          errorMessage.includes("ECONNRESET") ||
          errorMessage.includes("socket hang up") ||
          errorMessage.includes("Proxy connection");

        if (isRetryableError && this.pollCount < this.options.maxPollCount) {
          logger.warn(
            `轮询过程中发生网络错误 (${error?.code || errorMessage})，等待后继续轮询...`,
          );
          await abortableDelay(
            this.options.pollInterval,
            this.options.signal,
            "轮询重试等待已取消",
          );
          continue;
        }

        logger.error(`轮询过程中发生不可恢复的错误: ${errorMessage}`);
        throw error;
      }
    }

    const finalElapsedTime = Math.round((Date.now() - this.startTime) / 1000);

    const result: PollingResult = {
      status: lastStatus.status,
      failCode: lastStatus.failCode,
      itemCount: lastStatus.itemCount,
      elapsedTime: finalElapsedTime,
      pollCount: this.pollCount,
      exitReason: this.shouldExitPolling(lastStatus).reason,
    };

    logger.info(
      `${this.options.type === "image" ? "图像" : "视频"}生成完成: 成功生成 ${lastStatus.itemCount} 个结果，总耗时 ${finalElapsedTime} 秒，最终状态: ${this.getStatusName(lastStatus.status)}`,
    );

    return { result, data: lastData! };
  }
}
