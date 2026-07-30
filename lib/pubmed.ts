/**
 * lib/pubmed.ts
 *
 * Typed wrappers around the three NCBI E-utilities we need:
 *   ESearch  → list of PMIDs matching a query
 *   ESummary → metadata (title, journal, authors, pub type)
 *   EFetch   → full records including abstracts (XML)
 *
 * Adapted from perezcodex/clinical_ai_weekly_digest, with three additions:
 * PMID batching (NCBI rejects very long id lists), outbound rate limiting, and
 * retry with backoff when NCBI rate-limits us back.
 *
 * Set NCBI_API_KEY. It is free, and it matters more than it looks: without one
 * the 3 req/s limit is shared across everyone on your IP, and CI runners have
 * busy shared IPs. A run from a laptop is fine without a key; a run from GitHub
 * Actions will eventually hit 429 without one.
 * Free key: https://www.ncbi.nlm.nih.gov/account/
 */

import { XMLParser } from "fast-xml-parser";

const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const API_KEY = process.env.NCBI_API_KEY ?? "";

/** NCBI allows 3 req/s without a key, 10 with one. Stay under it. */
const MIN_INTERVAL_MS = API_KEY ? 110 : 350;

/** ESummary and EFetch take id lists; keep each request comfortably small. */
const ID_BATCH_SIZE = 100;

/** Retries on 429 and 5xx. NCBI limits by IP, and CI runners share saturated IPs. */
const MAX_ATTEMPTS = 5;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Throttled fetch with backoff on 429 and 5xx.
 *
 * Without an NCBI_API_KEY the rate limit is 3 req/s shared across everyone on
 * the same IP, which on a CI runner means someone else's traffic can spend our
 * budget. Retrying with backoff is what makes the run survive that.
 */
async function ncbiFetch(url: string, label: string): Promise<Response> {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    const res = await fetch(url);
    if (res.ok) return res;

    lastStatus = res.status;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) break;

    // Honor Retry-After when NCBI sends it, otherwise exponential with jitter.
    const header = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(header) && header > 0
      ? header * 1000
      : 1000 * 2 ** (attempt - 1) + Math.random() * 500;

    console.warn(
      `  ! ${label} got ${res.status}, retrying in ${Math.round(backoff / 1000)}s ` +
        `(attempt ${attempt} of ${MAX_ATTEMPTS - 1})`,
    );
    await sleep(backoff);
  }

  const hint =
    lastStatus === 429 && !API_KEY
      ? " Set NCBI_API_KEY to get your own rate-limit bucket instead of sharing the IP's."
      : "";
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempt(s): ${lastStatus}.${hint}`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PubMedArticle {
  pmid: string;
  title: string;
  journal: string;
  pubDate: Date | null;
  authors: string[];
  abstract: string | null;
  url: string;
  doi: string | null;
  publicationTypes: string[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("db", "pubmed");
  if (API_KEY) url.searchParams.set("api_key", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parsePubDate(raw: string): Date | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  const year = parts[0];
  const month = parts[1] ? (MONTH_MAP[parts[1].toLowerCase().slice(0, 3)] ?? "01") : "01";
  const day = parts[2] ? parts[2].padStart(2, "0") : "01";
  const d = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function parseDoi(elocationid?: string): string | null {
  if (!elocationid) return null;
  // Handles all the formats seen in the wild:
  //   "doi: 10.1038/s41586-025-10097-9"
  //   "10.1001/jama.2026.1234 [doi]"
  //   "S0140-6736(26)00123-4 [pii] 10.1016/S0140-6736(26)00123-4 [doi]"
  const match = elocationid.match(/(10\.\d{4,}\/\S+?)(?:\s*\[doi\])?(?:\s|$)/i);
  return match ? match[1] : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── ESearch ──────────────────────────────────────────────────────────────────

export interface ESearchResult {
  /** Total matches PubMed reports, which may exceed what we retrieved. */
  count: number;
  idlist: string[];
  querytranslation: string;
}

export async function esearch(
  query: string,
  daysBack: number,
  limit: number,
): Promise<ESearchResult> {
  const url = buildUrl("esearch.fcgi", {
    term: query,
    retmax: String(limit),
    retmode: "json",
    usehistory: "n",
    datetype: "pdat",
    reldate: String(daysBack),
  });

  const res = await ncbiFetch(url, "ESearch");

  const data = (await res.json()) as {
    esearchresult: { count: string; idlist: string[]; querytranslation: string };
  };

  const r = data.esearchresult;
  return {
    count: Number(r.count),
    idlist: r.idlist ?? [],
    querytranslation: r.querytranslation,
  };
}

// ─── ESummary ─────────────────────────────────────────────────────────────────

interface ESummaryRaw {
  uid: string;
  title: string;
  source: string;
  pubdate: string;
  authors?: Array<{ name: string }>;
  pubtype?: string[];
  elocationid?: string;
}

async function esummaryBatch(pmids: string[]): Promise<ESummaryRaw[]> {
  const url = buildUrl("esummary.fcgi", { id: pmids.join(","), retmode: "json" });
  const res = await ncbiFetch(url, "ESummary");

  const data = (await res.json()) as {
    result: { uids: string[]; [pmid: string]: ESummaryRaw | string[] };
  };

  return data.result.uids.map((uid) => data.result[uid] as ESummaryRaw);
}

export async function esummary(pmids: string[]): Promise<ESummaryRaw[]> {
  if (pmids.length === 0) return [];
  const out: ESummaryRaw[] = [];
  for (const batch of chunk(pmids, ID_BATCH_SIZE)) {
    out.push(...(await esummaryBatch(batch)));
  }
  return out;
}

// ─── EFetch (abstracts) ───────────────────────────────────────────────────────

async function efetchBatch(pmids: string[]): Promise<Map<string, string>> {
  const abstracts = new Map<string, string>();

  const url = buildUrl("efetch.fcgi", {
    id: pmids.join(","),
    retmode: "xml",
    rettype: "abstract",
  });

  const res = await ncbiFetch(url, "EFetch");

  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["PubmedArticle", "AbstractText", "Author"].includes(name),
  });

  const parsed = parser.parse(xml) as {
    PubmedArticleSet?: {
      PubmedArticle?: Array<{
        MedlineCitation: {
          PMID: { "#text"?: string } | string;
          Article?: {
            Abstract?: {
              AbstractText?:
                | string
                | string[]
                | Array<{ "#text"?: string; "@_Label"?: string }>;
            };
          };
        };
      }>;
    };
  };

  for (const article of parsed?.PubmedArticleSet?.PubmedArticle ?? []) {
    const citation = article.MedlineCitation;
    const pmid =
      typeof citation.PMID === "string"
        ? citation.PMID
        : String(citation.PMID?.["#text"] ?? "");
    if (!pmid) continue;

    const node = citation.Article?.Abstract?.AbstractText;
    let text = "";

    if (typeof node === "string") {
      text = node;
    } else if (Array.isArray(node)) {
      // Structured abstract: keep the section labels, they carry real meaning.
      text = node
        .map((section) => {
          if (typeof section === "string") return section;
          const label = section["@_Label"] ? `${section["@_Label"]}: ` : "";
          return `${label}${section["#text"] ?? ""}`;
        })
        .filter(Boolean)
        .join(" ");
    }

    if (text.trim()) abstracts.set(pmid, text.trim());
  }

  return abstracts;
}

export async function efetch(pmids: string[]): Promise<Map<string, string>> {
  const abstracts = new Map<string, string>();
  if (pmids.length === 0) return abstracts;
  for (const batch of chunk(pmids, ID_BATCH_SIZE)) {
    for (const [k, v] of await efetchBatch(batch)) abstracts.set(k, v);
  }
  return abstracts;
}

// ─── Combined fetch ───────────────────────────────────────────────────────────

/** Fetch full article details for a list of PMIDs (summary + abstract). */
export async function fetchArticles(pmids: string[]): Promise<PubMedArticle[]> {
  if (pmids.length === 0) return [];

  // Sequential, not parallel: both hit the same rate-limited NCBI endpoint.
  const summaries = await esummary(pmids);
  const abstracts = await efetch(pmids);

  return summaries.map((s) => ({
    pmid: s.uid,
    title: s.title,
    journal: s.source,
    pubDate: parsePubDate(s.pubdate),
    authors: (s.authors ?? []).map((a) => a.name),
    abstract: abstracts.get(s.uid) ?? null,
    url: `https://pubmed.ncbi.nlm.nih.gov/${s.uid}/`,
    doi: parseDoi(s.elocationid),
    publicationTypes: s.pubtype ?? [],
  }));
}
