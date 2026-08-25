/**
 * The Musher YAML profile — component spec §7.1, the `parser` validation phase.
 *
 * Musher documents are written in a restricted profile of YAML 1.2.2, not in
 * unrestricted YAML. Every restriction withholds something YAML permits because
 * it is legal but ambiguous: a document that means different things to different
 * readers, or that cannot be judged without unbounded work, is not a contract.
 *
 * This module is the profile, and it runs before any schema is consulted — a
 * later-phase diagnostic must never be reported before the earlier phases pass
 * (component spec §7).
 */
import { readFile } from 'node:fs/promises';
import YAML, { Alias, Scalar, type Node, type Pair } from 'yaml';

/** Codes are normative (component spec §8); the messages beside them are not. */
export type ParserDiagnostic = {
  code:
    | 'ERR_INVALID_YAML'
    | 'ERR_MULTIPLE_DOCUMENTS'
    | 'ERR_NON_STRING_KEY'
    | 'ERR_DUPLICATE_KEY'
    | 'ERR_ANCHOR_OR_ALIAS'
    | 'ERR_MERGE_KEY'
    | 'ERR_EXPLICIT_TAG'
    | 'ERR_DOCUMENT_TOO_LARGE'
    | 'ERR_DEPTH_EXCEEDED'
    | 'ERR_SCALAR_TOO_LONG';
  message: string;
};

/** COMP-YAML-010 / 011 / 012. */
export const BOUNDS = {
  documentBytes: 1_048_576,
  nestingDepth: 64,
  scalarBytes: 65_536,
} as const;

export type ParsedDocument = {
  /** Absent when the document did not survive the profile. */
  value: unknown;
  diagnostics: ParserDiagnostic[];
};

const diag = (code: ParserDiagnostic['code'], message: string): ParserDiagnostic => ({ code, message });

export async function parseDocument(absolutePath: string): Promise<ParsedDocument> {
  const bytes = await readFile(absolutePath);

  // COMP-YAML-010. Measured before parsing — a limit a parser can apply only
  // after building the tree is not a limit on the work it does.
  if (bytes.byteLength > BOUNDS.documentBytes) {
    return {
      value: undefined,
      diagnostics: [
        diag('ERR_DOCUMENT_TOO_LARGE', `${bytes.byteLength} bytes exceeds the ${BOUNDS.documentBytes}-byte bound`),
      ],
    };
  }

  // COMP-YAML-001: UTF-8, rejecting malformed sequences. COMP-YAML-002: a BOM is
  // permitted and carries no meaning.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch (error) {
    return { value: undefined, diagnostics: [diag('ERR_INVALID_YAML', `not valid UTF-8: ${(error as Error).message}`)] };
  }

  return parseText(text);
}

export function parseText(text: string): ParsedDocument {
  const diagnostics: ParserDiagnostic[] = [];

  // `merge: false` leaves `<<` an ordinary key so this module can name it in its
  // own diagnostic; an author who writes one is reaching for merge keys, not for
  // aliases, and is better told about `<<`.
  const documents = YAML.parseAllDocuments(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
  });

  // COMP-YAML-004. Picking the first of several silently discards a thing the
  // author wrote; an empty stream is not a document at all.
  if (documents.length === 0) {
    return { value: undefined, diagnostics: [diag('ERR_INVALID_YAML', 'the file holds no YAML document')] };
  }
  if (documents.length > 1) {
    diagnostics.push(diag('ERR_MULTIPLE_DOCUMENTS', `the stream holds ${documents.length} documents; exactly one is permitted`));
  }

  const document = documents[0]!;

  for (const error of document.errors) {
    // COMP-YAML-006 is called out separately from malformed YAML because the two
    // say different things to an author.
    if (error.code === 'DUPLICATE_KEY') diagnostics.push(diag('ERR_DUPLICATE_KEY', error.message));
    else diagnostics.push(diag('ERR_INVALID_YAML', error.message));
  }

  YAML.visit(document, {
    Node(_key, node: Node) {
      // COMP-YAML-007. An anchor with no alias is inert and is rejected anyway:
      // finding out at authoring time beats finding out when the alias is added.
      if (node instanceof Alias) {
        diagnostics.push(diag('ERR_ANCHOR_OR_ALIAS', `alias *${node.source}`));
      } else if ('anchor' in node && typeof node.anchor === 'string') {
        diagnostics.push(diag('ERR_ANCHOR_OR_ALIAS', `anchor &${node.anchor}`));
      }

      // COMP-YAML-009. An explicit tag overrides scalar resolution, which is
      // exactly what the profile fixes — `!!str 5` and `5` differ only in a tag.
      if ('tag' in node && typeof node.tag === 'string') {
        diagnostics.push(diag('ERR_EXPLICIT_TAG', `explicit tag ${node.tag}`));
      }

      // COMP-YAML-012.
      if (node instanceof Scalar && typeof node.value === 'string') {
        const size = Buffer.byteLength(node.value, 'utf8');
        if (size > BOUNDS.scalarBytes) {
          diagnostics.push(diag('ERR_SCALAR_TOO_LONG', `a scalar of ${size} bytes exceeds the ${BOUNDS.scalarBytes}-byte bound`));
        }
      }
    },

    Pair(_key, pair: Pair) {
      const key = pair.key;
      if (key instanceof Scalar) {
        // COMP-YAML-005. Mapping keys are property names in every schema this
        // repository publishes, and `1:` resolving to the integer one on one
        // parser and the string "1" on another is the duplicate-key problem
        // wearing a different hat.
        if (typeof key.value !== 'string') {
          diagnostics.push(diag('ERR_NON_STRING_KEY', `key ${JSON.stringify(key.value)} resolves to ${typeof key.value}, not a string`));
        } else if (key.value === '<<') {
          diagnostics.push(diag('ERR_MERGE_KEY', 'merge key `<<`'));
        }
      } else if (key !== null && key !== undefined) {
        diagnostics.push(diag('ERR_NON_STRING_KEY', 'a mapping key is a collection, not a string'));
      }
    },
  });

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: -1 });
  } catch (error) {
    diagnostics.push(diag('ERR_INVALID_YAML', (error as Error).message));
    return { value: undefined, diagnostics };
  }

  // COMP-YAML-011.
  const depth = measureDepth(value);
  if (depth > BOUNDS.nestingDepth) {
    diagnostics.push(diag('ERR_DEPTH_EXCEEDED', `nested ${depth} levels, exceeding the ${BOUNDS.nestingDepth}-level bound`));
  }

  return { value, diagnostics };
}

/** Depth in containers: a document whose root is a scalar is 0, a flat mapping 1. */
function measureDepth(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  let deepest = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    deepest = Math.max(deepest, measureDepth(child, seen));
  }
  seen.delete(value);
  return deepest + 1;
}
