/**
 * The spec bundles themselves.
 *
 * These tests fail first and loudest when the contract cannot be reached or
 * comes back as something other than what it claims — before any item is judged
 * against it. A corpus validated against a 404 page passes everything.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUNDLE_SHA256, FAMILIES, KIND_OF, SPEC_RELEASE, externalRefs, loadSchema, schemaUrl } from './lib/spec-schemas.ts';

describe('musher-dev/specifications', () => {
  it(`resolves all three v${SPEC_RELEASE} bundles from the published origin`, async () => {
    const bundles = await Promise.all(FAMILIES.map(loadSchema));
    for (const bundle of bundles) {
      console.log(`  ${bundle.family.padEnd(10)} sha256:${bundle.sha256.slice(0, 12)}  ${bundle.origin}`);
    }
    assert.equal(bundles.length, FAMILIES.length);
  });

  for (const family of FAMILIES) {
    describe(family, () => {
      it(`is the ${family}/v${SPEC_RELEASE} release, byte for byte`, async () => {
        // The ledger's digest, not one computed here: the exact release URL
        // serves the same bytes for as long as the site exists.
        const { sha256, schema } = await loadSchema(family);
        assert.equal(sha256, BUNDLE_SHA256[family]);
        assert.equal(schema['$id'], schemaUrl(family));
      });

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
        // CORE-ENV-005: unknown properties are rejected at every level, so a
        // misspelled field is an error rather than a silently ignored one.
        const { schema } = await loadSchema(family);
        assert.equal(schema['additionalProperties'], false);
        assert.deepEqual(schema['required'], ['specVersion', 'kind', 'metadata', 'spec']);
      });
    });
  }
});
