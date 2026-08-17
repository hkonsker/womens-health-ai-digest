/**
 * lib/config.ts
 *
 * Everything that defines WHAT the digest covers lives here.
 * Bump QUERY_VERSION any time you change a query or the feed list.
 * The version is stored on every digest run so you can tell which weeks
 * used which definition of the beat.
 */

// v6 (2026-08-16): added beat 4, LLMs and patient communication. Measured
// against 90 days of PubMed, only 3 of 362 papers on this topic appear in the
// beat 1 journal allowlist, so the reader's own research area was almost
// entirely invisible in their own digest.
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
export const QUERY_VERSION = "v6";

/** How many days back PubMed looks. Matches the weekly cadence. */
export const DAYS_BACK = 8;

/** Per-beat ceiling on candidates pulled before ranking. */
export const MAX_CANDIDATES_PER_BEAT = 80;

/**
 * How many items survive ranking and appear in the digest.
 *
 * Raised from 10 to 15 on 2026-08-16 when beat 4 arrived. With four beats the
 * cap started binding rather than the score floor: that run had 12 items clear
 * MIN_SCORE and dropped 2 purely for space.
 */
export const MAX_ITEMS_IN_DIGEST = 15;

/** Minimum score (0-10) an item needs to appear at all, even if the digest is short. */
export const MIN_SCORE = 5;

export type BeatId = "clinical-ai" | "repro-ai" | "patient-comm" | "industry";

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
  "patient-comm": {
    id: "patient-comm",
    label: "LLMs and Patient Communication",
    intent:
      "Language models talking to or about patients: answering patient messages and questions, patient education and readability, empathy and communication quality compared against clinicians, counseling, and symptom checkers.",
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

// ─── Beat 4: LLMs and patient communication ───────────────────────────────────
//
// Strategy: same shape as beat 2, high recall on topic with the ranker doing
// precision. A journal allowlist is exactly the wrong tool here. Measured over
// 90 days, the beat 1 allowlist contains 3 of the 362 papers this query finds:
// the work lives in JMIR, Patient Education and Counseling, Annals of Family
// Medicine, and specialty journals, not in JAMA and NEJM.
//
// Deliberately about the patient-facing side. A model that drafts a note for a
// clinician is beat 1; a model that answers the patient's portal message, or
// gets compared to a doctor on empathy, is this beat.

export const QUERY_PATIENT_COMM = `(
chatbot[Title/Abstract] OR chatbots[Title/Abstract] OR "conversational agent"[Title/Abstract] OR
"large language model"[Title/Abstract] OR LLM[Title/Abstract] OR ChatGPT[Title/Abstract] OR
"generative AI"[Title/Abstract] OR "symptom checker"[Title/Abstract]
)
AND
(
"patient question"[Title/Abstract] OR "patient questions"[Title/Abstract] OR
"patient communication"[Title/Abstract] OR "patient education"[Title/Abstract] OR
"patient portal"[Title/Abstract] OR "patient message"[Title/Abstract] OR
"patient messages"[Title/Abstract] OR "patient-facing"[Title/Abstract] OR
"patient inquiries"[Title/Abstract] OR empathy[Title/Abstract] OR
"health literacy"[Title/Abstract] OR "shared decision"[Title/Abstract] OR
readability[Title/Abstract] OR counseling[Title/Abstract]
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
