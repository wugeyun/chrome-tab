/**
 * Anonymous sync API for 武哥新标签页.
 * Stores only opaque ciphertext; clients hold the encryption key in the sync code.
 * Rotated codes are revoked: ciphertext removed, slot marked revoked (no recreate).
 *
 * Abuse controls: per-method rate limits, PoW on first create, KV TTL auto-expiry.
 */

const ID_RE = /^[a-f0-9]{24}$/;
const MAX_CIPHERTEXT_CHARS = 96_000; // ~64KB binary after base64url
const RATE_WINDOW_MS = 60_000;
const RATE_LIMITS = {
  GET: 60,
  PUT: 20,
  DELETE: 20,
};
/** Leading zero bits required for SHA-256(syncId + ":" + nonce) on first create. */
const POW_BITS = 18;
/** Refresh on every successful write; idle slots auto-delete. */
const KV_TTL_SECONDS = 90 * 24 * 60 * 60;

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateMap = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-Match, X-PoW",
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
    if (!allowRequest(ip, request.method)) {
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
    if (request.method === "DELETE") {
      return handleDelete(env, id);
    }
    return json({ error: "method_not_allowed" }, 405);
  },
};

/**
 * @param {string} ip
 * @param {string} method
 */
function allowRequest(ip, method) {
  const limit = RATE_LIMITS[method] ?? 30;
  const key = `${ip}:${method}`;
  const now = Date.now();
  const entry = rateMap.get(key);
  if (!entry || now >= entry.resetAt) {
    rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/**
 * @param {{ SYNC_KV: KVNamespace }} env
 * @param {string} id
 */
async function readRecord(env, id) {
  const raw = await env.SYNC_KV.get(kvKey(id), "text");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { corrupt: true };
  }
}

/**
 * @param {{ SYNC_KV: KVNamespace }} env
 * @param {string} id
 * @param {object} record
 */
async function putRecord(env, id, record) {
  await env.SYNC_KV.put(kvKey(id), JSON.stringify(record), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

/**
 * @param {{ SYNC_KV: KVNamespace }} env
 * @param {string} id
 */
async function handleGet(env, id) {
  const parsed = await readRecord(env, id);
  if (!parsed) {
    return json({ ciphertext: null, revision: 0 }, 200, {
      ETag: '"0"',
      "X-Revision": "0",
    });
  }
  if (parsed.corrupt) {
    return json({ error: "corrupt" }, 500);
  }
  if (parsed.revoked) {
    return json({ error: "revoked" }, 410, {
      "X-Revision": String(Number(parsed.revision) || 0),
    });
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

  const existing = await readRecord(env, id);
  if (existing?.corrupt) {
    return json({ error: "corrupt" }, 500);
  }
  if (existing?.revoked) {
    return json({ error: "revoked" }, 410);
  }

  const currentRevision = existing ? Number(existing.revision) || 0 : 0;

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

  // First create (empty slot): require cheap proof-of-work to deter mass spam.
  if (!existing) {
    const nonce = request.headers.get("X-PoW") || "";
    if (!(await verifyPow(id, nonce, POW_BITS))) {
      return json(
        { error: "pow_required", bits: POW_BITS },
        400,
        { "X-PoW-Bits": String(POW_BITS) }
      );
    }
  }

  const nextRevision = currentRevision + 1;
  const record = {
    ciphertext,
    revision: nextRevision,
    updatedAt: Date.now(),
  };
  await putRecord(env, id, record);

  return json(
    { ok: true, revision: nextRevision },
    200,
    {
      ETag: `"${nextRevision}"`,
      "X-Revision": String(nextRevision),
    }
  );
}

/**
 * Revoke a sync slot: drop ciphertext, mark revoked so old codes cannot recreate it.
 * @param {{ SYNC_KV: KVNamespace }} env
 * @param {string} id
 */
async function handleDelete(env, id) {
  const existing = await readRecord(env, id);
  if (existing?.corrupt) {
    return json({ error: "corrupt" }, 500);
  }
  if (existing?.revoked) {
    return json({ ok: true, revoked: true, revision: Number(existing.revision) || 0 });
  }

  const currentRevision = existing ? Number(existing.revision) || 0 : 0;
  const nextRevision = currentRevision + 1;
  await putRecord(env, id, {
    revoked: true,
    revision: nextRevision,
    updatedAt: Date.now(),
  });

  return json(
    { ok: true, revoked: true, revision: nextRevision },
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
 * @param {string} syncId
 * @param {string} nonce
 * @param {number} bits
 */
async function verifyPow(syncId, nonce, bits) {
  if (!nonce || typeof nonce !== "string") return false;
  if (!/^[a-f0-9]{1,32}$/i.test(nonce)) return false;
  const data = new TextEncoder().encode(`${syncId}:${nonce.toLowerCase()}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return hasLeadingZeroBits(digest, bits);
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
