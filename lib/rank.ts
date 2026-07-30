/**
 * lib/rank.ts
 *
 * The layer that turns a filtered feed into an actual digest: Claude scores
 * every candidate and writes two sentences on why it matters.
 *
 * Without an ANTHROPIC_API_KEY this degrades to an unranked feed rather than
 * failing the run, so the pipeline is testable before the key is in place.
 */

import Anthropic from "@anthropic-ai/sdk";
import { BEATS } from "./config.js";
import type { Candidate, RankedItem } from "./types.js";

/**
 * ── The main tuning knob ──────────────────────────────────────────────────
 * Who the digest is for. Everything the ranker decides flows from this, so
 * edit it before you edit anything else.
 */
const READER_PROFILE = `
The reader is a second-year medical student at Stanford who does research at
the intersection of clinical AI and reproductive endocrinology and infertility.
They read this to stay oriented in a field they work in, not for general news.

What earns a high score:
  - A finding that would change how a clinician or researcher acts or thinks.
  - Real evaluation: prospective design, external validation, a multi-site
    cohort, a randomized comparison, or a hard clinical endpoint.
  - Direct relevance to reproductive medicine, obstetrics, or gynecology.
  - A first: a capability, clearance, or deployment that did not exist before.

What earns a low score:
  - Another retrospective single-center model with an AUC and no validation.
  - Reviews, commentary, and opinion, unless genuinely field-defining.
  - Incremental benchmark gains with no clinical grounding.
  - Funding rounds and partnerships with no product or evidence behind them.
`.trim();

const MODEL = process.env.DIGEST_MODEL ?? "claude-opus-5";

/**
 * Scoring abstracts is a well-scoped judgment task, so medium effort is the
 * right cost/quality point. Raise to "high" if the summaries feel shallow.
 */
const EFFORT = process.env.DIGEST_EFFORT ?? "medium";

/** Candidates per API call. Keeps each response comfortably inside max_tokens. */
const BATCH_SIZE = 20;

const SYSTEM = `
You are the editor of a weekly research digest. You read a batch of candidate
items and decide which are worth the reader's limited time.

${READER_PROFILE}

Score every item from 0 to 10 on how much it deserves the reader's attention
this week. Be strict. A typical week should produce a handful of 7s and above
and a long tail of 3s and 4s. Do not inflate scores to be encouraging.

For each item also write "why": exactly two sentences, plain and factual.
The first says what was actually done or found. The second says why it matters
to this reader, or what its main limitation is. Write the way a colleague
explains a paper in the hallway. No hype, no marketing language, and never use
an em-dash. Use a colon, comma, or period instead.

Also give a short theme label in Title Case, two or three words, describing the
topic: for example "Embryo Selection", "Ambient Documentation", "FDA Clearance",
"Preterm Birth Risk".

Judge only what the provided text supports. If an abstract is missing or thin,
say so in the second sentence and score conservatively.
`.trim();

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The candidate id, copied exactly." },
          score: { type: "integer", description: "0 to 10." },
          why: { type: "string", description: "Exactly two sentences. No em-dashes." },
          theme: { type: "string", description: "Two or three words, Title Case." },
        },
        required: ["id", "score", "why", "theme"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

interface Verdict {
  id: string;
  score: number;
  why: string;
  theme: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function renderCandidate(c: Candidate): string {
  const authors =
    c.authors.length > 1
      ? `${c.authors[0]} et al.`
      : c.authors[0] ?? "";
  const body = (c.body ?? "").slice(0, 2500);
  return [
    `<item id="${c.id}">`,
    `beat: ${BEATS[c.beat].label} (${BEATS[c.beat].intent})`,
    `source: ${c.source}`,
    authors ? `authors: ${authors}` : null,
    c.date ? `date: ${c.date.slice(0, 10)}` : null,
    `title: ${c.title}`,
    body ? `text: ${body}` : `text: (none available)`,
    `</item>`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function rankBatch(
  client: Anthropic,
  batch: Candidate[],
): Promise<Verdict[]> {
  const prompt = [
    `Score the following ${batch.length} candidate item(s).`,
    `Return one entry per item, using the exact id given.`,
    "",
    batch.map(renderCandidate).join("\n\n"),
  ].join("\n");

  // Beta endpoint: `fallbacks` and the scalar "default" mode live there.
  // Cast because the SDK typings trail the newer fields.
  const params = {
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [{ role: "user" as const, content: prompt }],
  };

  const res = await client.beta.messages.create(params as never);

  if (res.stop_reason === "refusal") {
    // Safety classifiers declined. Rare for this content, but it returns a
    // successful 200 with empty content, so it has to be checked explicitly.
    throw new Error(
      `Ranking refused (category: ${(res as any).stop_details?.category ?? "unknown"})`,
    );
  }

  const text = res.content.find((b): b is { type: "text"; text: string } & typeof b =>
    b.type === "text",
  )?.text;
  if (!text) throw new Error("Ranking returned no text block");

  const parsed = JSON.parse(text) as { items?: Verdict[] };
  return parsed.items ?? [];
}

export interface RankResult {
  items: RankedItem[];
  ranked: boolean;
}

/**
 * Score every candidate. Returns items sorted best first.
 * Batches are independent, so one failed batch does not lose the others.
 */
export async function rankCandidates(candidates: Candidate[]): Promise<RankResult> {
  if (candidates.length === 0) return { items: [], ranked: true };

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "  ! ANTHROPIC_API_KEY is not set. Skipping ranking: you will get an\n" +
        "    unranked feed with no summaries. Set the key to enable the digest.",
    );
    return {
      items: candidates.map((c) => ({ ...c, score: 0, why: "", theme: "" })),
      ranked: false,
    };
  }

  const client = new Anthropic();
  const batches = chunk(candidates, BATCH_SIZE);
  console.log(`  Ranking ${candidates.length} candidate(s) in ${batches.length} batch(es) with ${MODEL} at ${EFFORT} effort...`);

  const settled = await Promise.allSettled(batches.map((b) => rankBatch(client, b)));

  const byId = new Map<string, Verdict>();
  let failedBatches = 0;

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      for (const v of r.value) byId.set(v.id, v);
    } else {
      failedBatches++;
      console.warn(
        `  ! Batch ${i + 1}/${batches.length} failed: ${
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        }`,
      );
    }
  });

  if (failedBatches === batches.length) {
    throw new Error("Every ranking batch failed. Not writing a digest.");
  }

  const items: RankedItem[] = candidates.map((c) => {
    const v = byId.get(c.id);
    return {
      ...c,
      // An item whose batch failed scores -1 so it sorts last and is visibly
      // unranked rather than silently treated as a genuine zero.
      score: v ? Math.max(0, Math.min(10, v.score)) : -1,
      why: v?.why ?? "",
      theme: v?.theme ?? "",
    };
  });

  items.sort((a, b) => b.score - a.score);
  return { items, ranked: true };
}
