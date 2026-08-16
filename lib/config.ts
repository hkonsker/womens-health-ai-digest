/**
 * lib/config.ts
 *
 * Everything that defines WHAT the digest covers lives here.
 * Bump QUERY_VERSION any time you change a query or the feed list.
 * The version is stored on every digest run so you can tell which weeks
 * used which definition of the beat.
 */

// v5 (2026-08-16): FEED_RELEVANCE now requires a women's health term. It used
// to accept a bare AI term as well, which flooded the industry beat with
// general health-IT trade press. Paired with a separate news-scoring rubric for
// beat 3 in lib/rank.ts, after the beat returned zero items three weeks running.
// v4 (2026-07-30): dropped "predictive model" and "prediction model" from the
// repro AI terms. A multivariable logistic regression is a prediction model and
// is not AI; those terms were pulling in classical-statistics papers.
// v3: dropped "time-lapse" from the repro AI terms. It is an
// imaging and culture technique, not AI, and it was pulling in incubator
// hardware studies. Real AI embryo work says deep learning or machine learning.
// v2: dropped STAT News, everything there is paywalled.
export const QUERY_VERSION = "v5";

/** How many days back PubMed looks. Matches the weekly cadence. */
export const DAYS_BACK = 8;

/** Per-beat ceiling on candidates pulled before ranking. */
export const MAX_CANDIDATES_PER_BEAT = 80;

/** How many items survive ranking and appear in the digest. */
export const MAX_ITEMS_IN_DIGEST = 10;

/** Minimum score (0-10) an item needs to appear at all, even if the digest is short. */
export const MIN_SCORE = 5;

export type BeatId = "clinical-ai" | "repro-ai" | "industry";

export interface Beat {
  id: BeatId;
  label: string;
  /** One line telling the ranker what this beat is for. */
  intent: string;
}

export const BEATS: Record<BeatId, Beat> = {
  "clinical-ai": {
    id: "clinical-ai",
    label: "Clinical AI",
    intent:
      "Substantial clinical AI research: studies that change how AI is understood, evaluated, or deployed in patient care.",
  },
  "repro-ai": {
    id: "repro-ai",
    label: "AI in OB/GYN and REI",
    intent:
      "AI applied to women's reproductive and obstetric health: infertility and IVF, embryo and oocyte selection, obstetric risk prediction, gynecologic imaging and screening.",
  },
  industry: {
    id: "industry",
    label: "FEMTECH and Digital Health",
    intent:
      "Industry movement in women's health and digital health: product launches, funding, partnerships, regulatory clearances, and company news.",
  },
};

// ─── Beat 1: substantial clinical AI ──────────────────────────────────────────
//
// Strategy: high precision via a journal allowlist. We refuse to look outside
// these ~20 journals, which does most of the signal-to-noise work without an
// LLM. Three AND clauses: journal AND method AND clinical context.

export const QUERY_CLINICAL_AI = `(
JAMA[jour] OR "JAMA Netw Open"[jour] OR "JAMA Intern Med"[jour] OR "JAMA Pediatr"[jour] OR
"JAMA Surg"[jour] OR "JAMA Oncol"[jour] OR "JAMA Neurol"[jour] OR "JAMA Cardiol"[jour] OR
"N Engl J Med"[jour] OR "NEJM AI"[jour] OR Lancet[jour] OR BMJ[jour] OR
"Lancet Digit Health"[jour] OR "Nat Med"[jour] OR "npj Digit Med"[jour] OR
"J Am Med Inform Assoc"[jour] OR "Ann Intern Med"[jour] OR Nature[jour] OR Science[jour]
)
AND
(
"large language model"[Title/Abstract] OR LLM[Title/Abstract] OR "generative AI"[Title/Abstract] OR
"artificial intelligence"[Title/Abstract] OR "foundation model"[Title/Abstract] OR GPT[Title/Abstract] OR
"machine learning"[Title/Abstract] OR "deep learning"[Title/Abstract] OR
"natural language processing"[Title/Abstract] OR "neural network"[Title/Abstract]
)
AND
(
clinical[Title/Abstract] OR patient[Title/Abstract] OR workflow[Title/Abstract] OR
implementation[Title/Abstract] OR "clinical decision support"[Title/Abstract] OR
documentation[Title/Abstract] OR EHR[Title/Abstract] OR radiology[Title/Abstract] OR
triage[Title/Abstract] OR diagnosis[Title/Abstract] OR outcome[Title/Abstract]
)
NOT (news[Publication Type] OR comment[Publication Type] OR editorial[Publication Type])`;

// ─── Beat 2: AI in ob/gyn and REI ─────────────────────────────────────────────
//
// Strategy: the inverse of beat 1. This field is small enough weekly that a
// journal allowlist would strangle it, so we cast wide on topic and let the
// ranker do precision. That division of labor is deliberate: high precision by
// allowlist on the broad beat, high recall plus LLM filtering on the narrow one.

export const QUERY_REPRO_AI = `(
"artificial intelligence"[Title/Abstract] OR "machine learning"[Title/Abstract] OR
"deep learning"[Title/Abstract] OR "large language model"[Title/Abstract] OR LLM[Title/Abstract] OR
"generative AI"[Title/Abstract] OR GPT[Title/Abstract] OR "foundation model"[Title/Abstract] OR
"neural network"[Title/Abstract] OR "computer vision"[Title/Abstract] OR
"natural language processing"[Title/Abstract] OR radiomics[Title/Abstract]
)
AND
(
infertility[Title/Abstract] OR "in vitro fertilization"[Title/Abstract] OR IVF[Title/Abstract] OR
"assisted reproduction"[Title/Abstract] OR "assisted reproductive"[Title/Abstract] OR
embryo[Title/Abstract] OR blastocyst[Title/Abstract] OR oocyte[Title/Abstract] OR
"ovarian reserve"[Title/Abstract] OR endometriosis[Title/Abstract] OR
"polycystic ovary"[Title/Abstract] OR PCOS[Title/Abstract] OR endometrial[Title/Abstract] OR
pregnancy[Title/Abstract] OR pregnant[Title/Abstract] OR obstetric[Title/Abstract] OR
preeclampsia[Title/Abstract] OR "pre-eclampsia"[Title/Abstract] OR "preterm birth"[Title/Abstract] OR
fetal[Title/Abstract] OR "maternal health"[Title/Abstract] OR "maternal mortality"[Title/Abstract] OR
postpartum[Title/Abstract] OR gynecolog*[Title/Abstract] OR "cervical cancer"[Title/Abstract] OR
menopause[Title/Abstract] OR contracepti*[Title/Abstract] OR "women's health"[Title/Abstract]
)
NOT (
news[Publication Type] OR comment[Publication Type] OR editorial[Publication Type] OR
"case reports"[Publication Type]
)`;

// ─── Beat 3: femtech and digital health industry ──────────────────────────────
//
// Not on PubMed. RSS only. Feeds break; every failure is reported in the
// digest footer rather than silently swallowed.

export interface FeedSource {
  name: string;
  url: string;
}

// Verified working 2026-07-30.
// Not here on purpose:
//   MobiHealthNews, Healthcare IT News - HIMSS properties, both 403 any
//     non-browser client regardless of user agent.
//   STAT News - everything worth reading there is behind STAT+.
export const FEEDS: FeedSource[] = [
  { name: "FemTech Insider", url: "https://femtechinsider.com/feed/" },
  { name: "Fierce Healthcare", url: "https://www.fiercehealthcare.com/rss/xml" },
  { name: "MedCity News", url: "https://medcitynews.com/feed/" },
  { name: "MedTech Dive", url: "https://www.medtechdive.com/feeds/news/" },
  { name: "Healthcare Dive", url: "https://www.healthcaredive.com/feeds/news/" },
  { name: "Rock Health", url: "https://rockhealth.com/feed/" },
];

/**
 * An RSS item is a candidate only if it names something in women's health.
 *
 * This used to also admit anything matching a bare AI term, which was the wrong
 * gate for a women's health beat: on 2026-08-16 that branch let in 12 of 20
 * candidates as general health-IT trade press with no women's health angle
 * (payer analytics, hospital comms startups, model-security work groups). They
 * cost money to rank and every one of them correctly scored near zero.
 *
 * AI is deliberately not required. An AI angle is a bonus the ranker can weigh,
 * not an entry condition, so a menopause trial readout or a fertility platform
 * shutting down still reaches the digest.
 */
export const FEED_RELEVANCE = new RegExp(
  [
    "women'?s health",
    "femtech",
    "fertility",
    "infertility",
    "\\bIVF\\b",
    "reproductive",
    "matern(al|ity)",
    "pregnan",
    "perinatal",
    "prenatal",
    "obstetric",
    "gynecolog",
    "menopaus",
    "contracepti",
    "birth control",
    "endometriosis",
    "\\bPCOS\\b",
    "postpartum",
    "period tracking",
    "menstrua",
    "breastfeed",
    "lactation",
    "doula",
    "midwif",
    "cervical",
    "ovarian",
    "uterine",
    "endometrial",
    "breast cancer",
    "egg freezing",
    "surrogacy",
    "pelvic",
    "hormone therapy",
  ].join("|"),
  "i",
);
