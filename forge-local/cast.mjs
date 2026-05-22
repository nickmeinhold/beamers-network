#!/usr/bin/env node
/**
 * Local multi-model forge — Claude builds, Gemini + Codex judge.
 *
 * Runs forge's build -> evaluate -> iterate loop across DIFFERENT model families so the
 * evaluator doesn't share the builder's blind spots (Claude grading Claude inflates).
 * Builder = `claude -p` (Max plan). Evaluator panel = `gemini -p` + `codex exec`.
 *
 * Usage:
 *   node forge-local/cast.mjs --wish "lean harder into terminal" [--base ../flyer.html] [--rounds 3]
 *
 * Local-only by design: a Cloudflare Worker can't shell out to these CLIs. The hosted
 * web forge stays Claude-only for lightweight team riffing; this is the cross-model power tool.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIP_THRESHOLD = 0.85;

// ---------- arg parsing ----------
function parseArgs(argv) {
  const a = { rounds: 3, base: join(__dirname, "..", "flyer.html") };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--wish") a.wish = argv[++i];
    else if (k === "--base") a.base = argv[++i];
    else if (k === "--rounds") a.rounds = parseInt(argv[++i], 10) || 3;
  }
  return a;
}

// ---------- CLI adapters ----------
/** Spawn a command, write `input` to stdin, resolve with stdout. */
function run(cmd, args, input, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
      else resolve(out);
    });
    if (input != null) { p.stdin.write(input); }
    p.stdin.end();
  });
}

const builders = {
  claude: (prompt) => run("claude", ["-p"], prompt),
};

const evaluators = {
  gemini: async (prompt) => (await run("gemini", [], prompt)).trim(),
  codex: async (prompt) => {
    const raw = await run("codex", ["exec", "-"], prompt);
    // codex wraps output; the model reply sits between the "codex" marker and "tokens used"
    const m = raw.match(/\bcodex\b\s*\n([\s\S]*?)\n\s*tokens used/i);
    return (m ? m[1] : raw).trim();
  },
};

// ---------- extraction ----------
function extractHtml(text) {
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  let html = fence ? fence[1] : text;
  const start = html.search(/<!doctype html>|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  return html.trim();
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("no JSON in evaluator output");
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- prompts ----------
const BUILDER_PROMPT = (wish, base, lastNotes) => `You are the Builder in a forge loop for the Beamers Network flyer. Produce ONE self-contained HTML document (all CSS inline in <style>, no external JS, Google Fonts via <link> only), polished and print-friendly at A5.

You are RIFFING on the base artifact below: apply the requested change, preserve everything that already works (brand canon, structure, untouched parts). Evolve, don't rebuild.

Output ONLY the HTML. No prose, no markdown fences. Start with <!doctype html>.

RIFF REQUEST:
${wish}
${lastNotes ? `\nFIX THESE from the last round:\n${lastNotes}\n` : ""}
BASE ARTIFACT:
${base}`;

const EVALUATOR_PROMPT = (wish, html) => `You are a skeptical Evaluator scoring an HTML flyer for the Beamers Network. Be precise; do not round up.

Score against these canon criteria AND the riff intent:
1. honors the riff: "${wish}"
2. four-beat arc (spell / three named quests / retention turn / Lavanter footer)
3. dual register — mythic serif (Cinzel/Caveat) AND terminal tech (VT323/CLI), fused not segregated
4. preserves B3AM3RS wordmark and named loot (Dawn Heron / Inbox Whisperer / Booking Golem)
5. reads in ~25s, prints A5, mobile-responsive, WCAG AA contrast

Respond with ONLY this JSON (no prose):
{"scores":[{"criterion":"<id>","score":<0..1>,"passed":<bool>,"note":"<one sentence>"}],"overall":<0..1>,"verdict":"ship"|"iterate","topFix":"<single most valuable next change>"}

ARTIFACT (HTML):
${html.slice(0, 12000)}`;

// ---------- trajectory (ported from the Worker) ----------
function analyzeTrajectory(scores) {
  const EPS = 0.03, last = scores[scores.length - 1];
  if (scores.length === 1)
    return { pattern: "first-pass", recommendation: last >= SHIP_THRESHOLD ? "ship" : "iterate", scores, reasoning: `First pass at ${last.toFixed(2)}.` };
  const deltas = scores.slice(1).map((s, i) => s - scores[i]);
  const net = last - scores[0];
  const signs = deltas.map((d) => (d > EPS ? 1 : d < -EPS ? -1 : 0));
  if (signs.includes(1) && signs.includes(-1))
    return { pattern: "oscillation", recommendation: "pivot", scores, reasoning: `Scores swing (${scores.map((s) => s.toFixed(2)).join(" → ")}) — criteria likely conflict.` };
  if (net < -EPS)
    return { pattern: "regression", recommendation: "pivot", scores, reasoning: `Sliding backward (${scores.map((s) => s.toFixed(2)).join(" → ")}).` };
  if (Math.abs(deltas[deltas.length - 1]) < EPS || net < EPS)
    return { pattern: "plateau", recommendation: last >= SHIP_THRESHOLD ? "ship" : "escalate", scores, reasoning: `Flattened (${scores.map((s) => s.toFixed(2)).join(" → ")}).` };
  return { pattern: "improving", recommendation: last >= SHIP_THRESHOLD ? "ship" : "iterate", scores, reasoning: `Climbing (${scores.map((s) => s.toFixed(2)).join(" → ")}).` };
}

// ---------- main loop ----------
async function main() {
  const args = parseArgs(process.argv);
  if (!args.wish) { console.error("Usage: node cast.mjs --wish \"...\" [--base flyer.html] [--rounds 3]"); process.exit(1); }
  const base = readFileSync(args.base, "utf8");
  const outDir = join(__dirname, "out");
  mkdirSync(outDir, { recursive: true });

  console.log(`\n⚒  FORGE (local, multi-model)`);
  console.log(`   builder:    claude`);
  console.log(`   evaluators: gemini + codex (foreign panel)`);
  console.log(`   riff:       ${args.wish}`);
  console.log(`   rounds:     up to ${args.rounds}\n`);

  const panelScores = [];
  let lastNotes = "";

  for (let round = 1; round <= args.rounds; round++) {
    process.stdout.write(`── round ${round} ──\n  claude conjuring… `);
    const builderOut = await builders.claude(BUILDER_PROMPT(args.wish, base, lastNotes));
    const html = extractHtml(builderOut);
    const file = join(outDir, `round-${round}.html`);
    writeFileSync(file, html);
    console.log(`done (${html.length} bytes → ${file})`);

    // foreign evaluator panel, in parallel
    const evalNames = Object.keys(evaluators);
    process.stdout.write(`  panel judging (${evalNames.join(" + ")})… `);
    const results = await Promise.allSettled(
      evalNames.map((n) => evaluators[n](EVALUATOR_PROMPT(args.wish, html)))
    );
    console.log("done");

    const verdicts = [];
    evalNames.forEach((name, i) => {
      const r = results[i];
      if (r.status !== "fulfilled") { console.log(`    ${name}: ERROR ${r.reason.message}`); return; }
      let obj;
      try { obj = extractJson(r.value); } catch (e) { console.log(`    ${name}: unparseable (${e.message})`); return; }
      verdicts.push({ name, ...obj });
      console.log(`    ${name.padEnd(7)} overall=${(obj.overall ?? 0).toFixed(2)} verdict=${obj.verdict} topFix="${(obj.topFix || "").slice(0, 70)}"`);
    });

    if (verdicts.length === 0) { console.log("  no usable evaluations — stopping."); break; }
    const panelMean = verdicts.reduce((s, v) => s + (v.overall || 0), 0) / verdicts.length;
    panelScores.push(panelMean);
    const spread = Math.max(...verdicts.map((v) => v.overall || 0)) - Math.min(...verdicts.map((v) => v.overall || 0));
    console.log(`  PANEL MEAN: ${panelMean.toFixed(2)}  (disagreement spread: ${spread.toFixed(2)})`);

    // combine the panel's fixes for the next builder round
    lastNotes = verdicts.map((v) => `[${v.name}] ${v.topFix || ""}`).filter((s) => s.length > 6).join("\n");

    const allShip = verdicts.every((v) => v.verdict === "ship") || panelMean >= SHIP_THRESHOLD;
    if (allShip) { console.log(`  ✦ panel agrees: worthy.\n`); break; }
    console.log("");
  }

  const traj = analyzeTrajectory(panelScores);
  console.log(`\n⚖  TRAJECTORY`);
  console.log(`   scores:         ${panelScores.map((s) => s.toFixed(2)).join(" → ")}`);
  console.log(`   pattern:        ${traj.pattern}`);
  console.log(`   recommendation: ${traj.recommendation}`);
  console.log(`   ${traj.reasoning}`);
  console.log(`\n   artifacts in ${outDir}/\n`);
}

main().catch((e) => { console.error("forge error:", e.message); process.exit(1); });
