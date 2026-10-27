/**
 * The spec bundles themselves.
 *
 * These tests fail first and loudest when the vendored contract is missing or
 * is something other than what it claims — before any item is judged against
 * it. A corpus validated against the wrong bundle passes everything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { REPO_ROOT } from './lib/paths.ts';
import {
  ARCHIVE_FAMILIES,
  FAMILIES,
  KIND_OF,
  RELEASES,
  VENDOR_DIR,
  archivePath,
  externalRefs,
  loadSchema,
  releaseDir,
  releaseOf,
  schemaUrl,
} from './lib/spec-schemas.ts';

describe('musher-dev/specifications', () => {
  it('vendors exactly the pinned release archives, and nothing else', () => {
    const expected = ARCHIVE_FAMILIES.map((family) => path.basename(archivePath(family))).sort();
    const vendored = fs.readdirSync(VENDOR_DIR).filter((name) => name.endsWith('.tar.gz')).sort();
    assert.deepEqual(vendored, expected);
  });

  it('records each archive in SHA256SUMS with its pinned digest', () => {
    // The release's own SHA256SUMS lines, so `sha256sum --check` verifies the
    // vendored bytes without this suite. They must say what RELEASES says.
    const sums = fs.readFileSync(path.join(VENDOR_DIR, 'SHA256SUMS'), 'utf8').trim().split('\n').sort();
    const expected = ARCHIVE_FAMILIES.map((family) => `${RELEASES[family].archiveSha256}  ${path.basename(archivePath(family))}`).sort();
    assert.deepEqual(sums, expected);
  });

  for (const family of ARCHIVE_FAMILIES) {
    it(`unpacks the ${family}/v${releaseOf(family)} archive, whose release record names that release`, () => {
      const record = JSON.parse(fs.readFileSync(path.join(releaseDir(family), 'specification.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(record['tag'], `${family}/v${releaseOf(family)}`);
      // Every family sits on one core release (docs/publication.md, the
      // dependency gate), so each names the core this suite pins.
      if (family !== 'core') assert.equal(record['coreTag'], `core/v${releaseOf('core')}`);
      const bundle = RELEASES[family].bundleSha256;
      if (bundle !== undefined) assert.equal(record['bundleSha256'], bundle);
    });
  }

  it('resolves every pinned family bundle from its vendored archive', async () => {
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
