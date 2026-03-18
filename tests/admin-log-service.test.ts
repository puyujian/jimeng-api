import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AdminLogService from "../src/haochi/services/admin-log-service.ts";
import config from "../src/lib/config.ts";

test("AdminLogService 会按任务聚合外呼日志，并保留失败原因和最新状态", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-log-service-"));
  const originalLogDir = config.system.logDir;
  const date = "2026-03-18";
  const logFile = path.join(tempDir, `${date}.log`);

  try {
    config.system.logDir = tempDir;
    fs.writeFileSync(
      logFile,
      [
        '[2026-03-18 21:00:00.000][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_1] -> POST https://mweb-api-sg.capcut.com/mweb/v1/aigc_draft/generate',
        '[2026-03-18 21:00:00.001][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_1] start={"groupId":"grp_alpha_submit","accountLabel":"alpha@example.com","ability":"images","requestMode":"pool","requestKind":"提交任务","attempt":0,"attemptLabel":"首次请求","generationStatus":"生成中"}',
        '[2026-03-18 21:00:01.250][error][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_1] xx POST https://mweb-api-sg.capcut.com/mweb/v1/aigc_draft/generate 1249ms code=ECONNRESET message=socket hang up',
        '[2026-03-18 21:00:01.251][error][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_1] end={"groupId":"grp_alpha_submit","accountLabel":"alpha@example.com","ability":"images","requestMode":"pool","requestKind":"提交任务","attempt":0,"attemptLabel":"首次请求","durationMs":1249,"resultStatus":"error","errorCode":"ECONNRESET","errorMessage":"socket hang up","generationStatus":"生成失败"}',
        '[2026-03-18 21:00:02.000][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_2] -> POST https://mweb-api-sg.capcut.com/mweb/v1/aigc_draft/generate',
        '[2026-03-18 21:00:02.001][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_2] start={"groupId":"grp_alpha_submit","accountLabel":"alpha@example.com","ability":"images","requestMode":"pool","requestKind":"提交任务","attempt":1,"attemptLabel":"第 1 次重试","generationStatus":"生成中"}',
        '[2026-03-18 21:00:03.500][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_2] <- POST https://mweb-api-sg.capcut.com/mweb/v1/aigc_draft/generate 200 OK 1499ms',
        '[2026-03-18 21:00:03.501][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_submit_2] end={"groupId":"grp_alpha_submit","accountLabel":"alpha@example.com","ability":"images","requestMode":"pool","requestKind":"提交任务","historyId":"hist_alpha","attempt":1,"attemptLabel":"第 1 次重试","durationMs":1499,"httpStatus":200,"httpStatusText":"OK","resultStatus":"success","generationStatus":"生成中"}',
        '[2026-03-18 21:00:05.000][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_poll] -> POST https://mweb-api-sg.capcut.com/mweb/v1/get_history_by_ids',
        '[2026-03-18 21:00:05.001][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_poll] start={"groupId":"grp_alpha_poll","accountLabel":"alpha@example.com","ability":"images","requestMode":"pool","requestKind":"轮询状态","historyId":"hist_alpha","attempt":0,"attemptLabel":"首次请求","generationStatus":"生成中"}',
        '[2026-03-18 21:00:05.900][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_poll] <- POST https://mweb-api-sg.capcut.com/mweb/v1/get_history_by_ids 200 OK 899ms',
        '[2026-03-18 21:00:05.901][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_alpha_poll] end={"groupId":"grp_alpha_poll","accountLabel":"alpha@example.com","ability":"images","requestMode":"pool","requestKind":"轮询状态","historyId":"hist_alpha","attempt":0,"attemptLabel":"首次请求","durationMs":899,"httpStatus":200,"httpStatusText":"OK","resultStatus":"success","generationStatus":"生成完成","generationStatusCode":50}',
        '[2026-03-18 21:00:06.000][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_submit] -> POST https://mweb-api-sg.capcut.com/mweb/v1/aigc_draft/generate',
        '[2026-03-18 21:00:06.001][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_submit] start={"groupId":"grp_beta_submit","accountLabel":"beta@example.com","ability":"videos","requestMode":"pool","requestKind":"提交任务","attempt":0,"attemptLabel":"首次请求","generationStatus":"生成中"}',
        '[2026-03-18 21:00:07.200][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_submit] <- POST https://mweb-api-sg.capcut.com/mweb/v1/aigc_draft/generate 200 OK 1199ms',
        '[2026-03-18 21:00:07.201][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_submit] end={"groupId":"grp_beta_submit","accountLabel":"beta@example.com","ability":"videos","requestMode":"pool","requestKind":"提交任务","historyId":"hist_beta","attempt":0,"attemptLabel":"首次请求","durationMs":1199,"httpStatus":200,"httpStatusText":"OK","resultStatus":"success","generationStatus":"生成中"}',
        '[2026-03-18 21:00:09.000][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_poll] -> POST https://mweb-api-sg.capcut.com/mweb/v1/get_history_by_ids',
        '[2026-03-18 21:00:09.001][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_poll] start={"groupId":"grp_beta_poll","accountLabel":"beta@example.com","ability":"videos","requestMode":"pool","requestKind":"轮询状态","historyId":"hist_beta","attempt":0,"attemptLabel":"首次请求","generationStatus":"生成中"}',
        '[2026-03-18 21:00:09.700][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_poll] <- POST https://mweb-api-sg.capcut.com/mweb/v1/get_history_by_ids 200 OK 699ms',
        '[2026-03-18 21:00:09.701][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_beta_poll] end={"groupId":"grp_beta_poll","accountLabel":"beta@example.com","ability":"videos","requestMode":"pool","requestKind":"轮询状态","historyId":"hist_beta","attempt":0,"attemptLabel":"首次请求","durationMs":699,"httpStatus":200,"httpStatusText":"OK","resultStatus":"error","generationStatus":"生成失败","generationStatusCode":30,"errorMessage":"额度不足"}',
        '[2026-03-18 21:00:10.000][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_gamma_test] -> GET http://127.0.0.1:38991/test?x=1',
        '[2026-03-18 21:00:10.031][info][outbound-request-log.ts<1,1>] [OUTBOUND][req_gamma_test] <- GET http://127.0.0.1:38991/test?x=1 200 OK 31ms',
      ].join("\n"),
      "utf8",
    );

    const service = new AdminLogService();
    const payload = service.getOutboundLogs({ date, limit: 10 });

    assert.equal(payload.available, true);
    assert.equal(payload.totalMatched, 2);
    assert.equal(payload.returnedCount, 2);
    assert(payload.entries.every((entry) => entry.requestKind === "提交任务" || entry.requestKind === "轮询状态"));
    assert.equal(payload.entries.some((entry) => entry.requestId === "req_gamma_test"), false);

    const [failedEntry, successEntry] = payload.entries;

    assert.equal(failedEntry.taskKey, "history:hist_beta");
    assert.equal(failedEntry.requestId, "req_beta_poll");
    assert.deepEqual(failedEntry.requestIds, ["req_beta_submit", "req_beta_poll"]);
    assert.equal(failedEntry.accountLabel, "beta@example.com");
    assert.equal(failedEntry.status, "error");
    assert.equal(failedEntry.statusLabel, "调用失败");
    assert.equal(failedEntry.generationStatus, "生成失败");
    assert.equal(failedEntry.errorMessage, "额度不足");
    assert.equal(failedEntry.historyId, "hist_beta");

    assert.equal(successEntry.taskKey, "history:hist_alpha");
    assert.equal(successEntry.requestId, "req_alpha_poll");
    assert.deepEqual(successEntry.requestIds, [
      "req_alpha_submit_1",
      "req_alpha_submit_2",
      "req_alpha_poll",
    ]);
    assert.equal(successEntry.accountLabel, "alpha@example.com");
    assert.equal(successEntry.attempt, 1);
    assert.equal(successEntry.attemptLabel, "第 1 次重试");
    assert.equal(successEntry.status, "success");
    assert.equal(successEntry.statusLabel, "调用成功");
    assert.equal(successEntry.generationStatus, "生成完成");
    assert.equal(successEntry.durationMs, 899);
    assert.equal(successEntry.httpStatus, 200);
    assert.equal(successEntry.historyId, "hist_alpha");
    assert.equal(successEntry.errorMessage, "");
    assert.match(successEntry.detailText, /req_alpha_submit_1/);
    assert.match(successEntry.detailText, /socket hang up/);
    assert.match(successEntry.detailText, /req_alpha_poll/);
  } finally {
    config.system.logDir = originalLogDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
