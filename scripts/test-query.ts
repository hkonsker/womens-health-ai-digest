/**
 * scripts/test-query.ts
 *
 * Dry-run the collectors without touching state, Claude, or email.
 * Use this after every query edit to see what the beat actually catches.
 *
 *   npm run test:query
 *   npm run test:query -- --days 30      widen the window
 *   npm run test:query -- --beat repro   one beat only
 */

import "dotenv/config";
import {
  QUERY_CLINICAL_AI,
  QUERY_REPRO_AI,
  QUERY_PATIENT_COMM,
  DAYS_BACK,
  MAX_CANDIDATES_PER_BEAT,
  BEATS,
} from "../lib/config.js";
import { esearch, fetchArticles } from "../lib/pubmed.js";
import { collectFeeds } from "../lib/feeds.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const days = Number(flag("days") ?? DAYS_BACK);
const only = flag("beat");

async function showPubMed(label: string, query: string): Promise<void> {
  console.log("=".repeat(64));
  console.log(` ${label}  (last ${days} days)`);
  console.log("=".repeat(64));

  const { count, idlist, querytranslation } = await esearch(query, days, MAX_CANDIDATES_PER_BEAT);
  console.log(`Total matches : ${count}`);
  console.log(`Retrieved     : ${idlist.length}${count > idlist.length ? `  [capped, ${count - idlist.length} not seen]` : ""}`);
  console.log();

  if (idlist.length === 0) {
    console.log("(no results)\n");
    console.log(`PubMed read the query as:\n${querytranslation}\n`);
    return;
  }

  const articles = await fetchArticles(idlist);
  articles
    .sort((a, b) => (b.pubDate?.getTime() ?? 0) - (a.pubDate?.getTime() ?? 0))
    .forEach((a, i) => {
      const author = a.authors.length > 1 ? `${a.authors[0]} et al.` : a.authors[0] ?? "Unknown";
      console.log(`${String(i + 1).padStart(3)}. ${a.journal}  ${a.pubDate?.toISOString().slice(0, 10) ?? "n/d"}`);
      console.log(`     ${a.title.slice(0, 96)}${a.title.length > 96 ? "..." : ""}`);
      console.log(`     ${author}${a.abstract ? "" : "   [no abstract]"}`);
      console.log();
    });

  const withAbstract = articles.filter((a) => a.abstract).length;
  console.log(`Abstracts available: ${withAbstract} of ${articles.length}\n`);
}

async function showFeeds(): Promise<void> {
  console.log("=".repeat(64));
  console.log(` ${BEATS.industry.label}  (last ${days} days)`);
  console.log("=".repeat(64));

  const { candidates, failures } = await collectFeeds(days);
  console.log(`Relevant items: ${candidates.length}`);
  for (const f of failures) console.log(`! feed failed: ${f.name} (${f.error})`);
  console.log();

  candidates
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .forEach((c, i) => {
      console.log(`${String(i + 1).padStart(3)}. ${c.source}  ${c.date?.slice(0, 10) ?? "n/d"}`);
      console.log(`     ${c.title.slice(0, 96)}${c.title.length > 96 ? "..." : ""}`);
      console.log();
    });
}

async function main(): Promise<void> {
  if (!only || only === "clinical") await showPubMed(BEATS["clinical-ai"].label, QUERY_CLINICAL_AI);
  if (!only || only === "repro") await showPubMed(BEATS["repro-ai"].label, QUERY_REPRO_AI);
  if (!only || only === "patient") await showPubMed(BEATS["patient-comm"].label, QUERY_PATIENT_COMM);
  if (!only || only === "industry") await showFeeds();
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
