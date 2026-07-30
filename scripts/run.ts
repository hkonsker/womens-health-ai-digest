/**
 * scripts/run.ts
 *
 * The whole pipeline:
 *   collect (PubMed x2 + RSS) -> dedup -> rank with Claude -> cut -> write -> email
 *
 * Usage:
 *   npm run digest              run for the current ISO week
 *   npm run digest -- --force   re-run a week that already exists
 *   npm run digest -- --dry-run collect and rank, write nothing, send nothing
 *   npm run digest -- --no-email
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  QUERY_VERSION,
  QUERY_CLINICAL_AI,
  QUERY_REPRO_AI,
  DAYS_BACK,
  MAX_CANDIDATES_PER_BEAT,
  MAX_ITEMS_IN_DIGEST,
  MIN_SCORE,
  BEATS,
  FEEDS,
  type BeatId,
} from "../lib/config.js";
import { esearch, fetchArticles } from "../lib/pubmed.js";
import { collectFeeds } from "../lib/feeds.js";
import { rankCandidates } from "../lib/rank.js";
import { renderPage, renderEmail, emailSubject } from "../lib/render.js";
import { sendDigestEmail } from "../lib/email.js";
import {
  ROOT,
  isoWeekLabel,
  weekBounds,
  loadSeen,
  saveSeen,
  saveDigest,
  loadDigest,
  listDigests,
} from "../lib/store.js";
import type { Candidate, DigestRun, RunStats } from "../lib/types.js";

const DOCS_DIR = path.join(ROOT, "docs");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");
const NO_EMAIL = args.includes("--no-email") || DRY_RUN;

function line(char = "-"): void {
  console.log(char.repeat(64));
}

async function collectPubMed(
  beat: BeatId,
  query: string,
): Promise<{ candidates: Candidate[]; totalMatches: number; truncated: boolean }> {
  const { count, idlist } = await esearch(query, DAYS_BACK, MAX_CANDIDATES_PER_BEAT);
  const articles = await fetchArticles(idlist);

  return {
    totalMatches: count,
    truncated: count > idlist.length,
    candidates: articles.map((a) => ({
      id: `pmid:${a.pmid}`,
      beat,
      title: a.title,
      source: a.journal,
      // Prefer the DOI: it lands on the publisher, not the PubMed stub.
      url: a.doi ? `https://doi.org/${a.doi}` : a.url,
      date: a.pubDate ? a.pubDate.toISOString() : null,
      authors: a.authors,
      body: a.abstract,
    })),
  };
}

async function main(): Promise<void> {
  const now = new Date();
  const weekLabel = isoWeekLabel(now);
  const { startDate, endDate } = weekBounds(now);

  line("=");
  console.log(" Women's Health and AI Weekly");
  line("=");
  console.log(` Week    : ${weekLabel}`);
  console.log(` Window  : ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`);
  console.log(` Query   : ${QUERY_VERSION}`);
  if (DRY_RUN) console.log(" Mode    : DRY RUN, nothing will be written or sent");
  line("=");
  console.log();

  const existing = await loadDigest(weekLabel);
  if (existing && !FORCE && !DRY_RUN) {
    console.log(`Already collected for ${weekLabel} (${existing.items.length} items).`);
    console.log("Pass --force to re-run and replace it.");
    return;
  }

  // ── 1. Collect ──────────────────────────────────────────────────────────
  console.log("Collecting...");
  const perBeat: RunStats["perBeat"] = [];
  let candidates: Candidate[] = [];

  for (const [beat, query] of [
    ["clinical-ai", QUERY_CLINICAL_AI],
    ["repro-ai", QUERY_REPRO_AI],
  ] as Array<[BeatId, string]>) {
    const r = await collectPubMed(beat, query);
    candidates.push(...r.candidates);
    perBeat.push({
      beat,
      label: BEATS[beat].label,
      totalMatches: r.totalMatches,
      retrieved: r.candidates.length,
      truncated: r.truncated,
      newAfterDedup: 0,
    });
    console.log(
      `  ${BEATS[beat].label.padEnd(24)} ${String(r.candidates.length).padStart(3)} retrieved of ${r.totalMatches} match(es)` +
        (r.truncated ? `  [capped, ${r.totalMatches - r.candidates.length} not seen]` : ""),
    );
  }

  const feeds = await collectFeeds(DAYS_BACK);
  candidates.push(...feeds.candidates);
  perBeat.push({
    beat: "industry",
    label: BEATS.industry.label,
    totalMatches: feeds.candidates.length,
    retrieved: feeds.candidates.length,
    truncated: false,
    newAfterDedup: 0,
  });
  console.log(
    `  ${BEATS.industry.label.padEnd(24)} ${String(feeds.candidates.length).padStart(3)} retrieved from ${
      FEEDS.length - feeds.failures.length
    } of ${FEEDS.length} feed(s)`,
  );
  for (const f of feeds.failures) console.log(`  ! feed failed: ${f.name} (${f.error})`);
  console.log();

  // ── 2. Dedup against everything ever seen ───────────────────────────────
  // Global, not per-week: a paper never appears in two digests, even when
  // PubMed re-surfaces it after a date correction.
  const seen = await loadSeen();
  const before = candidates.length;
  candidates = candidates.filter((c) => !(c.id in seen));

  for (const b of perBeat) {
    b.newAfterDedup = candidates.filter((c) => c.beat === b.beat).length;
  }
  console.log(`Dedup: ${before} candidate(s) in, ${candidates.length} new, ${before - candidates.length} seen before.`);
  console.log();

  if (candidates.length === 0) {
    console.log("Nothing new this week. Not writing a digest.");
    return;
  }

  // ── 3. Rank ─────────────────────────────────────────────────────────────
  const { items: rankedAll, ranked } = await rankCandidates(candidates);
  console.log();

  // ── 4. Cut ──────────────────────────────────────────────────────────────
  const cleared = ranked ? rankedAll.filter((i) => i.score >= MIN_SCORE) : rankedAll;
  const items = cleared.slice(0, MAX_ITEMS_IN_DIGEST);
  const droppedBelowCut = Math.max(0, cleared.length - items.length);

  if (ranked) {
    console.log(
      `Cut: ${rankedAll.length} scored, ${cleared.length} at or above ${MIN_SCORE}, ${items.length} in the digest` +
        (droppedBelowCut ? `, ${droppedBelowCut} dropped by the ${MAX_ITEMS_IN_DIGEST}-item cap` : ""),
    );
    console.log();
  }

  const run: DigestRun = {
    weekLabel,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    generatedAt: new Date().toISOString(),
    queryVersion: QUERY_VERSION,
    queries: {
      "clinical-ai": QUERY_CLINICAL_AI,
      "repro-ai": QUERY_REPRO_AI,
      industry: `RSS: ${feeds.candidates.length} item(s) from configured feeds`,
    },
    items,
    stats: { perBeat, feedFailures: feeds.failures, ranked, droppedBelowCut },
  };

  // ── 5. Report ───────────────────────────────────────────────────────────
  console.log("This week's digest:");
  run.items.forEach((it, i) => {
    const s = it.score >= 0 ? String(it.score).padStart(2) : " ?";
    console.log(`  ${s}  [${BEATS[it.beat].label}] ${it.title.slice(0, 76)}${it.title.length > 76 ? "..." : ""}`);
    console.log(`      ${it.source}${it.theme ? ` | ${it.theme}` : ""}`);
    if (it.why) console.log(`      ${it.why}`);
    console.log();
  });
  if (run.items.length === 0) console.log("  (nothing cleared the bar)\n");

  if (DRY_RUN) {
    line();
    console.log("Dry run: no files written, no email sent.");
    return;
  }

  // ── 6. Persist ──────────────────────────────────────────────────────────
  await saveDigest(run);
  const nowIso = new Date().toISOString();
  // Mark every candidate seen, not just the ones that made the cut. An item
  // that scored a 3 this week would score a 3 next week too.
  for (const c of candidates) seen[c.id] = nowIso;
  await saveSeen(seen);

  // ── 7. Render the site ──────────────────────────────────────────────────
  const all = await listDigests();
  const archive = all.map((d) => ({ weekLabel: d.weekLabel, count: d.items.length }));

  await fs.mkdir(path.join(DOCS_DIR, "weeks"), { recursive: true });
  await fs.writeFile(path.join(DOCS_DIR, "index.html"), renderPage(run, archive), "utf8");
  // Regenerate every archive page so their "Past Weeks" lists include this one.
  for (const d of all) {
    const page = renderPage(d, archive).replace(/href="weeks\//g, 'href="');
    await fs.writeFile(path.join(DOCS_DIR, "weeks", `${d.weekLabel}.html`), page, "utf8");
  }
  // GitHub Pages runs Jekyll by default, which skips files it does not like.
  await fs.writeFile(path.join(DOCS_DIR, ".nojekyll"), "", "utf8");
  console.log(`Wrote docs/index.html and ${all.length} archive page(s).`);

  // ── 8. Email ────────────────────────────────────────────────────────────
  if (NO_EMAIL) {
    console.log("Email skipped (--no-email).");
  } else {
    const archiveUrl = process.env.DIGEST_SITE_URL?.trim() || null;
    const result = await sendDigestEmail(emailSubject(run), renderEmail(run, archiveUrl));
    console.log(result.sent ? `Email sent (id ${result.id}).` : `Email not sent: ${result.reason}`);
  }

  line("=");
  console.log(` Done. ${run.items.length} item(s) for ${weekLabel}.`);
  line("=");
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
