const state = {
  user: null,
  overview: null,
  accountsById: new Map(),
  keysById: new Map(),
  latestSecret: "",
  clearSessionOnSave: false,
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
};

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

function setNotice(message, kind = "info") {
  if (!message) {
    refs.notice.hidden = true;
    refs.notice.textContent = "";
    return;
  }
  refs.notice.hidden = false;
  refs.notice.textContent = message;
  refs.notice.dataset.kind = kind;
}

function appendLog(title, detail) {
  const content =
    typeof detail === "string"
      ? detail
      : JSON.stringify(detail, null, 2);
  refs.activityLog.textContent = `[${new Date().toLocaleString()}] ${title}\n${content}\n\n${refs.activityLog.textContent}`;
}

function showLogin() {
  refs.loginView.hidden = false;
  refs.appView.hidden = true;
}

function showApp() {
  refs.loginView.hidden = true;
  refs.appView.hidden = false;
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

function statusPill(status, blacklisted) {
  const normalized = blacklisted ? "blacklisted" : status;
  const kind =
    normalized === "healthy"
      ? "ok"
      : ["blacklisted", "invalid", "insufficient_credit", "error"].includes(normalized)
        ? "danger"
        : "warn";
  return `<span class="pill ${kind}">${escapeHtml(normalized)}</span>`;
}

function abilityLabels(abilities) {
  return (abilities || []).map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join(" ");
}

function collectAbilities() {
  return Array.from(document.querySelectorAll('input[name="ability"]:checked')).map(
    (input) => input.value
  );
}

async function apiFetch(url, options = {}) {
  const config = {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    credentials: "same-origin",
    body: options.body,
  };

  const response = await fetch(url, config);
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
  document.getElementById("account-enabled").checked = !!item.enabled;
  document.getElementById("account-auto-refresh").checked = !!item.autoRefresh;
  document.getElementById("account-notes").value = item.notes || "";
  state.clearSessionOnSave = false;
}

function resetKeyForm() {
  document.getElementById("key-id").value = "";
  document.getElementById("key-name").value = "";
  document.getElementById("key-description").value = "";
  document.getElementById("key-enabled").checked = true;
  document
    .querySelectorAll('input[name="ability"]')
    .forEach((checkbox) => {
      checkbox.checked = ["images", "videos", "chat"].includes(checkbox.value);
    });
}

function fillKeyForm(item) {
  document.getElementById("key-id").value = item.id;
  document.getElementById("key-name").value = item.name || "";
  document.getElementById("key-description").value = item.description || "";
  document.getElementById("key-enabled").checked = !!item.enabled;
  document
    .querySelectorAll('input[name="ability"]')
    .forEach((checkbox) => {
      checkbox.checked = (item.allowedAbilities || []).includes(checkbox.value);
    });
}

function renderMetrics(overview) {
  const metrics = [
    { label: "账号总数", value: overview.counts.accounts, helper: "所有入池账号" },
    { label: "健康账号", value: overview.counts.healthy, helper: "可直接承接请求" },
    { label: "可用 Session", value: overview.counts.withSession, helper: "已拿到 SessionID" },
    { label: "黑名单", value: overview.counts.blacklisted, helper: "积分耗尽或失效账号" },
    { label: "活跃租约", value: overview.counts.activeLeases, helper: "当前并发占用" },
  ];

  refs.metricsGrid.innerHTML = metrics
    .map(
      (item) => `
        <article class="metric-card">
          <span class="muted">${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
          <p class="muted">${escapeHtml(item.helper)}</p>
        </article>
      `
    )
    .join("");
}

function renderAccounts(accounts) {
  state.accountsById = new Map(accounts.map((item) => [item.id, item]));
  refs.accountsTableBody.innerHTML = accounts
    .map(
      (item) => `
        <tr>
          <td>${statusPill(item.status, item.blacklisted)}</td>
          <td>
            <strong>${escapeHtml(item.email)}</strong>
            <div class="muted">${escapeHtml(item.notes || "无备注")}</div>
            <div class="muted">${escapeHtml(item.proxyPreview ? `代理: ${item.proxyPreview}` : "代理: 直连")}</div>
          </td>
          <td>
            <div>${escapeHtml(item.sessionIdPreview || "—")}</div>
            <div class="muted">刷新: ${escapeHtml(formatTime(item.sessionUpdatedAt))}</div>
          </td>
          <td>
            <div>${escapeHtml(item.activeLeases)} / ${escapeHtml(item.maxConcurrency)}</div>
            <div class="muted">验证: ${escapeHtml(item.lastValidationStatus || "unknown")}</div>
          </td>
          <td>
            <div>成功 ${escapeHtml(item.successCount)} / 失败 ${escapeHtml(item.failureCount)}</div>
            <div class="muted">${escapeHtml(item.lastError || item.blacklistedReason || "无异常")}</div>
          </td>
          <td>
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
  refs.keysTableBody.innerHTML = keys
    .map(
      (item) => `
        <tr>
          <td>
            <strong>${escapeHtml(item.name)}</strong>
            <div class="muted">${escapeHtml(item.description || "无描述")}</div>
          </td>
          <td>
            <div class="inline-secret">${escapeHtml(
              item.rawKey ||
                (item.rawKeyLocked ? "当前实例无法解密该密钥" : "旧密钥尚未保存原文，请先使用或重置")
            )}</div>
            <div class="muted">${escapeHtml(item.keyPreview)}</div>
          </td>
          <td>${abilityLabels(item.allowedAbilities)}</td>
          <td>${escapeHtml(formatTime(item.lastUsedAt))}</td>
          <td>
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
  refs.userSummary.textContent = `当前登录: ${overview.user.username} | provider=${overview.loginProvider} | sessionTTL=${overview.settings.sessionTtlMinutes} 分钟`;
  renderMetrics(overview);
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
  } catch (error) {
    showLogin();
  }
}

refs.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await apiFetch("/api/admin/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("login-username").value.trim(),
        password: document.getElementById("login-password").value,
      }),
    });
    showApp();
    setNotice("登录成功");
    refs.loginForm.reset();
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    await apiFetch(accountId ? `/api/admin/accounts/${accountId}` : "/api/admin/accounts", {
      method: accountId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    setNotice(accountId ? "账号已更新" : "账号已创建");
    appendLog(accountId ? "更新账号" : "创建账号", payload);
    resetAccountForm();
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    text: document.getElementById("account-import-text").value,
    defaultProxy: document.getElementById("account-import-default-proxy").value.trim(),
    maxConcurrency: Number(document.getElementById("account-import-max-concurrency").value || 2),
    enabled: document.getElementById("account-import-enabled").checked,
    autoRefresh: document.getElementById("account-import-auto-refresh").checked,
    overwriteExisting: document.getElementById("account-import-overwrite").checked,
  };

  try {
    const result = await apiFetch("/api/admin/accounts/import", {
      method: "POST",
      body: JSON.stringify(payload),
    });
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
  const keyId = document.getElementById("key-id").value;
  const payload = {
    name: document.getElementById("key-name").value.trim(),
    description: document.getElementById("key-description").value.trim(),
    enabled: document.getElementById("key-enabled").checked,
    allowedAbilities: collectAbilities(),
  };

  try {
    const result = await apiFetch(keyId ? `/api/admin/api-keys/${keyId}` : "/api/admin/api-keys", {
      method: keyId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    if (result?.rawKey) {
      setLatestSecret(result.rawKey);
      appendLog("创建 API Key", result.apiKey);
    } else {
      appendLog("更新 API Key", result.item);
    }
    setNotice(keyId ? "API Key 已更新" : "API Key 已创建");
    resetKeyForm();
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await apiFetch("/api/admin/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: document.getElementById("current-password").value,
        nextPassword: document.getElementById("next-password").value,
      }),
    });
    refs.passwordForm.reset();
    setNotice("管理员密码已更新");
    appendLog("修改管理员密码", "密码修改成功");
    await loadOverview();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

document.getElementById("reload-overview").addEventListener("click", async () => {
  try {
    await loadOverview();
    setNotice("总览已刷新");
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await apiFetch("/api/admin/auth/logout", { method: "POST" });
  showLogin();
  state.user = null;
  setNotice("已退出登录");
});

document.getElementById("reset-account-form").addEventListener("click", resetAccountForm);
document.getElementById("reset-key-form").addEventListener("click", resetKeyForm);

document.getElementById("clear-account-session").addEventListener("click", () => {
  document.getElementById("account-session-id").value = "";
  state.clearSessionOnSave = true;
  setNotice("已标记为清空 Session，保存后生效");
});

document.getElementById("copy-secret").addEventListener("click", async () => {
  try {
    await copyText(state.latestSecret, "已复制最近签发的 API Key");
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
      setNotice(`正在编辑账号 ${item.email}`);
      return;
    }

    if (action === "refresh-account") {
      const result = await apiFetch(`/api/admin/accounts/${id}/refresh-session`, { method: "POST" });
      appendLog(`刷新账号 ${item.email}`, result.logs || result);
      setNotice(`账号 ${item.email} Session 已刷新`);
      await loadOverview();
      return;
    }

    if (action === "validate-account") {
      const result = await apiFetch(`/api/admin/accounts/${id}/validate-session`, { method: "POST" });
      appendLog(`校验账号 ${item.email}`, result);
      setNotice(result.valid ? `账号 ${item.email} Session 有效` : result.reason, result.valid ? "info" : "danger");
      await loadOverview();
      return;
    }

    if (action === "blacklist-account") {
      const reason = window.prompt("请输入拉黑原因", item.lastError || "手动拉黑");
      if (reason === null) return;
      await apiFetch(`/api/admin/accounts/${id}/blacklist`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      appendLog(`拉黑账号 ${item.email}`, reason);
      setNotice(`账号 ${item.email} 已拉黑`);
      await loadOverview();
      return;
    }

    if (action === "unblacklist-account") {
      await apiFetch(`/api/admin/accounts/${id}/unblacklist`, { method: "POST" });
      appendLog(`解除拉黑 ${item.email}`, "已恢复为可调度状态");
      setNotice(`账号 ${item.email} 已解除拉黑`);
      await loadOverview();
      return;
    }

    if (action === "delete-account") {
      if (!window.confirm(`确认删除账号 ${item.email} 吗？`)) return;
      await apiFetch(`/api/admin/accounts/${id}`, { method: "DELETE" });
      appendLog(`删除账号 ${item.email}`, "账号已删除");
      setNotice(`账号 ${item.email} 已删除`);
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
      await copyText(item.rawKey, `已复制 API Key ${item.name}`);
      return;
    }

    if (action === "edit-key") {
      fillKeyForm(item);
      setNotice(`正在编辑 API Key ${item.name}`);
      return;
    }

    if (action === "rotate-key") {
      if (!window.confirm(`确认重置 API Key ${item.name} 吗？旧密钥会立刻失效。`)) return;
      const result = await apiFetch(`/api/admin/api-keys/${id}/rotate`, { method: "POST" });
      setLatestSecret(result.rawKey);
      appendLog(`重置 API Key ${item.name}`, result.apiKey);
      setNotice(`API Key ${item.name} 已重置`);
      await loadOverview();
      return;
    }

    if (action === "delete-key") {
      if (!window.confirm(`确认删除 API Key ${item.name} 吗？`)) return;
      await apiFetch(`/api/admin/api-keys/${id}`, { method: "DELETE" });
      appendLog(`删除 API Key ${item.name}`, "API Key 已删除");
      setNotice(`API Key ${item.name} 已删除`);
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
