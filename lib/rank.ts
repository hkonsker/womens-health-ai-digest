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

For each item write two summaries of the same facts, at two different levels.

"why": exactly two sentences for a reader who works in this field. Be precise
and technical where precision earns its keep: name the study design, the metric,
and the actual numbers. The first sentence says what was done and found. The
second says why it matters to this reader, or its main limitation.

Expand every abbreviation the first time you use it in the technical summary,
in the form "randomized controlled trial (RCT)". You may use the short form
after that. A reader who meets "RCT" cold cannot look it up in a glossary filed
under its full name.

"plain": the same two sentences rewritten for a smart college-level reader with
no background in medicine, statistics, or machine learning. Prefer the plain
phrase: "a type of AI that reads images" beats "a vision transformer" unless the
architecture is the point. Spell out what a number means rather than naming the
metric: "identified the right gene 88% of the time" beats "88.5% top-5
accuracy". Never assume an abbreviation is known. Same facts, no jargon, and no
loss of the actual finding.

Neither version uses hype, marketing language, or an em-dash. Use a colon,
comma, or period instead. Write in American English: summarize, capitalize,
analyze, modeling, labeled, not the British spellings. Much of the source
literature is British, so match the digest rather than the abstract you are
reading from.

For "glossary": list every term in "why", the technical version, that an
educated reader outside this field could not confidently define. Cover medicine,
statistics, and machine learning alike, for example "external validation",
"prospective cohort", "vision transformer", "sensitivity", "odds ratio". Each
definition is one plain sentence that says what the term means and why it
matters, using no jargon of its own. Define the general concept rather than this
study's specific use of it, because these definitions are reused across future
weeks. When a term has both a full name and an abbreviation, use the full name
as the term, so that "intraclass correlation coefficient" and "ICC" do not
become two separate entries. Write the term in Title Case, capitalizing each
important word, but leave acronyms and cased names exactly as they are
conventionally written: AUC, sFlt-1/PlGF, mRNA.

Two rules that are easy to miss, and both matter more than the rest:

1. Every abbreviation and acronym you use in the technical summary must have a
   glossary entry, and the definition must open with the full name followed by
   the abbreviation in parentheses, so the two are connected: "Inherited
   retinal disease (IRD), a group of genetic eye conditions that damage the
   light-sensing layer at the back of the eye." Never leave an abbreviation
   unexpanded. This is the single most common miss.

2. When a term is a variant of a more familiar one, define the difference, not
   just the term. The useful part is what makes it different. "Top-5 accuracy"
   means the answer counts as correct if the right one appears anywhere in the
   model's five best guesses, which is an easier bar than ordinary accuracy
   where only the single top guess counts. The same applies to sensitivity
   against specificity, relative against absolute risk, and precision against
   recall.

Define only terms that literally appear in your technical summary. Do not
define a term you read in the abstract but did not use: a chip for a word the
reader will never encounter is clutter, not teaching.

Return an empty array only if the technical summary genuinely contains no such
term, which will be rare.

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
          why: {
            type: "string",
            description: "Two sentences for someone in the field. Technical. No em-dashes.",
          },
          plain: {
            type: "string",
            description:
              "The same two sentences for a college-level reader with no background. No jargon, no em-dashes.",
          },
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
        required: ["id", "score", "why", "plain", "theme", "glossary"],
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
  plain: string;
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

/**
 * Abbreviations common enough that defining them is noise, not help.
 * Everything else that looks like an acronym should be in the glossary.
 */
const ASSUMED_KNOWN = new Set([
  "AI", "US", "USA", "UK", "EU", "FDA", "NHS", "WHO", "COVID", "DNA", "RNA",
  "MRI", "CT", "ICU", "ER", "IVF", "PCOS", "BMI", "HIV", "GP", "LLM", "LLMs",
  // A medical reader knows these cold; defining them is noise.
  "OB", "GYN", "REI", "IUD", "STI", "STD", "CDC", "NIH", "ACOG", "EHR",
]);

/**
 * Flag abbreviations used in a summary but never defined.
 *
 * A prompt rule alone is not enough: an undefined acronym reads as ordinary
 * prose to anyone who already knows it, so the miss is invisible to whoever
 * writes the instruction. This only catches acronyms. Terms that need a
 * contrastive definition, like top-5 accuracy against plain accuracy, still
 * depend on the prompt.
 */
export function undefinedAbbreviations(item: RankedItem): string[] {
  const defined = new Set(
    item.glossary.flatMap((g) => [
      g.term.toLowerCase(),
      ...(g.term.match(/\b[A-Za-z]{2,}\b/g) ?? []).map((w) => w.toLowerCase()),
      ...(g.definition.match(/\b[A-Z]{2,}\b/g) ?? []).map((w) => w.toLowerCase()),
    ]),
  );

  // An abbreviation expanded inline, as in "machine learning (ML)", needs no
  // glossary entry: the reader already has it. Treat those as covered.
  for (const m of item.why.matchAll(/\(([A-Z][A-Za-z0-9+-]*)\)/g)) {
    defined.add(m[1].toLowerCase());
  }

  // Split hyphenated compounds so "AI-assisted" is judged on "AI", and require
  // an all-caps run so mixed-case product names like "Retina4IRD" stay quiet.
  const found = (item.why.match(/\b[A-Za-z][A-Za-z0-9/-]*\b/g) ?? [])
    .flatMap((t) => t.split(/[-/]/))
    .filter((t) => /^[A-Z0-9]{2,}$/.test(t) && /[A-Z]{2,}/.test(t));

  return [...new Set(found)].filter(
    (a) => !ASSUMED_KNOWN.has(a.toUpperCase()) && !defined.has(a.toLowerCase()),
  );
}

/**
 * Terms defined but never used in the summary. A chip for a word the reader
 * will not meet is clutter.
 *
 * Terms are named "Full Name (ABBREV)", so a match has to accept the prose
 * using either half. Checking only the first word reported HPV as unused when
 * the summary said exactly that.
 */
export function unusedTerms(item: RankedItem): string[] {
  const why = item.why.toLowerCase();
  return item.glossary
    .filter((g) => {
      const full = g.term.replace(/\s*\([^)]*\)\s*/g, " ").trim().toLowerCase();
      const abbrev = g.term.match(/\(([^)]+)\)/)?.[1]?.toLowerCase();
      return (
        !why.includes(full) &&
        !(abbrev && why.includes(abbrev)) &&
        !why.includes(full.split(" ")[0])
      );
    })
    .map((g) => g.term);
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
      items: candidates.map((c) => ({ ...c, score: 0, why: "", plain: "", theme: "", glossary: [] })),
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
      plain: v?.plain ?? "",
      theme: v?.theme ?? "",
      glossary: (v?.glossary ?? []).map((g) => ({
        term: g.term.trim(),
        definition: g.definition.trim(),
      })),
    };
  });

  // Only audit what a reader will actually see.
  const shown = items.filter((i) => i.score >= 0 && i.why);

  const gaps = [...new Set(shown.flatMap((i) => undefinedAbbreviations(i)))];
  if (gaps.length) {
    console.warn(`  ! abbreviation(s) used but never defined: ${gaps.join(", ")}`);
  }

  // A chip for a word the summary never uses is clutter, so flag it too.
  // Enforce the "only define what you used" rule rather than trusting it. The
  // model complies most of the time, and a chip for a word the summary never
  // uses is clutter, so drop the strays instead of hoping. Report, never drop
  // silently.
  const dropped: string[] = [];
  for (const item of shown) {
    const strays = new Set(unusedTerms(item));
    if (!strays.size) continue;
    dropped.push(...[...strays].map((t) => `${t} (${item.source})`));
    item.glossary = item.glossary.filter((g) => !strays.has(g.term));
  }
  if (dropped.length) {
    console.warn(`  ! dropped ${dropped.length} term(s) absent from their summary: ${dropped.join(", ")}`);
  }

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
