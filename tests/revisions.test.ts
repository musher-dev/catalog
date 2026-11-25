/**
 * The revision ledger (`lib/revisions.ts`): a component or blueprint document
 * whose text changes must raise its `metadata.revision`, and `revisions.json`
 * must record every document as it stands.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compare, currentDocuments, readLedger } from './lib/revisions.ts';

const ledger = readLedger();
const current = currentDocuments();
const { changed, stale } = compare(ledger, current);

describe('revision ledger', () => {
  it('records at least one document', () => {
    assert.ok(Object.keys(ledger).length > 0, 'revisions.json is missing or empty');
  });

  it('never changes a document without raising its revision', () => {
    assert.deepEqual(changed, [], `an environment holding the recorded text refuses these:\n  ${changed.join('\n  ')}`);
  });

  it('is current: run `npm run revisions:lock` after raising, adding or removing a document', () => {
    assert.deepEqual(stale, [], stale.join('\n'));
  });
});

describe('revision ledger rules', () => {
  const held = { 'a.yaml': { revision: 2, sha256: 'x' } };
  it('refuses new text at a recorded revision', () => {
    assert.equal(compare(held, { 'a.yaml': { revision: 2, sha256: 'y' } }).changed.length, 1);
  });
  it('refuses a lowered revision', () => {
    assert.equal(compare(held, { 'a.yaml': { revision: 1, sha256: 'x' } }).changed.length, 1);
  });
  it('asks for a rewrite, not a bump, when the revision was raised', () => {
    const result = compare(held, { 'a.yaml': { revision: 3, sha256: 'y' } });
    assert.deepEqual([result.changed.length, result.stale.length], [0, 1]);
  });
  it('accepts the recorded text', () => {
    assert.deepEqual(compare(held, { 'a.yaml': { revision: 2, sha256: 'x' } }), { changed: [], stale: [] });
  });
});
