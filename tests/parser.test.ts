/**
 * The `parser` phase — the Musher YAML profile, component spec §7.1.
 *
 * Musher documents are written in a restricted profile of YAML 1.2.2. Every
 * document in the corpus is held to it before any schema is consulted, because
 * component spec §7 forbids reporting a later-phase diagnostic before the
 * earlier phases pass.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverItems, loadItemDocuments } from './lib/catalog.ts';
import { BOUNDS, parseText } from './lib/yaml-profile.ts';

const items = discoverItems();

for (const item of items) {
  describe(`items/${item.slug}`, () => {
    it('every document satisfies the Musher YAML profile', async () => {
      const documents = await loadItemDocuments(item);
      const all = [documents.listing, documents.blueprint, ...documents.components.values()].filter(
        (document) => document !== null,
      );

      const failures = all.flatMap((document) =>
        document.parserDiagnostics.map((diagnostic) => `${document.label}: ${diagnostic.code} — ${diagnostic.message}`),
      );

      assert.deepEqual(failures, []);
    });

    it('every document parses to a mapping', async () => {
      // The envelope is an object at the root. A document parsing to a scalar or
      // a sequence has no `kind` to discriminate on and nothing for the schema
      // to bind against.
      const documents = await loadItemDocuments(item);
      const all = [documents.listing, documents.blueprint, ...documents.components.values()].filter(
        (document) => document !== null,
      );
      const notMappings = all.filter((document) => document.value === undefined).map((document) => document.label);
      assert.deepEqual(notMappings, []);
    });
  });
}

describe('the YAML profile itself', () => {
  // The profile is what every document above is judged by, so it is worth
  // showing that it rejects what the spec says it rejects. Each case is a rule
  // from component spec §7.1 with its normative diagnostic code.
  const cases: { rule: string; code: string; source: string }[] = [
    { rule: 'COMP-YAML-004', code: 'ERR_MULTIPLE_DOCUMENTS', source: 'a: 1\n---\nb: 2\n' },
    { rule: 'COMP-YAML-005', code: 'ERR_NON_STRING_KEY', source: '1: one\n' },
    { rule: 'COMP-YAML-006', code: 'ERR_DUPLICATE_KEY', source: 'a: 1\na: 2\n' },
    { rule: 'COMP-YAML-007 (anchor)', code: 'ERR_ANCHOR_OR_ALIAS', source: 'a: &anchor 1\n' },
    { rule: 'COMP-YAML-007 (alias)', code: 'ERR_ANCHOR_OR_ALIAS', source: 'a: &anchor 1\nb: *anchor\n' },
    { rule: 'COMP-YAML-008', code: 'ERR_MERGE_KEY', source: 'base: {a: 1}\nderived:\n  <<: {a: 1}\n' },
    { rule: 'COMP-YAML-009 (core tag)', code: 'ERR_EXPLICIT_TAG', source: "a: !!str 5\n" },
    { rule: 'COMP-YAML-009 (custom tag)', code: 'ERR_EXPLICIT_TAG', source: 'a: !secret hunter2\n' },
  ];

  for (const { rule, code, source } of cases) {
    it(`${rule} → ${code}`, () => {
      const { diagnostics } = parseText(source);
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === code),
        `expected ${code}, got ${diagnostics.map((d) => d.code).join(', ') || 'no diagnostics'}`,
      );
    });
  }

  it('COMP-YAML-011 → ERR_DEPTH_EXCEEDED', () => {
    const depth = BOUNDS.nestingDepth + 1;
    const source = Array.from({ length: depth }, (_, level) => `${'  '.repeat(level)}a:`).join('\n') + ' 1\n';
    const { diagnostics } = parseText(source);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'ERR_DEPTH_EXCEEDED'));
  });

  it('COMP-YAML-012 → ERR_SCALAR_TOO_LONG', () => {
    const { diagnostics } = parseText(`a: ${'x'.repeat(BOUNDS.scalarBytes + 1)}\n`);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'ERR_SCALAR_TOO_LONG'));
  });

  it('resolves scalars by the YAML 1.2 core schema', () => {
    // A YAML 1.1 parser reads `no` as boolean false, and a `country: no` read by
    // both is two different documents. This is the one place naming the version
    // does real work.
    const { value, diagnostics } = parseText('country: no\nenabled: true\nempty: ~\n');
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(value, { country: 'no', enabled: true, empty: null });
  });

  it('accepts document markers and a byte order mark', () => {
    // COMP-YAML-002 and COMP-YAML-004: the markers may be present, and a BOM
    // carries no meaning.
    const { value, diagnostics } = parseText('﻿---\na: 1\n...\n');
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(value, { a: 1 });
  });
});
