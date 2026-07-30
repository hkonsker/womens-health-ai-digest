/**
 * lib/store.ts
 *
 * State lives in JSON files committed back to the repo. That is the whole
 * database. At roughly 30 items a week it does everything Postgres would do
 * here, with no server to keep awake and no connection string to rotate.
 *
 *   data/seen.json            id -> ISO date first seen (the dedup ledger)
 *   data/digests/<week>.json  one full digest run
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DigestRun, GlossaryTerm } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const SEEN_PATH = path.join(DATA_DIR, "seen.json");
const DIGEST_DIR = path.join(DATA_DIR, "digests");
const GLOSSARY_PATH = path.join(DATA_DIR, "glossary.json");

/** Forget an item after a year so seen.json cannot grow without bound. */
const SEEN_RETENTION_DAYS = 365;

export type SeenLedger = Record<string, string>;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function loadSeen(): Promise<SeenLedger> {
  return readJson<SeenLedger>(SEEN_PATH, {});
}

export async function saveSeen(seen: SeenLedger): Promise<void> {
  const cutoff = Date.now() - SEEN_RETENTION_DAYS * 86_400_000;
  const pruned: SeenLedger = {};
  for (const [id, iso] of Object.entries(seen)) {
    const t = new Date(iso).getTime();
    if (!isNaN(t) && t >= cutoff) pruned[id] = iso;
  }
  await writeJson(SEEN_PATH, pruned);
}

/**
 * Terms the digest has already explained, keyed by lowercased term.
 *
 * The first definition of a term wins and is never regenerated. That keeps
 * "external validation" meaning the same thing in February as in August, and
 * it means a term is only ever paid for once.
 */
export type GlossaryStore = Record<
  string,
  { term: string; definition: string; firstSeen: string }
>;

/**
 * Small words stay lowercase unless they open or close the term.
 * Matches the house style: Title Case for anything that is not a sentence.
 */
const SMALL_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor",
  "of", "to", "by", "in", "on", "at", "as", "for", "per", "vs",
]);

/**
 * Title Case a glossary label.
 *
 * Any word that already contains a capital is left exactly alone. That is the
 * load-bearing rule: acronyms (AUC, AMH, SHAP) and cased biomarkers such as
 * sFlt-1/PlGF are meaningful as written, and blindly capitalising them would
 * produce Sflt-1/Plgf, which is not a real thing.
 */
export function titleCaseTerm(raw: string): string {
  const words = raw.trim().split(/\s+/);
  return words
    .map((word, i) => {
      if (/[A-Z]/.test(word)) return word;
      const bare = word.replace(/[^a-z]/g, "");
      const isEdge = i === 0 || i === words.length - 1;
      if (!isEdge && SMALL_WORDS.has(bare)) return word;
      // Capitalise after a hyphen or slash too: decision-tree -> Decision-Tree
      return word.replace(/(^|[-/])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
    })
    .join(" ");
}

export async function loadGlossary(): Promise<GlossaryStore> {
  return readJson<GlossaryStore>(GLOSSARY_PATH, {});
}

export async function saveGlossary(g: GlossaryStore): Promise<void> {
  await writeJson(GLOSSARY_PATH, g);
}

/** Every known term, A-Z, with the ones first seen this week flagged. */
export function glossaryToList(g: GlossaryStore, weekLabel?: string): GlossaryTerm[] {
  return Object.values(g)
    .map((e) => ({
      term: e.term,
      definition: e.definition,
      isNew: weekLabel ? e.firstSeen === weekLabel : false,
    }))
    .sort((a, b) => a.term.toLowerCase().localeCompare(b.term.toLowerCase()));
}

export async function saveDigest(run: DigestRun): Promise<void> {
  await writeJson(path.join(DIGEST_DIR, `${run.weekLabel}.json`), run);
}

export async function loadDigest(weekLabel: string): Promise<DigestRun | null> {
  return readJson<DigestRun | null>(path.join(DIGEST_DIR, `${weekLabel}.json`), null);
}

/** Every stored digest, newest first. */
export async function listDigests(): Promise<DigestRun[]> {
  let files: string[];
  try {
    files = await fs.readdir(DIGEST_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const runs: DigestRun[] = [];
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const run = await readJson<DigestRun | null>(path.join(DIGEST_DIR, f), null);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.weekLabel.localeCompare(a.weekLabel));
}

// ─── ISO week helpers ─────────────────────────────────────────────────────────

/** e.g. "2026-W31". Weeks are the unit of the whole system. */
export function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday 00:00:00 through Sunday 23:59:59, in UTC. */
export function weekBounds(date: Date): { startDate: Date; endDate: Date } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1 ... Sun=7
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  monday.setUTCHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { startDate: monday, endDate: sunday };
}

export { DATA_DIR, ROOT };
