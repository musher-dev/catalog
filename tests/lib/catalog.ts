/**
 * Discovery of the catalog corpus and the item shape the spec defines.
 *
 * A **catalog item** is one directory holding one deployable thing
 * (blueprint spec §3.1, listing spec §3.1). The directory holding `blueprint.yaml`
 * — or, for an item that holds none, `listing.yaml` — is the **item root**, and
 * it is what every containment and identity rule is measured against.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ITEMS_DIR, rel } from './paths.ts';
import { parseDocument, type ParserDiagnostic } from './yaml-profile.ts';

/** Only two names in an item tree are fixed by the blueprint family. */
export const LISTING_FILE = 'listing.yaml';
export const BLUEPRINT_FILE = 'blueprint.yaml';
/** `media/` is fixed too, but by the listing family (listing spec §5). */
export const MEDIA_DIR = 'media';
/** `components/` is a convention rather than a rule; a flat sibling is equally valid. */
export const COMPONENTS_DIR = 'components';

/** metadata.slug grammar, shared with blueprint node names. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const isYamlFile = (name: string): boolean => name.endsWith('.yaml') || name.endsWith('.yml');

export type Item = {
  slug: string;
  /** The item root — absolute. */
  root: string;
  listingPath: string | null;
  blueprintPath: string | null;
  /**
   * Every YAML document under the root that is neither of the two fixed names.
   * Component documents MAY sit anywhere under the root, so this is a walk rather
   * than a listing of `components/` — which is what makes `ERR_UNREFERENCED_COMPONENT`
   * able to see a stray document parked outside the conventional directory.
   */
  componentPaths: string[];
  /** Every regular file under `media/`, whether or not the listing declares it. */
  mediaPaths: string[];
  /** Top-level entries of the item directory, for the layout rules. */
  entries: fs.Dirent[];
  /** Symlinks found anywhere in the item, which the containment rules turn on. */
  symlinkPaths: string[];
};

/** Every file below `dir`, with symlinks reported rather than followed. */
function walk(dir: string, onSymlink: (absolute: string) => void): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      onSymlink(absolute);
      found.push(absolute);
    } else if (entry.isDirectory()) {
      found.push(...walk(absolute, onSymlink));
    } else if (entry.isFile()) {
      found.push(absolute);
    }
  }
  return found;
}

export function discoverItems(itemsDir: string = ITEMS_DIR): Item[] {
  if (!fs.existsSync(itemsDir)) return [];

  return fs
    .readdirSync(itemsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((slug) => readItem(path.join(itemsDir, slug)));
}

/** The item model for one directory, whether or not it lives under `items/`. */
export function readItem(root: string): Item {
  const symlinkPaths: string[] = [];
  const noteSymlink = (absolute: string) => symlinkPaths.push(absolute);

  const listingPath = path.join(root, LISTING_FILE);
  const blueprintPath = path.join(root, BLUEPRINT_FILE);
  const mediaRoot = path.join(root, MEDIA_DIR);

  const componentPaths = walk(root, noteSymlink)
    .filter((absolute) => isYamlFile(absolute))
    .filter((absolute) => absolute !== listingPath && absolute !== blueprintPath)
    .filter((absolute) => !absolute.startsWith(mediaRoot + path.sep))
    .sort();

  return {
    slug: path.basename(root),
    root,
    listingPath: fs.existsSync(listingPath) ? listingPath : null,
    blueprintPath: fs.existsSync(blueprintPath) ? blueprintPath : null,
    componentPaths,
    mediaPaths: walk(mediaRoot, noteSymlink).sort(),
    entries: fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [],
    symlinkPaths: [...new Set(symlinkPaths)].sort(),
  };
}

export type LoadedDocument = {
  path: string;
  /** Repo-relative, for messages. */
  label: string;
  value: Record<string, unknown> | undefined;
  parserDiagnostics: ParserDiagnostic[];
};

export async function loadDocument(absolutePath: string): Promise<LoadedDocument> {
  const { value, diagnostics } = await parseDocument(absolutePath);
  return {
    path: absolutePath,
    label: rel(absolutePath),
    value: isRecord(value) ? value : undefined,
    parserDiagnostics: diagnostics,
  };
}

export type ItemDocuments = {
  listing: LoadedDocument | null;
  blueprint: LoadedDocument | null;
  /** Keyed by absolute path. */
  components: Map<string, LoadedDocument>;
};

export async function loadItemDocuments(item: Item): Promise<ItemDocuments> {
  const [listing, blueprint, components] = await Promise.all([
    item.listingPath ? loadDocument(item.listingPath) : Promise.resolve(null),
    item.blueprintPath ? loadDocument(item.blueprintPath) : Promise.resolve(null),
    Promise.all(item.componentPaths.map(loadDocument)),
  ]);
  return { listing, blueprint, components: new Map(components.map((doc) => [doc.path, doc])) };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether `target` resolves inside `root`.
 *
 * Containment is a property of the **resolved** location rather than of the
 * string (blueprint spec §10, listing spec §5): a link committed inside an item
 * can point anywhere the process can read. A dangling link whose target lies
 * outside the root is an escape too — existence is not what the rule turns on —
 * so an unresolvable leaf is resolved through its parent instead.
 */
export function resolvesInside(root: string, target: string): boolean {
  const realRoot = realpathOrNearest(root);
  const realTarget = realpathOrNearest(target);
  if (realRoot === null || realTarget === null) return false;
  const relative = path.relative(realRoot, realTarget);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** realpath of `target`, or of the deepest ancestor that exists, with the rest re-appended. */
function realpathOrNearest(target: string): string | null {
  let current = path.resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}
