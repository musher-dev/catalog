/**
 * `npm run revisions:lock`: rewrite `revisions.json` from the tree, after a
 * document's revision is raised, a document is added, or one is removed.
 *
 * It refuses, and writes nothing, when a document's text changed at a revision
 * the ledger already records: that is the change an environment would refuse
 * (see `lib/revisions.ts`), and recording it would hide it. Raise the
 * document's `metadata.revision` and run it again.
 */
import fs from 'node:fs';

import { LEDGER_FILE, compare, currentDocuments, readLedger } from './lib/revisions.ts';

const current = currentDocuments();
const { changed } = compare(readLedger(), current);
if (changed.length > 0) {
  console.error(`revisions.json not written:\n  ${changed.join('\n  ')}`);
  process.exit(1);
}
const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(LEDGER_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`revisions.json: ${Object.keys(sorted).length} documents`);
