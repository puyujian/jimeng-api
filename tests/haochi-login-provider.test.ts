import test from "node:test";
import assert from "node:assert/strict";

import { resolveRefreshedRegionPrefix } from "../src/haochi/services/login-provider.ts";

test("自动刷新默认保留账号原有区域前缀，而不是被页面检测结果覆盖", () => {
  const resolved = resolveRefreshedRegionPrefix({
    originalRegionPrefix: "jp-",
    detectedRegionPrefix: "us-",
  });

  assert.equal(resolved.finalRegionPrefix, "jp-");
  assert.equal(resolved.originalRegionPrefix, "jp-");
  assert.equal(resolved.detectedRegionPrefix, "us-");
  assert.equal(resolved.preservedOriginal, true);
});

test("当账号原来没有区域前缀时，自动刷新使用页面检测结果", () => {
  const resolved = resolveRefreshedRegionPrefix({
    originalRegionPrefix: "",
    detectedRegionPrefix: "us-",
  });

  assert.equal(resolved.finalRegionPrefix, "us-");
  assert.equal(resolved.preservedOriginal, false);
});

test("环境变量强制区域前缀时优先使用强制值", () => {
  const resolved = resolveRefreshedRegionPrefix({
    originalRegionPrefix: "jp-",
    detectedRegionPrefix: "us-",
    forcedRegionPrefix: "sg-",
  });

  assert.equal(resolved.finalRegionPrefix, "sg-");
  assert.equal(resolved.preservedOriginal, false);
});
