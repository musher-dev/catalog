/**
 * The catalog's own policy — rules that are not the specification's.
 *
 * Every rule here is something the platform rejects only at sync or at the
 * first deploy, or a convention this catalog keeps so that a defect it has
 * already shipped once cannot ship again. None of them runs in `semantic`,
 * because that phase also replays the specification's conformance corpus,
 * which is right to accept every document these rules reject.
 *
 * Per-item suites are named `items/<slug>`, like the others, so
 * `task test:item -- <slug>` runs them. A deliberate exception lives in
 * policy-exceptions.ts with its reason and issue, and an exception that no
 * longer matches a finding fails here as stale.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverItems } from './lib/catalog.ts';
import {
  checkCopyDrift,
  checkInternalReferences,
  checkLineEndings,
  checkMediaDimensions,
  checkPortInputMismatch,
  checkPrivilegedPort,
  checkRequiredWithoutDefault,
  checkServiceReadiness,
  checkURLUnsafeSecrets,
  checkWorkaroundTags,
  POLICY_CHECKS,
  runPolicyChecks,
} from './lib/policy.ts';
import { contextForItem, type Diagnostic, type SemanticContext } from './lib/semantic.ts';
import { POLICY_EXCEPTIONS } from './policy-exceptions.ts';

const items = discoverItems();

const excused = (diagnostic: Diagnostic): boolean => POLICY_EXCEPTIONS[diagnostic.where]?.rule === diagnostic.code;

const report = (diagnostics: Diagnostic[]): string[] =>
  diagnostics.filter((diagnostic) => !excused(diagnostic)).map((d) => `${d.code} at ${d.where}: ${d.message}`);

const RULES: [string, (context: SemanticContext) => Diagnostic[]][] = [
  ['a COMPONENT item says whether each input is required — CATALOG_REQUIRED_WITHOUT_DEFAULT', checkRequiredWithoutDefault],
  ['no endpoint listens below port 1024 — CATALOG_PRIVILEGED_PORT', checkPrivilegedPort],
  ['a listen-port input defaults to one of its target ports — CATALOG_PORT_INPUT_MISMATCH', checkPortInputMismatch],
  ['every SERVICE has a readiness probe — CATALOG_SERVICE_WITHOUT_READINESS', checkServiceReadiness],
  ['the icon is square and at least 256 px; screenshots are at most 4096 px — CATALOG_ICON_SIZE, CATALOG_SCREENSHOT_SIZE', checkMediaDimensions],
  ['every text file uses LF line endings — CATALOG_LINE_ENDINGS', checkLineEndings],
  ['no comment cites an internal run id — CATALOG_INTERNAL_REFERENCE', checkInternalReferences],
  ['every command wrapper names the platform issue it works around — CATALOG_WORKAROUND_UNTAGGED', checkWorkaroundTags],
  ['a secret written into a URL is confined to URL-safe characters — CATALOG_URL_UNSAFE_SECRET', checkURLUnsafeSecrets],
  ['a building-block copy matches its source, or declares where it differs — CATALOG_COPY_DRIFT', checkCopyDrift],
];

for (const item of items) {
  describe(`items/${item.slug}`, () => {
    for (const [name, check] of RULES) {
      it(name, async () => {
        assert.deepEqual(report(check(await contextForItem(item))), []);
      });
    }
  });
}

describe('catalog policy', () => {
  it('covers every rule in POLICY_CHECKS', () => {
    // A rule added to POLICY_CHECKS but not to RULES would be checked by no item.
    assert.deepEqual(new Set(RULES.map(([, check]) => check)), new Set(POLICY_CHECKS));
  });

  it('each exception names a CATALOG_ rule, a reason and an issue', () => {
    const malformed = Object.entries(POLICY_EXCEPTIONS)
      .filter(([where, entry]) => {
        const anchored = /^items\/[a-z0-9-]+\/\S+#(\/\S*)?$/.test(where);
        return !anchored || !/^CATALOG_[A-Z_]+$/.test(entry.rule) || entry.reason.trim().length < 20 || !/^musher-dev\/[a-z0-9-]+#[0-9]+$/.test(entry.issue);
      })
      .map(([where]) => where);
    assert.deepEqual(malformed, []);
  });

  it('no exception is stale: each still matches a finding', async () => {
    const findings = new Set<string>();
    for (const item of items) {
      for (const diagnostic of runPolicyChecks(await contextForItem(item))) findings.add(`${diagnostic.where} ${diagnostic.code}`);
    }
    const stale = Object.entries(POLICY_EXCEPTIONS)
      .filter(([where, entry]) => !findings.has(`${where} ${entry.rule}`))
      .map(([where, entry]) => `${where} (${entry.rule}): no such finding any more; remove the exception`);
    assert.deepEqual(stale, []);
  });
});
