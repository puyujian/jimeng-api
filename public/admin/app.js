const state = {
  user: null,
  overview: null,
  accountsById: new Map(),
  keysById: new Map(),
  latestSecret: "",
  clearSessionOnSave: false,
};

const STATUS_LABELS = {
  healthy: "健康",
  blacklisted: "已拉黑",
  invalid: "已失效",
  insufficient_credit: "积分不足",
  error: "异常",
  valid: "有效",
  unknown: "未知",
};

const ABILITY_LABELS = {
  images: "图片",
  videos: "视频",
  chat: "Chat",
  token: "Token",
};

const refs = {
  loginView: document.getElementById("login-view"),
  appView: document.getElementById("app-view"),
  notice: document.getElementById("notice-banner"),
  loginForm: document.getElementById("login-form"),
  accountForm: document.getElementById("account-form"),
  accountImportForm: document.getElementById("account-import-form"),
  keyForm: document.getElementById("key-form"),
  passwordForm: document.getElementById("password-form"),
  accountsTableBody: document.getElementById("accounts-table-body"),
  keysTableBody: document.getElementById("keys-table-body"),
  metricsGrid: document.getElementById("metrics-grid"),
  userSummary: document.getElementById("user-summary"),
  issuedSecret: document.getElementById("issued-secret"),
  activityLog: document.getElementById("activity-log"),
  providerBadge: document.getElementById("provider-badge"),
  sessionTtlBadge: document.getElementById("session-ttl-badge"),
  accountHealthBadge: document.getElementById("account-health-badge"),
  keyPolicyBadge: document.getElementById("key-policy-badge"),
  overviewNote: document.getElementById("overview-note"),
};

function activateView(showElement, hideElement) {
  if (hideElement) {
    hideElement.classList.remove("is-visible");
    hideElement.hidden = true;
  }

  if (!showElement) return;
  showElement.hidden = false;
  requestAnimationFrame(() => {
    showElement.classList.add("is-visible");
  });
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function revealElement(element) {
  if (!element?.scrollIntoView) return;
  element.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
}

async function runWithButton(button, pendingText, task) {
  const target = button || null;
  const originalText = target?.dataset.originalLabel || target?.textContent || "";

  if (target) {
    target.dataset.originalLabel = originalText;
    target.disabled = true;
    target.textContent = pendingText;
  }

  try {
    return await task();
  } finally {
    if (target) {
      target.disabled = false;
      target.textContent = target.dataset.originalLabel || originalText;
    }
  }
}

async function copyText(value, successMessage = "已复制到剪贴板") {
  const text = String(value || "").trim();
  if (!text) throw new Error("没有可复制的内容");

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  setNotice(successMessage, "ok");
}

function setNotice(message, kind = "") {
  if (!message) {
    refs.notice.hidden = true;
    refs.notice.textContent = "";
    delete refs.notice.dataset.kind;
    return;
  }
  refs.notice.hidden = false;
  refs.notice.textContent = message;
  if (kind) {
    refs.notice.dataset.kind = kind;
  } else {
    delete refs.notice.dataset.kind;
  }
}

function appendLog(title, detail) {
  const content = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
  refs.activityLog.textContent = `[${new Date().toLocaleString()}] ${title}\n${content}\n\n${refs.activityLog.textContent}`;
}

function showLogin() {
  activateView(refs.loginView, refs.appView);
}

function showApp() {
  activateView(refs.appView, refs.loginView);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusLabel(status, blacklisted = false) {
  const normalized = blacklisted ? "blacklisted" : status || "unknown";
  return STATUS_LABELS[normalized] || normalized;
}

function statusPill(status, blacklisted) {
  const normalized = blacklisted ? "blacklisted" : status || "unknown";
  const kind =
    normalized === "healthy"
      ? "ok"
      : ["blacklisted", "invalid", "insufficient_credit", "error"].includes(normalized)
        ? "danger"
        : "warn";
  return `<span class="pill ${kind}">${escapeHtml(statusLabel(normalized, blacklisted))}</span>`;
}

function abilityLabels(abilities) {
  const items = abilities || [];
  if (!items.length) {
    return '<span class="pill">未限制</span>';
  }
  return items
    .map((item) => `<span class="pill">${escapeHtml(ABILITY_LABELS[item] || item)}</span>`)
    .join(" ");
}

function collectAbilities() {
  return Array.from(document.querySelectorAll('input[name="ability"]:checked')).map((input) => input.value);
}

function emptyTableRow(colspan, message) {
  return `
    <tr>
      <td colspan="${colspan}">
        <div class="table-subline">${escapeHtml(message)}</div>
      </td>
    </tr>
  `;
}

function clampProgress(value) {
  if (!Number.isFinite(value) || value <= 0) return "8%";
  return `${Math.max(8, Math.min(100, Math.round(value * 100)))}%`;
}

function apiFetch(url, options = {}) {
  const config = {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    credentials: "same-origin",
    body: options.body,
  };

  return fetch(url, config).then(async (response) => {
    let payload = null;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { message: text };
    }

    if (!response.ok) {
      const message =
        payload?.message ||
        payload?.error ||
        payload?.data?.message ||
        `${response.status} ${response.statusText}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  });
}

function resetAccountForm() {
  document.getElementById("account-id").value = "";
  document.getElementById("account-email").value = "";
  document.getElementById("account-password").value = "";
  document.getElementById("account-session-id").value = "";
  document.getElementById("account-proxy").value = "";
  document.getElementById("account-max-concurrency").value = "2";
  document.getElementById("account-enabled").checked = true;
  document.getElementById("account-auto-refresh").checked = true;
  document.getElementById("account-notes").value = "";
  state.clearSessionOnSave = false;
}

function fillAccountForm(item) {
  document.getElementById("account-id").value = item.id;
  document.getElementById("account-email").value = item.email || "";
  document.getElementById("account-password").value = "";
  document.getElementById("account-session-id").value = "";
  document.getElementById("account-proxy").value = item.proxy || "";
  document.getElementById("account-max-concurrency").value = String(item.maxConcurrency || 2);
  document.getElementById("account-enabled").checked = Boolean(item.enabled);
  document.getElementById("account-auto-refresh").checked = Boolean(item.autoRefresh);
  document.getElementById("account-notes").value = item.notes || "";
  state.clearSessionOnSave = false;
}

function resetKeyForm() {
  document.getElementById("key-id").value = "";
  document.getElementById("key-name").value = "";
  document.getElementById("key-description").value = "";
  document.getElementById("key-enabled").checked = true;
  document.querySelectorAll('input[name="ability"]').forEach((checkbox) => {
    checkbox.checked = ["images", "videos", "chat"].includes(checkbox.value);
  });
}

function fillKeyForm(item) {
  document.getElementById("key-id").value = item.id;
  document.getElementById("key-name").value = item.name || "";
  document.getElementById("key-description").value = item.description || "";
  document.getElementById("key-enabled").checked = Boolean(item.enabled);
  document.querySelectorAll('input[name="ability"]').forEach((checkbox) => {
    checkbox.checked = (item.allowedAbilities || []).includes(checkbox.value);
  });
}

function renderMetrics(overview) {
  const counts = overview.counts || {};
  const accountsTotal = Number(counts.accounts || 0);
  const healthy = Number(counts.healthy || 0);
  const withSession = Number(counts.withSession || 0);
  const blacklisted = Number(counts.blacklisted || 0);
  const activeLeases = Number(counts.activeLeases || 0);
  const totalCapacity =
    (overview.accounts || []).reduce((sum, item) => sum + Number(item.maxConcurrency || 0), 0) || 0;

  const metrics = [
    {
      label: "账号总数",
      value: accountsTotal,
      helper: accountsTotal ? "已纳入调度的全部账号" : "还没有录入账号",
      tone: "",
      progress: accountsTotal ? 1 : 0,
    },
    {
      label: "健康账号",
      value: healthy,
      helper: accountsTotal ? `占总账号 ${Math.round((healthy / accountsTotal) * 100)}%` : "等待接入账号",
      tone: "ok",
      progress: accountsTotal ? healthy / accountsTotal : 0,
    },
    {
      label: "可用 Session",
      value: withSession,
      helper: accountsTotal ? `占总账号 ${Math.round((withSession / accountsTotal) * 100)}%` : "暂无可用 Session",
      tone: "ok",
      progress: accountsTotal ? withSession / accountsTotal : 0,
    },
    {
      label: "黑名单",
      value: blacklisted,
      helper: blacklisted ? "这些账号不会再参与调度" : "当前没有被拉黑账号",
      tone: blacklisted ? "danger" : "",
      progress: accountsTotal ? blacklisted / accountsTotal : 0,
    },
    {
      label: "活跃租约",
      value: activeLeases,
      helper: totalCapacity ? `已占用并发 ${activeLeases} / ${totalCapacity}` : "暂无并发承载",
      tone: activeLeases ? "warn" : "",
      progress: totalCapacity ? activeLeases / totalCapacity : 0,
    },
  ];

  refs.metricsGrid.innerHTML = metrics
    .map(
      (item, index) => `
        <article class="metric-card motion-item" style="--item-index:${index}" ${
          item.tone ? `data-tone="${item.tone}"` : ""
        }>
          <span class="muted">${escapeHtml(item.label)}</span>
          <div class="metric-meta">
            <strong>${escapeHtml(item.value)}</strong>
          </div>
          <div class="metric-progress"><span style="width:${clampProgress(item.progress)}"></span></div>
          <p class="metric-helper">${escapeHtml(item.helper)}</p>
        </article>
      `
    )
    .join("");
}

function renderOverviewSignals(overview) {
  const counts = overview.counts || {};
  const accountsTotal = Number(counts.accounts || 0);
  const healthy = Number(counts.healthy || 0);
  const blacklisted = Number(counts.blacklisted || 0);
  const enabledKeys = (overview.apiKeys || []).filter((item) => item.enabled).length;
  const totalKeys = (overview.apiKeys || []).length;
  const provider = String(overview.loginProvider || "未配置").replaceAll("_", " ");
  const ttlMinutes = Number(overview.settings?.sessionTtlMinutes || 0);

  refs.providerBadge.textContent = provider;
  refs.sessionTtlBadge.textContent = ttlMinutes ? `${ttlMinutes} 分钟` : "未配置";
  refs.accountHealthBadge.textContent = accountsTotal ? `${healthy}/${accountsTotal} 健康` : "暂无账号";
  refs.keyPolicyBadge.textContent = totalKeys ? `${enabledKeys}/${totalKeys} 启用` : "暂无 Key";

  refs.overviewNote.textContent = accountsTotal
    ? `当前共有 ${accountsTotal} 个账号在池中，其中 ${healthy} 个健康，${blacklisted} 个被拉黑。${
        ttlMinutes ? `管理员会话 TTL 为 ${ttlMinutes} 分钟。` : ""
      }`
    : "当前还没有账号，建议先在左侧创建单个账号，或使用批量导入把号池灌入系统。";
}

function renderAccounts(accounts) {
  state.accountsById = new Map(accounts.map((item) => [item.id, item]));
  if (!accounts.length) {
    refs.accountsTableBody.innerHTML = emptyTableRow(6, "暂无账号，先通过上方表单创建，或用批量导入灌入账号池。");
    return;
  }

  refs.accountsTableBody.innerHTML = accounts
    .map(
      (item, index) => `
        <tr class="motion-item" style="--item-index:${index}">
          <td data-label="状态">${statusPill(item.status, item.blacklisted)}</td>
          <td data-label="邮箱">
            <strong class="table-title">${escapeHtml(item.email)}</strong>
            <div class="pill-row">
              <span class="pill ${item.enabled ? "ok" : "warn"}">${item.enabled ? "启用" : "停用"}</span>
              <span class="pill">${item.autoRefresh ? "自动续期" : "手动续期"}</span>
            </div>
            <div class="table-subline">${escapeHtml(item.notes || "无备注")}</div>
            <div class="table-subline">${escapeHtml(item.proxyPreview ? `代理: ${item.proxyPreview}` : "代理: 直连")}</div>
          </td>
          <td class="table-stat" data-label="Session">
            <strong class="mono">${escapeHtml(item.sessionIdPreview || "—")}</strong>
            <div class="table-subline">刷新: ${escapeHtml(formatTime(item.sessionUpdatedAt))}</div>
          </td>
          <td class="table-stat" data-label="并发">
            <strong>${escapeHtml(item.activeLeases)} / ${escapeHtml(item.maxConcurrency)}</strong>
            <div class="table-subline">验证: ${escapeHtml(statusLabel(item.lastValidationStatus || "unknown"))}</div>
          </td>
          <td class="table-stat" data-label="使用 / 错误">
            <strong>成功 ${escapeHtml(item.successCount)} / 失败 ${escapeHtml(item.failureCount)}</strong>
            <div class="table-subline">${escapeHtml(item.lastError || item.blacklistedReason || "无异常")}</div>
          </td>
          <td data-label="操作">
            <div class="table-actions">
              <button class="ghost-btn" data-action="edit-account" data-id="${escapeHtml(item.id)}">编辑</button>
              <button class="ghost-btn" data-action="refresh-account" data-id="${escapeHtml(item.id)}">刷新</button>
              <button class="ghost-btn" data-action="validate-account" data-id="${escapeHtml(item.id)}">校验</button>
              ${
                item.blacklisted
                  ? `<button class="ghost-btn" data-action="unblacklist-account" data-id="${escapeHtml(item.id)}">解除拉黑</button>`
                  : `<button class="ghost-btn" data-action="blacklist-account" data-id="${escapeHtml(item.id)}">拉黑</button>`
              }
              <button class="ghost-btn" data-action="delete-account" data-id="${escapeHtml(item.id)}">删除</button>
            </div>
          </td>
        </tr>
      `
    )
    .join("");
}

function renderKeys(keys) {
  state.keysById = new Map(keys.map((item) => [item.id, item]));
  if (!keys.length) {
    refs.keysTableBody.innerHTML = emptyTableRow(5, "暂无 API Key，建议先创建一个调用方密钥并限制它的能力范围。");
    return;
  }

  refs.keysTableBody.innerHTML = keys
    .map(
      (item, index) => `
        <tr class="motion-item" style="--item-index:${index}">
          <td data-label="名称">
            <strong class="table-title">${escapeHtml(item.name)}</strong>
            <div class="pill-row">
              <span class="pill ${item.enabled ? "ok" : "warn"}">${item.enabled ? "启用" : "停用"}</span>
            </div>
            <div class="table-subline">${escapeHtml(item.description || "无描述")}</div>
          </td>
          <td data-label="完整密钥">
            <div class="inline-secret">${escapeHtml(
              item.rawKey ||
                (item.rawKeyLocked ? "当前实例无法解密该密钥" : "旧密钥尚未保存原文，请先使用或重置")
            )}</div>
            <div class="table-subline">${escapeHtml(item.keyPreview)}</div>
          </td>
          <td data-label="能力"><div class="pill-row">${abilityLabels(item.allowedAbilities)}</div></td>
          <td data-label="最近使用">${escapeHtml(formatTime(item.lastUsedAt))}</td>
          <td data-label="操作">
            <div class="table-actions">
              ${
                item.rawKey
                  ? `<button class="ghost-btn" data-action="copy-key" data-id="${escapeHtml(item.id)}">复制</button>`
                  : ""
              }
              <button class="ghost-btn" data-action="edit-key" data-id="${escapeHtml(item.id)}">编辑</button>
              <button class="ghost-btn" data-action="rotate-key" data-id="${escapeHtml(item.id)}">重置</button>
              <button class="ghost-btn" data-action="delete-key" data-id="${escapeHtml(item.id)}">删除</button>
            </div>
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadOverview() {
  const overview = await apiFetch("/api/admin/overview");
  state.overview = overview;
  state.user = overview.user;
  refs.userSummary.textContent = `当前登录: ${overview.user.username} | 登录提供方: ${overview.loginProvider} | Session TTL: ${overview.settings.sessionTtlMinutes} 分钟`;
  renderMetrics(overview);
  renderOverviewSignals(overview);
  renderAccounts(overview.accounts || []);
  renderKeys(overview.apiKeys || []);
}

function setLatestSecret(secret) {
  state.latestSecret = secret || "";
  refs.issuedSecret.textContent = state.latestSecret || "暂无新密钥";
}

async function bootstrap() {
  try {
    const auth = await apiFetch("/api/admin/auth/me");
    state.user = auth.user;
    showApp();
    await loadOverview();
  } catch {
    showLogin();
  }
}

refs.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter || refs.loginForm.querySelector('button[type="submit"]');

  try {
    await runWithButton(submitter, "登录中...", async () => {
      await apiFetch("/api/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("login-username").value.trim(),
          password: document.getElementById("login-password").value,
        }),
      });
    });
    showApp();
    setNotice("登录成功", "ok");
    refs.loginForm.reset();
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter || refs.accountForm.querySelector('button[type="submit"]');
  const accountId = document.getElementById("account-id").value;
  const payload = {
    email: document.getElementById("account-email").value.trim(),
    password: document.getElementById("account-password").value,
    sessionId: document.getElementById("account-session-id").value.trim(),
    proxy: document.getElementById("account-proxy").value.trim(),
    maxConcurrency: Number(document.getElementById("account-max-concurrency").value || 2),
    enabled: document.getElementById("account-enabled").checked,
    autoRefresh: document.getElementById("account-auto-refresh").checked,
    notes: document.getElementById("account-notes").value.trim(),
    clearSession: state.clearSessionOnSave,
  };

  try {
    await runWithButton(submitter, accountId ? "更新中..." : "创建中...", async () => {
      await apiFetch(accountId ? `/api/admin/accounts/${accountId}` : "/api/admin/accounts", {
        method: accountId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    });
    setNotice(accountId ? "账号已更新" : "账号已创建", "ok");
    appendLog(accountId ? "更新账号" : "创建账号", payload);
    resetAccountForm();
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter || refs.accountImportForm.querySelector('button[type="submit"]');
  const payload = {
    text: document.getElementById("account-import-text").value,
    defaultProxy: document.getElementById("account-import-default-proxy").value.trim(),
    maxConcurrency: Number(document.getElementById("account-import-max-concurrency").value || 2),
    enabled: document.getElementById("account-import-enabled").checked,
    autoRefresh: document.getElementById("account-import-auto-refresh").checked,
    overwriteExisting: document.getElementById("account-import-overwrite").checked,
  };

  try {
    const result = await runWithButton(submitter, "导入中...", async () =>
      apiFetch("/api/admin/accounts/import", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    );

    appendLog("批量导入账号", result);
    setNotice(
      `批量导入完成：新增 ${result.createdCount}，更新 ${result.updatedCount}，跳过 ${result.skippedCount}，失败 ${result.failedCount}`,
      result.failedCount ? "warn" : "ok"
    );
    if (!result.failedCount) {
      document.getElementById("account-import-text").value = "";
    }
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter || refs.keyForm.querySelector('button[type="submit"]');
  const keyId = document.getElementById("key-id").value;
  const payload = {
    name: document.getElementById("key-name").value.trim(),
    description: document.getElementById("key-description").value.trim(),
    enabled: document.getElementById("key-enabled").checked,
    allowedAbilities: collectAbilities(),
  };

  try {
    const result = await runWithButton(submitter, keyId ? "更新中..." : "创建中...", async () =>
      apiFetch(keyId ? `/api/admin/api-keys/${keyId}` : "/api/admin/api-keys", {
        method: keyId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      })
    );

    if (result?.rawKey) {
      setLatestSecret(result.rawKey);
      appendLog("创建 API Key", result.apiKey);
    } else {
      appendLog("更新 API Key", result.item);
    }
    setNotice(keyId ? "API Key 已更新" : "API Key 已创建", "ok");
    resetKeyForm();
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter || refs.passwordForm.querySelector('button[type="submit"]');

  try {
    await runWithButton(submitter, "更新中...", async () => {
      await apiFetch("/api/admin/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: document.getElementById("current-password").value,
          nextPassword: document.getElementById("next-password").value,
        }),
      });
    });
    refs.passwordForm.reset();
    setNotice("管理员密码已更新", "ok");
    appendLog("修改管理员密码", "密码修改成功");
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

document.getElementById("reload-overview").addEventListener("click", async (event) => {
  try {
    await runWithButton(event.currentTarget, "刷新中...", async () => {
      await loadOverview();
    });
    setNotice("总览已刷新", "ok");
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

document.getElementById("logout-btn").addEventListener("click", async (event) => {
  try {
    await runWithButton(event.currentTarget, "退出中...", async () => {
      await apiFetch("/api/admin/auth/logout", { method: "POST" });
    });
    showLogin();
    state.user = null;
    setNotice("已退出登录", "ok");
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

document.getElementById("reset-account-form").addEventListener("click", () => {
  resetAccountForm();
  revealElement(refs.accountForm);
  setNotice("已切换到新建账号表单");
});

document.getElementById("reset-key-form").addEventListener("click", () => {
  resetKeyForm();
  revealElement(refs.keyForm);
  setNotice("已切换到新建 API Key 表单");
});

document.getElementById("clear-account-session").addEventListener("click", () => {
  document.getElementById("account-session-id").value = "";
  state.clearSessionOnSave = true;
  setNotice("已标记为清空 Session，保存后生效", "warn");
});

document.getElementById("copy-secret").addEventListener("click", async (event) => {
  try {
    await runWithButton(event.currentTarget, "复制中...", async () => {
      await copyText(state.latestSecret, "已复制最近签发的 API Key");
    });
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountsTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  const item = state.accountsById.get(id);
  if (!item) return;

  try {
    if (action === "edit-account") {
      fillAccountForm(item);
      revealElement(refs.accountForm);
      setNotice(`正在编辑账号 ${item.email}`);
      return;
    }

    if (action === "refresh-account") {
      const result = await runWithButton(button, "刷新中...", async () =>
        apiFetch(`/api/admin/accounts/${id}/refresh-session`, { method: "POST" })
      );
      appendLog(`刷新账号 ${item.email}`, result.logs || result);
      setNotice(`账号 ${item.email} Session 已刷新`, "ok");
      await loadOverview();
      return;
    }

    if (action === "validate-account") {
      const result = await runWithButton(button, "校验中...", async () =>
        apiFetch(`/api/admin/accounts/${id}/validate-session`, { method: "POST" })
      );
      appendLog(`校验账号 ${item.email}`, result);
      setNotice(result.valid ? `账号 ${item.email} Session 有效` : result.reason, result.valid ? "ok" : "danger");
      await loadOverview();
      return;
    }

    if (action === "blacklist-account") {
      const reason = window.prompt("请输入拉黑原因", item.lastError || "手动拉黑");
      if (reason === null) return;
      await runWithButton(button, "拉黑中...", async () => {
        await apiFetch(`/api/admin/accounts/${id}/blacklist`, {
          method: "POST",
          body: JSON.stringify({ reason }),
        });
      });
      appendLog(`拉黑账号 ${item.email}`, reason);
      setNotice(`账号 ${item.email} 已拉黑`, "warn");
      await loadOverview();
      return;
    }

    if (action === "unblacklist-account") {
      await runWithButton(button, "恢复中...", async () => {
        await apiFetch(`/api/admin/accounts/${id}/unblacklist`, { method: "POST" });
      });
      appendLog(`解除拉黑 ${item.email}`, "已恢复为可调度状态");
      setNotice(`账号 ${item.email} 已解除拉黑`, "ok");
      await loadOverview();
      return;
    }

    if (action === "delete-account") {
      if (!window.confirm(`确认删除账号 ${item.email} 吗？`)) return;
      await runWithButton(button, "删除中...", async () => {
        await apiFetch(`/api/admin/accounts/${id}`, { method: "DELETE" });
      });
      appendLog(`删除账号 ${item.email}`, "账号已删除");
      setNotice(`账号 ${item.email} 已删除`, "warn");
      resetAccountForm();
      await loadOverview();
    }
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.keysTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  const item = state.keysById.get(id);
  if (!item) return;

  try {
    if (action === "copy-key") {
      await runWithButton(button, "复制中...", async () => {
        await copyText(item.rawKey, `已复制 API Key ${item.name}`);
      });
      return;
    }

    if (action === "edit-key") {
      fillKeyForm(item);
      revealElement(refs.keyForm);
      setNotice(`正在编辑 API Key ${item.name}`);
      return;
    }

    if (action === "rotate-key") {
      if (!window.confirm(`确认重置 API Key ${item.name} 吗？旧密钥会立刻失效。`)) return;
      const result = await runWithButton(button, "重置中...", async () =>
        apiFetch(`/api/admin/api-keys/${id}/rotate`, { method: "POST" })
      );
      setLatestSecret(result.rawKey);
      appendLog(`重置 API Key ${item.name}`, result.apiKey);
      setNotice(`API Key ${item.name} 已重置`, "warn");
      await loadOverview();
      return;
    }

    if (action === "delete-key") {
      if (!window.confirm(`确认删除 API Key ${item.name} 吗？`)) return;
      await runWithButton(button, "删除中...", async () => {
        await apiFetch(`/api/admin/api-keys/${id}`, { method: "DELETE" });
      });
      appendLog(`删除 API Key ${item.name}`, "API Key 已删除");
      setNotice(`API Key ${item.name} 已删除`, "warn");
      resetKeyForm();
      await loadOverview();
    }
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

resetAccountForm();
resetKeyForm();
bootstrap();
