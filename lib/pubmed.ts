/**
 * lib/pubmed.ts
 *
 * Typed wrappers around the three NCBI E-utilities we need:
 *   ESearch  → list of PMIDs matching a query
 *   ESummary → metadata (title, journal, authors, pub type)
 *   EFetch   → full records including abstracts (XML)
 *
 * Adapted from perezcodex/clinical_ai_weekly_digest, with two additions:
 * PMID batching (NCBI rejects very long id lists) and polite rate limiting.
 *
 * Set NCBI_API_KEY in .env to raise the rate limit from 3 to 10 req/s.
 * Free key: https://www.ncbi.nlm.nih.gov/account/
 */

import { XMLParser } from "fast-xml-parser";

const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const API_KEY = process.env.NCBI_API_KEY ?? "";

/** NCBI allows 3 req/s without a key, 10 with one. Stay under it. */
const MIN_INTERVAL_MS = API_KEY ? 110 : 350;

/** ESummary and EFetch take id lists; keep each request comfortably small. */
const ID_BATCH_SIZE = 100;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
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
  await throttle();

  const url = buildUrl("esearch.fcgi", {
    term: query,
    retmax: String(limit),
    retmode: "json",
    usehistory: "n",
    datetype: "pdat",
    reldate: String(daysBack),
  });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESearch failed: ${res.status} ${res.statusText}`);

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
  await throttle();
  const url = buildUrl("esummary.fcgi", { id: pmids.join(","), retmode: "json" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESummary failed: ${res.status} ${res.statusText}`);

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
  await throttle();

  const url = buildUrl("efetch.fcgi", {
    id: pmids.join(","),
    retmode: "xml",
    rettype: "abstract",
  });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`EFetch failed: ${res.status} ${res.statusText}`);

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
