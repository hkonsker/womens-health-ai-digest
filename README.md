# Women's Health and AI Weekly

A self-hosted weekly research digest. It reads PubMed and a set of RSS feeds, has Claude
score and summarise what it found at two reading levels, defines the jargon, and emails
you the result. It runs on a GitHub Actions schedule, so nothing needs to be installed or
left running.

The beats below are one person's interests and are meant to be replaced. See
[Forking this for yourself](#forking-this-for-yourself).

A weekly digest of three beats:

1. **Clinical AI** — substantial clinical AI research, from a fixed allowlist of top journals.
2. **AI in OB/GYN and REI** — AI applied to reproductive and obstetric health.
3. **FEMTECH and Digital Health** — industry news, funding, and clearances.

Every Sunday morning a GitHub Action queries PubMed and a set of RSS feeds, has Claude
score and summarize what it found, writes the result to a styled archive page, and emails
you the digest.

There is no database, no server, and nothing to keep awake.

```
Sunday 14:17 UTC (7am Pacific in summer, 6am in winter), plus a 19:17 catch-up
  → PubMed (2 queries) + RSS (6 feeds)
  → dedup against every item ever seen
  → Claude scores 0-10, writes the summary at two levels, and defines the jargon
  → keep the top 10 that score 5 or above
  → docs/index.html + email via Resend
  → commit state back to the repo
```

## Forking this for yourself

Run this first, before anything else:

```bash
npm install
npm run reset
```

`npm run reset` clears the previous owner's accumulated state. It matters more than it
looks: `data/seen.json` is a permanent record of every item the digest has ever
considered, and it is committed to the repo so the weekly schedule has somewhere to
remember things. A fork inherits it, so without resetting, your first digest silently
skips everything the original owner already saw and comes back nearly empty. Add
`--keep-glossary` if you want to inherit the term definitions, which are generic and
cost real money to regenerate.

Then make it yours. There are exactly four places worth editing:

| What | Where | Why |
|---|---|---|
| **Who is reading** | `READER_PROFILE` in [`lib/rank.ts`](lib/rank.ts) | The single highest-leverage knob. Everything the ranker decides flows from these few paragraphs. Edit this before you touch a query. |
| **What gets collected** | `QUERY_*` and `FEEDS` in [`lib/config.ts`](lib/config.ts) | The beats themselves. Bump `QUERY_VERSION` when you change them. |
| **Beat names** | `BEATS` in [`lib/config.ts`](lib/config.ts) | The chip labels. |
| **Colours** | the palette constants in [`lib/render.ts`](lib/render.ts) | Currently the Stanford identity set. |

The three beats here are one person's interests. The machinery underneath, two PubMed
queries built on opposite principles, an LLM ranking pass, an accumulating glossary, and
a committed-JSON store instead of a database, is not specific to any subject.

## Requirements

Node 20 or newer, because the code uses the built-in `fetch`. The workflow runs Node 22.
Everything else is installed by `npm install`. You do not need a server, a database, or
anything running on your own machine.

## Setup

**1. Get your own copy.** Click **Use this template** at the top of the repo, which gives
you a clean copy with its own history rather than a fork tied to the original. Then clone
it and run `npm install && npm run reset`.

**2. Add the secrets.** Repo → Settings → Secrets and variables → Actions → New repository secret.

| Secret | Where to get it | Needed for |
|---|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API keys | Scoring and summaries |
| `RESEND_API_KEY` | [resend.com](https://resend.com) → API Keys | Sending the email |
| `DIGEST_TO_EMAILS` | Your address, comma-separated for more than one | Sending the email |
| `NCBI_API_KEY` | [ncbi.nlm.nih.gov/account](https://www.ncbi.nlm.nih.gov/account/) (free) | PubMed, see note below |

Under the **Variables** tab (not Secrets), optionally add `DIGEST_SITE_URL` so the email
links to your archive.

**Keys never go in the repo.** They live in GitHub Secrets, which are encrypted, are not
readable by anyone who clones the repo, and are not exposed to workflows triggered from
forks. Locally they go in `.env`, which is gitignored. Note that on a public repo the
Actions logs are public too, so if you add code of your own, do not print a URL that
carries a key as a query parameter, which is how the NCBI key would be the one at risk.

`NCBI_API_KEY` reads as optional and is not. NCBI rate-limits by IP at 3 requests per
second, and GitHub's runners are shared IPs already carrying other people's traffic, so a
keyless run competes for a budget it does not control and eventually gets a 429. The key
is free and gives you a private 10 req/s bucket. Runs from your laptop are fine without
one, which is exactly why this is easy to miss.

**3. Turn on the archive page.** Settings → Pages → Source: *Deploy from a branch*,
branch `main`, folder `/docs`. Free on a public repo. On a private repo it needs a paid
plan, which GitHub Education covers if you have it. Skipping this step breaks nothing;
the email just has no archive link.

**4. Run it once by hand.** Actions → Weekly Digest → Run workflow. Then read the log.

## Running locally

```bash
npm install
cp .env.example .env      # fill in the keys
npm run test:query        # see what the queries catch, no API cost
npm run digest -- --dry-run   # full pipeline, writes nothing, sends nothing
npm run digest            # the real thing
```

| Command | What it does |
|---|---|
| `npm run test:query` | Runs both PubMed queries and every feed, prints results. No Claude, no cost. |
| `npm run test:query -- --days 30 --beat repro` | Widen the window, or check one beat. |
| `npm run digest -- --dry-run` | Everything except writing files and sending mail. |
| `npm run digest -- --force` | Re-run a week that already has a digest. |
| `npm run digest -- --no-email` | Write the page, skip the email. |
| `npm run digest -- --resend` | Re-render the page and re-send the email from the stored digest. No PubMed, no Claude, no cost. Use this to iterate on layout. |
| `npm run typecheck` | `tsc --noEmit`. |

## Tuning it

Almost everything you would want to change is in [`lib/config.ts`](lib/config.ts):

| Knob | What it controls |
|---|---|
| `QUERY_CLINICAL_AI` | Beat 1. High precision by journal allowlist. Add a journal to widen it. |
| `QUERY_REPRO_AI` | Beat 2. High recall by topic, no journal filter. The ranker does precision. |
| `FEEDS` | Beat 3. Add or remove RSS sources. |
| `FEED_RELEVANCE` | Cheap keyword gate so you do not pay to rank unrelated healthcare news. |
| `MAX_ITEMS_IN_DIGEST` | How long the digest gets. Default 10. |
| `MIN_SCORE` | The floor. Default 5. Raise it if the digest feels padded. |
| `QUERY_VERSION` | **Bump this whenever you change a query or the feed list.** |

Every item is summarised twice from the same facts. `why` is two sentences for someone
who works in the field, naming the design, the metric, and the numbers. `plain` is the
same two sentences with the jargon removed, for a college-level reader with no background.

The page shows the technical version and hides the plain one behind an "Explain this
simply" toggle. Email cannot do toggles, so it prints both, with the plain version
visually demoted so it is easy to skip.

Jargon in the technical version gets defined: each item carries a `glossary`, rendered as
tappable chips on the page and as a bolded `TERMS` block in the email.

Definitions accumulate in `data/glossary.json`. The first definition of a term wins and
is never regenerated, so a term means the same thing in February as in August and is only
ever paid for once. Terms first seen this week are flagged as new, and the page grows an
A-Z reference section at the bottom.

The other knob that matters is `READER_PROFILE` at the top of
[`lib/rank.ts`](lib/rank.ts). It tells Claude who you are and what earns a high score.
Everything the ranker decides flows from those few paragraphs, so edit them before you
edit a query.

### Why the two PubMed queries are built differently

Beat 1 gets its quality from a journal allowlist: if it is not in JAMA, NEJM, Lancet,
Nature Medicine, npj Digital Medicine, JAMIA, or a handful of others, it does not get
looked at. That single filter does most of the signal-to-noise work for free.

Beat 2 cannot work that way. Reproductive AI is small enough weekly that a journal
allowlist would strangle it, and the good work is scattered across Fertility and
Sterility, Human Reproduction, AJOG, and general journals. So beat 2 casts wide on topic
and accepts noise, and the ranker supplies the precision. High precision by rule on the
broad beat, high recall plus judgment on the narrow one.

## What it costs

| Item | Cost |
|---|---|
| GitHub Actions | Free (about 3 minutes a week) |
| GitHub Pages | Free on public repos, needs Pro for private |
| Resend | Free tier is 3,000 emails a month |
| PubMed | Free |
| Anthropic API | Roughly $0.15 to $0.30 a week on Sonnet |

The API is the only real cost, on the order of $10 a year. It scales with how many
candidates get ranked. To cut it further, lower `MAX_CANDIDATES_PER_BEAT` or set the
`DIGEST_EFFORT` variable to `low`. To spend more for sharper summaries, set the
`DIGEST_MODEL` variable to `claude-opus-5`.

## Design notes

**Dedup is global, not per week.** An item is remembered in `data/seen.json` the first
time it is *considered*, not the first time it is published. A paper never appears in two
digests, and a low scorer does not get re-ranked every week.

**The schedule is best effort, so there are two of them.** GitHub delays or drops
scheduled runs under load, worst at the top of the hour, so the digest fires at :17 and
again five hours later. The second run is a no-op when the first worked, because the job
exits as soon as it sees the week already has a digest.

**External calls retry.** PubMed requests back off and retry on 429 and 5xx, honoring
`Retry-After` when NCBI sends it. Feed failures never kill a run; they get reported in the
digest footer instead.

**Nothing is capped silently.** If PubMed reports 200 matches and the run only pulls 80,
the digest says so. Same for feeds that failed and items cut by the length limit. A
digest that quietly drops half the week reads exactly like a quiet week, which is the
failure mode worth designing against.

**Queries are versioned.** Every run stores `QUERY_VERSION` and the full text of every
query it used, so months from now you can still tell which definition of the beat
produced a given week.

**State is JSON in the repo.** `data/seen.json` is the dedup ledger and
`data/digests/*.json` is the archive. Both are committed by the Action. At about 30 items
a week this does everything a database would, and there is no free-tier Postgres to keep
from going to sleep.

## Licence

MIT. See [LICENSE](LICENSE).

## Credit

The PubMed layer and the versioned-query idea are adapted from
[perezcodex/clinical_ai_weekly_digest](https://github.com/perezcodex/clinical_ai_weekly_digest).
The ranking and summarization layer, the second and third beats, and the no-database
architecture are new here.
