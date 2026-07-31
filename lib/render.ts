/**
 * lib/render.ts
 *
 * Two renderers over the same DigestRun: a styled archive page and an email.
 * Palette is the Stanford identity set. No teal anywhere.
 */

import type { DigestRun, GlossaryTerm, RankedItem } from "./types.js";
import { BEATS } from "./config.js";

const CARDINAL = "#8C1515";
const POPPY = "#E98300";
const PALO_ALTO = "#175E54";
const COOL_GREY = "#53565A";
const SLATE = "#4B535A";

/** Beat chip colors, one per beat so they are distinguishable at a glance. */
const BEAT_COLOR: Record<string, string> = {
  "clinical-ai": SLATE,
  "repro-ai": CARDINAL,
  industry: PALO_ALTO,
};

/**
 * Words that stay lowercase inside a title unless they open or close it, or
 * follow a colon or question mark.
 */
const TITLE_SMALL = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "of", "to", "by", "in", "on",
  "at", "as", "for", "per", "vs", "with", "from", "into", "over", "than",
  "that", "via", "up", "off",
]);

/**
 * Title Case a paper title. PubMed stores titles in sentence case.
 *
 * Any hyphen-part that already contains a capital is left alone, so AI, IRD,
 * MRI and mRNA survive, while the rest of a compound is still capitalised:
 * "AI-based" becomes "AI-Based", not "Ai-Based" and not "AI-based".
 */
export function titleCase(raw: string): string {
  const words = raw.trim().split(/\s+/);
  let capNext = true;

  return words
    .map((word, i) => {
      const forced = capNext || i === words.length - 1;
      capNext = /[:;?!]$/.test(word);

      const bare = word.replace(/[^A-Za-z]/g, "").toLowerCase();
      if (!forced && TITLE_SMALL.has(bare) && !/[A-Z]/.test(word)) return word.toLowerCase();

      return word
        .split("-")
        .map((part) =>
          /[A-Z]/.test(part) ? part : part.replace(/^([a-z])/, (c) => c.toUpperCase()),
        )
        .join("-");
    })
    .join(" ");
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtRange(run: DigestRun): string {
  const a = new Date(run.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const b = new Date(run.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${a} to ${b}`;
}

function byline(item: RankedItem): string {
  if (item.authors.length === 0) return "";
  return item.authors.length > 1 ? `${item.authors[0]} et al.` : item.authors[0];
}

// ─── Archive page ─────────────────────────────────────────────────────────────

/**
 * Jargon as tappable chips. Uses <details> so it works with no JavaScript and
 * on touch, where hover tooltips silently do nothing. An open chip takes a full
 * row so the definition has somewhere to go.
 */
function termChips(terms: GlossaryTerm[]): string {
  if (!terms.length) return "";
  return `
        <div class="terms">${terms
          .map(
            (t) => `
          <details class="term">
            <summary>${esc(t.term)}</summary>
            <p>${esc(t.definition)}</p>
          </details>`,
          )
          .join("")}
        </div>`;
}

function pageCard(item: RankedItem): string {
  const color = BEAT_COLOR[item.beat] ?? COOL_GREY;
  const author = byline(item);
  const date = fmtDate(item.date);
  const meta = [esc(item.source), author ? esc(author) : null, date]
    .filter(Boolean)
    .join(" &middot; ");

  return `
      <article class="card">
        <div class="card-top">
          <span class="chip" style="--chip:${color}">${esc(BEATS[item.beat].label)}</span>
          ${item.theme ? `<span class="theme">${esc(item.theme)}</span>` : ""}
          ${item.score >= 0 ? `<span class="score" title="Editor score out of 10">${item.score}</span>` : `<span class="score unranked" title="Ranking failed for this item">?</span>`}
        </div>
        <h2><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(titleCase(item.title))}</a></h2>
        <p class="meta">${meta}</p>
        ${item.why ? `<p class="why">${esc(item.why)}</p>` : ""}
        ${
          item.plain && item.plain !== item.why
            ? `<details class="plain">
          <summary>Explain this simply</summary>
          <p>${esc(item.plain)}</p>
        </details>`
            : ""
        }
        ${termChips(item.glossary ?? [])}
      </article>`;
}

export function renderPage(run: DigestRun, archive: Array<{ weekLabel: string; count: number }>): string {
  const cards = run.items.map(pageCard).join("\n");

  const coverage = run.stats.perBeat
    .map(
      (b) =>
        `<li><strong>${esc(BEATS[b.beat]?.label ?? b.label)}</strong>: ${b.retrieved} of ${b.totalMatches} match(es) retrieved${
          b.truncated ? `, <span class="warn">capped, ${b.totalMatches - b.retrieved} not seen</span>` : ""
        }${
          b.staleDropped ? `, ${b.staleDropped} dropped as older than the window` : ""
        }; ${b.newAfterDedup} new after dedup.</li>`,
    )
    .join("\n");

  const failures = run.stats.feedFailures.length
    ? `<p class="warn">Feeds that failed this run: ${run.stats.feedFailures
        .map((f) => `${esc(f.name)} (${esc(f.error)})`)
        .join("; ")}</p>`
    : "";

  const dropped = run.stats.droppedBelowCut
    ? `<p class="warn">${run.stats.droppedBelowCut} item(s) ${
        run.stats.ranked ? "cleared the score floor but were" : "were collected but"
      } cut to keep the digest short.</p>`
    : "";

  const lost = run.stats.refused || run.stats.unscored
    ? `<p class="warn">${run.stats.refused} item(s) were refused by a safety classifier and ${run.stats.unscored} could not be scored. They are missing from this digest, not ranked low.</p>`
    : "";

  const unranked = run.stats.ranked
    ? ""
    : `<p class="warn">Ranking was skipped this run: no API key was available, so these items are unscored and unsummarized.</p>`;

  const archiveLinks = archive
    .map(
      (a) =>
        `<li><a href="${a.weekLabel === run.weekLabel ? "#" : `weeks/${esc(a.weekLabel)}.html`}"${
          a.weekLabel === run.weekLabel ? ' class="current"' : ""
        }>${esc(a.weekLabel)}</a> <span>${a.count}</span></li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Women's Health and AI Weekly &middot; ${esc(run.weekLabel)}</title>
<style>
  :root {
    --cardinal: ${CARDINAL};
    --poppy: ${POPPY};
    --ink: #1c1d1f;
    --body: #33363a;
    --muted: ${COOL_GREY};
    --bg: #faf9f7;
    --surface: #ffffff;
    --line: #e4e1dd;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #f3f1ef; --body: #d6d3d0; --muted: #a3a09c;
      --bg: #151618; --surface: #1e2023; --line: #33363a;
    }
  }
  :root[data-theme="dark"] {
    --ink: #f3f1ef; --body: #d6d3d0; --muted: #a3a09c;
    --bg: #151618; --surface: #1e2023; --line: #33363a;
  }
  :root[data-theme="light"] {
    --ink: #1c1d1f; --body: #33363a; --muted: ${COOL_GREY};
    --bg: #faf9f7; --surface: #ffffff; --line: #e4e1dd;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--body);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 40px 20px 72px; }

  header { border-bottom: 3px solid var(--cardinal); padding-bottom: 18px; margin-bottom: 30px; }
  h1 { margin: 0 0 6px; font-size: 25px; line-height: 1.25; letter-spacing: -0.01em; color: var(--ink); }
  .sub { margin: 0; color: var(--muted); font-size: 14px; }

  .card {
    background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--cardinal);
    border-radius: 6px; padding: 18px 20px; margin-bottom: 14px;
  }
  .card-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .chip {
    font-size: 11px; font-weight: 650; letter-spacing: 0.02em; color: #fff;
    background: var(--chip); padding: 3px 9px; border-radius: 999px; white-space: nowrap;
  }
  .theme { font-size: 12px; color: var(--muted); }
  .score {
    margin-left: auto; font-size: 12px; font-weight: 700; color: var(--poppy);
    border: 1px solid var(--poppy); border-radius: 999px; padding: 2px 9px; white-space: nowrap;
  }
  .score.unranked { color: var(--muted); border-color: var(--line); }

  .card h2 { margin: 0 0 6px; font-size: 17px; line-height: 1.35; font-weight: 650; }
  .card h2 a { color: var(--ink); text-decoration: none; }
  .card h2 a:hover { color: var(--cardinal); text-decoration: underline; }
  .meta { margin: 0; font-size: 13px; color: var(--muted); }
  .why { margin: 10px 0 0; font-size: 15px; color: var(--body); }

  .plain { margin-top: 10px; }
  .plain > summary {
    list-style: none; cursor: pointer; display: inline-block;
    font-size: 12px; color: var(--muted);
    border-bottom: 1px dashed var(--line); padding-bottom: 1px;
  }
  .plain > summary::-webkit-details-marker { display: none; }
  .plain > summary::before { content: "▸"; margin-right: 5px; font-size: 11px; }
  .plain[open] > summary { color: var(--poppy); border-bottom-color: var(--poppy); }
  .plain[open] > summary::before { content: "▾"; }
  .plain p {
    margin: 8px 0 0; font-size: 15px; line-height: 1.6; color: var(--body);
    border-left: 2px solid var(--poppy); padding-left: 12px;
  }

  .terms { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .term { min-width: 0; }
  .term > summary {
    list-style: none; cursor: pointer; font-size: 12px; white-space: nowrap;
    border: 1px dashed var(--line); border-radius: 999px; padding: 2px 10px;
    color: var(--muted); transition: border-color .15s, color .15s;
  }
  .term > summary::-webkit-details-marker { display: none; }
  .term > summary:hover { border-color: var(--poppy); color: var(--poppy); }
  .term[open] { flex-basis: 100%; }
  .term[open] > summary {
    border-style: solid; border-color: var(--poppy); color: var(--poppy);
    display: inline-block; margin-bottom: 6px;
  }
  .term p {
    margin: 0 0 4px; font-size: 14px; line-height: 1.55; color: var(--body);
    border-left: 2px solid var(--line); padding-left: 10px;
  }
  .glossary { margin-bottom: 16px; }
  .glossary > summary { cursor: pointer; color: var(--body); }
  .glossary dl { margin: 10px 0 0; }
  .glossary dt { font-weight: 650; color: var(--ink); margin-top: 10px; font-size: 13px; }
  .glossary dd { margin: 2px 0 0; padding-left: 0; }

  .empty { color: var(--muted); font-style: italic; padding: 24px 0; }

  footer { margin-top: 44px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  footer h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
  footer ul { margin: 0 0 16px; padding-left: 18px; }
  .warn { color: var(--poppy); }

  .archive { list-style: none; padding: 0; margin: 0 0 16px; display: flex; flex-wrap: wrap; gap: 6px; }
  .archive li { display: flex; }
  .archive a {
    color: var(--body); text-decoration: none; border: 1px solid var(--line);
    border-radius: 4px; padding: 3px 9px; font-size: 12px;
  }
  .archive a.current { border-color: var(--cardinal); color: var(--cardinal); font-weight: 650; }
  .archive a span { color: var(--muted); }
  .archive a:hover { border-color: var(--cardinal); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Women's Health and AI Weekly</h1>
    <p class="sub">${esc(fmtRange(run))} &middot; ${run.items.length} item${run.items.length === 1 ? "" : "s"} &middot; ${esc(run.weekLabel)}</p>
  </header>

  ${unranked}
  ${run.items.length ? cards : `<p class="empty">Nothing cleared the bar this week.</p>`}

  <footer>
    <h3>Past Weeks</h3>
    <ul class="archive">${archiveLinks || "<li>None yet</li>"}</ul>

    ${
      (run.terms ?? []).length
        ? `<h3>Glossary (${run.terms.length} term${run.terms.length === 1 ? "" : "s"})</h3>
    <details class="glossary">
      <summary>Every term the digest has explained so far</summary>
      <dl>${(run.terms ?? [])
        .map(
          (t) =>
            `<dt>${esc(t.term)}</dt><dd>${esc(t.definition)}</dd>`,
        )
        .join("")}</dl>
    </details>`
        : ""
    }

    <h3>Coverage</h3>
    <ul>${coverage}</ul>
    ${dropped}
    ${lost}
    ${failures}

    <p>Query version ${esc(run.queryVersion)} &middot; generated ${esc(fmtDate(run.generatedAt))} &middot; sources: PubMed and public RSS feeds.</p>
  </footer>
</div>
</body>
</html>
`;
}

// ─── Email ────────────────────────────────────────────────────────────────────

/**
 * Email has no tappable chips, so terms go in a labelled block under the
 * summary: one per line, term bolded, blank line between entries.
 *
 * An earlier version spliced definitions into the prose in parentheses and
 * appended the rest as a run of italics. It interrupted sentences mid-thought
 * and the leftovers ran together into an unreadable blob. Keeping the prose
 * clean and the definitions separate is both easier to read and easier to skim
 * past when you already know the term.
 */
function emailTerms(terms: GlossaryTerm[]): string {
  if (!terms.length) return "";
  const rows = terms
    .map(
      (t) => `
    <div style="font-size:13px;line-height:1.55;color:#33363a;margin-bottom:9px;">
      <strong style="color:#1c1d1f;">${esc(t.term)}</strong><br>${esc(t.definition)}
    </div>`,
    )
    .join("");

  return `
  <div style="margin-top:14px;padding-top:11px;border-top:1px solid #e4e1dd;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${COOL_GREY};margin-bottom:9px;">Terms</div>${rows}
  </div>`;
}

function emailCard(item: RankedItem): string {
  const color = BEAT_COLOR[item.beat] ?? COOL_GREY;
  const author = byline(item);
  const date = fmtDate(item.date);
  const meta = [esc(item.source), author ? esc(author) : null, date].filter(Boolean).join(" &middot; ");

  return `
<div style="border:1px solid #e4e1dd;border-left:3px solid ${CARDINAL};border-radius:6px;padding:16px 18px;margin-bottom:12px;background:#ffffff;">
  <div style="margin-bottom:8px;">
    <span style="font-size:11px;font-weight:700;color:#ffffff;background:${color};padding:3px 9px;border-radius:999px;">${esc(BEATS[item.beat].label)}</span>
    ${item.theme ? `<span style="font-size:12px;color:${COOL_GREY};margin-left:8px;">${esc(item.theme)}</span>` : ""}
    ${item.score >= 0 ? `<span style="float:right;font-size:12px;font-weight:700;color:${POPPY};border:1px solid ${POPPY};border-radius:999px;padding:1px 8px;">${item.score}</span>` : ""}
  </div>
  <a href="${esc(item.url)}" style="display:block;font-size:16px;font-weight:600;color:#1c1d1f;text-decoration:none;line-height:1.35;margin-bottom:5px;">${esc(titleCase(item.title))}</a>
  <div style="font-size:13px;color:${COOL_GREY};">${meta}</div>
  ${item.why ? `<div style="font-size:14px;color:#33363a;line-height:1.55;margin-top:9px;">${esc(item.why)}</div>` : ""}
  ${
    item.plain && item.plain !== item.why
      ? `<details style="margin-top:11px;">
    <summary style="cursor:pointer;list-style:none;display:inline-block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${CARDINAL};background:#faf6f6;border:1px solid #e6d5d5;border-radius:999px;padding:5px 13px;">Explain this simply</summary>
    <div style="margin-top:9px;padding-left:11px;border-left:2px solid #f0ded0;font-size:13px;line-height:1.55;color:${COOL_GREY};">${esc(item.plain)}</div>
  </details>`
      : ""
  }
  ${emailTerms(item.glossary ?? [])}
</div>`;
}

export function renderEmail(run: DigestRun, archiveUrl: string | null): string {
  const cards = run.items.map(emailCard).join("");

  const notes: string[] = [];
  if (!run.stats.ranked) {
    notes.push("Ranking was skipped this run: no API key was available, so items are unscored.");
  }
  const capped = run.stats.perBeat.filter((b) => b.truncated);
  if (capped.length) {
    notes.push(
      `Capped before ranking: ${capped
        .map((b) => `${esc(BEATS[b.beat]?.label ?? b.label)} (${b.totalMatches - b.retrieved} not seen)`)
        .join(", ")}.`,
    );
  }
  if (run.stats.droppedBelowCut) {
    notes.push(
      `${run.stats.droppedBelowCut} item(s) ${
        run.stats.ranked ? "cleared the score floor but were" : "were collected but"
      } cut to keep this short.`,
    );
  }
  if (run.stats.refused || run.stats.unscored) {
    notes.push(
      `${run.stats.refused} item(s) refused by a safety classifier, ${run.stats.unscored} unscored. Missing here, not ranked low.`,
    );
  }
  if (run.stats.feedFailures.length) {
    notes.push(`Feeds that failed: ${run.stats.feedFailures.map((f) => esc(f.name)).join(", ")}.`);
  }

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#faf9f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;">

  <div style="border-bottom:3px solid ${CARDINAL};padding-bottom:14px;margin-bottom:22px;">
    <div style="font-size:21px;font-weight:700;color:#1c1d1f;letter-spacing:-0.01em;">Women's Health and AI Weekly</div>
    <div style="font-size:13px;color:${COOL_GREY};margin-top:4px;">${esc(fmtRange(run))} &middot; ${run.items.length} item${run.items.length === 1 ? "" : "s"}</div>
  </div>

  ${run.items.length ? cards : `<div style="color:${COOL_GREY};font-style:italic;padding:20px 0;">Nothing cleared the bar this week.</div>`}

  <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e4e1dd;font-size:12px;color:${COOL_GREY};line-height:1.6;">
    ${notes.map((n) => `<div style="color:${POPPY};">${n}</div>`).join("")}
    <div style="margin-top:8px;">
      Query version ${esc(run.queryVersion)} &middot; PubMed and public RSS feeds
      ${archiveUrl ? ` &middot; <a href="${esc(archiveUrl)}" style="color:${COOL_GREY};">View the archive</a>` : ""}
    </div>
  </div>

</div>
</body>
</html>`;
}

export function emailSubject(run: DigestRun): string {
  const top = run.items[0];
  const n = run.items.length;
  const lead = top ? `: ${titleCase(top.title).slice(0, 60)}${top.title.length > 60 ? "..." : ""}` : "";
  return `Women's Health and AI Weekly (${n} item${n === 1 ? "" : "s"})${lead}`;
}
