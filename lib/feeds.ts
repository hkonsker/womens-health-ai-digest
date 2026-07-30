/**
 * lib/feeds.ts
 *
 * RSS/Atom collection for the industry beat. PubMed does not index company
 * news, so this is the only source for it.
 *
 * Design rule: a broken feed never kills a run and never disappears quietly.
 * Failures are collected and printed in the digest footer.
 */

import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { FEEDS, FEED_RELEVANCE, type FeedSource } from "./config.js";
import type { Candidate } from "./types.js";

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "womens-health-ai-digest/1.0 (personal weekly digest; +https://github.com/)";

export interface FeedResult {
  candidates: Candidate[];
  failures: Array<{ name: string; error: string }>;
}

function stableId(url: string): string {
  return `url:${createHash("sha1").update(url).digest("hex").slice(0, 16)}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  hellip: "…", ndash: "–", mdash: "—",
};

/**
 * Strip HTML tags and decode entities. Feed descriptions are full of markup,
 * and several feeds double-encode, so decode twice.
 */
function stripHtml(input: string): string {
  const decode = (s: string): string =>
    s
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);

  return decode(
    decode(
      input
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function asText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
  }
  return "";
}

/** Atom links are attribute-based; RSS links are text. Handle both. */
function extractLink(item: Record<string, unknown>): string {
  const raw = item.link;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    const alt = raw.find(
      (l) =>
        typeof l === "object" &&
        l !== null &&
        ((l as Record<string, unknown>)["@_rel"] === "alternate" ||
          (l as Record<string, unknown>)["@_rel"] === undefined),
    );
    const pick = (alt ?? raw[0]) as Record<string, unknown> | string;
    if (typeof pick === "string") return pick.trim();
    return String(pick?.["@_href"] ?? "").trim();
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return String(obj["@_href"] ?? obj["#text"] ?? "").trim();
  }
  return String(item.guid ? asText(item.guid) : "").trim();
}

function parseDate(item: Record<string, unknown>): string | null {
  const raw =
    asText(item.pubDate) ||
    asText(item.published) ||
    asText(item.updated) ||
    asText(item["dc:date"]);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchOne(feed: FeedSource, sinceMs: number): Promise<Candidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let xml: string;
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["item", "entry", "link"].includes(name),
  });

  const doc = parser.parse(xml) as Record<string, any>;
  const items: Array<Record<string, unknown>> =
    doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.["rdf:RDF"]?.item ?? [];

  const out: Candidate[] = [];

  for (const item of items) {
    const title = stripHtml(asText(item.title));
    const url = extractLink(item);
    if (!title || !url) continue;

    const date = parseDate(item);
    // Feeds carry months of history. Only take this week's.
    if (date && new Date(date).getTime() < sinceMs) continue;

    const body = stripHtml(
      asText(item.description) ||
        asText(item.summary) ||
        asText(item["content:encoded"]) ||
        asText(item.content),
    ).slice(0, 2000);

    // Cheap keyword gate so we do not pay to rank unrelated healthcare news.
    if (!FEED_RELEVANCE.test(`${title} ${body}`)) continue;

    out.push({
      id: stableId(url),
      beat: "industry",
      title,
      source: feed.name,
      url,
      date,
      authors: [],
      body: body || null,
    });
  }

  return out;
}

/** Fetch every configured feed. Failures are returned, not thrown. */
export async function collectFeeds(daysBack: number): Promise<FeedResult> {
  const sinceMs = Date.now() - daysBack * 86_400_000;

  const settled = await Promise.allSettled(
    FEEDS.map(async (feed) => ({ feed, items: await fetchOne(feed, sinceMs) })),
  );

  const candidates: Candidate[] = [];
  const failures: Array<{ name: string; error: string }> = [];

  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      candidates.push(...result.value.items);
    } else {
      const reason = result.reason;
      failures.push({
        name: FEEDS[i].name,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });

  // Same story syndicated by two outlets: keep the first.
  const seen = new Set<string>();
  return {
    candidates: candidates.filter((c) => !seen.has(c.id) && seen.add(c.id)),
    failures,
  };
}
