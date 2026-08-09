/**
 * scripts/reset.ts
 *
 * Clear the previous owner's accumulated state. Run this once after forking or
 * copying the repo, before your first digest.
 *
 *   npm run reset
 *
 * Why this exists: data/seen.json is a permanent record of every item the
 * digest has ever considered, and it is committed to the repo so the schedule
 * has somewhere to remember things. That is the right design for one person and
 * exactly wrong for a second one, because a fork inherits the ledger and
 * silently skips everything the original owner already saw. Their first digest
 * comes back nearly empty and looks broken rather than inherited.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function count(file: string): Promise<number> {
  try {
    return Object.keys(JSON.parse(await fs.readFile(path.join(ROOT, file), "utf8"))).length;
  } catch {
    return 0;
  }
}

async function rmGlob(dir: string, ext: string): Promise<number> {
  const full = path.join(ROOT, dir);
  let files: string[];
  try {
    files = await fs.readdir(full);
  } catch {
    return 0;
  }
  const hits = files.filter((f) => f.endsWith(ext));
  await Promise.all(hits.map((f) => fs.unlink(path.join(full, f))));
  return hits.length;
}

async function main(): Promise<void> {
  const seen = await count("data/seen.json");
  const terms = await count("data/glossary.json");

  console.log("This will clear the accumulated state in this repo:\n");
  console.log(`  data/seen.json        ${seen} remembered item(s)`);
  console.log(`  data/glossary.json    ${terms} defined term(s)`);
  console.log(`  data/digests/*.json   past digests`);
  console.log(`  docs/*.html           rendered pages\n`);
  console.log("Your code, queries, and settings are untouched.\n");

  const keepGlossary = process.argv.includes("--keep-glossary");
  if (keepGlossary) console.log("--keep-glossary: definitions will be kept.\n");

  if (!process.argv.includes("--yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Type 'reset' to confirm: ");
    rl.close();
    if (answer.trim().toLowerCase() !== "reset") {
      console.log("Canceled. Nothing changed.");
      return;
    }
  }

  await fs.writeFile(path.join(ROOT, "data/seen.json"), "{}\n", "utf8");
  if (!keepGlossary) {
    await fs.writeFile(path.join(ROOT, "data/glossary.json"), "{}\n", "utf8");
  }
  const digests = await rmGlob("data/digests", ".json");
  const pages = (await rmGlob("docs", ".html")) + (await rmGlob("docs/weeks", ".html"));

  console.log(`\nCleared. Removed ${digests} digest(s) and ${pages} page(s).`);
  console.log("Next: edit READER_PROFILE in lib/rank.ts, then run npm run digest.");
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
