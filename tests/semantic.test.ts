/**
 * The `semantic` phase — the rules JSON Schema cannot express.
 *
 * These are the item's cross-document obligations: identity agreement, reference
 * resolution, path containment, and the compatibility of the two ends of every
 * wire. All of them need a second document or the filesystem, and none of them
 * needs the network — which is what makes an item-local item validate completely
 * offline, all the way through this phase.
 *
 * The `admission` phase is deliberately absent. Whether a Compute Profile is on
 * offer, whether a revision increases, whether a licence is on the SPDX list and
 * how large an image is are decided against the platform, and an implementation
 * MUST NOT report a rule it has not been given the means to check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverItems, type Item, type ItemDocuments } from './lib/catalog.ts';
import {
  checkBindings,
  checkComponentReferences,
  checkComponentCount,
  checkConnectionBindings,
  checkEnvVars,
  checkExposure,
  checkHealthProbes,
  checkIdentity,
  checkInputOrigins,
  checkItemFiles,
  checkItemType,
  checkMedia,
  checkMounts,
  checkNodeCompute,
  checkOutputOrigins,
  checkOverview,
  checkParameters,
  checkSchedule,
  checkSensitiveLiterals,
  checkUnusedInputs,
  checkValueCycles,
  checkVolumeAllocations,
  contextForItem,
  type Diagnostic,
  type SemanticContext,
} from './lib/semantic.ts';

const items = discoverItems();

async function contextFor(item: Item): Promise<{ context: SemanticContext; documents: ItemDocuments }> {
  const context = await contextForItem(item);
  return { context, documents: context.documents };
}

const report = (diagnostics: Diagnostic[]): string[] =>
  diagnostics.map((diagnostic) => `${diagnostic.code} at ${diagnostic.where}: ${diagnostic.message}`);

for (const item of items) {
  describe(`items/${item.slug}`, () => {
    it('slug agrees with the item directory — CORE-ITEM-001', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkIdentity(context)), []);
    });

    it('every YAML file of the item parses — CORE-ITEM-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkItemFiles(context)), []);
    });

    it('itemType agrees with what the item root holds — LIST-ITEM-001', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkItemType(context)), []);
    });

    it('a component item holds exactly one component document — LIST-ITEM-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkComponentCount(context)), []);
    });

    it('every component reference resolves to a valid document inside the item root — §4.1, §10, BP-ID-003', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkComponentReferences(context)), []);
    });

    it('every declared media path resolves to a file inside the item root, within its size bound — LIST-MEDIA-001..004', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkMedia(context)), []);
    });

    it('the overview and getting-started text satisfy the Markdown profile — LIST-MD-001/002/003', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkOverview(context)), []);
    });

    it('no two inputs claim one environment variable — COMP-ENVVAR-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkEnvVars(context)), []);
    });

    it('every mount path is canonical and no two mounts nest — §5.5', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkMounts(context)), []);
    });

    it('every schedule is a cron expression within §5.7\'s ranges — COMP-JOB-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkSchedule(context)), []);
    });

    it('every health probe names an endpoint that answers HTTP — §5.4, COMP-EP-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkHealthProbes(context)), []);
    });

    it('every trust bundle, probe credential and build secret reads an input that is always supplied — COMP-EP-006/010, COMP-BUILD-004', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkInputOrigins(context)), []);
    });

    it('every output origin names something its own component declares — COMP-OUT-002/003/004, COMP-PLACEHOLDER-001, COMP-EP-004', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkOutputOrigins(context)), []);
    });

    it('every input without a target is read by something — COMP-INPUT-001', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkUnusedInputs(context)), []);
    });

    it('no authored literal supplies a sensitive contract — COMP-VAL-005, §11', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkSensitiveLiterals(context)), []);
    });

    it('a node names compute exactly when its component runs — BP-NODE-001, BP-NODE-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkNodeCompute(context)), []);
    });

    it('every volume the component declares is allocated at or above its minimum — §4.3', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkVolumeAllocations(context)), []);
    });

    it('every exposed endpoint exists, is exposable, and is gated — §4.3, COMP-EP-003', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkExposure(context)), []);
    });

    it('every binding resolves at both ends and the two types fit — §4.2, BP-BIND-006/007, BP-PARAM-008', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkBindings(context)), []);
    });

    it('no value depends on itself — BP-BIND-002', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkValueCycles(context)), []);
    });

    it('a connection input takes a connection parameter, and a connection parameter takes one — BP-CONNECTION-001', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkConnectionBindings(context)), []);
    });

    it('every parameter is bound, agrees with what it supplies, names a permitted origin and is offered where it must be — BP-PARAM-001..003, BP-PLACEHOLDER-001, BP-UI-003, BP-UI-005', async () => {
      const { context } = await contextFor(item);
      assert.deepEqual(report(checkParameters(context)), []);
    });
  });
}

describe('the corpus as a whole', () => {
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
      for (const field of ['overview', 'gettingStarted']) {
        const markdown = spec?.[field];
        if (typeof markdown !== 'string') continue;
        for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*(\S+?)\s*[)\s]/g)) {
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
