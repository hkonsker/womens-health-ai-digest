import type { BeatId } from "./config.js";

/** A thing that might make the digest, before ranking. */
export interface Candidate {
  /** Stable across runs. "pmid:41234567" or "url:<sha1>". Used for dedup. */
  id: string;
  beat: BeatId;
  title: string;
  /** Journal name for papers, feed name for industry items. */
  source: string;
  url: string;
  /** ISO date string, or null when the source does not give one. */
  date: string | null;
  authors: string[];
  /** Abstract or feed description. What the ranker reads. */
  body: string | null;
}

/** A candidate after Claude has scored it. */
export interface RankedItem extends Candidate {
  /** 0-10. Higher is more worth your time. */
  score: number;
  /** Two sentences on why this matters. Empty when ranking is skipped. */
  why: string;
  /** Short label, e.g. "Embryo Selection" or "Regulatory". */
  theme: string;
}

/** One week's digest. Written to data/digests/<weekLabel>.json. */
export interface DigestRun {
  weekLabel: string;
  startDate: string;
  endDate: string;
  generatedAt: string;
  queryVersion: string;
  /** Full text of every query used, for the audit trail. */
  queries: Record<string, string>;
  items: RankedItem[];
  stats: RunStats;
}

export interface RunStats {
  /** Per beat: what PubMed/RSS reported vs what we actually pulled. */
  perBeat: Array<{
    beat: BeatId;
    label: string;
    totalMatches: number;
    retrieved: number;
    /** True when totalMatches exceeded our cap and we did not see everything. */
    truncated: boolean;
    /** Dropped because the resolved publication date fell outside the window. */
    staleDropped: number;
    newAfterDedup: number;
  }>;
  /** Feeds that failed this run, with the reason. Surfaced in the digest. */
  feedFailures: Array<{ name: string; error: string }>;
  ranked: boolean;
  /** Items that cleared MIN_SCORE but were cut by MAX_ITEMS_IN_DIGEST. */
  droppedBelowCut: number;
}
