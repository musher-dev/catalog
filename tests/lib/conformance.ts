/**
 * An adapter over the conformance corpus `musher-dev/specifications` releases —
 * its own words: "each implementation writes its own thin adapter over this
 * data" (docs/conformance.md).
 *
 * The corpus is read from each family's release archive, fetched on
 * every run and checked against the SHA-256 digests GitHub records for those
 * immutable release assets, for the same reason the schemas are: a copy held
 * here would be a second authority that drifts. The blueprint archive carries
 * the component and core corpora it was released against, so two archives
 * cover all four families.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readItem } from './catalog.ts';
import { contextForItem, runSemanticChecks } from './semantic.ts';
import { RELEASES, releaseOf, validatorFor, type Family } from './spec-schemas.ts';
import { parseDocument } from './yaml-profile.ts';

const TIMEOUT_MS = Number(process.env.MUSHER_SPEC_TIMEOUT_MS ?? 15_000);

/**
 * The families whose release archives carry a conformance corpus. The blueprint
 * archive carries the component and core corpora of the releases it was built
 * against, so these two cover all four. Their versions and asset digests live
 * in `RELEASES` with the bundle digests, so adopting a release is one edit.
 */
const ARCHIVE_FAMILIES = ['blueprint', 'listing'] as const;
type ArchiveFamily = (typeof ARCHIVE_FAMILIES)[number];

const archiveSha256 = (family: ArchiveFamily): string => {
  const digest = RELEASES[family].archiveSha256;
  if (digest === undefined) throw new Error(`RELEASES.${family} carries no archiveSha256`);
  return digest;
};

const archiveUrl = (family: ArchiveFamily): string => {
  const version = releaseOf(family);
  return `https://github.com/musher-dev/specifications/releases/download/${family}/v${version}/${family}-v${version}.tar.gz`;
};

export type CorpusFamily = 'core' | Family;

/** Where each family's corpus sits once both archives are unpacked under one directory. */
const CORPUS_DIRS: Record<CorpusFamily, string> = {
  core: 'blueprint-v1/core/conformance',
  component: 'blueprint-v1/component/conformance',
  blueprint: 'blueprint-v1/conformance',
  listing: 'listing-v1/conformance',
};

/**
 * Codes the catalog deliberately does not decide: logical value validation
 * needs a validator for the bounded 2020-12 value profile, which is a different
 * project from reading documents (tests/README.md). A case expecting only these
 * is skipped by name, never passed.
 */
export const OUT_OF_SCOPE = new Set(['ERR_VALUE_CONSTRAINT', 'ERR_SECRET_LITERAL', 'ERR_INVALID_VALUE_SCHEMA']);

/**
 * Rules measured against an item root. A `case.yaml` asserts it has none, and an
 * implementation in that position MUST NOT report them (docs/conformance.md →
 * Case trees). The adapter still has to hand the checks an item, so these are
 * the diagnostics it discards when the item is its own invention.
 */
const ITEM_ROOT_CODES = new Set([
  'ERR_SLUG_MISMATCH',
  'ERR_ITEM_TYPE_MISMATCH',
  'ERR_COMPONENT_NOT_FOUND',
  'ERR_REFERENCE_ESCAPE',
  'ERR_UNREFERENCED_COMPONENT',
  'ERR_INVALID_DEPENDENCY',
  'ERR_MEDIA_NOT_FOUND',
  'ERR_PATH_ESCAPE',
]);

/** Where the synthetic item puts a `case.yaml` of each family. */
const CASE_FILE: Record<Family, string> = {
  component: 'components/case.yaml',
  blueprint: 'blueprint.yaml',
  listing: 'listing.yaml',
};

type Phase = 'parser' | 'structural' | 'semantic';

export type CaseMetadata = {
  id: string;
  phase: Phase | 'capability';
  expected: 'pass' | 'fail' | 'incomplete';
  document?: string;
  symlinks?: Record<string, string>;
};

export type Case = {
  family: CorpusFamily;
  directory: string;
  metadata: CaseMetadata;
  /** The declared diagnostic codes; empty unless `expected` is `fail`. */
  expectedCodes: string[];
};

export type Outcome = {
  /** The first phase that reported anything, or null when every phase passed. */
  failedAt: Phase | null;
  /** Diagnostic codes from that phase — always empty for `structural`. */
  codes: string[];
};

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS * 4) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Fetch, verify and unpack both archives into `into`. */
export async function fetchCorpus(into: string): Promise<void> {
  await Promise.all(
    ARCHIVE_FAMILIES.map(async (family) => {
      const url = archiveUrl(family);
      let bytes: Buffer;
      try {
        bytes = await download(url);
      } catch (error) {
        throw new Error(
          `Could not fetch the ${family} conformance archive from ${url}: ${(error as Error).message}\n` +
            'The corpus is read from the pinned release, so this needs network access to github.com.',
        );
      }

      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== archiveSha256(family)) {
        throw new Error(
          `${url} has sha256 ${sha256}, but the ${family}/v${releaseOf(family)} release asset is ${archiveSha256(family)}`,
        );
      }

      const archive = path.join(into, `${family}.tar.gz`);
      fs.writeFileSync(archive, bytes);
      execFileSync('tar', ['-xzf', archive, '-C', into]);
      fs.rmSync(archive);
    }),
  );
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

/** Every indexed case of one family. `cases.json` is the contract; the directory tree is not. */
export function casesOf(root: string, family: CorpusFamily): Case[] {
  const corpus = path.join(root, CORPUS_DIRS[family]);
  const index = readJson<{ cases: { id: string; path: string }[] }>(path.join(corpus, 'cases.json'));

  return index.cases.map(({ path: relative }) => {
    const directory = path.join(corpus, relative);
    const metadata = readJson<CaseMetadata>(path.join(directory, 'metadata.json'));
    const diagnostics = path.join(directory, 'diagnostics.json');
    const expectedCodes = fs.existsSync(diagnostics)
      ? [...new Set(readJson<{ code: string }[]>(diagnostics).map((diagnostic) => diagnostic.code))]
      : [];
    return { family, directory, metadata, expectedCodes };
  });
}

let materialised = 0;

/**
 * Run one case through the phases this repository implements, in order,
 * stopping at the first that reports anything (core §6).
 */
export async function runCase(testCase: Case, workspace: string): Promise<Outcome> {
  const { family, directory, metadata } = testCase;
  const scratch = path.join(workspace, `case-${materialised++}`);

  // Materialise the subject somewhere writable: a tree with its declared links,
  // or a lone document inside an item root this adapter invents.
  let root: string;
  let documentPath: string;
  if (metadata.document) {
    fs.cpSync(path.join(directory, 'tree'), scratch, { recursive: true });
    for (const [link, target] of Object.entries(metadata.symlinks ?? {})) {
      const at = path.join(scratch, link);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.rmSync(at, { force: true });
      fs.symlinkSync(target, at);
    }
    documentPath = path.join(scratch, metadata.document);
    root = path.dirname(documentPath);
  } else {
    root = path.join(scratch, 'case');
    documentPath = path.join(root, family === 'core' ? 'case.yaml' : CASE_FILE[family]);
    fs.mkdirSync(path.dirname(documentPath), { recursive: true });
    fs.copyFileSync(path.join(directory, 'case.yaml'), documentPath);
  }

  const parsed = await parseDocument(documentPath);
  if (parsed.diagnostics.length > 0) return { failedAt: 'parser', codes: parsed.diagnostics.map((d) => d.code) };

  // Every core case is a parser case, and an adapter MUST NOT dispatch on a kind.
  if (family === 'core') return { failedAt: null, codes: [] };

  // Ajv's errors are not the specification's structural codes, and this suite
  // does not translate one into the other, so a structural failure reports its
  // phase alone. The conformance test asserts no more than that.
  const validate = await validatorFor(family);
  if (!validate(parsed.value)) return { failedAt: 'structural', codes: [] };

  let codes = runSemanticChecks(await contextForItem(readItem(root))).map((d) => d.code);
  if (!metadata.document) codes = codes.filter((code) => !ITEM_ROOT_CODES.has(code));
  return codes.length > 0 ? { failedAt: 'semantic', codes: [...new Set(codes)] } : { failedAt: null, codes: [] };
}
