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
