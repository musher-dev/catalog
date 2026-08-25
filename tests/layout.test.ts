/**
 * Item layout — the folder structure every catalog item must follow.
 *
 * Two shapes are defined. Blueprint spec §3.1 anchors the item root on
 * `blueprint.yaml`; listing spec §3.1 anchors it on `listing.yaml` for an item
 * that holds no blueprint. Only three names in the tree are fixed —
 * `blueprint.yaml`, `listing.yaml`, and `media/` — so this file tests those and
 * the catalog's own additions on top of them, which the repository README states
 * as hard requirements for a platform sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLUEPRINT_FILE,
  COMPONENTS_DIR,
  LISTING_FILE,
  MEDIA_DIR,
  SLUG_PATTERN,
  discoverItems,
} from './lib/catalog.ts';
import { ITEMS_DIR, rel } from './lib/paths.ts';

/** Extensions listing spec §5 permits for a media path. */
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** What a catalog item directory is allowed to hold at its top level. */
const PERMITTED_ENTRIES = new Set([LISTING_FILE, BLUEPRINT_FILE, COMPONENTS_DIR, MEDIA_DIR]);

const items = discoverItems();

describe('catalog layout', () => {
  it('holds at least one item', () => {
    assert.ok(items.length > 0, `no item directories found under ${rel(ITEMS_DIR)}`);
  });

  it('puts every item in its own directory directly under items/', () => {
    const strays = fs
      .readdirSync(ITEMS_DIR, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name);
    assert.deepEqual(strays, [], `items/ holds entries that are not item directories: ${strays.join(', ')}`);
  });

  it('derives slug uniqueness from the directory name', () => {
    // The directory name *is* the slug, so uniqueness is structural. This asserts
    // the property the corpus relies on rather than re-deriving it.
    const slugs = items.map((item) => item.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  });
});

for (const item of items) {
  describe(`items/${item.slug}`, () => {
    it('is named by a valid slug', () => {
      assert.match(item.slug, SLUG_PATTERN);
    });

    it(`holds ${LISTING_FILE}`, () => {
      // The storefront wrapper is what makes a directory a catalog item, and it
      // is the item root for an item holding no blueprint.
      assert.ok(item.listingPath, `${rel(item.root)} holds no ${LISTING_FILE}`);
    });

    it(`holds ${BLUEPRINT_FILE}`, () => {
      // A catalog rule rather than a spec one: the spec lets a COMPONENT-kind
      // listing ship without a blueprint, and the platform deploys exactly one
      // blueprint per listing — so this corpus authors a trivial single-node
      // blueprint even there, per the repository README.
      assert.ok(item.blueprintPath, `${rel(item.root)} holds no ${BLUEPRINT_FILE}`);
    });

    it('holds at least one component document', () => {
      assert.ok(item.componentPaths.length > 0, `${rel(item.root)} holds no component document`);
    });

    it(`keeps its component documents under ${COMPONENTS_DIR}/`, () => {
      // `components/` is a convention the spec does not impose — a flat sibling
      // is equally valid — but this corpus keeps it so a reader can find the
      // building blocks of any item in the same place.
      const misplaced = item.componentPaths
        .filter((absolute) => path.dirname(absolute) !== path.join(item.root, COMPONENTS_DIR))
        .map(rel);
      assert.deepEqual(misplaced, []);
    });

    it('holds no unexpected top-level entries', () => {
      const unexpected = item.entries
        .map((entry) => entry.name)
        .filter((name) => !PERMITTED_ENTRIES.has(name))
        .sort();
      assert.deepEqual(
        unexpected,
        [],
        `${rel(item.root)} holds ${unexpected.join(', ')}; permitted: ${[...PERMITTED_ENTRIES].join(', ')}`,
      );
    });

    it('uses the .yaml spelling for the two fixed names', () => {
      const wrongSpelling = ['listing.yml', 'blueprint.yml'].filter((name) =>
        fs.existsSync(path.join(item.root, name)),
      );
      assert.deepEqual(wrongSpelling, [], 'the fixed names are blueprint.yaml and listing.yaml');
    });

    it(`ships assets only from ${MEDIA_DIR}/`, () => {
      // listing spec §5: one fixed directory means a reader can find every asset
      // an item ships without first reading its listing, and a publisher can copy
      // that directory without walking the document to work out what to take.
      const wrongExtension = item.mediaPaths
        .filter((absolute) => !MEDIA_EXTENSIONS.has(path.extname(absolute).toLowerCase()))
        .map(rel);
      assert.deepEqual(
        wrongExtension,
        [],
        `media/ may hold only ${[...MEDIA_EXTENSIONS].join(', ')} files`,
      );
    });

    it('contains no symbolic links', () => {
      // Defence in depth for the containment rules the semantic phase enforces.
      // A link committed inside an item can point anywhere the process can read,
      // and this corpus has no use for one, so the whole class is excluded here.
      assert.deepEqual(item.symlinkPaths.map(rel), []);
    });
  });
}
