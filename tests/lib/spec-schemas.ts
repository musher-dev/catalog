/**
 * Loads the normative JSON Schema bundles for one exact, released version of
 * each `musher-dev/specifications` family, and refuses any bytes but the
 * released ones.
 *
 * The catalog is not the authority on what a valid item looks like; the spec is.
 * What this repository holds is the release itself: each family's release
 * archive, vendored byte for byte under `vendor/specifications/`, exactly as
 * the specification's adoption guide asks (docs/downstream-v2-adoption.md →
 * Pin the v2 releases). An archive carries its family's bundle, specification,
 * examples, conformance corpus and whole dependency closure, so the suite needs
 * no network at all.
 *
 * A vendored copy is still not a second authority, because nothing here is
 * trusted for being present. Each archive's SHA-256 must equal the digest
 * GitHub records for that immutable release asset, and each bundle inside it
 * must equal the `bundleSha256` the release ledger records (the specification
 * repository's `published.json`). Both are copied into `RELEASES`, never
 * computed: a digest taken from the bytes it is meant to check would check
 * nothing. vendor/specifications/README.md shows how to verify an archive
 * against GitHub before adopting it.
 *
 * Adopting a new release is a deliberate change of the archive and that
 * family's entry in `RELEASES`, in the same pull request. Every core release
 * re-releases every family, so the four sit on one core release.
 *
 * Nothing about the source is configurable. A knob for the version, a mirror, or
 * a local checkout would each be a second answer to "what is the contract",
 * which is the thing this module exists to have only one of.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ajvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { REPO_ROOT } from './paths.ts';

// Ajv 8 ships CommonJS with no `exports` map, so under module:nodenext TypeScript
// types the default import as the module namespace while Node hands back the class
// itself. Re-point the binding at the constructor the namespace declares.
const Ajv2020 = ajvModule as unknown as typeof ajvModule.default;

export const FAMILIES = ['listing', 'blueprint', 'component'] as const;
export type Family = (typeof FAMILIES)[number];

/** Every family with a release archive: the three document families, and core. */
export const ARCHIVE_FAMILIES = ['core', 'component', 'blueprint', 'listing'] as const;
export type ArchiveFamily = (typeof ARCHIVE_FAMILIES)[number];

/** The `kind` discriminator each family's documents must carry. */
export const KIND_OF: Record<Family, string> = {
  listing: 'LISTING',
  blueprint: 'BLUEPRINT',
  component: 'COMPONENT',
};

/** Where the release archives are vendored. */
export const VENDOR_DIR = path.join(REPO_ROOT, 'vendor', 'specifications');

/**
 * The identity of the contract: one released version per family, with the
 * digests that pin its bytes.
 *
 * `archiveSha256` is the digest GitHub records for the release's `.tar.gz`
 * asset (`gh release view <family>/v<version> -R musher-dev/specifications
 * --json assets`), which the release's `SHA256SUMS` also lists.
 * `bundleSha256` is the family's entry in the release ledger,
 * https://specifications.musher.dev/published.json. Core publishes no bundle of
 * its own, so it carries only the archive digest.
 */
export const RELEASES: Record<ArchiveFamily, { version: string; archiveSha256: string; bundleSha256?: string }> = {
  core: {
    version: '2.0.0',
    archiveSha256: '45182a42a1d2b6bf490bc10e859fc85259885d243cda1c2b8b68c3f8cd7763dc',
  },
  component: {
    version: '2.0.0',
    archiveSha256: 'f33eecab25d501ab6147b65e0db939336e3be03f05334f3b722cbfe2736af990',
    bundleSha256: '3ffb508d81765bf2d9fdd168c16e2720912391ba4b6032d391088786bbeb8323',
  },
  blueprint: {
    version: '2.0.0',
    archiveSha256: '9c7397005128e7e04e923a402fbcc4b5ede3ca85c79cb1eaf5728321c851272f',
    bundleSha256: '90af173a303790de9df1e08224c824dd912798e5644b98c30c31d7d22412c92f',
  },
  listing: {
    version: '2.0.0',
    archiveSha256: '5a2addae3eab202da5cb5efedadf8a1a78fb3b017278dff64a67c81bf43a5c94',
    bundleSha256: '5b7b311eb2bf879b50a98fc171d0f22937a15cf592014d0ba6feb60f2272856a',
  },
};

/** The released version of one family, as the release tag spells it. */
export const releaseOf = (family: ArchiveFamily): string => RELEASES[family].version;

/** The major version a release belongs to, as the archive's root directory spells it. */
const majorOf = (family: ArchiveFamily): string => `v${releaseOf(family).split('.')[0]}`;

/** The exact release URL a bundle names as its `$id`, and the editor reads it from. */
export const schemaUrl = (family: Family): string =>
  `https://specifications.musher.dev/${family}/v${releaseOf(family)}/${family}.schema.json`;

/** The vendored archive of one family's release. */
export const archivePath = (family: ArchiveFamily): string =>
  path.join(VENDOR_DIR, `${family}-v${releaseOf(family)}.tar.gz`);

let unpacked: string | null = null;

/**
 * Verify every vendored archive against its pinned digest and unpack them all,
 * once per process, into one scratch directory. An archive whose bytes differ
 * from the release asset is never opened.
 */
export function releasesRoot(): string {
  if (unpacked !== null) return unpacked;

  const into = fs.mkdtempSync(path.join(os.tmpdir(), 'musher-catalog-specifications-'));
  process.on('exit', () => fs.rmSync(into, { recursive: true, force: true }));

  for (const family of ARCHIVE_FAMILIES) {
    const archive = archivePath(family);
    if (!fs.existsSync(archive)) {
      throw new Error(`${path.relative(REPO_ROOT, archive)} is missing: the ${family}/v${releaseOf(family)} release is vendored, never fetched`);
    }
    const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (sha256 !== RELEASES[family].archiveSha256) {
      throw new Error(
        `${path.relative(REPO_ROOT, archive)} has sha256 ${sha256}, but the ${family}/v${releaseOf(family)} ` +
          `release asset is ${RELEASES[family].archiveSha256}. Whatever is vendored is not that release.`,
      );
    }
    execFileSync('tar', ['-xzf', archive, '-C', into]);
  }

  unpacked = into;
  return into;
}

/** The directory one family's archive unpacks to, e.g. `component-v2`. */
export const releaseDir = (family: ArchiveFamily): string => path.join(releasesRoot(), `${family}-${majorOf(family)}`);

/** Every `$ref` in a published bundle resolves inside `$defs`; anything else is external. */
export function externalRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) externalRefs(child, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) found.push(value);
      else externalRefs(value, found);
    }
  }
  return found;
}

/**
 * Sanity on the artifact itself, before the corpus is validated with it. An
 * archive holding another family's bundle, or a truncated one, would otherwise
 * validate every item against nothing at all.
 */
function assertIsFamilyBundle(family: Family, schema: Record<string, unknown>, origin: string): void {
  const where = `${family} schema from ${origin}`;

  if (schema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error(`${where}: expected a JSON Schema 2020-12 document, got $schema=${String(schema['$schema'])}`);
  }

  // The `kind` discriminator is what establishes the family.
  const properties = schema['properties'] as Record<string, { const?: unknown }> | undefined;
  const kind = properties?.['kind']?.const;
  if (kind !== KIND_OF[family]) {
    throw new Error(`${where}: root kind discriminator is ${JSON.stringify(kind)}, expected ${KIND_OF[family]}`);
  }

  // spec README: "Every published schema is a self-contained compound document."
  const external = externalRefs(schema);
  if (external.length > 0) {
    throw new Error(`${where}: not self-contained — external $ref(s): ${external.join(', ')}`);
  }
}

export type FetchedSchema = {
  family: Family;
  schema: Record<string, unknown>;
  origin: string;
  sha256: string;
};

const inFlight = new Map<Family, Promise<FetchedSchema>>();

/** Load (once per process) and structurally vet one family's bundle. */
export function loadSchema(family: Family): Promise<FetchedSchema> {
  let pending = inFlight.get(family);
  if (!pending) {
    pending = resolveSchema(family);
    inFlight.set(family, pending);
  }
  return pending;
}

export const loadAllSchemas = (): Promise<FetchedSchema[]> => Promise.all(FAMILIES.map(loadSchema));

async function resolveSchema(family: Family): Promise<FetchedSchema> {
  const file = path.join(releaseDir(family), `${family}.schema.json`);
  const origin = `${path.relative(REPO_ROOT, archivePath(family))}:${path.basename(releaseDir(family))}/${family}.schema.json`;
  const text = fs.readFileSync(file, 'utf8');

  // The digest is checked before the bytes are even parsed: anything else is not
  // the release this corpus is pinned to, whatever it claims to be.
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (sha256 !== RELEASES[family].bundleSha256) {
    throw new Error(
      `${family} schema in ${origin} has sha256 ${sha256}, but the ${family}/v${releaseOf(family)} ` +
        `release ledger records ${RELEASES[family].bundleSha256}.`,
    );
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${family} schema in ${origin} is not valid JSON: ${(error as Error).message}`);
  }
  assertIsFamilyBundle(family, schema, origin);

  // A released bundle carries its exact-version `$id`.
  if (schema['$id'] !== schemaUrl(family)) {
    throw new Error(`${family} schema in ${origin}: $id is ${String(schema['$id'])}, expected ${schemaUrl(family)}`);
  }

  return { family, schema, origin, sha256 };
}

/**
 * `validateFormats: false` is not a convenience. Core spec §6.2 makes the
 * JSON Schema `format` keyword an annotation that asserts nothing, and forbids a
 * validator from rejecting a document because a value fails one.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

const validators = new Map<Family, ValidateFunction>();

export async function validatorFor(family: Family): Promise<ValidateFunction> {
  let validate = validators.get(family);
  if (!validate) {
    const { schema } = await loadSchema(family);
    validate = ajv.compile(schema);
    validators.set(family, validate);
  }
  return validate;
}

/** Ajv errors as one readable block, deepest instance path first so the specific cause leads. */
export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice()
    .sort((a, b) => b.instancePath.length - a.instancePath.length)
    .map((error) => {
      const at = error.instancePath === '' ? '/' : error.instancePath;
      const params = Object.entries(error.params ?? {})
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      return `  ${at} ${error.message}${params ? ` (${params})` : ''}`;
    })
    .join('\n');
}
