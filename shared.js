/** Shared storage helpers for Fixed Cards New Tab (extension + web). */

const STORAGE_KEY = "cards";
const THEME_KEY = "theme";
const SEARCH_HISTORY_KEY = "searchHistory";
const SEARCH_HISTORY_LIMIT = 20;
const WEB_STORAGE_PREFIX = "wuge-newtab:";

/** @typedef {"light" | "dark" | "auto"} ThemeMode */

const THEME_MODES = new Set(["light", "dark", "auto"]);

/** True when running inside the Chromium extension pages. */
export function isExtensionContext() {
  try {
    return typeof chrome !== "undefined" && !!chrome?.storage?.local;
  } catch {
    return false;
  }
}

/** @param {unknown} value @returns {ThemeMode} */
export function normalizeTheme(value) {
  return THEME_MODES.has(value) ? /** @type {ThemeMode} */ (value) : "auto";
}

/** @param {string} key */
function webStorageKey(key) {
  return `${WEB_STORAGE_PREFIX}${key}`;
}

/** @param {string} key @param {unknown} fallback */
function readWebValue(key, fallback) {
  try {
    const raw = localStorage.getItem(webStorageKey(key));
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {unknown} value */
function writeWebValue(key, value) {
  localStorage.setItem(webStorageKey(key), JSON.stringify(value));
  try {
    window.dispatchEvent(
      new CustomEvent("wuge-storage", { detail: { key, value } })
    );
  } catch {
    /* ignore */
  }
}

/** @param {string[]} keys @returns {Promise<Record<string, unknown>>} */
async function storageGet(keys) {
  if (isExtensionContext()) {
    return chrome.storage.local.get(keys);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of keys) {
    const value = readWebValue(key, undefined);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** @param {Record<string, unknown>} values */
async function storageSet(values) {
  if (isExtensionContext()) {
    await chrome.storage.local.set(values);
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    writeWebValue(key, value);
  }
}

/**
 * Listen for local storage key changes in both extension and web.
 * @param {(changes: Record<string, { newValue?: unknown }>) => void} callback
 * @returns {() => void}
 */
export function onStorageChange(callback) {
  if (isExtensionContext()) {
    /** @param {Record<string, chrome.storage.StorageChange>} changes @param {string} area */
    const listener = (changes, area) => {
      if (area !== "local") return;
      /** @type {Record<string, { newValue?: unknown }>} */
      const mapped = {};
      for (const [key, change] of Object.entries(changes)) {
        mapped[key] = { newValue: change.newValue };
      }
      callback(mapped);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  /** @param {CustomEvent<{ key: string, value: unknown }>} event */
  const onLocal = (event) => {
    const key = event.detail?.key;
    if (!key) return;
    callback({ [key]: { newValue: event.detail.value } });
  };
  /** @param {StorageEvent} event */
  const onWindow = (event) => {
    if (!event.key || !event.key.startsWith(WEB_STORAGE_PREFIX)) return;
    const key = event.key.slice(WEB_STORAGE_PREFIX.length);
    let newValue;
    try {
      newValue = event.newValue == null ? undefined : JSON.parse(event.newValue);
    } catch {
      newValue = undefined;
    }
    callback({ [key]: { newValue } });
  };
  window.addEventListener("wuge-storage", /** @type {EventListener} */ (onLocal));
  window.addEventListener("storage", onWindow);
  return () => {
    window.removeEventListener("wuge-storage", /** @type {EventListener} */ (onLocal));
    window.removeEventListener("storage", onWindow);
  };
}

/** @returns {Promise<ThemeMode>} */
export async function getTheme() {
  const data = await storageGet([THEME_KEY]);
  return normalizeTheme(data[THEME_KEY]);
}

/** @param {ThemeMode} mode */
export async function setTheme(mode) {
  const next = normalizeTheme(mode);
  await storageSet({ [THEME_KEY]: next });
  return next;
}

/**
 * Apply theme to the document and keep it in sync with storage / system preference.
 * @returns {Promise<() => void>} disposer
 */
export async function initTheme() {
  const apply = (mode) => {
    document.documentElement.dataset.theme = normalizeTheme(mode);
  };

  apply(await getTheme());

  const dispose = onStorageChange((changes) => {
    if (changes[THEME_KEY]) {
      apply(changes[THEME_KEY].newValue);
    }
  });

  return dispose;
}

/**
 * @typedef {{ id: string, title: string, url: string, createdAt: number }} Card
 */

/** @returns {Promise<string[]>} */
export async function getSearchHistory() {
  const data = await storageGet([SEARCH_HISTORY_KEY]);
  const list = data[SEARCH_HISTORY_KEY];
  return Array.isArray(list) ? list.filter((q) => typeof q === "string" && q.trim()) : [];
}

/** @param {string} query */
export async function addSearchHistory(query) {
  const q = query.trim();
  if (!q) return getSearchHistory();

  const prev = await getSearchHistory();
  const next = [q, ...prev.filter((item) => item.toLowerCase() !== q.toLowerCase())].slice(
    0,
    SEARCH_HISTORY_LIMIT
  );
  await storageSet({ [SEARCH_HISTORY_KEY]: next });
  return next;
}

/** @param {string} query */
export async function removeSearchHistory(query) {
  const q = query.trim().toLowerCase();
  const prev = await getSearchHistory();
  const next = prev.filter((item) => item.toLowerCase() !== q);
  await storageSet({ [SEARCH_HISTORY_KEY]: next });
  return next;
}

/**
 * @param {string} query
 * @param {number} [limit=8]
 * @returns {Promise<string[]>}
 */
export async function filterSearchHistory(query, limit = 8) {
  const needle = query.trim().toLowerCase();
  const list = await getSearchHistory();
  const matched = needle
    ? list.filter((item) => item.toLowerCase().includes(needle))
    : list;
  return matched.slice(0, limit);
}

/**
 * Bing OpenSearch-style suggestions: ["query", ["a", "b", ...]]
 * Web uses same-origin proxy to avoid CORS.
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function fetchBingSuggestions(query, signal) {
  const q = query.trim();
  if (!q) return [];

  const url = isExtensionContext()
    ? `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`
    : `/api/bing-suggest?query=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, credentials: "omit" });
  if (!res.ok) return [];

  const data = await res.json();
  const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
  return list.filter((item) => typeof item === "string" && item.trim());
}

/** Open a URL in the current tab or a new browser tab. */
export function openUrl(url, { newTab = false } = {}) {
  if (newTab && isExtensionContext() && chrome.tabs?.create) {
    chrome.tabs.create({ url });
    return;
  }
  if (newTab) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  location.href = url;
}

/**
 * Search or navigate. Extension uses chrome.search when available.
 * @param {string} raw
 */
export function performSearch(raw) {
  const q = raw.trim();
  if (!q) return;

  if (/^(https?:\/\/|www\.)/i.test(q) || /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(q)) {
    const href = /^https?:\/\//i.test(q) ? q : `https://${q}`;
    location.href = href;
    return;
  }

  if (isExtensionContext() && chrome.search?.query) {
    chrome.search.query({ text: q, disposition: "CURRENT_TAB" });
    return;
  }

  location.href = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
}

/** @returns {Promise<Card[]>} */
export async function getCards() {
  const data = await storageGet([STORAGE_KEY]);
  const cards = data[STORAGE_KEY];
  return Array.isArray(cards) ? cards : [];
}

/** @param {Card[]} cards */
export async function saveCards(cards) {
  await storageSet({ [STORAGE_KEY]: cards });
}

/** @param {{ title: string, url: string }} input */
export async function addCard({ title, url }) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    throw new Error("网址无效");
  }

  const cards = await getCards();
  const existing = cards.find((c) => urlsEqual(c.url, normalizedUrl));
  if (existing) {
    return { card: existing, created: false };
  }

  const card = {
    id: crypto.randomUUID(),
    title: (title || hostnameOf(normalizedUrl)).trim() || "未命名",
    url: normalizedUrl,
    createdAt: Date.now(),
  };
  cards.push(card);
  await saveCards(cards);
  return { card, created: true };
}

/** @param {string} id @param {{ title?: string, url?: string }} patch */
export async function updateCard(id, patch) {
  const cards = await getCards();
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) throw new Error("卡片不存在");

  const next = { ...cards[index] };
  if (typeof patch.title === "string") {
    next.title = patch.title.trim() || "未命名";
  }
  if (typeof patch.url === "string") {
    const normalizedUrl = normalizeUrl(patch.url);
    if (!normalizedUrl) throw new Error("网址无效");
    next.url = normalizedUrl;
  }
  cards[index] = next;
  await saveCards(cards);
  return next;
}

/** @param {string} id */
export async function removeCard(id) {
  const cards = await getCards();
  await saveCards(cards.filter((c) => c.id !== id));
}

/** @param {string[]} orderedIds */
export async function reorderCards(orderedIds) {
  const cards = await getCards();
  const map = new Map(cards.map((c) => [c.id, c]));
  const next = [];
  for (const id of orderedIds) {
    const card = map.get(id);
    if (card) {
      next.push(card);
      map.delete(id);
    }
  }
  for (const leftover of map.values()) next.push(leftover);
  await saveCards(next);
  return next;
}

/** @param {string} raw */
export function normalizeUrl(raw) {
  const value = (raw || "").trim();
  if (!value) return "";
  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
      ? value
      : `https://${value}`;
    const url = new URL(withProtocol);
    if (!/^https?:$/i.test(url.protocol)) return "";
    return url.href;
  } catch {
    return "";
  }
}

/** @param {string} a @param {string} b */
function urlsEqual(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.hostname.replace(/^www\./, "") === ub.hostname.replace(/^www\./, "") &&
      ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "") &&
      ua.search === ub.search
    );
  } catch {
    return a === b;
  }
}

/** @param {string} href */
export function hostnameOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

/** Favicon: extension API in Chrome, public icon service on web. */
export function faviconUrl(pageUrl, size = 64) {
  if (isExtensionContext() && chrome.runtime?.getURL) {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", String(size));
    return url.toString();
  }
  return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(pageUrl)}&sz=${size}`;
}

export function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(
    url || ""
  );
}

/** Share links open on the web new-tab site; hash carries card payload. */
export const SHARE_BASE_URL = "https://tab.wuge.xyz";
const SHARE_HASH_PREFIX = "wuge=";

/** @param {Card[]} cards */
export function buildExportPayload(cards) {
  return {
    app: "wuge-newtab",
    version: 1,
    exportedAt: new Date().toISOString(),
    cards: cards.map((c) => ({
      id: c.id,
      title: c.title,
      url: c.url,
      createdAt: c.createdAt,
    })),
  };
}

/**
 * Parse import JSON. Accepts `{ cards: [...] }` or a bare card array.
 * @param {unknown} raw
 * @returns {Card[]}
 */
export function parseImportPayload(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.cards)
      ? raw.cards
      : Array.isArray(raw?.c)
        ? raw.c
        : null;
  if (!list) throw new Error("链接格式无效：需要包含卡片数据");

  /** @type {Card[]} */
  const cards = [];
  for (const item of list) {
    if (Array.isArray(item)) {
      const url = normalizeUrl(String(item[1] || ""));
      if (!url) continue;
      cards.push({
        id: crypto.randomUUID(),
        title: String(item[0] || hostnameOf(url)).trim() || "未命名",
        url,
        createdAt: Date.now(),
      });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const url = normalizeUrl(String(item.url || item.u || ""));
    if (!url) continue;
    cards.push({
      id:
        typeof item.id === "string" && item.id
          ? item.id
          : crypto.randomUUID(),
      title: String(item.title || item.t || hostnameOf(url)).trim() || "未命名",
      url,
      createdAt:
        typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
          ? item.createdAt
          : Date.now(),
    });
  }
  if (!cards.length) throw new Error("链接中没有有效卡片");
  return cards;
}

/** @param {Uint8Array} bytes */
function bytesToBase64Url(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text */
function base64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
async function deflate(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {Uint8Array} bytes */
async function inflate(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Build a shareable URL that embeds card data in the hash.
 * @param {Card[]} cards
 */
export async function buildShareUrl(cards) {
  if (!cards.length) throw new Error("当前没有可导出的卡片");
  const compact = {
    a: "wuge-newtab",
    v: 1,
    c: cards.map((card) => [card.title, card.url]),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(compact));
  const compressed = await deflate(jsonBytes);
  const payload = `1.${bytesToBase64Url(compressed)}`;
  return `${SHARE_BASE_URL}#${SHARE_HASH_PREFIX}${payload}`;
}

/**
 * Extract share payload token from a full URL, hash, or raw token.
 * @param {string} raw
 * @returns {string | null}
 */
export function extractShareToken(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  try {
    if (/^https?:\/\//i.test(text)) {
      const url = new URL(text);
      const fromHash = url.hash.replace(/^#/, "");
      if (fromHash.startsWith(SHARE_HASH_PREFIX)) {
        return fromHash.slice(SHARE_HASH_PREFIX.length);
      }
      const fromQuery = url.searchParams.get("wuge");
      if (fromQuery) return fromQuery;
    }
  } catch {
    /* fall through */
  }

  const hash = text.startsWith("#") ? text.slice(1) : text;
  if (hash.startsWith(SHARE_HASH_PREFIX)) {
    return hash.slice(SHARE_HASH_PREFIX.length);
  }
  if (/^\d+\./.test(hash)) return hash;
  return null;
}

/**
 * Decode cards from a share URL / hash / token.
 * @param {string} raw
 * @returns {Promise<Card[]>}
 */
export async function parseShareUrl(raw) {
  const token = extractShareToken(raw);
  if (!token) throw new Error("未识别到有效的分享链接");

  const dot = token.indexOf(".");
  if (dot < 0) throw new Error("分享链接格式无效");
  const version = token.slice(0, dot);
  const body = token.slice(dot + 1);
  if (version !== "1" || !body) throw new Error("不支持的分享链接版本");

  try {
    const inflated = await inflate(base64UrlToBytes(body));
    const json = new TextDecoder().decode(inflated);
    return parseImportPayload(JSON.parse(json));
  } catch (err) {
    if (err instanceof Error && /有效卡片|格式无效|链接/.test(err.message)) {
      throw err;
    }
    throw new Error("分享链接已损坏或无法解析");
  }
}

/**
 * @param {Card[]} incoming
 * @param {"merge" | "replace"} mode
 */
export async function importCards(incoming, mode) {
  if (mode === "replace") {
    await saveCards(incoming);
    return { total: incoming.length, added: incoming.length, skipped: 0 };
  }

  const existing = await getCards();
  const next = [...existing];
  let added = 0;
  let skipped = 0;
  for (const card of incoming) {
    if (next.some((c) => urlsEqual(c.url, card.url))) {
      skipped += 1;
      continue;
    }
    next.push({
      ...card,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    });
    added += 1;
  }
  await saveCards(next);
  return { total: next.length, added, skipped };
}
