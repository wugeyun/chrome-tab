import {
  SHARE_BASE_URL,
  buildShareUrl,
  extractShareToken,
  getCards,
  getTheme,
  hostnameOf,
  importCards,
  initTheme,
  parseShareUrl,
  setTheme,
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

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === "replace"
    ? "replace"
    : "merge";
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
});

syncThemeControls();
refreshPreview();
bootFromHash();
