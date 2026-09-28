/**
 * The spec bundles themselves.
 *
 * These tests fail first and loudest when the contract cannot be reached or
 * comes back as something other than what it claims — before any item is judged
 * against it. A corpus validated against a 404 page passes everything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { REPO_ROOT } from './lib/paths.ts';
import { FAMILIES, KIND_OF, RELEASES, externalRefs, loadSchema, releaseOf, schemaUrl } from './lib/spec-schemas.ts';

describe('musher-dev/specifications', () => {
  it('resolves every pinned family bundle from the published origin', async () => {
    const bundles = await Promise.all(FAMILIES.map(loadSchema));
    for (const bundle of bundles) {
      console.log(`  ${bundle.family.padEnd(10)} sha256:${bundle.sha256.slice(0, 12)}  ${bundle.origin}`);
    }
    assert.equal(bundles.length, FAMILIES.length);
  });

  for (const family of FAMILIES) {
    describe(family, () => {
      it(`is the ${family}/v${releaseOf(family)} release, byte for byte`, async () => {
        // The ledger's digest, not one computed here: the exact release URL
        // serves the same bytes for as long as the site exists.
        const { sha256, schema } = await loadSchema(family);
        assert.equal(sha256, RELEASES[family].bundleSha256);
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

/**
 * The editor's schemas are the suite's. The dev container points the YAML
 * extension at a schema for each family, and it has to be the release pinned
 * above: an alias or an older pin lets the editor accept, or flag, a document
 * that `npm test` judges the other way. This is what makes adopting a release
 * update both places, in the same pull request.
 */
describe('dev container', () => {
  const GLOBS: Record<string, string> = {
    listing: 'items/*/listing.yaml',
    blueprint: 'items/*/blueprint.yaml',
    component: 'items/*/components/*.yaml',
  };

  it('points the editor at the pinned release of every family', () => {
    // JSON with comments, which JSON.parse refuses. TypeScript's tsconfig
    // reader is the JSONC parser already in this repository's toolchain.
    const file = path.join(REPO_ROOT, '.devcontainer', 'devcontainer.json');
    const { config, error } = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'));
    assert.equal(error, undefined, 'devcontainer.json does not parse');

    const schemas = config?.customizations?.vscode?.settings?.['yaml.schemas'];
    assert.deepEqual(schemas, Object.fromEntries(FAMILIES.map((family) => [schemaUrl(family), GLOBS[family]])));
  });
});
