# Catalog validation

These tests hold every item under `items/` to the contracts published in
[`musher-dev/specifications`](https://github.com/musher-dev/specifications).

The suite is held to **one exact, released version per family**: the `RELEASES`
table in [`lib/spec-schemas.ts`](lib/spec-schemas.ts), today `core/v2.0.0`,
`component/v2.0.0`, `blueprint/v2.0.0` and `listing/v2.0.0`. Every core release
re-releases every family, so all four sit on one core release
([ADR 0038](https://github.com/musher-dev/specifications/blob/main/docs/adr/0038-v2-one-vocabulary-and-v1-retires.md)
retired v1 and started v2 at `2.0.0` for each).

The releases are **vendored**, as the specification's
[adoption guide](https://github.com/musher-dev/specifications/blob/main/docs/downstream-v2-adoption.md)
asks: each family's release archive sits under
[`vendor/specifications/`](../vendor/specifications/README.md) exactly as the
release published it. An archive carries its schema bundle, specification,
examples, conformance corpus and whole dependency closure, so the suite needs
no network and no credential.

A vendored file is never trusted for being present. Before anything is read
from an archive, its SHA-256 must equal the digest GitHub records for that
immutable release asset, and each bundle inside it must equal the
`bundleSha256` the specification's release ledger
([`published.json`](https://specifications.musher.dev/published.json)) records.
Both digests are copied into `RELEASES`, never computed: a digest taken from
the bytes it is meant to check would check nothing. A bundle's `$id` must also
be its exact release URL,

```text
https://specifications.musher.dev/<family>/v<release>/<family>.schema.json
```

which is the URL the editor validates against
([Pinning in automation](https://github.com/musher-dev/specifications/blob/main/docs/using-schemas.md#pinning)
forbids the moving `/v2/` alias, which changes its bytes whenever a release
ships).

Every archive ships its whole dependency closure, so more than one carries a
given corpus — and **which copy is read is not arbitrary**. A corpus has to come
from the same release as the schema it is replayed against, so each corpus is
read from its own family's archive, core's included.

**Nothing about the source is configurable**: not the version, not a mirror, not
a local checkout. Each of those would be a second answer to "what is the
contract", which is the thing this suite exists to not have. If an archive is
missing or a digest disagrees, the suite fails loudly and names the file.

## Adopting a new release

It is one pull request, and
[`vendor/specifications/README.md`](../vendor/specifications/README.md) lists
the steps: replace and verify the archives, edit `RELEASES`, point the editor's
`yaml.schemas` in [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json)
at the same releases (`spec.test.ts` fails while the two disagree), and run
`npm test`. Any item or rule the new release disagrees with fails by name. A
release that narrows what validates migrates the items in the same pull
request, because the pins and the documents cannot disagree even briefly.

```sh
npm install
npm test          # validate the corpus
npm run typecheck # tsc --noEmit
```

Tests are TypeScript run directly by Node's type stripping and its built-in test
runner. There is no build step and no test framework to install.

## What runs

The files map to the validation phases core spec §6 defines (`parser`,
`structural`, `semantic`, `admission`, `resolution`), which are applied in
order — a later-phase diagnostic is never reported before the earlier phases
pass. This suite runs the first three.

| File | Phase | What it checks |
| --- | --- | --- |
| `spec.test.ts` | — | Exactly the pinned archives are vendored and listed in `SHA256SUMS`, each names its own release and core release, and each bundle is byte for byte the pinned release, names its own family, and is self-contained. Fails first, so a corpus is never judged against the wrong contract. |
| `parser.test.ts` | `parser` | Every document satisfies the Musher YAML profile (core §6.1): UTF-8, one document per file, string keys, no anchors, aliases, merge keys or explicit tags, finite numbers and safe integers, and the size, depth and scalar bounds. |
| `structural.test.ts` | `structural` | Every document validates against its family's vendored JSON Schema. |
| `semantic.test.ts` | `semantic` | The cross-document rules: identity agreement, every YAML file of the item parsing (CORE-ITEM-002), the listing's `itemType` against the item root (LIST-ITEM-001), one component document per component item (LIST-ITEM-002), reference resolution and dependency validity (§10), path containment, media and its size bounds (LIST-MEDIA-001..004), the overview Markdown profile over `overview` and `gettingStarted`, environment variables — no two inputs claim one `envVar` (COMP-ENVVAR-002), mounts (§5.5), schedules (COMP-JOB-002), probe endpoints (COMP-EP-002), trust bundles, probe credentials and build secrets reading guaranteed inputs (COMP-EP-006/010, COMP-BUILD-004), output origins, connection members and templates (COMP-OUT-002/003/004, COMP-PLACEHOLDER-001, COMP-EP-004), inputs nothing reads (COMP-INPUT-001), authored sensitive values (COMP-VAL-005, §11), node compute (BP-NODE-001/002), volume allocation, exposure and its readiness rule (COMP-EP-003), access and viewer identity — the mode or claim each viewer property needs, OIDC clients and the exemptions a component offers (BP-NODE-007/008, COMP-EP-012/014), binding resolution and type agreement (BP-BIND-006/007, BP-PARAM-008), value cycles (BP-BIND-002), connection bindings — a connection input takes a connection parameter and a connection parameter takes one (BP-CONNECTION-001), and the parameters — reachability, schema agreement, origins, creator facts, hashes, enum labels and the deploy form offering what a required input needs (BP-PARAM-001..003, BP-PARAM-011/012, BP-PLACEHOLDER-001, BP-UI-003, BP-UI-005, CORE-PLACEHOLDER-001..003). |
| `layout.test.ts` | — | The item folder structure, and the catalog's own additions to it. |
| `rules.test.ts` | — | The rules themselves, against deliberately broken synthetic items. |
| `conformance.test.ts` | all three | The pinned release's conformance corpus, run through the same three phases. Each case is a test named by its id. |

`admission` (v1's `capability`) is deliberately absent. Whether a Compute
Profile is offered, whether a catalog component exists, whether a connection can
be acquired, whether a revision increases, whether a licence is on the SPDX
License List release the platform pins (`ERR_UNKNOWN_LICENSE`) and whether an
image has the dimensions listing §5 requires (`ERR_MEDIA_DIMENSIONS`) are all
decided by the platform, and an implementation MUST NOT report a rule it has not
been given the means to check. The conformance adapter skips every `admission`
case by its phase.

Component v1.3.0 moved six more rules there, and they are worth knowing by
name because they are things this suite used to catch and no longer does: a
runnable component carrying a `workload` (`ERR_WORKLOAD_REQUIRED`), a workload
carrying a `source` (`ERR_SOURCE_REQUIRED`), a `SERVICE` declaring an endpoint
(`ERR_ENDPOINT_REQUIRED`), a `JOB` carrying a `command` (`ERR_COMMAND_REQUIRED`),
an `EXTERNAL` component publishing an output (`ERR_OUTPUT_REQUIRED`), and every
input and output being described (`ERR_DESCRIPTION_REQUIRED`). The specification
is explicit that an offline validator MUST NOT report any of them, so a document
missing one passes here and is rejected at sync.

Blueprint v1.5.0 brought them back for one reader. A component may be stored
unfinished, but a node deploys it as it will run, so a node deploying one that
misses an obligation is `ERR_INVALID_DEPENDENCY` at its `componentRef`, semantic
(`BP-REF-003`). Every item with a blueprint is checked for all six again; only a
`COMPONENT` item, which no node deploys, still waits for sync.

Two further groups are absent by decision rather than by phase, and both would
need machinery this suite does not have. **Logical value validation** —
`COMP-VAL-003` and the value half of `COMP-VAL-005`, and with them
`ERR_INVALID_VALUE_SCHEMA` and `ERR_VALUE_CONSTRAINT` — needs a validator for
the bounded 2020-12 profile, which is a different project from reading
documents.

`ERR_SENSITIVE_LITERAL` (v1's `ERR_SECRET_LITERAL`) used to be listed here and did not belong. It is the other
half of `COMP-VAL-005`, and deciding it needs two fields read side by side, not
a value validator — a sensitive input carrying a `default`, a sensitive output
publishing a literal, a node binding one, a parameter default behind one. Grouping it with its neighbours
skipped the corpus case that would have caught an authored secret in `mlflow`,
which a downstream consumer found instead
([#39](https://github.com/musher-dev/catalog/issues/39)). It is implemented in
[`lib/semantic.ts`](lib/semantic.ts) and no longer skipped. The lesson is worth
more than the rule: a code in `OUT_OF_SCOPE` is a rule nothing here enforces, so
each one earns its place by what it would take to decide, not by which sentence
of the spec it sits in.
One `ERR_VALUE_CONSTRAINT` is decided here anyway, for the same reason: an
output forwarding a sensitive connection member must declare `sensitive: true`
(COMP-OUT-004), which needs two fields and no value validator. Its corpus case
is still skipped by code, so `rules.test.ts` holds it.

**The `resolution` phase** needs deployment context: submitted values,
organization variables, an acquired connection. Neither omission is a gap in
what is here; each is a thing this repository has not been given the means to
decide, and saying so is the same discipline `admission` gets. The conformance
adapter holds the first group in one list, `OUT_OF_SCOPE` in
[`lib/conformance.ts`](lib/conformance.ts), and reports a case that expects
only those codes as skipped, with the reason. It never counts one as passed. It
does not run `behavior.json`, whose cases are resolution and deploy operations.

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
- A `structural` case runs at the `structural` validation scope: no later phase
  runs on it, so a passing one makes no claim beyond its shape. A failing one is
  held to its phase only, because Ajv's errors are not the specification's
  structural codes and this suite does not translate them.
- A `case.yaml` asserts it has no item root. The adapter wraps it in one to run
  the checks, then discards every rule measured against the root.

## Where the rules come from

Nothing is restated from the spec where it can be read from it instead. The
media-path grammar and the component input defaults are pulled out of the
vendored bundles at run time rather than copied, so the two places the semantic
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
reference grammar itself. Component `v1.3.0` went the other way with six rules,
moving them out of `structural` into `capability` (v2's `admission`) rather than into the schema —
see above. That last one retired a rule outright rather than
moving it — a bare name means `latest` and every tag is accepted, as in Docker,
so `ERR_UNPINNED_IMAGE` has no implementation here any more and
`rules.test.ts` holds the inverse case so it cannot quietly return. None of
these is restated here, because a second copy of a rule is a second thing to
keep true.

## Configuration

None. The suite reads no environment variable: with the releases vendored there
is nothing left to tune about how the contract is read, and *which* contract is
read is never configurable.

## Adding a rule

Put it in the phase it belongs to. If JSON Schema can express it, it belongs in
`musher-dev/specifications` and not here — opening a PR there is the fix, and
this suite picks it up when it adopts the release that carries it. If it needs a second
document or the filesystem, it is `semantic`: add it to `tests/lib/semantic.ts`
with its diagnostic code, add it to `SEMANTIC_CHECKS` there and wire it into
`semantic.test.ts`, and add a case to `rules.test.ts` proving it fires.
