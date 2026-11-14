/** Shared storage helpers for Fixed Cards New Tab. */

const STORAGE_KEY = "cards";
const THEME_KEY = "theme";
const SEARCH_HISTORY_KEY = "searchHistory";
const SEARCH_HISTORY_LIMIT = 20;
const SYNC_CONFIG_KEY = "syncConfig";
const DELETED_URLS_KEY = "cardDeletedUrls";
const DELETED_URLS_LIMIT = 500;

/** Public sync API (Cloudflare Worker on custom domain). */
export const SYNC_API_BASE = "https://tab.wuge.xyz";
const SYNC_CODE_PREFIX = "WUGE1.";
const SYNC_ID_BYTES = 12;
const SYNC_SECRET_BYTES = 16;
const SYNC_QUEUE_MS = 800;
const SYNC_MAX_RETRIES = 3;
/** Must match sync-worker POW_BITS (first-create anti-spam). */
const SYNC_POW_BITS = 18;

/**
 * @typedef {{
 *   enabled: boolean,
 *   syncId: string,
 *   secret: string,
 *   lastSyncedAt: number | null,
 *   lastRevision: number,
 *   lastError: string | null,
 *   revoked: boolean,
 * }} SyncConfig
 */

export const SYNC_REVOKED_MESSAGE = "同步码已失效，请在选项页绑定新码";

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

/** @returns {Promise<string[]>} */
export async function getSearchHistory() {
  const data = await chrome.storage.local.get(SEARCH_HISTORY_KEY);
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
  await chrome.storage.local.set({ [SEARCH_HISTORY_KEY]: next });
  return next;
}

/** @param {string} query */
export async function removeSearchHistory(query) {
  const q = query.trim().toLowerCase();
  const prev = await getSearchHistory();
  const next = prev.filter((item) => item.toLowerCase() !== q);
  await chrome.storage.local.set({ [SEARCH_HISTORY_KEY]: next });
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
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function fetchBingSuggestions(query, signal) {
  const q = query.trim();
  if (!q) return [];

  const url = `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, credentials: "omit" });
  if (!res.ok) return [];

  const data = await res.json();
  const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
  return list.filter((item) => typeof item === "string" && item.trim());
}

/** @returns {Promise<Card[]>} */
export async function getCards() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const cards = data[STORAGE_KEY];
  return Array.isArray(cards) ? cards : [];
}

/**
 * @param {Card[]} cards
 * @param {{ skipSyncQueue?: boolean }} [opts]
 */
export async function saveCards(cards, opts = {}) {
  await chrome.storage.local.set({ [STORAGE_KEY]: cards });
  if (!opts.skipSyncQueue) queueSync();
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

  await forgetDeletedUrl(normalizedUrl);

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

  const prev = cards[index];
  const next = { ...prev };
  if (typeof patch.title === "string") {
    next.title = patch.title.trim() || "未命名";
  }
  if (typeof patch.url === "string") {
    const normalizedUrl = normalizeUrl(patch.url);
    if (!normalizedUrl) throw new Error("网址无效");
    if (!urlsEqual(prev.url, normalizedUrl)) {
      await rememberDeletedUrl(prev.url);
      await forgetDeletedUrl(normalizedUrl);
    }
    next.url = normalizedUrl;
  }
  cards[index] = next;
  await saveCards(cards);
  return next;
}

/** @param {string} id */
export async function removeCard(id) {
  const cards = await getCards();
  const target = cards.find((c) => c.id === id);
  if (target) await rememberDeletedUrl(target.url);
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
    await clearDeletedUrls();
    for (const card of incoming) await forgetDeletedUrl(card.url);
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
    await forgetDeletedUrl(card.url);
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

/* ---------- Cloud sync (anonymous sync code) ---------- */

/** @returns {SyncConfig} */
function emptySyncConfig() {
  return {
    enabled: false,
    syncId: "",
    secret: "",
    lastSyncedAt: null,
    lastRevision: 0,
    lastError: null,
    revoked: false,
  };
}

/** @returns {Promise<SyncConfig>} */
export async function getSyncConfig() {
  const data = await chrome.storage.local.get(SYNC_CONFIG_KEY);
  const raw = data[SYNC_CONFIG_KEY];
  if (!raw || typeof raw !== "object") return emptySyncConfig();
  return {
    enabled: Boolean(raw.enabled),
    syncId: typeof raw.syncId === "string" ? raw.syncId : "",
    secret: typeof raw.secret === "string" ? raw.secret : "",
    lastSyncedAt:
      typeof raw.lastSyncedAt === "number" && Number.isFinite(raw.lastSyncedAt)
        ? raw.lastSyncedAt
        : null,
    lastRevision:
      typeof raw.lastRevision === "number" && Number.isFinite(raw.lastRevision)
        ? raw.lastRevision
        : 0,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    revoked: Boolean(raw.revoked),
  };
}

/** @param {Partial<SyncConfig>} patch */
export async function setSyncConfig(patch) {
  const prev = await getSyncConfig();
  const next = { ...prev, ...patch };
  await chrome.storage.local.set({ [SYNC_CONFIG_KEY]: next });
  return next;
}

/** @returns {Promise<string[]>} */
async function getDeletedUrls() {
  const data = await chrome.storage.local.get(DELETED_URLS_KEY);
  const list = data[DELETED_URLS_KEY];
  return Array.isArray(list)
    ? list.filter((u) => typeof u === "string" && u)
    : [];
}

/** @param {string[]} urls */
async function saveDeletedUrls(urls) {
  const trimmed = urls.slice(-DELETED_URLS_LIMIT);
  await chrome.storage.local.set({ [DELETED_URLS_KEY]: trimmed });
}

async function clearDeletedUrls() {
  await chrome.storage.local.set({ [DELETED_URLS_KEY]: [] });
}

/** @param {string} url */
async function rememberDeletedUrl(url) {
  const key = normalizeUrl(url) || url;
  if (!key) return;
  const list = await getDeletedUrls();
  if (list.some((u) => urlsEqual(u, key))) return;
  list.push(key);
  await saveDeletedUrls(list);
}

/** @param {string} url */
async function forgetDeletedUrl(url) {
  const key = normalizeUrl(url) || url;
  if (!key) return;
  const list = await getDeletedUrls();
  const next = list.filter((u) => !urlsEqual(u, key));
  if (next.length !== list.length) await saveDeletedUrls(next);
}

/** @param {Uint8Array} bytes */
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {string} hex */
function hexToBytes(hex) {
  const clean = hex.toLowerCase();
  if (!/^[a-f0-9]+$/.test(clean) || clean.length % 2) {
    throw new Error("无效的同步码");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode sync id + secret into one copyable code.
 * @param {string} syncId hex
 * @param {string} secret hex
 */
export function formatSyncCode(syncId, secret) {
  const idBytes = hexToBytes(syncId);
  const secretBytes = hexToBytes(secret);
  if (idBytes.length !== SYNC_ID_BYTES || secretBytes.length !== SYNC_SECRET_BYTES) {
    throw new Error("同步码内部格式错误");
  }
  const packed = new Uint8Array(SYNC_ID_BYTES + SYNC_SECRET_BYTES);
  packed.set(idBytes, 0);
  packed.set(secretBytes, SYNC_ID_BYTES);
  return `${SYNC_CODE_PREFIX}${bytesToBase64Url(packed)}`;
}

/**
 * @param {string} raw
 * @returns {{ syncId: string, secret: string }}
 */
export function parseSyncCode(raw) {
  let text = (raw || "").trim().replace(/\s+/g, "");
  if (!text) throw new Error("请输入同步码");

  if (!text.startsWith(SYNC_CODE_PREFIX)) {
    // Allow pasting without prefix if it looks like base64url body
    if (/^[A-Za-z0-9_-]+$/.test(text) && text.length > 20) {
      text = `${SYNC_CODE_PREFIX}${text}`;
    } else {
      throw new Error("同步码格式无效，应以 WUGE1. 开头");
    }
  }

  const body = text.slice(SYNC_CODE_PREFIX.length);
  let packed;
  try {
    packed = base64UrlToBytes(body);
  } catch {
    throw new Error("同步码无法解析");
  }
  if (packed.length !== SYNC_ID_BYTES + SYNC_SECRET_BYTES) {
    throw new Error("同步码长度不正确");
  }
  return {
    syncId: bytesToHex(packed.subarray(0, SYNC_ID_BYTES)),
    secret: bytesToHex(packed.subarray(SYNC_ID_BYTES)),
  };
}

function generateSyncCredentials() {
  const idBytes = crypto.getRandomValues(new Uint8Array(SYNC_ID_BYTES));
  const secretBytes = crypto.getRandomValues(new Uint8Array(SYNC_SECRET_BYTES));
  const syncId = bytesToHex(idBytes);
  const secret = bytesToHex(secretBytes);
  return { syncId, secret, code: formatSyncCode(syncId, secret) };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} bits
 */
function hasLeadingZeroBits(bytes, bits) {
  const fullBytes = Math.floor(bits / 8);
  const rem = bits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  if (rem === 0) return true;
  const mask = 0xff << (8 - rem);
  return (bytes[fullBytes] & mask) === 0;
}

/**
 * Solve SHA-256(syncId + ":" + nonce) with SYNC_POW_BITS leading zero bits.
 * Used only when creating an empty cloud slot.
 * @param {string} syncId
 * @param {number} [bits]
 * @returns {Promise<string>} nonce hex
 */
async function solveSyncPow(syncId, bits = SYNC_POW_BITS) {
  const enc = new TextEncoder();
  for (let n = 0; n < 16_777_216; n += 1) {
    const nonce = n.toString(16);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", enc.encode(`${syncId}:${nonce}`))
    );
    if (hasLeadingZeroBits(digest, bits)) return nonce;
  }
  throw new Error("同步防刷校验超时，请重试");
}

/** @returns {Promise<{ syncId: string, secret: string, code: string }>} */
export async function createSyncSession() {
  const { syncId, secret, code } = generateSyncCredentials();
  await setSyncConfig({
    enabled: true,
    syncId,
    secret,
    lastSyncedAt: null,
    lastRevision: 0,
    lastError: null,
    revoked: false,
  });
  await syncNow({ force: true });
  return { syncId, secret, code };
}

/** @param {string} rawCode */
export async function bindSyncCode(rawCode) {
  const { syncId, secret } = parseSyncCode(rawCode);
  await setSyncConfig({
    enabled: true,
    syncId,
    secret,
    lastSyncedAt: null,
    lastRevision: 0,
    lastError: null,
    revoked: false,
  });
  const result = await syncNow({ force: true });
  return result;
}

/** Pause sync locally; keep sync code so it can resume later. */
export async function pauseSync() {
  const config = await getSyncConfig();
  if (!config.syncId || !config.secret) {
    throw new Error("尚未绑定同步码");
  }
  await setSyncConfig({
    enabled: false,
    lastError: null,
  });
}

/** Resume a previously paused sync with the same code. */
export async function resumeSync() {
  const config = await getSyncConfig();
  if (!config.syncId || !config.secret) {
    throw new Error("尚未绑定同步码");
  }
  if (config.revoked) {
    throw new Error(SYNC_REVOKED_MESSAGE);
  }
  await setSyncConfig({ enabled: true, lastError: null, revoked: false });
  return syncNow({ force: true });
}

/** Clear local sync binding only (does not revoke cloud slot). */
export async function unbindSync() {
  await setSyncConfig(emptySyncConfig());
}

/** @deprecated use pauseSync — kept for older UI call sites */
export async function disableSync() {
  return pauseSync();
}

/**
 * Rotate to a new sync code: upload to new slot, revoke old slot immediately.
 * Local cards are preserved. Other devices on the old code will see revoked.
 * @returns {Promise<{ syncId: string, secret: string, code: string }>}
 */
export async function rotateSyncCode() {
  const prev = await getSyncConfig();
  if (!prev.syncId || !prev.secret) {
    throw new Error("尚未绑定同步码");
  }
  if (prev.revoked) {
    throw new Error(SYNC_REVOKED_MESSAGE);
  }

  if (prev.enabled) {
    try {
      await syncNow({ force: true });
    } catch (err) {
      if (err instanceof Error && err.message === SYNC_REVOKED_MESSAGE) {
        throw err;
      }
      // Continue with local snapshot if last push failed for transient reasons.
    }
  }

  const cards = await getCards();
  const deletedUrls = await getDeletedUrls();
  const next = generateSyncCredentials();
  const ciphertext = await encryptPayload(
    buildSyncPayload(cards, deletedUrls),
    next.secret
  );

  const pow = await solveSyncPow(next.syncId);
  const putRes = await fetch(syncEndpoint(next.syncId), {
    method: "PUT",
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      "If-Match": '"0"',
      "X-PoW": pow,
    },
    body: JSON.stringify({ ciphertext, revision: 0 }),
  });
  if (!putRes.ok) {
    throw new Error(await describeSyncHttpError("创建新同步槽失败", putRes));
  }
  const putBody = await putRes.json().catch(() => ({}));
  const nextRevision = Number(putBody.revision) || 1;

  const revokeRes = await fetch(syncEndpoint(prev.syncId), {
    method: "DELETE",
    credentials: "omit",
    cache: "no-store",
  });
  if (!revokeRes.ok && revokeRes.status !== 404) {
    throw new Error(await describeSyncHttpError("作废旧同步码失败", revokeRes));
  }

  await setSyncConfig({
    enabled: true,
    syncId: next.syncId,
    secret: next.secret,
    lastSyncedAt: Date.now(),
    lastRevision: nextRevision,
    lastError: null,
    revoked: false,
  });

  return next;
}

/** @param {string} secretHex */
async function importAesKey(secretHex) {
  const keyBytes = hexToBytes(secretHex);
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * @param {object} payload
 * @param {string} secretHex
 */
async function encryptPayload(payload, secretHex) {
  const key = await importAesKey(secretHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  const cipher = new Uint8Array(cipherBuf);
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToBase64Url(packed);
}

/**
 * @param {string} ciphertext
 * @param {string} secretHex
 */
async function decryptPayload(ciphertext, secretHex) {
  const packed = base64UrlToBytes(ciphertext);
  if (packed.length < 13) throw new Error("远端数据损坏");
  const iv = packed.subarray(0, 12);
  const cipher = packed.subarray(12);
  const key = await importAesKey(secretHex);
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipher
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    throw new Error("解密失败：同步码可能不正确");
  }
}

/**
 * Merge local + remote cards; apply deleted URL tombstones.
 * Local order wins; remote-only cards append.
 * @param {Card[]} local
 * @param {Card[]} remote
 * @param {string[]} deletedUrls
 * @returns {Card[]}
 */
export function mergeCardsForSync(local, remote, deletedUrls = []) {
  /** @type {Card[]} */
  const merged = [];

  const isDeleted = (url) => deletedUrls.some((d) => urlsEqual(d, url));

  for (const card of local) {
    if (isDeleted(card.url)) continue;
    merged.push(card);
  }

  for (const card of remote) {
    if (isDeleted(card.url)) continue;
    const idx = merged.findIndex((c) => urlsEqual(c.url, card.url));
    if (idx < 0) {
      merged.push({
        id: crypto.randomUUID(),
        title: (card.title || hostnameOf(card.url)).trim() || "未命名",
        url: card.url,
        createdAt:
          typeof card.createdAt === "number" && Number.isFinite(card.createdAt)
            ? card.createdAt
            : Date.now(),
      });
      continue;
    }
    const cur = merged[idx];
    const remoteNewer =
      (card.createdAt || 0) > (cur.createdAt || 0) &&
      (card.title || "").trim() &&
      card.title !== cur.title;
    if (remoteNewer) {
      merged[idx] = {
        ...cur,
        title: card.title.trim() || cur.title,
        createdAt: cur.createdAt || card.createdAt || Date.now(),
      };
    }
  }

  return merged;
}

/**
 * @param {Card[]} cards
 * @param {string[]} deletedUrls
 */
function buildSyncPayload(cards, deletedUrls) {
  return {
    v: 1,
    updatedAt: Date.now(),
    cards: cards.map((c) => ({
      title: c.title,
      url: c.url,
      createdAt: c.createdAt,
    })),
    deleted: deletedUrls.slice(-DELETED_URLS_LIMIT),
  };
}

/**
 * @param {unknown} payload
 * @returns {{ cards: Card[], deleted: string[] }}
 */
function parseSyncPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("远端数据格式无效");
  }
  const cardsRaw = Array.isArray(payload.cards) ? payload.cards : [];
  /** @type {Card[]} */
  const cards = [];
  for (const item of cardsRaw) {
    if (!item || typeof item !== "object") continue;
    const url = normalizeUrl(String(item.url || ""));
    if (!url) continue;
    cards.push({
      id: crypto.randomUUID(),
      title: String(item.title || hostnameOf(url)).trim() || "未命名",
      url,
      createdAt:
        typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
          ? item.createdAt
          : Date.now(),
    });
  }
  const deleted = Array.isArray(payload.deleted)
    ? payload.deleted
        .filter((u) => typeof u === "string" && u)
        .map((u) => normalizeUrl(u) || u)
    : [];
  return { cards, deleted };
}

/** @param {string} syncId */
function syncEndpoint(syncId) {
  return `${SYNC_API_BASE}/v1/sync/${syncId}`;
}

/**
 * @param {string} prefix
 * @param {Response} res
 */
async function describeSyncHttpError(prefix, res) {
  if (res.status === 410) {
    return SYNC_REVOKED_MESSAGE;
  }
  let detail = "";
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const body = await res.json();
      if (body?.error === "revoked") return SYNC_REVOKED_MESSAGE;
      if (body?.error === "pow_required") {
        return `${prefix}：同步服务已升级防刷校验，请更新扩展后重试`;
      }
      if (body?.error) detail = `：${body.error}`;
    } catch {
      /* ignore */
    }
  }
  if (res.status === 404 || res.status === 502 || res.status === 503) {
    return `${prefix}：同步服务暂时不可用，请稍后重试`;
  }
  if (res.status === 429) {
    return `${prefix}：请求过于频繁，请稍后再试`;
  }
  return `${prefix}（${res.status}${detail}）`;
}

/** @param {string} message */
async function markSyncRevoked(message = SYNC_REVOKED_MESSAGE) {
  await setSyncConfig({
    enabled: false,
    revoked: true,
    lastError: message,
  });
}

let syncInFlight = null;
let syncTimer = null;
let syncQueued = false;

/** Debounced sync after local edits. */
export function queueSync() {
  syncQueued = true;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    flushSyncQueue();
  }, SYNC_QUEUE_MS);
}

function flushSyncQueue() {
  if (syncInFlight) {
    syncQueued = true;
    return;
  }
  if (!syncQueued) return;
  syncQueued = false;
  syncNow().catch(() => {
    /* lastError persisted in syncNow */
  });
}

/**
 * Pull → merge → save → push. Safe to call often; concurrent calls share one flight.
 * @param {{ force?: boolean }} [opts]
 */
export async function syncNow(opts = {}) {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }

  syncInFlight = (async () => {
    const config = await getSyncConfig();
    if (!config.enabled || !config.syncId || !config.secret) {
      if (opts.force) throw new Error("尚未开启同步");
      return { skipped: true };
    }

    try {
      let revision = 0;
      let remoteCards = [];
      let remoteDeleted = [];

      for (let attempt = 0; attempt < SYNC_MAX_RETRIES; attempt += 1) {
        const getRes = await fetch(syncEndpoint(config.syncId), {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
        });
        if (getRes.status === 410) {
          await markSyncRevoked();
          throw new Error(SYNC_REVOKED_MESSAGE);
        }
        if (!getRes.ok) {
          throw new Error(await describeSyncHttpError("同步拉取失败", getRes));
        }
        let getBody;
        try {
          getBody = await getRes.json();
        } catch {
          throw new Error("同步服务响应异常，请稍后重试");
        }
        revision = Number(getBody.revision) || 0;

        if (getBody.ciphertext) {
          const payload = await decryptPayload(getBody.ciphertext, config.secret);
          const parsed = parseSyncPayload(payload);
          remoteCards = parsed.cards;
          remoteDeleted = parsed.deleted;
        } else {
          remoteCards = [];
          remoteDeleted = [];
        }

        const localCards = await getCards();
        const localDeleted = await getDeletedUrls();
        const deletedUrls = [...localDeleted];
        for (const url of remoteDeleted) {
          if (!deletedUrls.some((d) => urlsEqual(d, url))) deletedUrls.push(url);
        }

        // Keep local cards even when remote is empty (e.g. never uploaded yet).
        const merged = mergeCardsForSync(localCards, remoteCards, deletedUrls);
        await saveDeletedUrls(deletedUrls);
        await saveCards(merged, { skipSyncQueue: true });

        const ciphertext = await encryptPayload(
          buildSyncPayload(merged, deletedUrls),
          config.secret
        );

        /** @type {Record<string, string>} */
        const putHeaders = {
          "Content-Type": "application/json",
          "If-Match": `"${revision}"`,
        };
        if (revision === 0) {
          putHeaders["X-PoW"] = await solveSyncPow(config.syncId);
        }

        const putRes = await fetch(syncEndpoint(config.syncId), {
          method: "PUT",
          credentials: "omit",
          headers: putHeaders,
          body: JSON.stringify({ ciphertext, revision }),
        });

        if (putRes.status === 410) {
          await markSyncRevoked();
          throw new Error(SYNC_REVOKED_MESSAGE);
        }
        if (putRes.status === 409) {
          continue;
        }
        if (!putRes.ok) {
          throw new Error(await describeSyncHttpError("同步上传失败", putRes));
        }

        const putBody = await putRes.json();
        const nextRevision = Number(putBody.revision) || revision + 1;
        await setSyncConfig({
          lastSyncedAt: Date.now(),
          lastRevision: nextRevision,
          lastError: null,
          revoked: false,
        });
        return {
          ok: true,
          revision: nextRevision,
          total: merged.length,
        };
      }

      throw new Error("同步冲突过多，请稍后重试");
    } catch (err) {
      const message = err instanceof Error ? err.message : "同步失败";
      if (message === SYNC_REVOKED_MESSAGE) {
        await markSyncRevoked(message);
      } else {
        await setSyncConfig({ lastError: message });
      }
      throw err instanceof Error ? err : new Error(message);
    } finally {
      syncInFlight = null;
      if (syncQueued) flushSyncQueue();
    }
  })();

  return syncInFlight;
}
