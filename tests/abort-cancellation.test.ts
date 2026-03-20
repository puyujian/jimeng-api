import assert from "node:assert/strict";
import test from "node:test";

import { request } from "../src/api/controllers/core.ts";
import { SmartPoller } from "../src/lib/smart-poller.ts";
import { createCompletionStream } from "../src/api/controllers/chat.ts";

test("request 在 signal 预先取消时直接退出", async () => {
  const controller = new AbortController();
  controller.abort(new Error("client disconnected"));

  await assert.rejects(
    () =>
      request("post", "/mweb/v1/get_history_by_ids", "test-sessionid", {
        signal: controller.signal,
        data: {
          history_ids: ["hist_test"],
        },
      }),
    (error: any) => {
      assert.equal(error?.code, "ECANCELED");
      assert.match(String(error?.message || ""), /client disconnected|请求已取消/);
      return true;
    },
  );
});

test("SmartPoller 在等待下一轮时响应取消", async () => {
  const controller = new AbortController();
  let pollCount = 0;

  const poller = new SmartPoller({
    maxPollCount: 5,
    pollInterval: 1000,
    expectedItemCount: 1,
    signal: controller.signal,
  });

  const pollingPromise = poller.poll(async () => {
    pollCount += 1;
    setTimeout(() => controller.abort(new Error("stream closed")), 20);
    return {
      status: {
        status: 20,
        itemCount: 0,
      },
      data: null,
    };
  });

  await assert.rejects(
    pollingPromise,
    (error: any) => {
      assert.equal(error?.code, "ECANCELED");
      assert.match(String(error?.message || ""), /stream closed|轮询已取消|请求已取消/);
      return true;
    },
  );

  assert.equal(pollCount, 1);
});

test("createCompletionStream 在 signal 预先取消时不启动后台任务", async () => {
  const controller = new AbortController();
  controller.abort(new Error("sse closed"));

  await assert.rejects(
    () =>
      createCompletionStream(
        [{ role: "user", content: "画一只猫" }],
        "test-sessionid",
        undefined,
        {},
        0,
        undefined,
        controller.signal,
      ),
    (error: any) => {
      assert.equal(error?.code, "ECANCELED");
      assert.match(String(error?.message || ""), /sse closed|流式生成已取消|请求已取消/);
      return true;
    },
  );
});
