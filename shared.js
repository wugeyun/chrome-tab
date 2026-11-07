/** Shared storage helpers for Fixed Cards New Tab. */

const STORAGE_KEY = "cards";
const THEME_KEY = "theme";

/** @typedef {"light" | "dark" | "auto"} ThemeMode */

const THEME_MODES = new Set(["light", "dark", "auto"]);

/** @param {unknown} value @returns {ThemeMode} */
export function normalizeTheme(value) {
  return THEME_MODES.has(value) ? /** @type {ThemeMode} */ (value) : "auto";
}

/** @returns {Promise<ThemeMode>} */
export async function getTheme() {
  const data = await chrome.storage.local.get(THEME_KEY);
  return normalizeTheme(data[THEME_KEY]);
}

/** @param {ThemeMode} mode */
export async function setTheme(mode) {
  const next = normalizeTheme(mode);
  await chrome.storage.local.set({ [THEME_KEY]: next });
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

  const onStorage = (changes, area) => {
    if (area === "local" && changes[THEME_KEY]) {
      apply(changes[THEME_KEY].newValue);
    }
  };
  chrome.storage.onChanged.addListener(onStorage);

  return () => chrome.storage.onChanged.removeListener(onStorage);
}

/**
 * @typedef {{ id: string, title: string, url: string, createdAt: number }} Card
 */

/** @returns {Promise<Card[]>} */
export async function getCards() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const cards = data[STORAGE_KEY];
  return Array.isArray(cards) ? cards : [];
}

/** @param {Card[]} cards */
export async function saveCards(cards) {
  await chrome.storage.local.set({ [STORAGE_KEY]: cards });
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

/** Favicon via Chrome extension API (works for chrome-extension pages). */
export function faviconUrl(pageUrl, size = 64) {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", String(size));
  return url.toString();
}

export function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(
    url || ""
  );
}

/** Share links are hosted on the public repo page + hash payload. */
export const SHARE_BASE_URL = "https://github.com/wugeyun/chrome-tab";
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
 * Build a shareable GitHub URL that embeds card data in the hash.
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
