/**
 * Anonymous sync API for 武哥新标签页.
 * Stores only opaque ciphertext; clients hold the encryption key in the sync code.
 */

const ID_RE = /^[a-f0-9]{24}$/;
const MAX_CIPHERTEXT_CHARS = 96_000; // ~64KB binary after base64url
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateMap = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-Match",
  "Access-Control-Expose-Headers": "ETag, X-Revision",
  "Access-Control-Max-Age": "86400",
};

export default {
  /**
   * @param {Request} request
   * @param {{ SYNC_KV: KVNamespace }} env
   */
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!allowRequest(ip)) {
      return json({ error: "rate_limited" }, 429);
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/sync\/([a-f0-9]{24})$/i);
    if (!match) {
      return json({ error: "not_found" }, 404);
    }

    const id = match[1].toLowerCase();
    if (!ID_RE.test(id)) {
      return json({ error: "invalid_id" }, 400);
    }

    if (request.method === "GET") {
      return handleGet(env, id);
    }
    if (request.method === "PUT") {
      return handlePut(env, id, request);
    }
    return json({ error: "method_not_allowed" }, 405);
  },
};

/**
 * @param {string} ip
 */
function allowRequest(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

/**
 * @param {{ SYNC_KV: KVNamespace }} env
 * @param {string} id
 */
async function handleGet(env, id) {
  const raw = await env.SYNC_KV.get(kvKey(id), "text");
  if (!raw) {
    return json({ ciphertext: null, revision: 0 }, 200, {
      ETag: '"0"',
      "X-Revision": "0",
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "corrupt" }, 500);
  }

  const revision = Number(parsed.revision) || 0;
  const ciphertext =
    typeof parsed.ciphertext === "string" ? parsed.ciphertext : null;

  return json(
    { ciphertext, revision },
    200,
    {
      ETag: `"${revision}"`,
      "X-Revision": String(revision),
    }
  );
}

/**
 * @param {{ SYNC_KV: KVNamespace }} env
 * @param {string} id
 * @param {Request} request
 */
async function handlePut(env, id, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const ciphertext = body?.ciphertext;
  if (typeof ciphertext !== "string" || !ciphertext) {
    return json({ error: "ciphertext_required" }, 400);
  }
  if (ciphertext.length > MAX_CIPHERTEXT_CHARS) {
    return json({ error: "payload_too_large" }, 413);
  }

  const expected =
    parseRevision(request.headers.get("If-Match")) ??
    (Number.isFinite(Number(body?.revision)) ? Number(body.revision) : null);

  if (expected === null) {
    return json({ error: "revision_required" }, 400);
  }

  const existingRaw = await env.SYNC_KV.get(kvKey(id), "text");
  let currentRevision = 0;
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      currentRevision = Number(existing.revision) || 0;
    } catch {
      currentRevision = 0;
    }
  }

  if (expected !== currentRevision) {
    return json(
      { error: "conflict", revision: currentRevision },
      409,
      {
        ETag: `"${currentRevision}"`,
        "X-Revision": String(currentRevision),
      }
    );
  }

  const nextRevision = currentRevision + 1;
  const record = {
    ciphertext,
    revision: nextRevision,
    updatedAt: Date.now(),
  };
  await env.SYNC_KV.put(kvKey(id), JSON.stringify(record));

  return json(
    { ok: true, revision: nextRevision },
    200,
    {
      ETag: `"${nextRevision}"`,
      "X-Revision": String(nextRevision),
    }
  );
}

/** @param {string} id */
function kvKey(id) {
  return `sync:${id}`;
}

/** @param {string | null} value */
function parseRevision(value) {
  if (!value) return null;
  const cleaned = value.trim().replace(/^W\//, "").replace(/"/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * @param {unknown} data
 * @param {number} status
 * @param {Record<string, string>} [extra]
 */
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}
