/**
 * An adapter over the conformance corpus `musher-dev/specifications` releases —
 * its own words: "each implementation writes its own thin adapter over this
 * data" (docs/conformance.md).
 *
 * The corpus is read from each family's vendored release archive, which
 * lib/spec-schemas.ts verifies against the digest GitHub records for that
 * immutable asset before unpacking it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { readItem } from './catalog.ts';
import { contextForItem, runSemanticChecks } from './semantic.ts';
import { releaseDir, validatorFor, type ArchiveFamily, type Family } from './spec-schemas.ts';
import { parseDocument } from './yaml-profile.ts';

/**
 * Every archive ships its whole dependency closure, so more than one offers a
 * given corpus — and which copy is read is not arbitrary: a corpus must come
 * from the same release as the schema it is replayed against. So each corpus
 * is read from its own family's archive, core's included.
 */
export type CorpusFamily = ArchiveFamily;

const corpusDir = (family: CorpusFamily): string => path.join(releaseDir(family), 'conformance');

/**
 * Codes the catalog deliberately does not decide: logical value validation
 * needs a validator for the bounded 2020-12 value profile, which is a different
 * project from reading documents (tests/README.md). A case expecting only these
 * is skipped by name, never passed.
 *
 * `ERR_SENSITIVE_LITERAL` (v1's `ERR_SECRET_LITERAL`) used to sit here and
 * does not belong: deciding it needs two fields read side by side, not a value
 * validator. Skipping it let an
 * authored secret reach a downstream consumer (#39). It is implemented in
 * `lib/semantic.ts` and this corpus now holds the suite to it.
 */
export const OUT_OF_SCOPE = new Set(['ERR_VALUE_CONSTRAINT', 'ERR_INVALID_VALUE_SCHEMA']);

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
  'ERR_MEDIA_TOO_LARGE',
  'ERR_PATH_ESCAPE',
  'ERR_COMPONENT_COUNT',
  'ERR_INVALID_YAML',
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
  phase: Phase | 'admission' | 'resolution';
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

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

/** Every indexed case of one family. `cases.json` is the contract; the directory tree is not. */
export function casesOf(family: CorpusFamily): Case[] {
  const corpus = corpusDir(family);
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

  // A `structural` case runs at the `structural` validation scope, so no later
  // phase runs on it: a passing structural case makes no claim about the
  // document beyond its shape (docs/conformance.md → Validation coverage).
  if (metadata.phase === 'structural') return { failedAt: null, codes: [] };

  let codes = runSemanticChecks(await contextForItem(readItem(root))).map((d) => d.code);
  if (!metadata.document) codes = codes.filter((code) => !ITEM_ROOT_CODES.has(code));
  return codes.length > 0 ? { failedAt: 'semantic', codes: [...new Set(codes)] } : { failedAt: null, codes: [] };
}
