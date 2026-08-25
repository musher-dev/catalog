/**
 * The `structural` phase — each document against its family's JSON Schema.
 *
 * The bundles are fetched from musher-dev/spec at run time rather than vendored,
 * so what the corpus is judged against is the contract as it currently stands,
 * not a copy of it that has quietly fallen behind.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverItems, loadItemDocuments, type LoadedDocument } from './lib/catalog.ts';
import { KIND_OF, formatAjvErrors, validatorFor, type Family } from './lib/spec-schemas.ts';
import { rel } from './lib/paths.ts';

const items = discoverItems();

async function assertValidates(family: Family, document: LoadedDocument): Promise<void> {
  assert.ok(document.value, `${document.label} did not survive the parser phase`);

  // The envelope's own discriminator is checked first: validating a listing
  // against the component schema produces a wall of errors that says nothing
  // about the actual mistake.
  assert.equal(
    document.value['kind'],
    KIND_OF[family],
    `${document.label} declares kind ${JSON.stringify(document.value['kind'])}, expected ${KIND_OF[family]}`,
  );

  const validate = await validatorFor(family);
  const valid = validate(document.value);
  assert.ok(valid, `${document.label} does not validate against the ${family} schema:\n${formatAjvErrors(validate.errors)}`);
}

for (const item of items) {
  describe(`items/${item.slug}`, () => {
    it('listing.yaml validates against the listing schema', async () => {
      const { listing } = await loadItemDocuments(item);
      assert.ok(listing, `items/${item.slug} holds no listing.yaml`);
      await assertValidates('listing', listing);
    });

    it('blueprint.yaml validates against the blueprint schema', async () => {
      const { blueprint } = await loadItemDocuments(item);
      assert.ok(blueprint, `items/${item.slug} holds no blueprint.yaml`);
      await assertValidates('blueprint', blueprint);
    });

    it('every component document validates against the component schema', async () => {
      const { components } = await loadItemDocuments(item);
      assert.ok(components.size > 0, `items/${item.slug} holds no component document`);

      const failures: string[] = [];
      for (const [componentPath, document] of components) {
        try {
          await assertValidates('component', document);
        } catch (error) {
          failures.push(`${rel(componentPath)}\n${(error as Error).message}`);
        }
      }
      assert.deepEqual(failures, []);
    });
  });
}
