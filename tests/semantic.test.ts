/**
 * The `semantic` phase — the rules JSON Schema cannot express.
 *
 * These are the item's cross-document obligations: identity agreement, reference
 * resolution, path containment, and the compatibility of the two ends of every
 * wire. All of them need a second document or the filesystem, and none of them
 * needs the network — which is what makes a repo-local item validate completely
 * offline, all the way through this phase.
 *
 * The `capability` phase is deliberately absent. Whether a Compute Profile is on
 * offer and whether a component version is monotonic are decided against the
 * platform catalog, and an implementation MUST NOT report a rule it has not been
 * given the means to check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverItems, loadItemDocuments, type Item, type ItemDocuments } from './lib/catalog.ts';
import { mediaPathPatternFrom } from './lib/media.ts';
import { loadSchema } from './lib/spec-schemas.ts';
import {
  buildContext,
  checkComponentReferences,
  checkConnections,
  checkDescription,
  checkHealthProbes,
  checkIdentity,
  checkImagePinning,
  checkMedia,
  checkNodeCompute,
  checkOutputInputReferences,
  checkParameters,
  checkPlatformDefaults,
  valueSchemaDefaultsFrom,
  type Diagnostic,
  type SemanticContext,
} from './lib/semantic.ts';

const items = discoverItems();

/**
 * The media-path grammar and the value-schema defaults are read back out of the
 * fetched bundles rather than restated here, so the two places this phase needs
 * them cannot drift from what the spec publishes.
 */
async function contextFor(item: Item): Promise<{ context: SemanticContext; documents: ItemDocuments }> {
  const [listingBundle, componentBundle, documents] = await Promise.all([
    loadSchema('listing'),
    loadSchema('component'),
    loadItemDocuments(item),
  ]);

  const mediaPathPattern = mediaPathPatternFrom(listingBundle.schema);
  const context = buildContext(
    item,
    documents,
    (value) => mediaPathPattern.test(value),
    valueSchemaDefaultsFrom(componentBundle.schema),
  );

  return { context, documents };
}

const report = (diagnostics: Diagnostic[]): string[] =>
  diagnostics.map((diagnostic) => `${diagnostic.code} at ${diagnostic.where}: ${diagnostic.message}`);

for (const item of items) {
  describe(`items/${item.slug}`, () => {
    it('slug and version agree across the item — BP-ID-001/002, LIST-ID-001/002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkIdentity(context)), []);
    });

    it('every component reference resolves to a document inside the item root — §4.1, BP-ID-003', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkComponentReferences(context)), []);
    });

    it('every declared media path resolves to a file inside the item root — LIST-MEDIA-001/002/003', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkMedia(context)), []);
    });

    it('the description satisfies the Markdown profile — LIST-MD-001/002/003', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkDescription(context)), []);
    });

    it('every image reference is pinned — COMP-SRC-001', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkImagePinning(context)), []);
    });

    it('every health probe resolves to an HTTP-family endpoint — §5.4', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkHealthProbes(context)), []);
    });

    it('every platform default resolves to a public endpoint of the right address form — §6.1', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkPlatformDefaults(context)), []);
    });

    it('every INPUT output names a non-CONNECTION input of its own component — COMP-OUT-002/003', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkOutputInputReferences(context)), []);
    });

    it('a node names no compute exactly when its component runs nothing — BP-NODE-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkNodeCompute(context)), []);
    });

    it('every connection resolves at both ends, fills a CONNECTION input, and the two fit — §4.2, BP-CONN-001', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkConnections(context)), []);
    });

    it('the install form covers what a deploying user must supply — §5.2, §5.3', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkParameters(context)), []);
    });
  });
}

describe('the corpus as a whole', () => {
  it('holds one contract per external resourceType', async () => {
    // Not a spec rule — a catalog one. Blueprint §4.1 keeps a repo-local
    // reference inside its item, so every item wiring an external node carries
    // its own copy of it (open-webui's models.yaml beside llm-endpoint's
    // endpoint.yaml). Copies drift silently, and two nodes claiming one
    // resourceType while asking for different values would put two different
    // install forms behind one identifier.
    const byType = new Map<string, { label: string; contract: string }[]>();
    for (const item of items) {
      const { documents } = await contextFor(item);
      for (const doc of documents.components.values()) {
        const spec = doc.value?.['spec'] as Record<string, unknown> | undefined;
        const resourceType = (spec?.['external'] as Record<string, unknown> | undefined)?.['resourceType'];
        if (typeof resourceType !== 'string') continue;
        const list = byType.get(resourceType) ?? [];
        list.push({ label: doc.label, contract: JSON.stringify(spec?.['contract']) });
        byType.set(resourceType, list);
      }
    }

    const drifted = [...byType].flatMap(([resourceType, copies]) =>
      copies.filter((copy) => copy.contract !== copies[0]!.contract).map((copy) => `${copy.label} disagrees with ${copies[0]!.label} on ${resourceType}`),
    );
    assert.deepEqual(drifted, []);
  });

  it('declares every media file it ships', async () => {
    // Not a spec rule — nothing rejects an item for shipping an asset it never
    // declares. It is a catalog rule: an undeclared file is bytes the storefront
    // never serves, and the reason it is here is that a rename leaves the old
    // file behind and nothing else in the pipeline notices.
    const orphans: string[] = [];

    for (const item of items) {
      const { context, documents } = await contextFor(item);
      if (!documents.listing?.value) continue;

      const declared = new Set<string>();
      const spec = documents.listing.value['spec'] as Record<string, unknown> | undefined;
      const icon = spec?.['icon'];
      if (typeof icon === 'string') declared.add(icon);
      for (const shot of (spec?.['screenshots'] as { file?: unknown }[] | undefined) ?? []) {
        if (typeof shot?.file === 'string') declared.add(shot.file);
      }
      const description = spec?.['description'];
      if (typeof description === 'string') {
        for (const match of description.matchAll(/!\[[^\]]*\]\(\s*(\S+?)\s*[)\s]/g)) {
          if (match[1] && context.isMediaPath(match[1])) declared.add(match[1]);
        }
      }

      for (const absolute of item.mediaPaths) {
        const itemRelative = absolute.slice(item.root.length + 1).split(/[\\/]/).join('/');
        if (!declared.has(itemRelative)) orphans.push(`items/${item.slug}/${itemRelative}`);
      }
    }

    assert.deepEqual(orphans, []);
  });
});
