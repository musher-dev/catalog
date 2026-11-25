/**
 * The revision ledger: each component and blueprint document's revision and
 * the SHA-256 of its text, as `revisions.json` at the repository root records
 * them.
 *
 * The platform publishes a document under its `metadata.revision`, and an
 * environment that imported it holds that text under that revision. A later
 * import of different text at the same revision is refused with
 * `ERR_REVISION_NOT_INCREASING`, a comment-only change included, because the
 * platform compares the text's digest, not its parsed value (platform-api,
 * `catalog/application/manifest/lowering.py`, `judge_revision`). The suite
 * cannot see what an environment holds, so the ledger stands in for it: what
 * `main` once published under a revision stays that revision's text.
 *
 * Listings carry no revision and are upserted on every import, so they are
 * not recorded.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { discoverItems, isRecord } from './catalog.ts';
import { REPO_ROOT, rel } from './paths.ts';

export const LEDGER_FILE: string = path.join(REPO_ROOT, 'revisions.json');

export type Entry = { revision: number; sha256: string };
export type Ledger = Record<string, Entry>;

/** Every component and blueprint document now in the tree, by repo-relative path. */
export function currentDocuments(): Ledger {
  const found: Ledger = {};
  for (const item of discoverItems()) {
    const paths = [...(item.blueprintPath ? [item.blueprintPath] : []), ...item.componentPaths];
    for (const absolute of paths) {
      const text = fs.readFileSync(absolute, 'utf8');
      const parsed: unknown = YAML.parse(text);
      const metadata = isRecord(parsed) ? parsed.metadata : undefined;
      const revision = isRecord(metadata) ? metadata.revision : undefined;
      // A document with no integer revision is the structural phase's to refuse.
      if (typeof revision !== 'number' || !Number.isInteger(revision)) continue;
      found[rel(absolute)] = {
        revision,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      };
    }
  }
  return found;
}

export function readLedger(): Ledger {
  return fs.existsSync(LEDGER_FILE)
    ? (JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) as Ledger)
    : {};
}

/**
 * What is wrong with *current* against *ledger*, one line per document.
 * `changed` is text that differs at a revision the ledger already holds, the
 * one a ledger rewrite cannot fix; `stale` is everything `npm run
 * revisions:lock` fixes.
 */
export function compare(ledger: Ledger, current: Ledger): { changed: string[]; stale: string[] } {
  const changed: string[] = [];
  const stale: string[] = [];
  for (const [file, now] of Object.entries(current)) {
    const held = ledger[file];
    if (held === undefined) {
      stale.push(`${file}: not in revisions.json`);
    } else if (now.revision < held.revision) {
      changed.push(`${file}: revision ${now.revision} is below ${held.revision}, already recorded`);
    } else if (now.revision === held.revision && now.sha256 !== held.sha256) {
      changed.push(
        `${file}: the text changed at revision ${now.revision}; raise metadata.revision (a comment counts)`,
      );
    } else if (now.revision > held.revision) {
      stale.push(`${file}: revision ${now.revision}, recorded at ${held.revision}`);
    }
  }
  for (const file of Object.keys(ledger)) {
    if (!(file in current)) stale.push(`${file}: recorded but no longer in the tree`);
  }
  return { changed, stale };
}
