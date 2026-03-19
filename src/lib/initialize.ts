import logger from "./logger.js";
import { haochiStateStore } from "@/haochi/index.ts";

process.setMaxListeners(Number(process.env.JIMENG_MAX_LISTENERS || 50));
// 输出未捕获异常
process.on("uncaughtException", (err, origin) => {
  logger.error(`An unhandled error occurred: ${origin}`, err);
});
// 输出未处理的Promise.reject
process.on("unhandledRejection", (_, promise) => {
  promise.catch((err) => logger.error("An unhandled rejection occurred:", err));
});
// 输出系统警告信息
process.on("warning", (warning) => logger.warn("System warning: ", warning));
// 进程退出监听
process.on("exit", () => {
  haochiStateStore.flushSync();
  logger.info("Service exit");
  logger.footer();
});
// 进程被kill
process.on("SIGTERM", () => {
  logger.warn("received kill signal");
  process.exit(2);
});
// Ctrl-C进程退出
process.on("SIGINT", () => {
  process.exit(0);
});
