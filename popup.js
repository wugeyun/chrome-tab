import { addCard, initTheme, isRestrictedUrl } from "./shared.js";

initTheme();

const titleInput = document.getElementById("title");
const urlInput = document.getElementById("url");
const addBtn = document.getElementById("add");
const openBtn = document.getElementById("open-newtab");
const statusEl = document.getElementById("status");

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

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    setStatus("无法读取当前标签页。", "err");
    addBtn.disabled = true;
    return;
  }

  if (isRestrictedUrl(tab.url) || tab.url.startsWith("chrome://newtab")) {
    titleInput.value = "";
    urlInput.value = tab.url;
    setStatus("系统页面无法添加，请打开普通网页后再试。", "err");
    addBtn.disabled = true;
    return;
  }

  titleInput.value = tab.title || "";
  urlInput.value = tab.url;
  addBtn.disabled = false;
  titleInput.focus();
  titleInput.select();
}

addBtn.addEventListener("click", async () => {
  addBtn.disabled = true;
  try {
    const result = await addCard({
      title: titleInput.value,
      url: urlInput.value,
    });
    setStatus(
      result.created ? "已添加到新标签页。" : "该页面已在卡片中。",
      "ok"
    );
    setTimeout(() => window.close(), 700);
  } catch (err) {
    setStatus(err?.message || "添加失败", "err");
    addBtn.disabled = false;
  }
});

openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://newtab" });
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

loadCurrentTab();
