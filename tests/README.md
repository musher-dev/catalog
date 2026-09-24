# Catalog validation

These tests hold every item under `items/` to the contracts published in
[`musher-dev/specifications`](https://github.com/musher-dev/specifications).

The suite is held to **one exact, released version per family**: the `RELEASES`
table in [`lib/spec-schemas.ts`](lib/spec-schemas.ts), today listing `v1.0.0`,
component `v1.2.0` and blueprint `v1.3.0`. Nothing is vendored. The schemas are
fetched on every run from each release's exact URL:

```
https://specifications.musher.dev/<family>/v<release>/<family>.schema.json
```

Families release independently, so they sit at different numbers. Component and
blueprint are past `1.0.0` because
[ADR 0033](https://github.com/musher-dev/specifications/blob/main/docs/adr/0033-inputs-are-the-only-way-into-a-component.md)
made inputs the only way into a component, which was breaking for both; listing
did not change, and a family that did not change does not get a new number. The
version therefore lives beside the digest it belongs to, never above all three —
a digest that outlives the version it was copied for checks nothing.

Each bundle's SHA-256 must equal the `bundleSha256` the specification's release
ledger ([`published.json`](https://specifications.musher.dev/published.json))
records for it. The spec requires automation to pin an exact release rather than
the moving `/v1/` alias
([Pinning in automation](https://github.com/musher-dev/specifications/blob/main/docs/using-schemas.md#pinning)),
because the alias changes its bytes whenever a release ships. A suite whose
verdict can change without a commit here reports on a contract nobody chose.

The **conformance corpus** is fetched the same way, from the
`blueprint-v1.3.0.tar.gz` and `listing-v1.0.0.tar.gz` release assets, each
checked against the digest GitHub records for it. Those two archives cover all
four corpora: the blueprint archive carries the component and core corpora it
was released against — so the component and core corpora are pinned by the
**blueprint** release, not by one of their own.

The origins are **public**, so this is fetched with **no credential**. Nothing in
the suite reads a token and none should be configured: a token attached to a
public read is a secret handed to a host that never asked for one, and it makes
the suite pass on a machine that has it and fail on one that does not.

**Nothing about the source is configurable**: not the version, not a mirror, not
a local checkout. Each of those would be a second answer to "what is the
contract", which is the thing this suite exists to not have. If a fetch fails or
a digest disagrees, the suite fails loudly and names the URL.

### Adopting a new release

It is one pull request, and it changes nothing else:

1. Edit that family's entry in `RELEASES` in `lib/spec-schemas.ts` — `version`
   and `bundleSha256` together, from the new entry in `published.json`.
2. If the family attaches a conformance archive (blueprint or listing), set its
   `archiveSha256` in the same entry, from the release's assets:
   `gh release view <family>/v<X.Y.Z> -R musher-dev/specifications --json assets`.
3. Run `npm test`. Any item or rule the new release disagrees with fails by
   name. Fix it in the same pull request.

Families move independently, so this is usually one entry, not three. A release
that narrows what validates — as component `v1.2.0` and blueprint `v1.3.0` did —
migrates the items in the same pull request, because the pins and the documents
cannot disagree even briefly.

```sh
npm install
npm test          # validate the corpus
npm run typecheck # tsc --noEmit
```

Tests are TypeScript run directly by Node's type stripping and its built-in test
runner. There is no build step and no test framework to install.

## What runs

The files map to the four validation phases core spec §6 defines, which are
applied in order — a later-phase diagnostic is never reported before the earlier
phases pass.

| File | Phase | What it checks |
|---|---|---|
| `spec.test.ts` | — | The bundles resolve, are byte for byte the pinned release, name their own family, and are self-contained. Fails first, so a corpus is never judged against a 404 page. |
| `parser.test.ts` | `parser` | Every document satisfies the Musher YAML profile (core §6.1): UTF-8, one document per file, string keys, no anchors, aliases, merge keys or explicit tags, finite numbers and safe integers, and the size, depth and scalar bounds. |
| `structural.test.ts` | `structural` | Every document validates against its family's fetched JSON Schema. |
| `semantic.test.ts` | `semantic` | The cross-document rules: identity agreement, the listing's `itemType` against the item root (LIST-ITEM-001), reference resolution and dependency validity (§10), path containment, media, the description Markdown profile, environment keys — no two inputs claim one `envVarKey` (COMP-ENVVAR-002), mounts (§5.5), schedules (COMP-JOB-002), probe endpoints (COMP-EP-002), output origins and templates (COMP-OUT-002/003/004, COMP-REF-001, COMP-EP-004), authored secrets (COMP-VAL-005, §11), node compute (BP-NODE-001/002), volume allocation, exposure and its readiness rule (COMP-EP-003), binding resolution and type agreement (BP-PARAM-006/007/008), value cycles (BP-CONN-002), connection bindings — a connection input takes a connection parameter and a connection parameter takes one (BP-CONNECTION-001), and the parameters — reachability, schema agreement, sources and enum labels (BP-PARAM-001..003, BP-REF-001, BP-UI-003, CORE-REF-001..003). |
| `layout.test.ts` | — | The item folder structure, and the catalog's own additions to it. |
| `rules.test.ts` | — | The rules themselves, against deliberately broken synthetic items. |
| `conformance.test.ts` | all three | The pinned release's conformance corpus, run through the same three phases. Each case is a test named by its id. |

`capability` is deliberately absent. Whether a Compute Profile is offered,
whether a published component exists, whether a connection can be acquired, and
whether a version is monotonic are all decided against the platform catalog over
the network, and an implementation MUST NOT report a rule it has not been given
the means to check.

Two further groups are absent by decision rather than by phase, and both would
need machinery this suite does not have. **Logical value validation** —
`COMP-VAL-003` and the value half of `COMP-VAL-005`, and with them
`ERR_INVALID_VALUE_SCHEMA` and `ERR_VALUE_CONSTRAINT` — needs a validator for
the bounded 2020-12 profile, which is a different project from reading
documents.

`ERR_SECRET_LITERAL` used to be listed here and did not belong. It is the other
half of `COMP-VAL-005`, and deciding it needs two fields read side by side, not
a value validator — a sensitive input carrying a `default`, a sensitive output
publishing a literal, a node binding one. Grouping it with its neighbours
skipped the corpus case that would have caught an authored secret in `mlflow`,
which a downstream consumer found instead
([#39](https://github.com/musher-dev/catalog/issues/39)). It is implemented in
[`lib/semantic.ts`](lib/semantic.ts) and no longer skipped. The lesson is worth
more than the rule: a code in `OUT_OF_SCOPE` is a rule nothing here enforces, so
each one earns its place by what it would take to decide, not by which sentence
of the spec it sits in.
**The `resolution` phase** needs installation context: submitted values,
organization variables, an acquired connection. Neither omission is a gap in
what is here; each is a thing this repository has not been given the means to
decide, and saying so is the same discipline `capability` gets. The conformance
adapter holds the first group in one list, `OUT_OF_SCOPE` in
[`lib/conformance.ts`](lib/conformance.ts), and reports a case that expects
only those codes as skipped, with the reason. It never counts one as passed. It
does not run `behavior.json`, whose cases are resolution and install operations.

### Why `rules.test.ts` and `conformance.test.ts` both exist

A suite that passes on a clean corpus proves nothing on its own. It passes just
as readily when a rule is silently unreachable. Each case in `rules.test.ts`
breaks one thing in a synthetic item and asserts the normative diagnostic fires,
so the checks guarding `items/` are themselves guarded.

Those cases are written here, so they can only confirm what this repository
already believes. `conformance.test.ts` runs cases written by the specification
instead: the corpus `musher-dev/specifications` releases is the authority on what
an implementation must report. A rule here that rejects a case the corpus
passes, or accepts one it fails, is drift, and the failing test names the case.

The adapter follows the fixture format in the archive's `conformance/README.md`:

- A passing or incomplete case must report nothing.
- A failing case must fail in its declared phase.
- For `parser` and `semantic`, a failing case must also report at least the
  declared codes. Extra diagnostics are permitted.
- A `structural` case is held to its phase only, because Ajv's errors are not
  the specification's structural codes and this suite does not translate them.
- A `case.yaml` asserts it has no item root. The adapter wraps it in one to run
  the checks, then discards every rule measured against the root.

## Where the rules come from

Nothing is restated from the spec where it can be read from it instead. The
media-path grammar and the component input defaults are pulled out of the
fetched bundles at run time rather than copied, so the two places the semantic
phase needs them cannot drift.

What is written down here is what JSON Schema cannot express, and each rule
carries the clause it implements: `CORE-ITEM-001`, `LIST-MEDIA-003`,
`COMP-ENVVAR-002` and the rest. A rule whose spelling has to live in this
repository — `COMP-JOB-002`'s cron ranges, for instance, whose five fields and
their bounds no `pattern` states usefully — says so at the definition.

The reverse also applies, and the v1 bundles took several rules back: that a
binding names exactly one supplier, that `node` and `output` go together, that
an output names exactly one origin, that a parameter carries at most one of
`default`, `generator` and `from` and no `schema` at all, and that `workload` is
required off `EXTERNAL` and forbidden on it are all structural now. Component
`v1.2.0` took back more: which fields a connection input excludes, that only an
`EXTERNAL` component declares one, that `member` requires `input`, and the image
reference grammar itself. That last one retired a rule outright rather than
moving it — a bare name means `latest` and every tag is accepted, as in Docker,
so `ERR_UNPINNED_IMAGE` has no implementation here any more and
`rules.test.ts` holds the inverse case so it cannot quietly return. None of
these is restated here, because a second copy of a rule is a second thing to
keep true.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MUSHER_SPEC_TIMEOUT_MS` | `15000` | Per-request timeout when fetching a schema; four times this for a conformance archive. |

That is the whole of it. The timeout is the only knob because it is the only one
that changes how the contract is fetched rather than *which* contract is fetched.

## Adding a rule

Put it in the phase it belongs to. If JSON Schema can express it, it belongs in
`musher-dev/specifications` and not here — opening a PR there is the fix, and
this suite picks it up when it adopts the release that carries it. If it needs a second
document or the filesystem, it is `semantic`: add it to `tests/lib/semantic.ts`
with its diagnostic code, add it to `SEMANTIC_CHECKS` there and wire it into
`semantic.test.ts`, and add a case to `rules.test.ts` proving it fires.
