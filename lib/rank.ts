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

The digest covers three beats, and they compete on equal footing. Never mark an
item down for belonging to one beat rather than another:

  1. Substantial clinical AI anywhere in medicine. A strong trial of AI in
     oncology, radiology, or primary care is fully in scope and should score as
     high as its quality warrants. No reproductive angle is required.
  2. AI applied to reproductive and obstetric health.
  3. Industry movement in women's health and digital health.

What earns a high score, in rough order of weight:
  - A finding that would change how a clinician or researcher acts or thinks.
  - Real evaluation: prospective design, external validation, a multi-site
    cohort, a randomized comparison, or a hard clinical endpoint.
  - A first: a capability, clearance, or deployment that did not exist before.
  - Scale and setting that make the result likely to generalize.

Reproductive relevance is a tiebreaker, not a requirement. Between two items of
equal quality, prefer the one closer to reproductive medicine. Do not penalize a
strong general clinical AI study for sitting outside that area.

What earns a low score:
  - Another retrospective single-center model with an AUC and no validation.
  - Reviews, commentary, and opinion, unless genuinely field-defining.
  - Incremental benchmark gains with no clinical grounding.
  - Funding rounds and partnerships with no product or evidence behind them.
  - Work with no AI or algorithmic component at all. However good the study,
    it is off-topic here: score it low and say so.
`.trim();

// Sonnet by default: scoring abstracts and writing two plain sentences is a
// well-scoped task and Sonnet handles it at a fraction of the cost. Override
// with the DIGEST_MODEL variable if summaries start feeling shallow.
// Note the `||`, not `??`. GitHub Actions renders an unset repository
// variable as an empty string, and `??` only falls back on undefined.
const MODEL = process.env.DIGEST_MODEL?.trim() || "claude-sonnet-5";

/**
 * Scoring abstracts is a well-scoped judgment task, so medium effort is the
 * right cost/quality point. Raise to "high" if the summaries feel shallow.
 */
const EFFORT = process.env.DIGEST_EFFORT?.trim() || "medium";

/** Candidates per API call. Keeps each response comfortably inside max_tokens. */
const BATCH_SIZE = 20;

/**
 * Server-side refusal fallbacks are not available on every model: Sonnet 5
 * rejects the parameter outright with a 400. Send it only where it is known to
 * work, and treat this list as a best guess rather than gospel, because the
 * request below also recovers on its own if the guess is wrong.
 */
const SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5|mythos-5)\b/.test(MODEL);

const SYSTEM = `
You are the editor of a weekly research digest. You read a batch of candidate
items and decide which are worth the reader's limited time.

${READER_PROFILE}

Score every item from 0 to 10 on how much it deserves the reader's attention
this week. Be strict. A typical week should produce a handful of 7s and above
and a long tail of 3s and 4s. Do not inflate scores to be encouraging.

For each item write "why": exactly two sentences, plain and factual.
The first says what was actually done or found. The second says why it matters
to this reader, or what its main limitation is.

Write for a smart college-level reader with no background in medicine,
statistics, or machine learning. This is the most important instruction here.
Prefer the plain phrase whenever it is just as accurate: "a type of AI that
reads images" beats "a vision transformer" unless the specific architecture is
the point of the paper. Spell out what a number means rather than naming the
metric: "identified the right gene 88% of the time" beats "88.5% top-5
accuracy". Never assume the reader knows an abbreviation.

Keep a technical term only when it is genuinely load-bearing, and when you keep
one, put it in the glossary. No hype, no marketing language, and never use an
em-dash. Use a colon, comma, or period instead.

For "glossary": list every term in your two sentences that an educated reader
outside this field could not confidently define. Cover medicine, statistics,
and machine learning alike, for example "external validation", "prospective
cohort", "vision transformer", "sensitivity", "odds ratio". Each definition is
one plain sentence that says what the term means and why it matters, using no
jargon of its own. Define the general concept rather than this study's specific
use of it, because these definitions are reused across future weeks. When a
term has both a full name and an abbreviation, use the full name as the term,
so that "intraclass correlation coefficient" and "ICC" do not become two
separate entries. Return an
empty array if your summary genuinely contains no such term.

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
          glossary: {
            type: "array",
            description: "Jargon used in `why`, defined for a non-specialist.",
            items: {
              type: "object",
              properties: {
                term: { type: "string", description: "The term as it appears in `why`." },
                definition: {
                  type: "string",
                  description: "One plain sentence. No jargon of its own.",
                },
              },
              required: ["term", "definition"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "score", "why", "theme", "glossary"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

/**
 * A safety classifier declined the request. Distinct from a transport error
 * because the response is a successful 200 with empty content, and because the
 * right recovery is to split the batch rather than retry it unchanged.
 */
class RefusalError extends Error {
  constructor(readonly category: string) {
    super(`refused by the ${category} classifier`);
    this.name = "RefusalError";
  }
}

interface Verdict {
  id: string;
  score: number;
  why: string;
  theme: string;
  glossary?: Array<{ term: string; definition: string }>;
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

  // Cast because the SDK typings trail the newer beta fields.
  const base = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [{ role: "user" as const, content: prompt }],
  };
  const withFallbacks = {
    ...base,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };

  let res;
  try {
    res = await client.beta.messages.create(
      (SUPPORTS_FALLBACKS ? withFallbacks : base) as never,
    );
  } catch (err) {
    // Belt and braces: if this model turns out not to accept `fallbacks`,
    // drop the parameter and carry on rather than failing the whole run.
    // You cannot test this ahead of time with a throwaway key, because auth is
    // checked before parameters and a 401 masks the 400 you are looking for.
    const msg = err instanceof Error ? err.message : String(err);
    if (!SUPPORTS_FALLBACKS || !/fallbacks/i.test(msg)) throw err;
    console.warn(`  ! ${MODEL} rejected the fallbacks parameter, retrying without it`);
    res = await client.beta.messages.create(base as never);
  }

  if (res.stop_reason === "refusal") {
    // A safety classifier declined the whole request. It returns a successful
    // 200 with empty content, so it has to be checked explicitly.
    throw new RefusalError((res as any).stop_details?.category ?? "unknown");
  }

  const text = res.content.find((b): b is { type: "text"; text: string } & typeof b =>
    b.type === "text",
  )?.text;
  if (!text) throw new Error("Ranking returned no text block");

  const parsed = JSON.parse(text) as { items?: Verdict[] };
  return parsed.items ?? [];
}

/**
 * Score a batch, and on a classifier refusal split it in half and try each side.
 *
 * A refusal applies to the whole request, so a single item that trips a
 * classifier would otherwise take every other item in its batch down with it.
 * That is exactly what happened on the first real digest: one AI protein
 * engineering paper sat in a batch of twenty and the bio classifier killed all
 * twenty, including every item from an entire beat. Bisecting isolates the
 * offender in about log2(n) extra calls, and only when a refusal actually
 * occurs, so the normal path costs nothing.
 */
async function rankBatchBisecting(
  client: Anthropic,
  batch: Candidate[],
  refused: Candidate[],
): Promise<Verdict[]> {
  try {
    return await rankBatch(client, batch);
  } catch (err) {
    if (!(err instanceof RefusalError)) throw err;

    if (batch.length === 1) {
      // Isolated. Record it and carry on: one item is not worth failing a run.
      refused.push(batch[0]);
      console.warn(
        `  ! refused by the ${err.category} classifier, skipping: ${batch[0].title.slice(0, 70)}`,
      );
      return [];
    }

    const mid = Math.ceil(batch.length / 2);
    console.warn(
      `  ! ${err.category} refusal on ${batch.length} item(s), splitting into ${mid} and ${batch.length - mid}`,
    );
    const halves = await Promise.all([
      rankBatchBisecting(client, batch.slice(0, mid), refused),
      rankBatchBisecting(client, batch.slice(mid), refused),
    ]);
    return halves.flat();
  }
}

export interface RankResult {
  items: RankedItem[];
  ranked: boolean;
  /** Candidates a classifier refused to score, after isolating them. */
  refused: number;
  /** Candidates with no verdict for any other reason (a batch errored out). */
  unscored: number;
}

/**
 * Score every candidate. Returns items sorted best first.
 * Batches are independent, so one failed batch does not lose the others.
 */
export async function rankCandidates(candidates: Candidate[]): Promise<RankResult> {
  if (candidates.length === 0) return { items: [], ranked: true, refused: 0, unscored: 0 };

  const refused: Candidate[] = [];

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "  ! ANTHROPIC_API_KEY is not set. Skipping ranking: you will get an\n" +
        "    unranked feed with no summaries. Set the key to enable the digest.",
    );
    return {
      items: candidates.map((c) => ({ ...c, score: 0, why: "", theme: "", glossary: [] })),
      ranked: false,
      refused: 0,
      unscored: candidates.length,
    };
  }

  const client = new Anthropic();
  const batches = chunk(candidates, BATCH_SIZE);
  console.log(`  Ranking ${candidates.length} candidate(s) in ${batches.length} batch(es) with ${MODEL} at ${EFFORT} effort...`);

  const settled = await Promise.allSettled(
    batches.map((b) => rankBatchBisecting(client, b, refused)),
  );

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
      glossary: (v?.glossary ?? []).map((g) => ({
        term: g.term.trim(),
        definition: g.definition.trim(),
      })),
    };
  });

  items.sort((a, b) => b.score - a.score);

  const refusedIds = new Set(refused.map((c) => c.id));
  const unscored = items.filter((i) => i.score < 0 && !refusedIds.has(i.id)).length;
  if (refused.length || unscored) {
    console.warn(
      `  ! ${refused.length} refused by a classifier, ${unscored} unscored from failed batch(es).`,
    );
  }

  return { items, ranked: true, refused: refused.length, unscored };
}
