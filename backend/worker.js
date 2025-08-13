// Cloudflare Worker backend for secure Gemini usage and hex caching
// Endpoints:
//   POST /api/ocr  -> { text: "...", source: "Gemini" }
//   GET  /api/hex?color=...&bypassCache=0|1 -> { hex: "#RRGGBB" } or { hex: "N/A" }

const COOLDOWN_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Basic CORS (you can restrict to your domain later)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    try {
      if (url.pathname === "/api/ocr" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !body.imageBase64 || !body.mimeType) {
          return json({ error: "Invalid request body" }, 400, request);
        }
        const text = await geminiOcr(body.imageBase64, body.mimeType, env);
        return json({ text, source: "Gemini" }, 200, request);
      }

      if (url.pathname === "/api/hex" && request.method === "GET") {
        const color = url.searchParams.get("color") || "";
               const bypassCache = url.searchParams.get("bypassCache") === "1";
        if (!color.trim()) return json({ hex: "N/A" }, 200, request);

        const canonicalName = canonicalizeColorName(color);
        if (!bypassCache) {
          const cached = await env.HEX_CACHE.get(canonicalName, { type: "json" });
          if (cached && cached.hex && Date.now() < (cached.expiry || 0)) {
            return json({ hex: cached.hex }, 200, request);
          }
        }

        // Ask Gemini for a hex code
        const hex = await geminiHex(color, env);
        if (isValidHex(hex)) {
          const expiry = Date.now() + COOLDOWN_PERIOD_MS;
          await env.HEX_CACHE.put(
            canonicalName,
            JSON.stringify({ hex, expiry }),
            { expirationTtl: 31 * 24 * 60 * 60 } // ensure cleanup
          );
          return json({ hex }, 200, request);
        }
        return json({ hex: "N/A" }, 200, request);
      }

      return json({ error: "Not found" }, 404, request);
    } catch (err) {
      return json({ error: err?.message || "Server error" }, 500, request);
    }
  },
};

function corsHeaders(request) {
  const reqOrigin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": reqOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(request),
    },
  });
}

function isValidHex(hex) {
  return typeof hex === "string" && /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(hex.trim());
}

function canonicalizeColorName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

async function geminiOcr(imageBase64, mimeType, env) {
  const key = await getUsableKey(env);
  if (!key) throw new Error("No usable API key");

  const apiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" +
    encodeURIComponent(key);
  const payload = {
    contents: [
      {
        parts: [
          {
            text:
              "Extract all text from this image exactly as it appears, including labels, values, and hex codes. " +
              "Maintain original formatting and line breaks precisely. Preserve all characters from any language, " +
              "including Cyrillic letters like 'С', 'Т', 'О'.",
          },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      await handleKeyFailure(env, key, res.status);
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Gemini OCR error: ${res.status}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) throw new Error("Gemini OCR returned empty text");
    return text;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Gemini OCR timeout after 15s");
    throw e;
  }
}

async function geminiHex(colorName, env) {
  const key = await getUsableKey(env);
  if (!key) return "N/A";
  const apiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" +
    encodeURIComponent(key);
  const prompt = `You are an expert color system analyst. Determine the single most official or widely accepted 6-digit hex code for "${colorName}".
First, check official standards (Pantone, RAL) or major manufacturer specs. If multiple, pick the most common one.
If no standard, analyze reputable sources and choose the strongest consensus.
For the specific color "White", always return #F0F0F0.
Respond with only the hex code in #XXXXXX format. If you cannot determine reliably, respond with 'N/A'.`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      await handleKeyFailure(env, key, res.status);
      return "N/A";
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    if (isValidHex(text)) return text;
    return "N/A";
  } catch (e) {
    return "N/A";
  }
}

// --- Key state management in KV ---

async function getState(env) {
  const raw = await env.KEY_STATE.get("state", { type: "json" });
  return (
    raw || {
      currentIndex: 0,
      cooldowns: {}, // key->timestamp
      permanentFails: [], // array of keys
    }
  );
}

async function saveState(env, state) {
  await env.KEY_STATE.put("state", JSON.stringify(state));
}

async function getUsableKey(env) {
  let keys = [];
  try {
    keys = JSON.parse(env.GEMINI_KEYS || "[]");
  } catch {
    keys = [];
  }
  if (!Array.isArray(keys) || keys.length === 0) return null;

  let state = await getState(env);
  let start = state.currentIndex || 0;
  for (let i = 0; i < keys.length; i++) {
    const idx = (start + i) % keys.length;
    const key = keys[idx];
    if (!key) continue;
    if (state.permanentFails.includes(key)) continue;
    const cooldownUntil = state.cooldowns[key];
    if (cooldownUntil && Date.now() < cooldownUntil) continue;

    // Set pointer to this key
    if (state.currentIndex !== idx) {
      state.currentIndex = idx;
      await saveState(env, state);
    }
    return key;
  }

  // No immediately usable key found: try cooldown overrides (non-permanent)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (state.permanentFails.includes(key)) continue;
    // choose the first non-permanent
    state.currentIndex = i;
    await saveState(env, state);
    return key;
  }
  return null;
}

async function handleKeyFailure(env, key, status) {
  const state = await getState(env);
  if (status === 429) {
    // rate limit -> cooldown
    if (!state.cooldowns[key]) {
      state.cooldowns[key] = Date.now() + COOLDOWN_PERIOD_MS;
    } else if (Date.now() > state.cooldowns[key]) {
      // cooldown elapsed and failed again -> permanent fail
      if (!state.permanentFails.includes(key)) state.permanentFails.push(key);
    }
  } else if (status === 400 || status === 403) {
    if (!state.permanentFails.includes(key)) state.permanentFails.push(key);
  }
  // step to next key
  const keys = JSON.parse(env.GEMINI_KEYS || "[]");
  if (Array.isArray(keys) && keys.length > 0) {
    state.currentIndex = (state.currentIndex + 1) % keys.length;
  }
  await saveState(env, state);
}
