import {
  addCard,
  addSearchHistory,
  faviconUrl,
  fetchBingSuggestions,
  filterSearchHistory,
  getCards,
  hostnameOf,
  initTheme,
  normalizeUrl,
  onStorageChange,
  openUrl,
  performSearch,
  removeCard,
  removeSearchHistory,
  reorderCards,
  updateCard,
} from "./shared.js";

initTheme();

const grid = document.getElementById("card-grid");
const emptyHint = document.getElementById("empty-hint");
const creditEl = document.getElementById("credit");
const dialog = document.getElementById("edit-dialog");
const form = document.getElementById("edit-form");
const dialogTitle = document.getElementById("dialog-title");
const fieldTitle = document.getElementById("field-title");
const fieldUrl = document.getElementById("field-url");
const formError = document.getElementById("form-error");
const dialogCancel = document.getElementById("dialog-cancel");
const dialogDelete = document.getElementById("dialog-delete");
const clockEl = document.getElementById("clock");
const searchForm = document.getElementById("search-form");
const searchWrap = document.querySelector(".search-wrap");
const searchInput = document.getElementById("search-input");
const searchSuggest = document.getElementById("search-suggest");
const searchSubmit = document.getElementById("search-submit");
const bookmarkBtn = document.getElementById("bookmark-btn");
const bookmarkPanel = document.getElementById("bookmark-panel");
const bookmarkTree = document.getElementById("bookmark-tree");

const SEARCH_PLACEHOLDER = "搜索或输入网址";
const BOOKMARK_PLACEHOLDER = "搜索书签…";

/** @type {string | null} */
let editingId = null;
/** @type {string | null} */
let dragId = null;
/** Suppress click after long-press / drag reorder */
let suppressClick = false;
/** @typedef {{ text: string, source: "history" | "bing" }} SuggestItem */

/** @type {SuggestItem[]} */
let suggestItems = [];
let activeSuggestIndex = -1;
/** @type {ReturnType<typeof setTimeout> | null} */
let suggestHideTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let suggestDebounceTimer = null;
/** @type {AbortController | null} */
let suggestAbort = null;
/** @type {number} */
let suggestRequestId = 0;
let bookmarkMode = false;
/** 进入书签模式前暂存的网页搜索内容 */
let savedSearchValue = "";
/** @type {chrome.bookmarks.BookmarkTreeNode[] | null} */
let bookmarkRoots = null;
/** @type {Promise<chrome.bookmarks.BookmarkTreeNode[]> | null} */
let bookmarkLoadPromise = null;
/** @type {Set<string>} */
const openBookmarkFolders = new Set();
/** @type {ReturnType<typeof setTimeout> | null} */
let bookmarkSearchTimer = null;
/** @type {number} */
let bookmarkSearchRequestId = 0;

const LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 10;
const SUGGEST_LIMIT = 8;
const SUGGEST_DEBOUNCE_MS = 180;
const BOOKMARK_SEARCH_DEBOUNCE_MS = 140;
const BOOKMARK_SEARCH_LIMIT = 50;

function pad(n) {
  return String(n).padStart(2, "0");
}

function tickClock() {
  const now = new Date();
  clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function updateCredit() {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  creditEl.textContent = `武哥出品 ${date}`;
}

tickClock();
updateCredit();
setInterval(tickClock, 1000);

function hideSuggest() {
  if (suggestHideTimer) {
    clearTimeout(suggestHideTimer);
    suggestHideTimer = null;
  }
  if (suggestDebounceTimer) {
    clearTimeout(suggestDebounceTimer);
    suggestDebounceTimer = null;
  }
  suggestAbort?.abort();
  suggestAbort = null;
  searchSuggest.hidden = true;
  searchSuggest.innerHTML = "";
  suggestItems = [];
  activeSuggestIndex = -1;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
}

function setActiveSuggest(index) {
  const options = [...searchSuggest.querySelectorAll('[role="option"]')];
  options.forEach((el) => el.setAttribute("aria-selected", "false"));
  activeSuggestIndex = index;
  if (index < 0 || index >= options.length) {
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }
  const option = options[index];
  option.setAttribute("aria-selected", "true");
  searchInput.setAttribute("aria-activedescendant", option.id);
  option.scrollIntoView({ block: "nearest" });
}

/** @param {SuggestItem[]} items */
function renderSuggest(items) {
  suggestItems = items;
  activeSuggestIndex = -1;
  searchSuggest.innerHTML = "";

  if (!items.length) {
    searchSuggest.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }

  for (const [index, item] of items.entries()) {
    const li = document.createElement("li");
    li.id = `search-suggest-${index}`;
    li.className = "search-suggest-item";
    li.dataset.source = item.source;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "search-suggest-pick";
    pick.textContent = item.text;

    li.append(pick);

    if (item.source === "history") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "search-suggest-remove";
      remove.setAttribute("aria-label", `删除「${item.text}」`);
      remove.textContent = "×";
      li.append(remove);
    }

    searchSuggest.append(li);
  }

  searchSuggest.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
}

/**
 * @param {string[]} history
 * @param {string[]} remote
 * @returns {SuggestItem[]}
 */
function mergeSuggest(history, remote) {
  /** @type {SuggestItem[]} */
  const merged = [];
  const seen = new Set();

  for (const text of history) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ text, source: "history" });
    if (merged.length >= SUGGEST_LIMIT) return merged;
  }

  for (const text of remote) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ text, source: "bing" });
    if (merged.length >= SUGGEST_LIMIT) break;
  }

  return merged;
}

async function refreshSuggest() {
  if (bookmarkMode) return;

  const requestId = ++suggestRequestId;
  const query = searchInput.value;
  const q = query.trim();

  // 无输入时不展示历史/联想，避免打开新标签页就弹出下拉
  if (!q) {
    hideSuggest();
    return;
  }

  const history = await filterSearchHistory(query, SUGGEST_LIMIT);
  if (requestId !== suggestRequestId || bookmarkMode || document.activeElement !== searchInput) {
    return;
  }

  const historyItems = mergeSuggest(history, []);
  renderSuggest(historyItems);

  suggestAbort?.abort();
  const controller = new AbortController();
  suggestAbort = controller;

  try {
    const remote = await fetchBingSuggestions(q, controller.signal);
    if (requestId !== suggestRequestId || bookmarkMode || document.activeElement !== searchInput) {
      return;
    }
    renderSuggest(mergeSuggest(history, remote));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
  }
}

function scheduleSuggestRefresh() {
  if (suggestDebounceTimer) clearTimeout(suggestDebounceTimer);
  suggestDebounceTimer = setTimeout(() => {
    suggestDebounceTimer = null;
    void refreshSuggest();
  }, SUGGEST_DEBOUNCE_MS);
}

function runSearch(raw) {
  const q = raw.trim();
  if (!q) {
    searchInput.focus();
    return;
  }

  hideSuggest();
  void addSearchHistory(q);
  performSearch(q);
}

function openFirstBookmarkResult() {
  const first = bookmarkTree?.querySelector(".bookmark-row[data-url]");
  const url = first instanceof HTMLElement ? first.dataset.url : "";
  if (!url) return false;
  exitBookmarkMode({ restoreSearch: false });
  location.href = url;
  return true;
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (bookmarkMode) {
    openFirstBookmarkResult();
    return;
  }
  if (activeSuggestIndex >= 0 && suggestItems[activeSuggestIndex]) {
    runSearch(suggestItems[activeSuggestIndex].text);
    return;
  }
  runSearch(searchInput.value);
});

searchInput.addEventListener("input", () => {
  if (bookmarkMode) {
    scheduleBookmarkSearch();
    return;
  }
  scheduleSuggestRefresh();
});

searchInput.addEventListener("focus", () => {
  if (suggestHideTimer) {
    clearTimeout(suggestHideTimer);
    suggestHideTimer = null;
  }
  if (bookmarkMode) {
    void refreshBookmarkPanelContent();
    return;
  }
  void refreshSuggest();
});

searchInput.addEventListener("blur", () => {
  if (bookmarkMode) return;
  suggestHideTimer = setTimeout(hideSuggest, 120);
});

searchInput.addEventListener("keydown", (event) => {
  if (bookmarkMode) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (searchInput.value) {
        searchInput.value = "";
        void refreshBookmarkPanelContent();
        return;
      }
      exitBookmarkMode();
    }
    return;
  }

  if (searchSuggest.hidden || !suggestItems.length) {
    if (event.key === "Escape") hideSuggest();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveSuggest((activeSuggestIndex + 1) % suggestItems.length);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveSuggest(
      activeSuggestIndex <= 0 ? suggestItems.length - 1 : activeSuggestIndex - 1
    );
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideSuggest();
  }
});

searchSuggest.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

searchSuggest.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const removeBtn = target.closest(".search-suggest-remove");
  if (removeBtn) {
    const item = removeBtn.closest(".search-suggest-item");
    const text = item?.querySelector(".search-suggest-pick")?.textContent || "";
    if (text) {
      await removeSearchHistory(text);
      await refreshSuggest();
      searchInput.focus();
    }
    return;
  }

  const pickBtn = target.closest(".search-suggest-pick");
  if (pickBtn) {
    runSearch(pickBtn.textContent || "");
  }
});

function applySearchChrome() {
  searchInput.placeholder = SEARCH_PLACEHOLDER;
  searchInput.setAttribute("aria-label", "搜索");
  searchInput.setAttribute("aria-controls", "search-suggest");
  searchInput.setAttribute("enterkeyhint", "search");
  if (searchSubmit) {
    searchSubmit.setAttribute("aria-label", "搜索");
    searchSubmit.title = "搜索";
  }
  searchWrap?.removeAttribute("data-mode");
}

function applyBookmarkChrome() {
  searchInput.placeholder = BOOKMARK_PLACEHOLDER;
  searchInput.setAttribute("aria-label", "搜索书签");
  searchInput.setAttribute("aria-controls", "bookmark-panel");
  searchInput.setAttribute("enterkeyhint", "go");
  if (searchSubmit) {
    searchSubmit.setAttribute("aria-label", "打开匹配书签");
    searchSubmit.title = "打开匹配书签";
  }
  searchWrap?.setAttribute("data-mode", "bookmark");
}

/**
 * @param {{ restoreSearch?: boolean }} [options]
 */
function exitBookmarkMode(options = {}) {
  const restoreSearch = options.restoreSearch !== false;
  if (!bookmarkPanel || !bookmarkBtn) return;

  bookmarkMode = false;
  bookmarkPanel.hidden = true;
  bookmarkBtn.setAttribute("aria-expanded", "false");
  if (bookmarkSearchTimer) {
    clearTimeout(bookmarkSearchTimer);
    bookmarkSearchTimer = null;
  }

  applySearchChrome();
  if (restoreSearch) {
    searchInput.value = savedSearchValue;
  }
  savedSearchValue = "";
  if (document.activeElement === searchInput) {
    void refreshSuggest();
  }
}

function hideBookmarkPanel() {
  if (!bookmarkMode) return;
  exitBookmarkMode();
}

function isBookmarkFolder(node) {
  return !node.url;
}

function folderDefaultOpen(node) {
  return openBookmarkFolders.has(node.id);
}

/**
 * @param {chrome.bookmarks.BookmarkTreeNode} node
 * @param {number} depth
 * @param {{ showUrl?: boolean }} [options]
 */
function createBookmarkNode(node, depth, options = {}) {
  if (isBookmarkFolder(node)) {
    const children = node.children || [];
    const li = document.createElement("li");
    li.className = "bookmark-folder";
    const open = folderDefaultOpen(node);
    li.dataset.open = open ? "true" : "false";
    if (open) openBookmarkFolders.add(node.id);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "bookmark-row";
    row.dataset.folderId = node.id;

    const chevron = document.createElement("span");
    chevron.className = "bookmark-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▸";

    const icon = document.createElement("span");
    icon.className = "bookmark-folder-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';

    const title = document.createElement("span");
    title.className = "bookmark-title";
    title.textContent = node.title || "未命名文件夹";

    row.append(chevron, icon, title);
    row.setAttribute("aria-expanded", open ? "true" : "false");

    const childList = document.createElement("ul");
    childList.className = "bookmark-children";
    for (const child of children) {
      childList.append(createBookmarkNode(child, depth + 1, options));
    }

    if (!children.length) {
      const empty = document.createElement("li");
      empty.className = "bookmark-empty";
      empty.textContent = "空文件夹";
      childList.append(empty);
    }

    li.append(row, childList);
    return li;
  }

  const li = document.createElement("li");
  const row = document.createElement("button");
  row.type = "button";
  row.className = "bookmark-row";
  row.dataset.url = node.url || "";

  const spacer = document.createElement("span");
  spacer.className = "bookmark-chevron";
  spacer.setAttribute("aria-hidden", "true");

  const icon = document.createElement("img");
  icon.className = "bookmark-icon";
  icon.alt = "";
  icon.width = 16;
  icon.height = 16;
  icon.src = faviconUrl(node.url || "", 32);
  icon.loading = "lazy";

  const title = document.createElement("span");
  title.className = "bookmark-title";
  title.textContent = node.title || node.url || "未命名书签";

  row.append(spacer, icon, title);

  if (options.showUrl && node.url) {
    const urlHint = document.createElement("span");
    urlHint.className = "bookmark-url";
    urlHint.textContent = node.url;
    row.append(urlHint);
  }

  li.append(row);
  return li;
}

function renderBookmarkTree(roots) {
  bookmarkTree.innerHTML = "";
  const topFolders = roots.flatMap((root) => root.children || []);

  if (!topFolders.length) {
    const empty = document.createElement("p");
    empty.className = "bookmark-empty";
    empty.textContent = "还没有书签";
    bookmarkTree.append(empty);
    return;
  }

  const list = document.createElement("ul");
  for (const node of topFolders) {
    list.append(createBookmarkNode(node, 0));
  }
  bookmarkTree.append(list);
}

/**
 * @param {chrome.bookmarks.BookmarkTreeNode[]} results
 * @param {string} query
 */
function renderBookmarkSearchResults(results, query) {
  bookmarkTree.innerHTML = "";

  const matched = results
    .filter((node) => Boolean(node.url))
    .slice(0, BOOKMARK_SEARCH_LIMIT);

  if (!matched.length) {
    const empty = document.createElement("p");
    empty.className = "bookmark-empty";
    empty.textContent = query ? "没有匹配的书签" : "还没有书签";
    bookmarkTree.append(empty);
    return;
  }

  const list = document.createElement("ul");
  for (const node of matched) {
    list.append(createBookmarkNode(node, 0, { showUrl: true }));
  }
  bookmarkTree.append(list);
}

async function loadBookmarkTree(force = false) {
  if (!force && bookmarkRoots) return bookmarkRoots;
  if (!force && bookmarkLoadPromise) return bookmarkLoadPromise;

  bookmarkLoadPromise = chrome.bookmarks
    .getTree()
    .then((tree) => {
      bookmarkRoots = tree;
      return tree;
    })
    .finally(() => {
      bookmarkLoadPromise = null;
    });

  return bookmarkLoadPromise;
}

async function refreshBookmarkPanelContent() {
  if (!bookmarkMode || !bookmarkTree) return;
  const query = searchInput.value.trim();

  try {
    if (!query) {
      const tree = await loadBookmarkTree();
      if (bookmarkMode) renderBookmarkTree(tree);
      return;
    }

    const requestId = ++bookmarkSearchRequestId;
    const results = await chrome.bookmarks.search(query);
    if (requestId !== bookmarkSearchRequestId || !bookmarkMode) return;
    renderBookmarkSearchResults(results, query);
  } catch {
    if (!bookmarkMode) return;
    bookmarkTree.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "bookmark-empty";
    empty.textContent = "无法读取书签，请确认已授予书签权限";
    bookmarkTree.append(empty);
  }
}

function scheduleBookmarkSearch() {
  if (bookmarkSearchTimer) clearTimeout(bookmarkSearchTimer);
  bookmarkSearchTimer = setTimeout(() => {
    bookmarkSearchTimer = null;
    void refreshBookmarkPanelContent();
  }, BOOKMARK_SEARCH_DEBOUNCE_MS);
}

async function enterBookmarkMode() {
  if (!bookmarkPanel || !bookmarkBtn || !bookmarkTree) return;

  hideSuggest();
  savedSearchValue = searchInput.value;
  searchInput.value = "";
  openBookmarkFolders.clear();
  bookmarkMode = true;
  applyBookmarkChrome();
  bookmarkPanel.hidden = false;
  bookmarkBtn.setAttribute("aria-expanded", "true");
  await refreshBookmarkPanelContent();
  searchInput.focus();
}

async function toggleBookmarkMode() {
  if (bookmarkMode) {
    exitBookmarkMode();
    searchInput.focus();
    return;
  }
  await enterBookmarkMode();
}

if (bookmarkBtn && bookmarkPanel && bookmarkTree) {
  bookmarkBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleBookmarkMode();
  });

  bookmarkPanel.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });

  bookmarkPanel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const row = target.closest(".bookmark-row");
    if (!row) return;

    const folderId = row.dataset.folderId;
    if (folderId) {
      const folder = row.closest(".bookmark-folder");
      if (!(folder instanceof HTMLElement)) return;
      const open = folder.dataset.open !== "true";
      folder.dataset.open = open ? "true" : "false";
      row.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) openBookmarkFolders.add(folderId);
      else openBookmarkFolders.delete(folderId);
      return;
    }

    const url = row.dataset.url;
    if (url) {
      exitBookmarkMode({ restoreSearch: false });
      location.href = url;
    }
  });

  document.addEventListener("click", (event) => {
    if (!bookmarkMode) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (
      bookmarkPanel.contains(target) ||
      bookmarkBtn.contains(target) ||
      searchInput.contains(target) ||
      searchSubmit?.contains(target)
    ) {
      return;
    }
    exitBookmarkMode();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && bookmarkMode && document.activeElement !== searchInput) {
      exitBookmarkMode();
    }
  });

  function refreshOpenBookmarkPanel() {
    if (!bookmarkMode) {
      bookmarkRoots = null;
      return;
    }
    bookmarkRoots = null;
    void refreshBookmarkPanelContent();
  }

  if (chrome.bookmarks?.onCreated) {
    chrome.bookmarks.onCreated.addListener(refreshOpenBookmarkPanel);
    chrome.bookmarks.onRemoved.addListener(refreshOpenBookmarkPanel);
    chrome.bookmarks.onChanged.addListener(refreshOpenBookmarkPanel);
    chrome.bookmarks.onMoved.addListener(refreshOpenBookmarkPanel);
    chrome.bookmarks.onChildrenReordered?.addListener(refreshOpenBookmarkPanel);
  }
}

searchInput.focus();

function showError(message) {
  if (!message) {
    formError.hidden = true;
    formError.textContent = "";
    return;
  }
  formError.hidden = false;
  formError.textContent = message;
}

function openDialog(mode, card) {
  editingId = mode === "edit" ? card.id : null;
  dialogTitle.textContent = mode === "edit" ? "编辑卡片" : "添加卡片";
  fieldTitle.value = card?.title || "";
  fieldUrl.value = card?.url || "";
  dialogDelete.hidden = mode !== "edit";
  showError("");
  dialog.showModal();
  fieldTitle.focus();
  fieldTitle.select();
}

function closeDialog() {
  if (dialog.open) dialog.close();
  editingId = null;
  dialogDelete.hidden = true;
  showError("");
}

dialogCancel.addEventListener("click", closeDialog);

// Only Delete / Cancel / Save dismiss the dialog — not backdrop or Esc
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
});

dialogDelete.addEventListener("click", async () => {
  if (!editingId) return;
  const title = fieldTitle.value.trim() || "此卡片";
  if (!confirm(`删除「${title}」？`)) return;
  await removeCard(editingId);
  closeDialog();
  await render();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = fieldTitle.value.trim();
  const url = fieldUrl.value.trim();
  try {
    if (editingId) {
      await updateCard(editingId, { title, url });
    } else {
      await addCard({ title, url });
    }
    closeDialog();
    await render();
  } catch (err) {
    showError(err?.message || "保存失败");
  }
});

function clearDragOver() {
  grid.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
}

/** @param {number} x @param {number} y @param {HTMLElement} source */
function cardFromPoint(x, y, source) {
  const el = document.elementFromPoint(x, y);
  const target = el?.closest?.(".card:not(.card-add)");
  if (!target || target === source) return null;
  return /** @type {HTMLElement} */ (target);
}

function placeCardNear(source, target, clientX) {
  if (!target || target === source) return;
  const rect = target.getBoundingClientRect();
  const insertBefore = clientX < rect.left + rect.width / 2;
  const next = insertBefore ? target : target.nextElementSibling;
  if (next === source) return;
  if (insertBefore) {
    if (source.nextElementSibling === target) return;
    target.before(source);
  } else if (next && !next.classList.contains("card-add")) {
    if (source.previousElementSibling === target) return;
    next.before(source);
  } else {
    const addTile = grid.querySelector(".card-add");
    if (addTile) addTile.before(source);
    else grid.append(source);
  }
}

function createAddTile() {
  const li = document.createElement("li");
  li.className = "card card-add";
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.setAttribute("aria-label", "添加卡片");
  li.title = "添加卡片";

  const icon = document.createElement("div");
  icon.className = "card-icon add-icon";
  icon.textContent = "+";

  const title = document.createElement("p");
  title.className = "card-title";
  title.textContent = "添加";

  li.append(icon, title);
  li.addEventListener("click", () => openDialog("add"));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDialog("add");
    }
  });
  return li;
}

function createCardElement(card) {
  const li = document.createElement("li");
  li.className = "card";
  li.dataset.id = card.id;
  li.tabIndex = 0;
  li.setAttribute("role", "link");
  li.setAttribute("aria-label", card.title);
  li.title = "单击打开 · 长按拖动排序";

  const icon = document.createElement("div");
  icon.className = "card-icon";
  const img = document.createElement("img");
  img.src = faviconUrl(card.url, 64);
  img.alt = "";
  img.draggable = false;
  img.loading = "lazy";
  img.addEventListener("error", () => {
    img.remove();
    icon.textContent = (card.title || hostnameOf(card.url) || "?").slice(0, 1);
    icon.style.fontFamily = "var(--font-display)";
    icon.style.fontSize = "1.4rem";
    icon.style.color = "var(--accent-deep)";
  });
  icon.appendChild(img);

  const title = document.createElement("p");
  title.className = "card-title";
  title.textContent = card.title;

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "card-edit";
  editBtn.title = "编辑";
  editBtn.setAttribute("aria-label", `编辑 ${card.title}`);
  editBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.04a1.003 1.003 0 0 0 0-1.42l-2.5-2.5a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.99-1.66z"/></svg>';
  editBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openDialog("edit", card);
  });

  li.append(icon, title, editBtn);

  li.addEventListener("click", (e) => {
    if (suppressClick || e.target.closest(".card-edit")) {
      e.preventDefault();
      suppressClick = false;
      return;
    }
    openUrl(card.url, { newTab: e.metaKey || e.ctrlKey });
  });

  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      li.click();
    }
  });

  li.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".card-edit")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let activated = false;
    let moved = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = setTimeout(() => {
      activated = true;
      dragId = card.id;
      li.classList.add("long-press-ready", "dragging");
      suppressClick = true;
      try {
        li.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }, LONG_PRESS_MS);

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!activated) {
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
          if (timer) clearTimeout(timer);
          timer = null;
        }
        return;
      }

      moved = true;
      ev.preventDefault();
      clearDragOver();
      const over = cardFromPoint(ev.clientX, ev.clientY, li);
      if (over) {
        over.classList.add("drag-over");
        placeCardNear(li, over, ev.clientX);
      }
    };

    const onUp = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      li.classList.remove("long-press-ready", "dragging");
      clearDragOver();
      dragId = null;

      if (!activated) return;

      suppressClick = true;
      if (moved) {
        const ids = [...grid.querySelectorAll(".card:not(.card-add)")].map(
          (el) => el.dataset.id
        );
        await reorderCards(ids);
      }
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  return li;
}

async function render() {
  const cards = await getCards();
  grid.replaceChildren(...cards.map(createCardElement), createAddTile());
  emptyHint.hidden = cards.length > 0;
}

onStorageChange((changes) => {
  if (changes.cards) render();
});

render();

const params = new URLSearchParams(location.search);
if (params.get("add") === "1") {
  openDialog("add", {
    title: params.get("title") || "",
    url: normalizeUrl(params.get("url") || "") || "",
  });
}
