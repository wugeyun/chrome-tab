import {
  addCard,
  faviconUrl,
  getCards,
  hostnameOf,
  normalizeUrl,
  removeCard,
  reorderCards,
  updateCard,
} from "./shared.js";

const grid = document.getElementById("card-grid");
const emptyHint = document.getElementById("empty-hint");
const bookmarksEl = document.getElementById("bookmarks");
// 书签栏是横向滚动容器，会裁掉超出高度的内容，所以文件夹下拉菜单放到栏外的独立层里
const bmMenuLayer = document.createElement("div");
bmMenuLayer.className = "bm-menu-layer";
document.body.append(bmMenuLayer);
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

const FOLDER_ICON =
  '<svg class="bm-folder-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
const CHEVRON_ICON =
  '<svg class="bm-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 6.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4l-4.6 4.6a1 1 0 1 1-1.4-1.4L13.2 12 9.3 8.1a1 1 0 0 1 0-1.4z"/></svg>';

/**
 * 当前展开的菜单，按层级排列：[0] 是书签栏文件夹的下拉菜单，[1] 是它的子菜单，依此类推
 * @type {{ menu: HTMLElement, anchor: HTMLElement }[]}
 */
const openMenus = [];

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
    a.addEventListener("mouseenter", () => {
      if (openMenus.length) closeAllBookmarkMenus();
    });
    return a;
  }

  const wrap = document.createElement("div");
  wrap.className = "bm-folder";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bm-item bm-folder-btn";
  btn.title = node.title || "文件夹";
  btn.innerHTML = FOLDER_ICON;
  const label = document.createElement("span");
  label.textContent = node.title || "文件夹";
  btn.append(label);

  /** @type {HTMLElement | null} */
  let menu = null;
  const open = () => {
    menu ??= createBookmarkMenu(node, 0);
    openBookmarkMenu(0, menu, wrap);
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenus[0]?.anchor === wrap) closeAllBookmarkMenus();
    else open();
  });
  // 已经有菜单展开时，鼠标移到别的文件夹上直接切换过去（和 Chrome 原生书签栏一致）
  btn.addEventListener("mouseenter", () => {
    if (openMenus.length && openMenus[0].anchor !== wrap) open();
  });

  wrap.append(btn);
  return wrap;
}

/**
 * 创建某个文件夹的菜单；子文件夹显示为带箭头的一行，展开时再按需创建下一级菜单
 * @param {chrome.bookmarks.BookmarkTreeNode} folder
 * @param {number} level
 */
function createBookmarkMenu(folder, level) {
  const menu = document.createElement("div");
  menu.className = "bm-menu";
  menu.hidden = true;

  for (const child of folder.children || []) {
    if (child.url) {
      const link = createBookmarkMenuLink(child);
      // 鼠标移到普通书签上时，收起更深层的子菜单
      link.addEventListener("mouseenter", () => closeBookmarkMenusFrom(level + 1));
      menu.append(link);
    } else if (child.children) {
      menu.append(createBookmarkSubfolderRow(child, level));
    }
  }

  if (!menu.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "bm-menu-empty";
    empty.textContent = "空文件夹";
    menu.append(empty);
  }

  menu.addEventListener("click", (e) => e.stopPropagation());
  // 菜单自身滚动后子菜单会错位，直接收起
  menu.addEventListener("scroll", () => closeBookmarkMenusFrom(level + 1));

  bmMenuLayer.append(menu);
  return menu;
}

/**
 * 菜单里的子文件夹行：悬停或点击时在旁边弹出下一级菜单
 * @param {chrome.bookmarks.BookmarkTreeNode} folder
 * @param {number} level 这一行所在菜单的层级
 */
function createBookmarkSubfolderRow(folder, level) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "bm-menu-item bm-menu-folder";
  row.title = folder.title || "文件夹";
  row.innerHTML = FOLDER_ICON;
  const span = document.createElement("span");
  span.textContent = folder.title || "文件夹";
  row.append(span);
  row.insertAdjacentHTML("beforeend", CHEVRON_ICON);

  /** @type {HTMLElement | null} */
  let submenu = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let hoverTimer;
  const open = () => {
    clearTimeout(hoverTimer);
    if (openMenus[level + 1]?.anchor === row) return;
    submenu ??= createBookmarkMenu(folder, level + 1);
    openBookmarkMenu(level + 1, submenu, row);
  };

  row.addEventListener("click", open);
  // 稍微延迟再展开，鼠标斜着划过其他行时不会乱闪
  row.addEventListener("mouseenter", () => {
    hoverTimer = setTimeout(open, 120);
  });
  row.addEventListener("mouseleave", () => clearTimeout(hoverTimer));
  return row;
}

/**
 * 下拉菜单里的一条书签：图标 + 单行名称（过长显示省略号，悬停显示全名）
 * @param {chrome.bookmarks.BookmarkTreeNode} node
 */
function createBookmarkMenuLink(node) {
  const link = document.createElement("a");
  link.className = "bm-menu-item";
  link.href = node.url;
  const name = node.title || hostnameOf(node.url);
  link.title = node.title ? `${node.title}\n${node.url}` : node.url;

  const img = document.createElement("img");
  img.src = faviconUrl(node.url, 16);
  img.alt = "";
  img.draggable = false;
  img.addEventListener("error", () => {
    img.style.visibility = "hidden";
  });

  const span = document.createElement("span");
  span.textContent = name;
  link.append(img, span);
  return link;
}

/**
 * 在指定层级打开菜单：先收起这一层及更深的菜单，再显示并定位
 * @param {number} level
 * @param {HTMLElement} menu
 * @param {HTMLElement} anchor 第 0 层是书签栏上的文件夹，其余是菜单里的子文件夹行
 */
function openBookmarkMenu(level, menu, anchor) {
  closeBookmarkMenusFrom(level);
  menu.hidden = false;
  anchor.classList.add("open");
  openMenus[level] = { menu, anchor };
  if (level === 0) positionMenuBelow(menu, anchor);
  else positionMenuBeside(menu, anchor);
}

/** @param {number} level 收起这一层及更深的菜单 */
function closeBookmarkMenusFrom(level) {
  while (openMenus.length > level) {
    const { menu, anchor } = openMenus.pop();
    menu.hidden = true;
    anchor.classList.remove("open");
  }
}

function closeAllBookmarkMenus() {
  closeBookmarkMenusFrom(0);
}

const MENU_MARGIN = 8;

/**
 * @param {HTMLElement} menu
 * @param {HTMLElement} anchor
 */
function positionMenuBelow(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const maxLeft = window.innerWidth - menu.offsetWidth - MENU_MARGIN;
  menu.style.left = `${Math.max(MENU_MARGIN, Math.min(rect.left, maxLeft))}px`;
  menu.style.top = `${rect.bottom + 4}px`;
}

/**
 * 子菜单放在右侧，右边放不下就放到左侧；上下超出窗口时往回挪
 * @param {HTMLElement} menu
 * @param {HTMLElement} anchor
 */
function positionMenuBeside(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  let left = rect.right + 2;
  if (left + width > window.innerWidth - MENU_MARGIN) left = rect.left - width - 2;
  left = Math.max(MENU_MARGIN, left);

  const maxTop = window.innerHeight - menu.offsetHeight - MENU_MARGIN;
  const top = Math.max(MENU_MARGIN, Math.min(rect.top - 6, maxTop));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

document.addEventListener("click", () => closeAllBookmarkMenus());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllBookmarkMenus();
});
bookmarksEl.addEventListener("scroll", () => closeAllBookmarkMenus());
window.addEventListener("resize", () => closeAllBookmarkMenus());

async function renderBookmarks() {
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
    closeAllBookmarkMenus();
    bmMenuLayer.replaceChildren();
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
