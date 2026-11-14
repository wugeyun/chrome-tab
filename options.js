import {
  SHARE_BASE_URL,
  SYNC_REVOKED_MESSAGE,
  bindSyncCode,
  buildShareUrl,
  createSyncSession,
  extractShareToken,
  formatSyncCode,
  getCards,
  getSyncConfig,
  getTheme,
  hostnameOf,
  importCards,
  initTheme,
  parseShareUrl,
  pauseSync,
  resumeSync,
  rotateSyncCode,
  setTheme,
  syncNow,
} from "./shared.js";

initTheme();

const countEl = document.getElementById("count");
const previewEl = document.getElementById("preview");
const exportBtn = document.getElementById("export-btn");
const shareBox = document.getElementById("share-box");
const shareUrlEl = document.getElementById("share-url");
const copyBtn = document.getElementById("copy-btn");
const importBtn = document.getElementById("import-btn");
const importUrlEl = document.getElementById("import-url");
const statusEl = document.getElementById("status");
const themeInputs = document.querySelectorAll('input[name="theme"]');

const syncOff = document.getElementById("sync-off");
const syncOn = document.getElementById("sync-on");
const syncCreateBtn = document.getElementById("sync-create-btn");
const syncBindInput = document.getElementById("sync-bind-input");
const syncBindBtn = document.getElementById("sync-bind-btn");
const syncCodeDisplay = document.getElementById("sync-code-display");
const syncCopyBtn = document.getElementById("sync-copy-btn");
const syncNowBtn = document.getElementById("sync-now-btn");
const syncRotateBtn = document.getElementById("sync-rotate-btn");
const syncPauseBtn = document.getElementById("sync-pause-btn");
const syncResumeBtn = document.getElementById("sync-resume-btn");
const syncStateEl = document.getElementById("sync-state");
const syncLastEl = document.getElementById("sync-last");
const syncErrorEl = document.getElementById("sync-error");
const syncFeedbackEl = document.getElementById("sync-feedback");

let syncCopyResetTimer = null;

function setStatus(message, type) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.className = "status";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

/** Inline feedback inside the sync panel (visible without scrolling). */
function setSyncFeedback(message, type = "ok") {
  if (!syncFeedbackEl) return;
  if (!message) {
    syncFeedbackEl.hidden = true;
    syncFeedbackEl.textContent = "";
    syncFeedbackEl.className = "sync-feedback";
    return;
  }
  syncFeedbackEl.hidden = false;
  syncFeedbackEl.textContent = message;
  syncFeedbackEl.className = `sync-feedback ${type}`;
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === "replace"
    ? "replace"
    : "merge";
}

function formatSyncTime(ts) {
  if (!ts) return "尚未同步";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "尚未同步";
  }
}

async function refreshSyncPanel() {
  const config = await getSyncConfig();
  const bound = Boolean(config.syncId && config.secret);

  if (!bound || config.revoked) {
    syncOff.hidden = false;
    syncOn.hidden = true;
    syncCodeDisplay.value = "";
    setSyncFeedback("");
    if (config.revoked || config.lastError === SYNC_REVOKED_MESSAGE) {
      syncErrorEl.hidden = false;
      syncErrorEl.textContent = SYNC_REVOKED_MESSAGE;
    } else if (config.lastError && !bound) {
      syncErrorEl.hidden = false;
      syncErrorEl.textContent = `上次错误：${config.lastError}`;
    } else {
      syncErrorEl.hidden = true;
      syncErrorEl.textContent = "";
    }
    return;
  }

  syncOff.hidden = true;
  syncOn.hidden = false;
  syncCodeDisplay.value = formatSyncCode(config.syncId, config.secret);
  syncLastEl.textContent = formatSyncTime(config.lastSyncedAt);
  syncStateEl.textContent = config.enabled ? "已开启" : "已暂停";
  syncPauseBtn.hidden = !config.enabled;
  syncResumeBtn.hidden = config.enabled;
  syncNowBtn.hidden = !config.enabled;
  syncRotateBtn.hidden = false;

  if (config.lastError) {
    syncErrorEl.hidden = false;
    syncErrorEl.textContent = `上次错误：${config.lastError}`;
  } else {
    syncErrorEl.hidden = true;
    syncErrorEl.textContent = "";
  }
}

async function refreshPreview() {
  const cards = await getCards();
  countEl.textContent = String(cards.length);
  if (!cards.length) {
    previewEl.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "暂无卡片";
    previewEl.append(empty);
    return;
  }

  previewEl.replaceChildren(
    ...cards.map((card) => {
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.textContent = card.title || hostnameOf(card.url);
      const url = document.createElement("span");
      url.className = "url";
      url.textContent = card.url;
      url.title = card.url;
      li.append(title, url);
      return li;
    })
  );
}

async function runImport(raw, { prompted = false } = {}) {
  const incoming = await parseShareUrl(raw);
  const mode = selectedMode();

  if (mode === "replace") {
    const ok = confirm(
      prompted
        ? `检测到分享链接，含 ${incoming.length} 张卡片。替换模式会清空当前全部卡片，确定导入？`
        : "替换模式会清空当前全部卡片，确定继续？"
    );
    if (!ok) return false;
  } else if (prompted) {
    const ok = confirm(
      `检测到分享链接，含 ${incoming.length} 张卡片。以合并方式导入？`
    );
    if (!ok) return false;
  }

  const result = await importCards(incoming, mode);
  await refreshPreview();
  if (mode === "replace") {
    setStatus(`已替换为 ${result.total} 张卡片。`, "ok");
  } else {
    setStatus(
      `导入完成：新增 ${result.added} 张，跳过重复 ${result.skipped} 张，当前共 ${result.total} 张。`,
      "ok"
    );
  }
  return true;
}

function clearShareHash() {
  if (extractShareToken(location.hash)) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

exportBtn.addEventListener("click", async () => {
  try {
    const cards = await getCards();
    const url = await buildShareUrl(cards);
    shareUrlEl.value = url;
    shareBox.hidden = false;
    shareUrlEl.focus();
    shareUrlEl.select();
    setStatus(`已生成 ${cards.length} 张卡片的分享链接，可复制到其他电脑打开。`, "ok");
  } catch (err) {
    setStatus(err?.message || "导出失败", "err");
  }
});

copyBtn.addEventListener("click", async () => {
  const text = shareUrlEl.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("链接已复制到剪贴板。", "ok");
  } catch {
    shareUrlEl.focus();
    shareUrlEl.select();
    setStatus("自动复制失败，请手动全选复制。", "err");
  }
});

importBtn.addEventListener("click", async () => {
  const raw = importUrlEl.value.trim();
  if (!raw) {
    setStatus("请先粘贴分享链接。", "err");
    return;
  }
  try {
    await runImport(raw);
  } catch (err) {
    setStatus(err?.message || "导入失败", "err");
  }
});

syncCreateBtn.addEventListener("click", async () => {
  syncCreateBtn.disabled = true;
  try {
    const { code } = await createSyncSession();
    await refreshSyncPanel();
    await refreshPreview();
    setSyncFeedback("已生成同步码并完成首次上传，请复制到其他浏览器绑定。", "ok");
    setStatus(`已生成同步码并完成首次上传。请复制到其他浏览器绑定：${code}`, "ok");
  } catch (err) {
    await refreshSyncPanel();
    setSyncFeedback(err?.message || "生成同步码失败", "err");
    setStatus(err?.message || "生成同步码失败", "err");
  } finally {
    syncCreateBtn.disabled = false;
  }
});

syncBindBtn.addEventListener("click", async () => {
  const raw = syncBindInput.value.trim();
  if (!raw) {
    setStatus("请先粘贴同步码。", "err");
    return;
  }
  syncBindBtn.disabled = true;
  try {
    const result = await bindSyncCode(raw);
    await refreshSyncPanel();
    await refreshPreview();
    setSyncFeedback(
      result?.total != null
        ? `绑定成功，已同步，当前共 ${result.total} 张卡片。`
        : "绑定成功。",
      "ok"
    );
    setStatus(
      result?.total != null
        ? `绑定成功，已同步，当前共 ${result.total} 张卡片。`
        : "绑定成功。",
      "ok"
    );
    syncBindInput.value = "";
  } catch (err) {
    await refreshSyncPanel();
    setSyncFeedback(err?.message || "绑定失败", "err");
    setStatus(err?.message || "绑定失败", "err");
  } finally {
    syncBindBtn.disabled = false;
  }
});

syncCopyBtn.addEventListener("click", async () => {
  const text = syncCodeDisplay.value.trim();
  if (!text) {
    setSyncFeedback("没有可复制的同步码。", "err");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setSyncFeedback("同步码已复制到剪贴板，可在另一浏览器选项页粘贴绑定。", "ok");
    setStatus("同步码已复制。请在另一浏览器的选项页绑定。", "ok");
    const label = "复制同步码";
    syncCopyBtn.textContent = "已复制";
    if (syncCopyResetTimer) clearTimeout(syncCopyResetTimer);
    syncCopyResetTimer = setTimeout(() => {
      syncCopyBtn.textContent = label;
    }, 2000);
  } catch {
    syncCodeDisplay.focus();
    syncCodeDisplay.select();
    setSyncFeedback("自动复制失败，请手动全选同步码后复制。", "err");
    setStatus("自动复制失败，请手动全选复制。", "err");
  }
});

syncNowBtn.addEventListener("click", async () => {
  syncNowBtn.disabled = true;
  try {
    const result = await syncNow({ force: true });
    await refreshSyncPanel();
    await refreshPreview();
    const msg =
      result?.total != null
        ? `同步完成，当前共 ${result.total} 张卡片。`
        : "同步完成。";
    setSyncFeedback(msg, "ok");
    setStatus(msg, "ok");
  } catch (err) {
    await refreshSyncPanel();
    setSyncFeedback(err?.message || "同步失败", "err");
    setStatus(err?.message || "同步失败", "err");
  } finally {
    syncNowBtn.disabled = false;
  }
});

syncRotateBtn.addEventListener("click", async () => {
  const ok = confirm(
    "将生成新同步码，并立即作废旧码。其他仍使用旧码的浏览器会提示失效，需重新粘贴新码。本地卡片不会清空。确定更新？"
  );
  if (!ok) return;
  syncRotateBtn.disabled = true;
  try {
    const { code } = await rotateSyncCode();
    await refreshSyncPanel();
    await refreshPreview();
    setSyncFeedback("已更新同步码，旧码已作废。请复制新码到其他浏览器重新绑定。", "ok");
    setStatus(`已更新同步码。新码：${code}`, "ok");
  } catch (err) {
    await refreshSyncPanel();
    setSyncFeedback(err?.message || "更新同步码失败", "err");
    setStatus(err?.message || "更新同步码失败", "err");
  } finally {
    syncRotateBtn.disabled = false;
  }
});

syncPauseBtn.addEventListener("click", async () => {
  const ok = confirm(
    "暂停后本浏览器将暂时停止自动同步，同步码与云端数据保留，可随时恢复。确定暂停？"
  );
  if (!ok) return;
  await pauseSync();
  await refreshSyncPanel();
  setSyncFeedback("已暂停云同步，同步码仍有效，可随时恢复。", "ok");
  setStatus("已暂停云同步。", "ok");
});

syncResumeBtn.addEventListener("click", async () => {
  syncResumeBtn.disabled = true;
  try {
    const result = await resumeSync();
    await refreshSyncPanel();
    await refreshPreview();
    const msg =
      result?.total != null
        ? `已恢复同步，当前共 ${result.total} 张卡片。`
        : "已恢复同步。";
    setSyncFeedback(msg, "ok");
    setStatus(msg, "ok");
  } catch (err) {
    await refreshSyncPanel();
    setSyncFeedback(err?.message || "恢复同步失败", "err");
    setStatus(err?.message || "恢复同步失败", "err");
  } finally {
    syncResumeBtn.disabled = false;
  }
});

async function bootFromHash() {
  if (!extractShareToken(location.hash)) return;
  importUrlEl.value = location.hash.startsWith("#wuge=")
    ? `${SHARE_BASE_URL}${location.hash}`
    : `${location.origin}${location.pathname}${location.hash}`;
  try {
    const imported = await runImport(location.hash, { prompted: true });
    if (imported) clearShareHash();
  } catch (err) {
    setStatus(err?.message || "自动导入失败", "err");
  }
}

async function syncThemeControls() {
  const theme = await getTheme();
  for (const input of themeInputs) {
    input.checked = input.value === theme;
  }
}

for (const input of themeInputs) {
  input.addEventListener("change", async () => {
    if (!input.checked) return;
    await setTheme(input.value);
    setStatus(
      input.value === "light"
        ? "已切换为白天模式。"
        : input.value === "dark"
          ? "已切换为黑夜模式。"
          : "已切换为跟随系统。",
      "ok"
    );
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.cards) refreshPreview();
  if (changes.theme) syncThemeControls();
  if (changes.syncConfig) refreshSyncPanel();
});

syncThemeControls();
refreshPreview();
refreshSyncPanel();
bootFromHash();
