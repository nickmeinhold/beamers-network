/**
 * Beamers forge-api — a backend-hosted forge build->evaluate->iterate loop.
 *
 * POST /cast  { wish: string, criteria?: string[] }
 *   Streams Server-Sent Events as the loop runs:
 *     event: phase      data: {iteration, role: "builder"|"evaluator", status}
 *     event: iteration  data: {iteration, html, scores, overall, notes}
 *     event: done       data: {shipped, iterations, bestIndex}
 *     event: error      data: {message}
 *
 * Abuse/cost controls (public endpoint on Nick's Anthropic account):
 *   - HARD spend cap: set a monthly spend limit on the Anthropic API key itself
 *     in the console. The Worker surfaces the limit error as "well dry". This is
 *     the load-bearing cost control (the CF token has no KV/D1 to track spend).
 *   - per-IP soft rate limit via the Cache API (best-effort, per-colo, evictable —
 *     stops casual hammering, not a determined attacker; the spend cap is the real wall)
 *   - max iterations per wish
 *   - cost-tier models (Haiku evaluator, Sonnet builder), never Opus
 */

const CONFIG = {
  BUILDER_MODEL: "claude-sonnet-4-6",
  EVALUATOR_MODEL: "claude-haiku-4-5-20251001",
  MAX_ITERATIONS: 3,
  SHIP_THRESHOLD: 0.85,
  PER_IP_DAILY_WISHES: 5,
  MAX_OUTPUT_TOKENS_BUILDER: 4096,
  MAX_OUTPUT_TOKENS_EVALUATOR: 1024,
  ALLOWED_ORIGINS: [
    "https://nickmeinhold.github.io",
    "https://beamers.network",
    "https://beamer.network",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
  ],
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function corsHeaders(origin) {
  const allow = CONFIG.ALLOWED_ORIGINS.includes(origin) ? origin : CONFIG.ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Forge-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "0.0.0.0";
}

/** Constant-time-ish string compare to avoid trivial timing leaks on the passphrase. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

class SpendCapError extends Error {}

async function callAnthropic(env, { model, system, messages, max_tokens }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model, system, messages, max_tokens }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Anthropic returns 400 invalid_request_error with a credit/spend-limit message,
    // or 429 when rate/spend limited. Treat these as the well running dry.
    if (res.status === 429 || /credit|spend|limit|billing|quota/i.test(body)) {
      throw new SpendCapError("well_dry");
    }
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const usage = json.usage || { input_tokens: 0, output_tokens: 0 };
  return { text, tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) };
}

/**
 * Best-effort per-IP daily limit using the Cache API. Per-colo and evictable,
 * so it stops casual repeat-hammering but is not a hard wall — the Anthropic
 * key's own spend limit is the real cost ceiling. Returns true if allowed.
 */
async function softRateLimitOk(request, ip) {
  const cache = caches.default;
  const key = new Request(`https://rl.beamers.internal/${ip}/${today()}`);
  const hit = await cache.match(key);
  const count = hit ? parseInt(await hit.text(), 10) || 0 : 0;
  if (count >= CONFIG.PER_IP_DAILY_WISHES) return false;
  // store incremented count; TTL ~26h so it rolls over daily
  const resp = new Response(String(count + 1), {
    headers: { "cache-control": "max-age=93600" },
  });
  await cache.put(key, resp);
  return true;
}

/** Strip ```html fences and any prose around a full HTML document. */
function extractHtml(text) {
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  let html = fence ? fence[1] : text;
  const docStart = html.search(/<!doctype html>|<html[\s>]/i);
  if (docStart > 0) html = html.slice(docStart);
  return html.trim();
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in evaluator output");
  return JSON.parse(raw.slice(start, end + 1));
}

const BUILDER_SYSTEM = `You are the Builder in a forge build-evaluate loop for the Beamers Network flyer. You produce ONE self-contained HTML document — all CSS inline in a <style> tag, no external JS, no external assets except Google Fonts via <link>. The artifact must be visually polished, print-friendly at A5, and immediately renderable in an iframe.

If you are given a BASE ARTIFACT, you are RIFFING on it: apply the requested change while preserving everything that already works (structure, brand canon, the parts the riff doesn't touch). Do not rebuild from scratch — evolve it.

Output ONLY the HTML document. No prose, no explanation, no markdown fences. Start with <!doctype html>.

If you are given evaluator feedback from a previous iteration, address every failing criterion specifically while preserving what already passed.`;

const EVALUATOR_SYSTEM = `You are the Evaluator in a forge build-evaluate loop — skeptical, precise, fair. You score an HTML artifact against acceptance criteria. Do NOT round up; if something almost works, say so and score it honestly.

Respond ONLY with a JSON object of this exact shape:
{
  "scores": [ { "criterion": "<short id>", "score": <0..1>, "passed": <bool>, "note": "<one sentence>" } ],
  "overall": <0..1 weighted-ish average>,
  "verdict": "ship" | "iterate",
  "topFix": "<the single most valuable change for the next iteration, or empty if shipping>"
}
No prose outside the JSON.`;

function deriveCriteriaPrompt(wish, criteria) {
  if (criteria && criteria.length) {
    return criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  }
  // Let the evaluator infer sensible criteria from the wish itself.
  return `(no explicit criteria supplied — infer 3-5 sensible acceptance criteria from the wish, e.g. clarity, visual polish, fit-for-purpose, responsiveness, and whether it actually fulfils what was asked)`;
}

async function runForge(env, { wish, criteria, base }, emit) {
  const criteriaText = deriveCriteriaPrompt(wish, criteria);
  const iterations = [];
  let lastEvalNote = "";
  let currentBase = base || "";
  let tokensUsed = 0;

  for (let i = 1; i <= CONFIG.MAX_ITERATIONS; i++) {
    // ---- Builder ----
    await emit("phase", { iteration: i, role: "builder", status: "casting" });
    const builderUserParts = [`RIFF REQUEST:\n${wish}`, `\nACCEPTANCE CRITERIA:\n${criteriaText}`];
    if (currentBase) {
      const label = i === 1 ? "BASE ARTIFACT (riff on this — evolve, don't rebuild):" : "CURRENT ARTIFACT (your previous iteration — refine it):";
      builderUserParts.push(`\n${label}\n${currentBase.slice(0, 20000)}`);
    }
    if (lastEvalNote) builderUserParts.push(`\nPREVIOUS EVALUATION (address these):\n${lastEvalNote}`);
    const builder = await callAnthropic(env, {
      model: CONFIG.BUILDER_MODEL,
      system: BUILDER_SYSTEM,
      max_tokens: CONFIG.MAX_OUTPUT_TOKENS_BUILDER,
      messages: [{ role: "user", content: builderUserParts.join("\n") }],
    });
    tokensUsed += builder.tokens;
    const html = extractHtml(builder.text);
    currentBase = html; // next iteration refines this one
    await emit("phase", { iteration: i, role: "builder", status: "done" });

    // ---- Evaluator (fresh context) ----
    await emit("phase", { iteration: i, role: "evaluator", status: "scoring" });
    const evaluator = await callAnthropic(env, {
      model: CONFIG.EVALUATOR_MODEL,
      system: EVALUATOR_SYSTEM,
      max_tokens: CONFIG.MAX_OUTPUT_TOKENS_EVALUATOR,
      messages: [
        {
          role: "user",
          content: `WISH:\n${wish}\n\nACCEPTANCE CRITERIA:\n${criteriaText}\n\nARTIFACT (HTML):\n${html.slice(0, 12000)}`,
        },
      ],
    });
    tokensUsed += evaluator.tokens;

    let evalObj;
    try {
      evalObj = extractJson(evaluator.text);
    } catch (e) {
      evalObj = { scores: [], overall: 0, verdict: "iterate", topFix: "evaluator output unparseable: " + e.message };
    }
    const overall = typeof evalObj.overall === "number" ? evalObj.overall : 0;
    lastEvalNote = evalObj.topFix || "";

    const record = { iteration: i, html, scores: evalObj.scores || [], overall, verdict: evalObj.verdict, topFix: evalObj.topFix || "" };
    iterations.push(record);
    await emit("iteration", record);

    if (evalObj.verdict === "ship" || overall >= CONFIG.SHIP_THRESHOLD) break;
  }

  // best iteration by overall
  let bestIndex = 0;
  iterations.forEach((it, idx) => {
    if (it.overall > iterations[bestIndex].overall) bestIndex = idx;
  });
  const shipped = iterations.length > 0 && iterations[bestIndex].overall >= CONFIG.SHIP_THRESHOLD;

  return { iterations, bestIndex, shipped, tokensUsed };
}

async function handleCast(request, env) {
  const origin = request.headers.get("Origin") || "";
  const cors = corsHeaders(origin);

  if (!env.ANTHROPIC_API_KEY || !env.FORGE_PASSPHRASE) {
    return new Response(JSON.stringify({ error: "not_configured", message: "The forge backend isn't fully lit yet — the network keeper needs to set its key and passphrase." }), {
      status: 503,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  // ---- auth gate: fail closed. Only invited holders of the passphrase may spend. ----
  const provided = request.headers.get("X-Forge-Key") || "";
  if (!safeEqual(provided, env.FORGE_PASSPHRASE)) {
    return new Response(JSON.stringify({ error: "unauthorized", message: "That's not the right phrase. The forge stays shut to strangers." }), {
      status: 401,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad_request", message: "Body must be JSON { wish }" }), { status: 400, headers: { "content-type": "application/json", ...cors } });
  }
  const wish = (payload.wish || "").toString().trim();
  const criteria = Array.isArray(payload.criteria) ? payload.criteria.slice(0, 12).map((c) => c.toString().slice(0, 200)) : null;
  const base = payload.base ? payload.base.toString().slice(0, 24000) : "";
  if (wish.length < 3 || wish.length > 1000) {
    return new Response(JSON.stringify({ error: "bad_request", message: "wish must be 3-1000 chars" }), { status: 400, headers: { "content-type": "application/json", ...cors } });
  }

  const ip = clientIp(request);

  // ---- per-IP soft daily cap (Cache API, best-effort) ----
  const allowed = await softRateLimitOk(request, ip);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "rate_limited", message: `You've cast ${CONFIG.PER_IP_DAILY_WISHES} wishes today — the well refills tomorrow.` }), { status: 429, headers: { "content-type": "application/json", ...cors } });
  }

  // ---- SSE stream ----
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = async (event, data) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      const result = await runForge(env, { wish, criteria, base }, emit);
      await emit("done", { shipped: result.shipped, bestIndex: result.bestIndex, iterations: result.iterations.length, tokensUsed: result.tokensUsed });
    } catch (err) {
      if (err instanceof SpendCapError) {
        await emit("error", { message: "The network's magic is spent for now — the keeper's daily wish-budget is used up. Try again later.", code: "well_dry" });
      } else {
        await emit("error", { message: (err && err.message) || "unknown error" });
      }
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...cors,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/cast" && request.method === "POST") {
      return handleCast(request, env);
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, configured: !!(env.ANTHROPIC_API_KEY && env.FORGE_PASSPHRASE), gated: true, day: today() }), {
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    }

    return new Response(JSON.stringify({ error: "not_found", routes: ["POST /cast", "GET /health"] }), {
      status: 404,
      headers: { "content-type": "application/json", ...corsHeaders(origin) },
    });
  },
};
