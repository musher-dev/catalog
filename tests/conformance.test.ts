/**
 * The released conformance corpus, run through this repository's own phases.
 *
 * `rules.test.ts` proves each rule here fires on a case written for it. This
 * proves the rules agree with the specification's cases, which were written by
 * someone else: the corpus is the authority on what an implementation must
 * report, and a rule that rejects what it accepts — or accepts what it rejects —
 * is drift this file names by case id.
 *
 * Asserted, per docs/conformance.md: a passing or incomplete case reports
 * nothing; a failing case fails in its declared phase and, for `parser` and
 * `semantic`, reports at least the declared codes. Extra diagnostics are
 * permitted. `behavior.json` is not run: it exercises resolution and install
 * operations, which need context this repository does not have.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { OUT_OF_SCOPE, casesOf, fetchCorpus, runCase, type Case, type CorpusFamily } from './lib/conformance.ts';
import { SPEC_RELEASE } from './lib/spec-schemas.ts';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musher-catalog-conformance-'));
after(() => fs.rmSync(workspace, { recursive: true, force: true }));

const corpus = path.join(workspace, 'corpus');
fs.mkdirSync(corpus);
await fetchCorpus(corpus);

const FAMILIES: CorpusFamily[] = ['core', 'component', 'blueprint', 'listing'];

/** Why a case is not run, or null when it is. */
function skipReason({ metadata, expectedCodes }: Case): string | null {
  if (metadata.phase === 'capability') return 'capability is decided against the platform catalog';
  if (expectedCodes.length > 0 && expectedCodes.every((code) => OUT_OF_SCOPE.has(code))) {
    return `logical value validation is out of scope (${expectedCodes.join(', ')})`;
  }
  return null;
}

for (const family of FAMILIES) {
  describe(`conformance ${family}/v${SPEC_RELEASE}`, () => {
    for (const testCase of casesOf(corpus, family)) {
      const { metadata, expectedCodes } = testCase;
      const reason = skipReason(testCase);

      it(metadata.id, { skip: reason ?? false }, async () => {
        const outcome = await runCase(testCase, workspace);
        const got = `${outcome.failedAt ?? 'nothing'} [${outcome.codes.join(', ')}]`;

        if (metadata.expected !== 'fail') {
          assert.equal(outcome.failedAt, null, `expected ${metadata.expected}, but ${got}`);
          return;
        }

        assert.equal(outcome.failedAt, metadata.phase, `expected a ${metadata.phase} failure [${expectedCodes.join(', ')}], got ${got}`);
        if (metadata.phase === 'structural') return;
        const missing = expectedCodes.filter((code) => !outcome.codes.includes(code));
        assert.deepEqual(missing, [], `declared ${expectedCodes.join(', ')}, got ${got}`);
      });
    }
  });
}
