import {
  addCard,
  faviconUrl,
  getCards,
  hostnameOf,
  initTheme,
  normalizeUrl,
  removeCard,
  reorderCards,
  updateCard,
} from "./shared.js";

initTheme();

const grid = document.getElementById("card-grid");
const emptyHint = document.getElementById("empty-hint");
const bookmarksEl = document.getElementById("bookmarks");
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

/** @type {string | null} */
let editingId = null;
/** @type {string | null} */
let dragId = null;
/** Suppress click after long-press / drag reorder */
let suppressClick = false;

const LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 10;

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

searchForm.addEventListener("submit", (event) => {
  const q = searchInput.value.trim();
  if (!q) {
    event.preventDefault();
    searchInput.focus();
    return;
  }

  if (/^(https?:\/\/|www\.)/i.test(q) || /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(q)) {
    event.preventDefault();
    const href = /^https?:\/\//i.test(q) ? q : `https://${q}`;
    location.href = href;
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

/** @param {chrome.bookmarks.BookmarkTreeNode} node */
function createBookmarkItem(node) {
  if (node.url) {
    const a = document.createElement("a");
    a.className = "bm-item";
    a.href = node.url;
    a.title = node.title || node.url;

    const img = document.createElement("img");
    img.className = "bm-favicon";
    img.src = faviconUrl(node.url, 16);
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => {
      img.style.visibility = "hidden";
    });

    const span = document.createElement("span");
    span.textContent = node.title || hostnameOf(node.url);

    a.append(img, span);
    return a;
  }

  const wrap = document.createElement("div");
  wrap.className = "bm-folder";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bm-item bm-folder-btn";
  btn.title = node.title || "文件夹";
  btn.innerHTML =
    '<svg class="bm-folder-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  const label = document.createElement("span");
  label.textContent = node.title || "文件夹";
  btn.append(label);

  const menu = document.createElement("div");
  menu.className = "bm-menu";
  menu.hidden = true;

  for (const child of node.children || []) {
    if (child.url) {
      const link = document.createElement("a");
      link.className = "bm-menu-item";
      link.href = child.url;
      link.title = child.title || child.url;

      const img = document.createElement("img");
      img.src = faviconUrl(child.url, 16);
      img.alt = "";
      img.draggable = false;

      const span = document.createElement("span");
      span.textContent = child.title || hostnameOf(child.url);
      link.append(img, span);
      menu.append(link);
    } else if (child.children) {
      // Nested folder: show as labeled group heading + links one level deep
      const heading = document.createElement("div");
      heading.className = "bm-menu-heading";
      heading.textContent = child.title || "文件夹";
      menu.append(heading);
      for (const grand of child.children || []) {
        if (!grand.url) continue;
        const link = document.createElement("a");
        link.className = "bm-menu-item";
        link.href = grand.url;
        link.textContent = grand.title || hostnameOf(grand.url);
        menu.append(link);
      }
    }
  }

  if (!menu.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "bm-menu-empty";
    empty.textContent = "空文件夹";
    menu.append(empty);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeAllBookmarkMenus();
    menu.hidden = !open;
    wrap.classList.toggle("open", open);
  });

  wrap.append(btn, menu);
  return wrap;
}

function closeAllBookmarkMenus() {
  if (!bookmarksEl) return;
  bookmarksEl.querySelectorAll(".bm-menu").forEach((el) => {
    el.hidden = true;
  });
  bookmarksEl.querySelectorAll(".bm-folder.open").forEach((el) => {
    el.classList.remove("open");
  });
}

document.addEventListener("click", () => closeAllBookmarkMenus());

/** Edge already treats extension NTP as NTP for the native favorites bar. */
function isEdgeNativeFavorites() {
  return /\bEdg\//.test(navigator.userAgent);
}

async function renderBookmarks() {
  if (!bookmarksEl) return;
  if (isEdgeNativeFavorites()) {
    bookmarksEl.hidden = true;
    return;
  }
  try {
    const tree = await chrome.bookmarks.getTree();
    const barId =
      tree[0]?.children?.find((n) => n.id === "1")?.id ||
      tree[0]?.children?.[0]?.id;
    if (!barId) {
      bookmarksEl.hidden = true;
      return;
    }
    const [bar] = await chrome.bookmarks.getSubTree(barId);
    const items = (bar.children || []).filter(
      (n) => n.url || (n.children && n.children.length >= 0)
    );
    bookmarksEl.hidden = false;
    bookmarksEl.replaceChildren(...items.map(createBookmarkItem));
  } catch {
    bookmarksEl.hidden = true;
  }
}

chrome.bookmarks?.onCreated?.addListener(renderBookmarks);
chrome.bookmarks?.onRemoved?.addListener(renderBookmarks);
chrome.bookmarks?.onChanged?.addListener(renderBookmarks);
chrome.bookmarks?.onMoved?.addListener(renderBookmarks);
chrome.bookmarks?.onChildrenReordered?.addListener(renderBookmarks);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cards) render();
});

render();
renderBookmarks();

const params = new URLSearchParams(location.search);
if (params.get("add") === "1") {
  openDialog("add", {
    title: params.get("title") || "",
    url: normalizeUrl(params.get("url") || "") || "",
  });
}
