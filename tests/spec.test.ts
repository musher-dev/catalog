/**
 * The spec bundles themselves.
 *
 * These tests fail first and loudest when the contract cannot be reached or
 * comes back as something other than what it claims — before any item is judged
 * against it. A corpus validated against a 404 page passes everything.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FAMILIES, KIND_OF, externalRefs, loadSchema } from './lib/spec-schemas.ts';

describe('musher-dev/spec', () => {
  it('resolves all three bundles from the public repository at run time', async () => {
    const bundles = await Promise.all(FAMILIES.map(loadSchema));
    for (const bundle of bundles) {
      console.log(`  ${bundle.family.padEnd(10)} sha256:${bundle.sha256.slice(0, 12)}  ${bundle.origin}`);
    }
    assert.equal(bundles.length, FAMILIES.length);
  });

  for (const family of FAMILIES) {
    describe(family, () => {
      it('is a JSON Schema 2020-12 document', async () => {
        const { schema } = await loadSchema(family);
        assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema');
      });

      it(`discriminates documents on kind: ${KIND_OF[family]}`, async () => {
        const { schema } = await loadSchema(family);
        const properties = schema['properties'] as Record<string, { const?: unknown }>;
        assert.equal(properties['kind']?.const, KIND_OF[family]);
      });

      it('is self-contained — every $ref resolves inside the bundle', async () => {
        // spec README: no validator ever needs to make a network request to
        // evaluate a document, which is what makes offline validation possible.
        const { schema } = await loadSchema(family);
        assert.deepEqual(externalRefs(schema), []);
      });

      it('closes the document envelope', async () => {
        // COMP-ENV-005: unknown properties are rejected at every level, so a
        // misspelled field is an error rather than a silently ignored one.
        const { schema } = await loadSchema(family);
        assert.equal(schema['additionalProperties'], false);
        assert.deepEqual(schema['required'], ['specVersion', 'kind', 'metadata', 'spec']);
      });
    });
  }
});
