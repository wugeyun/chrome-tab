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
const searchInput = document.getElementById("search-input");
const searchSuggest = document.getElementById("search-suggest");

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

const LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 10;
const SUGGEST_LIMIT = 8;
const SUGGEST_DEBOUNCE_MS = 180;

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
  const requestId = ++suggestRequestId;
  const query = searchInput.value;
  const history = await filterSearchHistory(query, SUGGEST_LIMIT);
  if (requestId !== suggestRequestId || document.activeElement !== searchInput) return;

  const historyItems = mergeSuggest(history, []);
  renderSuggest(historyItems);

  const q = query.trim();
  if (!q) return;

  suggestAbort?.abort();
  const controller = new AbortController();
  suggestAbort = controller;

  try {
    const remote = await fetchBingSuggestions(q, controller.signal);
    if (requestId !== suggestRequestId || document.activeElement !== searchInput) return;
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

  if (/^(https?:\/\/|www\.)/i.test(q) || /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(q)) {
    const href = /^https?:\/\//i.test(q) ? q : `https://${q}`;
    location.href = href;
    return;
  }

  chrome.search.query({ text: q, disposition: "CURRENT_TAB" });
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (activeSuggestIndex >= 0 && suggestItems[activeSuggestIndex]) {
    runSearch(suggestItems[activeSuggestIndex].text);
    return;
  }
  runSearch(searchInput.value);
});

searchInput.addEventListener("input", () => {
  scheduleSuggestRefresh();
});

searchInput.addEventListener("focus", () => {
  if (suggestHideTimer) {
    clearTimeout(suggestHideTimer);
    suggestHideTimer = null;
  }
  void refreshSuggest();
});

searchInput.addEventListener("blur", () => {
  suggestHideTimer = setTimeout(hideSuggest, 120);
});

searchInput.addEventListener("keydown", (event) => {
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
    if (e.metaKey || e.ctrlKey) {
      chrome.tabs.create({ url: card.url });
    } else {
      location.href = card.url;
    }
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cards) render();
});

render();

const params = new URLSearchParams(location.search);
if (params.get("add") === "1") {
  openDialog("add", {
    title: params.get("title") || "",
    url: normalizeUrl(params.get("url") || "") || "",
  });
}
