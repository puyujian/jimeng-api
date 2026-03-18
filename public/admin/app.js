const state = {
  user: null,
  overview: null,
  accountsById: new Map(),
  selectedAccountIds: new Set(),
  accountsPagination: {
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 1,
  },
  accountsStatusFilter: "all",
  keysById: new Map(),
  clearSessionOnSave: false,
  outboundLogs: [],
  outboundExpandedKeys: new Set(),
};

const OUTBOUND_LOG_AUTO_REFRESH_MS = 3000;
let outboundLogRefreshTimer = null;
let outboundLogRefreshPromise = null;

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

const REGION_LABELS = {
  cn: "中国区",
  us: "美国区",
  hk: "香港区",
  jp: "日本区",
  sg: "新加坡区",
};

const ACCOUNT_STATUS_FILTER_LABELS = {
  all: "账号",
  healthy: "健康账号",
  invalid: "失效账号",
  blacklisted: "拉黑账号",
};

const ACCOUNT_TABLE_COLSPAN = 7;

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
  accountsStatusFilter: document.getElementById("accounts-status-filter"),
  accountsRefreshInvalidButton: document.getElementById("accounts-refresh-invalid"),
  accountsValidateAllButton: document.getElementById("accounts-validate-all"),
  accountsSelectAll: document.getElementById("accounts-select-all"),
  accountsSelectionSummary: document.getElementById("accounts-selection-summary"),
  accountsBatchApplyAll: document.getElementById("accounts-batch-apply-all"),
  accountsBatchProxyMode: document.getElementById("accounts-batch-proxy-mode"),
  accountsBatchProxy: document.getElementById("accounts-batch-proxy"),
  accountsBatchRegion: document.getElementById("accounts-batch-region"),
  accountsBatchApplyButton: document.getElementById("accounts-batch-apply"),
  accountsBatchDeleteButton: document.getElementById("accounts-batch-delete"),
  accountsTableMeta: document.getElementById("accounts-table-meta"),
  accountsPageIndicator: document.getElementById("accounts-page-indicator"),
  accountsPagePrev: document.getElementById("accounts-page-prev"),
  accountsPageNext: document.getElementById("accounts-page-next"),
  accountsPageSize: document.getElementById("accounts-page-size"),
  keysTableBody: document.getElementById("keys-table-body"),
  metricsGrid: document.getElementById("metrics-grid"),
  userSummary: document.getElementById("user-summary"),
  activityLog: document.getElementById("activity-log"),
  outboundLog: document.getElementById("outbound-log"),
  outboundLogMeta: document.getElementById("outbound-log-meta"),
  reloadOutboundLogsButton: document.getElementById("reload-outbound-logs"),
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

function renderOutboundLogs(payload) {
  state.outboundLogs = payload.entries || [];
  const visibleKeys = new Set();
  state.outboundLogs.forEach((entry) => {
    const aliasKeys = outboundEntryKeys(entry);
    if (aliasKeys.some((key) => state.outboundExpandedKeys.has(key))) {
      state.outboundExpandedKeys.add(outboundEntryKey(entry));
    }
    aliasKeys.forEach((key) => visibleKeys.add(key));
  });
  Array.from(state.outboundExpandedKeys).forEach((taskKey) => {
    if (!visibleKeys.has(taskKey)) {
      state.outboundExpandedKeys.delete(taskKey);
    }
  });
  const updatedAt = formatTime(payload.updatedAt);

  refs.outboundLogMeta.textContent = payload.available
    ? `文件 ${payload.fileName} | 显示 ${payload.returnedCount}/${payload.totalMatched} 条 | 最后更新 ${updatedAt}`
    : payload.emptyReason || "当前环境没有可读取的日志文件";

  refs.outboundLog.innerHTML = state.outboundLogs.length
    ? state.outboundLogs.map((entry, index) => renderOutboundLogEntry(entry, index)).join("")
    : `<div class="outbound-log-empty">${escapeHtml(payload.emptyReason || "当前还没有外部调用日志")}</div>`;
}

function renderOutboundLogError(error) {
  refs.outboundLogMeta.textContent = "调用日志加载失败";
  refs.outboundLog.innerHTML = `<div class="outbound-log-empty">${escapeHtml(error?.message || "未知错误")}</div>`;
}

function showLogin() {
  stopOutboundLogAutoRefresh();
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

function formatOutboundTime(value) {
  return value ? escapeHtml(value) : "—";
}

function formatDurationMs(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return "—";
  if (duration < 1000) return `${Math.round(duration)}ms`;
  if (duration < 10000) return `${(duration / 1000).toFixed(2)}s`;
  return `${(duration / 1000).toFixed(1)}s`;
}

function outboundPillTone(value) {
  const text = String(value || "");
  if (text.includes("失败") || text.includes("错误")) return "danger";
  if (text.includes("中") || text.includes("请求中")) return "warn";
  if (text.includes("成功") || text.includes("完成")) return "ok";
  return "";
}

function renderOutboundPill(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const tone = outboundPillTone(text);
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
}

function outboundEntryKey(entry) {
  return String(entry?.taskKey || entry?.historyId || entry?.requestId || "").trim();
}

function outboundEntryKeys(entry) {
  const keys = new Set();
  const taskKey = outboundEntryKey(entry);
  if (taskKey) keys.add(taskKey);
  if (entry?.historyId) keys.add(`history:${entry.historyId}`);
  if (entry?.groupId) keys.add(`group:${entry.groupId}`);
  if (entry?.requestId) keys.add(`request:${entry.requestId}`);
  return Array.from(keys);
}

function outboundDetailId(entry) {
  const raw = outboundEntryKey(entry) || "outbound-log-entry";
  return `outbound-log-detail-${raw.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function buildOutboundSummaryText(entry) {
  const failureReason = String(entry?.errorMessage || "").trim();
  if (entry?.status === "error" && failureReason) {
    return `失败原因: ${failureReason}`;
  }

  if (entry?.historyId && (entry?.requestKind === "提交任务" || entry?.requestKind === "轮询状态")) {
    return `${entry.requestKind} · historyId: ${entry.historyId}`;
  }

  if (entry?.requestKind && entry.requestKind !== "外部调用") {
    return `${entry.requestKind}${entry.requestPath ? ` · ${entry.requestPath}` : ""}`;
  }

  return `${entry?.method || "—"} ${entry?.requestPath || entry?.url || "—"}`;
}

function renderOutboundLogEntry(entry, index) {
  const accountLabel = escapeHtml(entry.accountLabel || "未知账号");
  const requestLine = escapeHtml(buildOutboundSummaryText(entry));
  const duration = formatDurationMs(entry.durationMs);
  const time = formatOutboundTime(entry.time);
  const detailText = escapeHtml(entry.detailText || "");
  const detailId = outboundDetailId(entry);
  const taskKey = outboundEntryKey(entry);
  const expanded = outboundEntryKeys(entry).some((key) => state.outboundExpandedKeys.has(key));
  const detailMeta = [
    entry.historyId ? `historyId: ${entry.historyId}` : "",
    entry.httpStatus ? `HTTP ${entry.httpStatus}${entry.httpStatusText ? ` ${entry.httpStatusText}` : ""}` : "",
    entry.requestMode ? `模式: ${entry.requestMode}` : "",
    entry.ability ? `能力: ${entry.ability}` : "",
    entry.errorCode ? `错误码: ${entry.errorCode}` : "",
    entry.errorMessage ? `失败原因: ${entry.errorMessage}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <article class="outbound-log-item" data-expanded="${expanded ? "true" : "false"}" data-task-key="${escapeHtml(taskKey)}">
      <button
        class="outbound-log-summary"
        type="button"
        data-outbound-toggle="true"
        aria-expanded="${expanded ? "true" : "false"}"
        aria-controls="${detailId}"
      >
        <div class="outbound-log-summary-layout">
          <div class="outbound-log-main">
            <strong class="outbound-log-account">${accountLabel}</strong>
            <div class="pill-row outbound-log-pills">
              ${renderOutboundPill(entry.attemptLabel)}
              ${renderOutboundPill(entry.statusLabel)}
              ${renderOutboundPill(entry.generationStatus)}
            </div>
            <div class="table-subline outbound-log-subline">${requestLine}</div>
          </div>
          <div class="outbound-log-side">
            <strong class="outbound-log-duration">${escapeHtml(duration)}</strong>
            <span class="table-subline">${time}</span>
          </div>
        </div>
      </button>
      <div class="outbound-log-detail" id="${detailId}"${expanded ? "" : " hidden"}>
        <p class="table-subline outbound-log-detail-meta">${escapeHtml(detailMeta || "无额外元信息")}</p>
        <pre class="activity-log outbound-log-detail-text">${detailText || "暂无明细"}</pre>
      </div>
    </article>
  `;
}

function formatAccountIssue(item) {
  const primary = item.lastError || item.blacklistedReason || "无异常";
  if (item.blacklisted && item.blacklistReleaseAt) {
    return `${primary} | 自动解除: ${formatTime(item.blacklistReleaseAt)}`;
  }
  return primary;
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

function regionLabel(region) {
  return REGION_LABELS[String(region || "cn").toLowerCase()] || String(region || "cn").toUpperCase();
}

function accountStatusFilterLabel(filter) {
  return ACCOUNT_STATUS_FILTER_LABELS[String(filter || "all").toLowerCase()] || "账号";
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

function currentVisibleAccountIds() {
  return Array.from(state.accountsById.keys());
}

function syncBatchProxyInputState() {
  const mode = refs.accountsBatchProxyMode.value;
  refs.accountsBatchProxy.disabled = mode !== "set";
  if (mode !== "set") {
    refs.accountsBatchProxy.value = "";
  }
}

function syncAccountSelectionUi() {
  const visibleIds = currentVisibleAccountIds();
  const selectedVisibleCount = visibleIds.filter((id) => state.selectedAccountIds.has(id)).length;
  const totalSelectedCount = state.selectedAccountIds.size;

  refs.accountsSelectAll.disabled = !visibleIds.length;
  refs.accountsSelectAll.checked = Boolean(visibleIds.length) && selectedVisibleCount === visibleIds.length;
  refs.accountsSelectAll.indeterminate =
    selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;

  refs.accountsSelectionSummary.textContent = refs.accountsBatchApplyAll.checked
    ? `将作用到全部 ${state.accountsPagination.total || 0} 个账号`
    : `已选 ${totalSelectedCount} 个账号`;
}

function resolveBatchAccountTarget() {
  if (refs.accountsBatchApplyAll.checked) {
    return {
      applyToAll: true,
    };
  }

  const ids = Array.from(state.selectedAccountIds);
  if (!ids.length) {
    throw new Error("请先勾选要批量处理的账号，或开启“作用到全部账号”");
  }

  return {
    ids,
  };
}

function setAccountsTableLoading(message = "账号列表加载中...") {
  state.accountsById = new Map();
  refs.accountsTableBody.innerHTML = emptyTableRow(ACCOUNT_TABLE_COLSPAN, message);
  refs.accountsTableMeta.textContent = message;
  refs.accountsPageIndicator.textContent = "加载中";
  refs.accountsPagePrev.disabled = true;
  refs.accountsPageNext.disabled = true;
  syncAccountSelectionUi();
}

function syncAccountsPagination(pageData = {}) {
  const total = Number(pageData.total || 0);
  const pageSize = Number(pageData.pageSize || state.accountsPagination.pageSize || 10);
  const totalPages = Math.max(1, Number(pageData.totalPages || (total ? Math.ceil(total / pageSize) : 1) || 1));
  const page = Math.min(totalPages, Math.max(1, Number(pageData.page || 1)));
  const statusFilter = String(pageData.status || state.accountsStatusFilter || "all");

  state.accountsPagination = {
    page,
    pageSize,
    total,
    totalPages,
  };
  state.accountsStatusFilter = statusFilter;

  refs.accountsPageSize.value = String(pageSize);
  refs.accountsStatusFilter.value = statusFilter;

  if (!total) {
    refs.accountsTableMeta.textContent = `${accountStatusFilterLabel(statusFilter)}暂无数据。`;
    refs.accountsPageIndicator.textContent = "暂无数据";
    refs.accountsPagePrev.disabled = true;
    refs.accountsPageNext.disabled = true;
    syncAccountSelectionUi();
    return;
  }

  const start = (page - 1) * pageSize + 1;
  const end = start + Math.max(0, Number(pageData.items?.length || 0)) - 1;
  refs.accountsTableMeta.textContent = `显示 ${start}-${end} / ${total} 个${accountStatusFilterLabel(statusFilter)}`;
  refs.accountsPageIndicator.textContent = `第 ${page} / ${totalPages} 页`;
  refs.accountsPagePrev.disabled = page <= 1;
  refs.accountsPageNext.disabled = page >= totalPages;
  syncAccountSelectionUi();
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
  document.getElementById("account-region").value = "jp";
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
  document.getElementById("account-region").value = item.region || "cn";
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

function renderMetrics(overview, options = {}) {
  const animate = options.animate !== false;
  const counts = overview.counts || {};
  const accountsTotal = Number(counts.accounts || 0);
  const healthy = Number(counts.healthy || 0);
  const withSession = Number(counts.withSession || 0);
  const blacklisted = Number(counts.blacklisted || 0);
  const activeLeases = Number(counts.activeLeases || 0);
  const totalCapacity = Number(counts.totalCapacity || 0);

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
        <article class="metric-card${animate ? " motion-item" : ""}"${
          animate ? ` style="--item-index:${index}"` : ""
        } ${
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

function renderAccounts(accounts, options = {}) {
  const animate = options.animate !== false;
  state.accountsById = new Map(accounts.map((item) => [item.id, item]));
  if (!accounts.length) {
    refs.accountsTableBody.innerHTML = emptyTableRow(
      ACCOUNT_TABLE_COLSPAN,
      "暂无账号，先通过上方表单创建，或用批量导入灌入账号池。"
    );
    syncAccountSelectionUi();
    return;
  }

  refs.accountsTableBody.innerHTML = accounts
    .map(
      (item, index) => `
        <tr class="${animate ? "motion-item" : ""}"${animate ? ` style="--item-index:${index}"` : ""}>
          <td data-label="选择">
            <label class="table-select">
              <input
                type="checkbox"
                data-account-select
                value="${escapeHtml(item.id)}"
                ${state.selectedAccountIds.has(item.id) ? "checked" : ""}
              />
              <span class="sr-only">选择账号 ${escapeHtml(item.email)}</span>
            </label>
          </td>
          <td data-label="状态">${statusPill(item.status, item.blacklisted)}</td>
          <td data-label="邮箱">
            <strong class="table-title">${escapeHtml(item.email)}</strong>
            <div class="pill-row">
              <span class="pill ${item.enabled ? "ok" : "warn"}">${item.enabled ? "启用" : "停用"}</span>
              <span class="pill">${item.autoRefresh ? "自动续期" : "手动续期"}</span>
              <span class="pill">${escapeHtml(regionLabel(item.region))}</span>
            </div>
            <div class="table-subline">${escapeHtml(item.notes || "无备注")}</div>
            <div class="table-subline">${escapeHtml(item.proxyPreview ? `代理: ${item.proxyPreview}` : "代理: 直连")}</div>
          </td>
          <td class="table-stat" data-label="Session">
            <strong class="mono">${escapeHtml(item.sessionIdPreview || "—")}</strong>
            <div class="table-subline">地区: ${escapeHtml(regionLabel(item.region))}</div>
            <div class="table-subline">刷新: ${escapeHtml(formatTime(item.sessionUpdatedAt))}</div>
          </td>
          <td class="table-stat" data-label="并发">
            <strong>${escapeHtml(item.activeLeases)} / ${escapeHtml(item.maxConcurrency)}</strong>
            <div class="table-subline">验证: ${escapeHtml(statusLabel(item.lastValidationStatus || "unknown"))}</div>
          </td>
          <td class="table-stat" data-label="使用 / 错误">
            <strong>成功 ${escapeHtml(item.successCount)} / 失败 ${escapeHtml(item.failureCount)}</strong>
            <div class="table-subline">${escapeHtml(formatAccountIssue(item))}</div>
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
  syncAccountSelectionUi();
}

function renderKeys(keys, options = {}) {
  const animate = options.animate !== false;
  state.keysById = new Map(keys.map((item) => [item.id, item]));
  if (!keys.length) {
    refs.keysTableBody.innerHTML = emptyTableRow(5, "暂无 API Key，建议先创建一个调用方密钥并限制它的能力范围。");
    return;
  }

  refs.keysTableBody.innerHTML = keys
    .map(
      (item, index) => `
        <tr class="${animate ? "motion-item" : ""}"${animate ? ` style="--item-index:${index}"` : ""}>
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

async function loadOverview(options = {}) {
  const animate = options.animate !== false;
  const overview = await apiFetch("/api/admin/overview");
  state.overview = overview;
  state.user = overview.user;
  refs.userSummary.textContent = `当前登录: ${overview.user.username} | 登录提供方: ${overview.loginProvider} | Session TTL: ${overview.settings.sessionTtlMinutes} 分钟`;
  renderMetrics(overview, { animate });
  renderOverviewSignals(overview);
  if (options.renderKeys !== false) {
    renderKeys(overview.apiKeys || [], { animate });
  }
}

async function loadAccounts(options = {}) {
  const silent = options.silent === true;
  const animate = options.animate !== false && !silent;
  const page = Number(options.page || state.accountsPagination.page || 1);
  const pageSize = Number(options.pageSize || state.accountsPagination.pageSize || 10);
  const statusFilter = String(options.statusFilter || state.accountsStatusFilter || "all");
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (statusFilter !== "all") {
    params.set("status", statusFilter);
  }
  const previous = {
    html: refs.accountsTableBody.innerHTML,
    meta: refs.accountsTableMeta.textContent,
    indicator: refs.accountsPageIndicator.textContent,
    prevDisabled: refs.accountsPagePrev.disabled,
    nextDisabled: refs.accountsPageNext.disabled,
    pageSize: state.accountsPagination.pageSize,
    pagination: { ...state.accountsPagination },
    statusFilter: state.accountsStatusFilter,
    accountsById: new Map(state.accountsById),
  };

  if (silent) {
    refs.accountsTableMeta.textContent = `正在同步${accountStatusFilterLabel(statusFilter)}...`;
    refs.accountsPageIndicator.textContent = "更新中";
    refs.accountsPagePrev.disabled = true;
    refs.accountsPageNext.disabled = true;
  } else {
    setAccountsTableLoading();
  }

  try {
    const payload = await apiFetch(`/api/admin/accounts?${params.toString()}`);
    renderAccounts(payload.items || [], { animate });
    syncAccountsPagination(payload);
  } catch (error) {
    refs.accountsTableBody.innerHTML = previous.html;
    refs.accountsTableMeta.textContent = previous.meta;
    refs.accountsPageIndicator.textContent = previous.indicator;
    refs.accountsPagePrev.disabled = previous.prevDisabled;
    refs.accountsPageNext.disabled = previous.nextDisabled;
    refs.accountsPageSize.value = String(previous.pageSize);
    state.accountsPagination = previous.pagination;
    state.accountsStatusFilter = previous.statusFilter;
    refs.accountsStatusFilter.value = previous.statusFilter;
    state.accountsById = previous.accountsById;
    syncAccountSelectionUi();
    throw error;
  }
}

async function loadOutboundLogs() {
  if (outboundLogRefreshPromise) return outboundLogRefreshPromise;

  const previousScrollTop = refs.outboundLog?.scrollTop || 0;
  outboundLogRefreshPromise = apiFetch("/api/admin/logs/outbound?limit=120")
    .then((payload) => {
      renderOutboundLogs(payload);
      if (refs.outboundLog) {
        refs.outboundLog.scrollTop = previousScrollTop;
      }
    })
    .finally(() => {
      outboundLogRefreshPromise = null;
    });

  return outboundLogRefreshPromise;
}

async function refreshOutboundLogsSilently() {
  if (!state.user || refs.appView.hidden || document.hidden) return;
  try {
    await loadOutboundLogs();
  } catch (error) {
    console.warn("自动刷新外部调用日志失败", error);
  }
}

function stopOutboundLogAutoRefresh() {
  if (outboundLogRefreshTimer) {
    window.clearInterval(outboundLogRefreshTimer);
    outboundLogRefreshTimer = null;
  }
}

function startOutboundLogAutoRefresh() {
  stopOutboundLogAutoRefresh();
  outboundLogRefreshTimer = window.setInterval(() => {
    void refreshOutboundLogsSilently();
  }, OUTBOUND_LOG_AUTO_REFRESH_MS);
}

async function reloadDashboard(options = {}) {
  const targetPage = options.resetAccountPage ? 1 : state.accountsPagination.page;
  const refreshOverview = options.refreshOverview !== false;
  const refreshAccounts = options.refreshAccounts !== false;
  const refreshLogs = options.refreshLogs === true;
  const silent = options.silent === true;
  const [overviewResult, accountsResult, logsResult] = await Promise.allSettled([
    refreshOverview
      ? loadOverview({
          animate: !silent,
          renderKeys: options.renderKeys !== false,
        })
      : Promise.resolve(),
    refreshAccounts
      ? loadAccounts({
          page: targetPage,
          pageSize: state.accountsPagination.pageSize,
          statusFilter: state.accountsStatusFilter,
          silent,
          animate: !silent,
        })
      : Promise.resolve(),
    refreshLogs ? loadOutboundLogs() : Promise.resolve(),
  ]);

  if (refreshLogs && logsResult.status === "rejected") {
    renderOutboundLogError(logsResult.reason);
  }
  if (refreshOverview && overviewResult.status === "rejected") {
    throw overviewResult.reason;
  }
  if (refreshAccounts && accountsResult.status === "rejected") {
    throw accountsResult.reason;
  }
}

async function bootstrap() {
  try {
    const auth = await apiFetch("/api/admin/auth/me");
    state.user = auth.user;
    showApp();
    await reloadDashboard({ resetAccountPage: true, refreshLogs: true });
    startOutboundLogAutoRefresh();
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
    await reloadDashboard({ resetAccountPage: true, refreshLogs: true });
    startOutboundLogAutoRefresh();
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter || refs.accountForm.querySelector('button[type="submit"]');
  const accountId = document.getElementById("account-id").value;
  const sessionId = document.getElementById("account-session-id").value.trim();
  const payload = {
    email: document.getElementById("account-email").value.trim(),
    password: document.getElementById("account-password").value,
    proxy: document.getElementById("account-proxy").value.trim(),
    region: document.getElementById("account-region").value,
    maxConcurrency: Number(document.getElementById("account-max-concurrency").value || 2),
    enabled: document.getElementById("account-enabled").checked,
    autoRefresh: document.getElementById("account-auto-refresh").checked,
    notes: document.getElementById("account-notes").value.trim(),
    clearSession: state.clearSessionOnSave,
  };
  if (sessionId) {
    payload.sessionId = sessionId;
  }

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
    await reloadDashboard({ resetAccountPage: !accountId, silent: true, renderKeys: false });
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
    defaultRegion: document.getElementById("account-import-default-region").value,
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
    await reloadDashboard({ resetAccountPage: true, silent: true, renderKeys: false });
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
      appendLog("创建 API Key", result.apiKey);
    } else {
      appendLog("更新 API Key", result.item);
    }
    setNotice(keyId ? "API Key 已更新" : "API Key 已创建，完整密钥请直接在列表中复制", "ok");
    resetKeyForm();
    await loadOverview({ animate: false });
    revealElement(refs.keysTableBody);
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
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

document.getElementById("reload-overview").addEventListener("click", async (event) => {
  try {
    await runWithButton(event.currentTarget, "刷新中...", async () => {
      await reloadDashboard({ refreshLogs: true });
    });
    setNotice("总览和账号列表已刷新", "ok");
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

refs.reloadOutboundLogsButton.addEventListener("click", async (event) => {
  try {
    await runWithButton(event.currentTarget, "刷新中...", async () => {
      await loadOutboundLogs();
    });
    setNotice("调用日志已刷新", "ok");
  } catch (error) {
    renderOutboundLogError(error);
    setNotice(error.message, "danger");
  }
});

refs.outboundLog.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("[data-outbound-toggle]");
  if (!button || !refs.outboundLog.contains(button)) return;

  const item = button.closest(".outbound-log-item");
  const detail = item?.querySelector(".outbound-log-detail");
  if (!(item instanceof HTMLElement) || !(detail instanceof HTMLElement)) return;

  const expanded = button.getAttribute("aria-expanded") === "true";
  const taskKey = String(item.dataset.taskKey || "").trim();
  item.dataset.expanded = expanded ? "false" : "true";
  button.setAttribute("aria-expanded", expanded ? "false" : "true");
  detail.hidden = expanded;
  if (taskKey) {
    if (expanded) {
      state.outboundExpandedKeys.delete(taskKey);
    } else {
      state.outboundExpandedKeys.add(taskKey);
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopOutboundLogAutoRefresh();
    return;
  }
  if (!refs.appView.hidden && state.user) {
    void refreshOutboundLogsSilently();
    startOutboundLogAutoRefresh();
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

refs.accountsSelectAll.addEventListener("change", (event) => {
  const checked = Boolean(event.currentTarget.checked);
  const visibleIds = currentVisibleAccountIds();
  visibleIds.forEach((id) => {
    if (checked) {
      state.selectedAccountIds.add(id);
    } else {
      state.selectedAccountIds.delete(id);
    }
  });
  refs.accountsTableBody
    .querySelectorAll('input[data-account-select]')
    .forEach((input) => {
      input.checked = checked;
    });
  syncAccountSelectionUi();
});

refs.accountsBatchApplyAll.addEventListener("change", () => {
  syncAccountSelectionUi();
});

refs.accountsBatchProxyMode.addEventListener("change", () => {
  syncBatchProxyInputState();
});

refs.accountsBatchApplyButton.addEventListener("click", async (event) => {
  try {
    const payload = resolveBatchAccountTarget();
    const proxyMode = refs.accountsBatchProxyMode.value;
    if (proxyMode === "set") {
      const proxy = refs.accountsBatchProxy.value.trim();
      if (!proxy) {
        throw new Error("请输入要批量设置的代理地址");
      }
      payload.proxy = proxy;
    } else if (proxyMode === "clear") {
      payload.proxy = "";
    }

    const region = refs.accountsBatchRegion.value;
    if (region !== "ignore") {
      payload.region = region;
    }

    if (payload.proxy === undefined && payload.region === undefined) {
      throw new Error("请至少选择一个批量修改项");
    }

    const result = await runWithButton(event.currentTarget, "应用中...", async () =>
      apiFetch("/api/admin/accounts/batch/update", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    );

    appendLog("批量修改账号", result);
    setNotice(
      `批量修改完成：命中 ${result.matchedCount} 个账号，更新 ${result.updatedCount} 个，地区跳过 ${result.regionSkippedCount} 个`,
      result.regionSkippedCount ? "warn" : "ok"
    );
    state.selectedAccountIds.clear();
    refs.accountsBatchApplyAll.checked = false;
    refs.accountsBatchProxyMode.value = "ignore";
    refs.accountsBatchRegion.value = "ignore";
    syncBatchProxyInputState();
    await reloadDashboard({ resetAccountPage: false, silent: true, renderKeys: false });
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountsBatchDeleteButton.addEventListener("click", async (event) => {
  try {
    const payload = resolveBatchAccountTarget();
    const scopeText = payload.applyToAll
      ? `全部 ${state.accountsPagination.total || 0} 个账号`
      : `${payload.ids.length} 个账号`;
    if (!window.confirm(`确认删除${scopeText}吗？此操作不可恢复。`)) return;

    const result = await runWithButton(event.currentTarget, "删除中...", async () =>
      apiFetch("/api/admin/accounts/batch/delete", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    );

    appendLog("批量删除账号", result);
    setNotice(`批量删除完成：已删除 ${result.deletedCount} 个账号`, "warn");
    state.selectedAccountIds.clear();
    refs.accountsBatchApplyAll.checked = false;
    resetAccountForm();
    await reloadDashboard({ resetAccountPage: true, silent: true, renderKeys: false });
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountsPagePrev.addEventListener("click", async (event) => {
  if (state.accountsPagination.page <= 1) return;

  try {
    await runWithButton(event.currentTarget, "上一页...", async () => {
      await loadAccounts({ page: state.accountsPagination.page - 1, silent: true });
    });
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountsPageNext.addEventListener("click", async (event) => {
  if (state.accountsPagination.page >= state.accountsPagination.totalPages) return;

  try {
    await runWithButton(event.currentTarget, "下一页...", async () => {
      await loadAccounts({ page: state.accountsPagination.page + 1, silent: true });
    });
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountsPageSize.addEventListener("change", async (event) => {
  const previousPageSize = state.accountsPagination.pageSize;
  const pageSize = Number(event.currentTarget.value || previousPageSize || 10);

  try {
    await loadAccounts({ page: 1, pageSize, silent: true });
    setNotice(`账号列表已切换为每页 ${pageSize} 条`, "ok");
  } catch (error) {
    refs.accountsPageSize.value = String(previousPageSize);
    setNotice(error.message, "danger");
  }
});

refs.accountsStatusFilter.addEventListener("change", async (event) => {
  const previousFilter = state.accountsStatusFilter;
  const statusFilter = String(event.currentTarget.value || "all");

  try {
    await loadAccounts({ page: 1, pageSize: state.accountsPagination.pageSize, statusFilter, silent: true });
    setNotice(`${accountStatusFilterLabel(statusFilter)}筛选已生效`, "ok");
  } catch (error) {
    refs.accountsStatusFilter.value = previousFilter;
    setNotice(error.message, "danger");
  }
});

refs.accountsRefreshInvalidButton.addEventListener("click", async (event) => {
  try {
    const result = await runWithButton(event.currentTarget, "刷新中...", async () =>
      apiFetch("/api/admin/accounts/batch/refresh-invalid-session", {
        method: "POST",
      })
    );
    appendLog("一键刷新失效账号 Session", result);
    setNotice(
      `失效账号刷新完成：命中 ${result.matchedCount} 个，成功 ${result.refreshedCount} 个，失败 ${result.failedCount} 个`,
      result.failedCount ? "warn" : "ok"
    );
    await reloadDashboard({ resetAccountPage: false, silent: true, renderKeys: false });
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountsValidateAllButton.addEventListener("click", async (event) => {
  try {
    const result = await runWithButton(event.currentTarget, "校验中...", async () =>
      apiFetch("/api/admin/accounts/batch/validate-session", {
        method: "POST",
      })
    );
    appendLog("一键校验全部账号", result);
    setNotice(
      `全部账号校验完成：总计 ${result.matchedCount} 个，有效 ${result.validCount} 个，失效 ${result.invalidCount} 个，异常 ${result.failedCount} 个`,
      result.failedCount ? "warn" : "ok"
    );
    await reloadDashboard({ resetAccountPage: false, silent: true, renderKeys: false });
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

refs.accountsTableBody.addEventListener("change", (event) => {
  const input = event.target.closest('input[data-account-select]');
  if (!input) return;

  if (input.checked) {
    state.selectedAccountIds.add(input.value);
  } else {
    state.selectedAccountIds.delete(input.value);
  }
  syncAccountSelectionUi();
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
      await reloadDashboard({ silent: true, renderKeys: false });
      return;
    }

    if (action === "validate-account") {
      const result = await runWithButton(button, "校验中...", async () =>
        apiFetch(`/api/admin/accounts/${id}/validate-session`, { method: "POST" })
      );
      appendLog(`校验账号 ${item.email}`, result);
      setNotice(result.valid ? `账号 ${item.email} Session 有效` : result.reason, result.valid ? "ok" : "danger");
      await reloadDashboard({ silent: true, renderKeys: false });
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
      await reloadDashboard({ silent: true, renderKeys: false });
      return;
    }

    if (action === "unblacklist-account") {
      await runWithButton(button, "恢复中...", async () => {
        await apiFetch(`/api/admin/accounts/${id}/unblacklist`, { method: "POST" });
      });
      appendLog(`解除拉黑 ${item.email}`, "已恢复为可调度状态");
      setNotice(`账号 ${item.email} 已解除拉黑`, "ok");
      await reloadDashboard({ silent: true, renderKeys: false });
      return;
    }

    if (action === "delete-account") {
      if (!window.confirm(`确认删除账号 ${item.email} 吗？`)) return;
      await runWithButton(button, "删除中...", async () => {
        await apiFetch(`/api/admin/accounts/${id}`, { method: "DELETE" });
      });
      state.selectedAccountIds.delete(id);
      appendLog(`删除账号 ${item.email}`, "账号已删除");
      setNotice(`账号 ${item.email} 已删除`, "warn");
      resetAccountForm();
      await reloadDashboard({ silent: true, renderKeys: false });
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
      appendLog(`重置 API Key ${item.name}`, result.apiKey);
      setNotice(`API Key ${item.name} 已重置，完整密钥请直接在列表中复制`, "warn");
      await loadOverview({ animate: false });
      revealElement(refs.keysTableBody);
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
      await loadOverview({ animate: false });
    }
  } catch (error) {
    setNotice(error.message, "danger");
  }
});

resetAccountForm();
resetKeyForm();
syncBatchProxyInputState();
syncAccountSelectionUi();
bootstrap();
