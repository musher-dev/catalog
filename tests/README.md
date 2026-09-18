# Catalog validation

These tests hold every item under `items/` to the contracts published in
[`musher-dev/specifications`](https://github.com/musher-dev/specifications).

The schemas are **fetched at run time** from that project's published origin,
never vendored. The catalog is not the authority on what a valid item looks like
— the spec is — and a copy held here would be a second authority that drifts. A
stale copy is worse than no copy at all, because it passes a corpus the live spec
would reject, silently.

There is exactly one source, and it is constant:

```
https://specifications.musher.dev/<family>/v1/<family>.schema.json
```

That is the **major-version alias**: it serves the newest v1 release of a family,
or a build of the specification repository's `main` before the family's first
release. Either way it is the contract as currently published, which is what this
corpus is held to — an item here has to satisfy what an implementor downloading
v1 today would get.

The origin is **public** and serves open CORS, so this is fetched with **no
credential**. Nothing in the suite reads a token and none should be configured: a
token attached to a public read is a secret handed to a host that never asked for
one, and it makes the suite pass on a machine that has it and fail on one that
does not.

**Nothing about the source is configurable** — not the version, not a mirror, not
a local checkout. Each of those would be a second answer to "what is the
contract", which is the thing this suite exists to not have. If the fetch fails
the suite fails, loudly, naming the URL: a run that quietly validated against
something else would be reporting on a contract nobody published.

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
| `spec.test.ts` | — | The bundles resolve, name their own family, and are self-contained. Fails first, so a corpus is never judged against a 404 page. |
| `parser.test.ts` | `parser` | Every document satisfies the Musher YAML profile (core §6.1): one document per file, string keys, no anchors, aliases, merge keys or explicit tags, and the size, depth and scalar bounds. |
| `structural.test.ts` | `structural` | Every document validates against its family's fetched JSON Schema. |
| `semantic.test.ts` | `semantic` | The cross-document rules: identity agreement, the listing's `itemType` against the item root (LIST-ITEM-001), reference resolution, path containment, media, the description Markdown profile, image pinning (COMP-SRC-003), probe endpoints (COMP-EP-002), output origins and templates (COMP-OUT-002, COMP-REF-001, COMP-EP-004), connection requirements (COMP-CONNECTION-001), node compute (BP-NODE-001/002), volume allocation, exposure and its readiness rule (COMP-EP-003), binding resolution and type agreement (BP-PARAM-006/007/008), connection bindings (BP-CONNECTION-001), and the parameters — reachability, schema agreement, generated sensitivity, sources and enum labels (BP-PARAM-001..004, BP-REF-001, BP-UI-003, CORE-REF-001..003). |
| `layout.test.ts` | — | The item folder structure, and the catalog's own additions to it. |
| `rules.test.ts` | — | The rules themselves, against deliberately broken synthetic items. |

`capability` is deliberately absent. Whether a Compute Profile is offered,
whether a published component exists, whether a connection can be acquired, and
whether a version is monotonic are all decided against the platform catalog over
the network, and an implementation MUST NOT report a rule it has not been given
the means to check.

Two further groups are absent by decision rather than by phase, and both would
need machinery this suite does not have. **Logical value validation** —
`COMP-VAL-003` and `COMP-VAL-005`, and with them `ERR_INVALID_VALUE_SCHEMA`,
`ERR_VALUE_CONSTRAINT` and `ERR_SECRET_LITERAL` — needs a validator for the
bounded 2020-12 profile, which is a different project from reading documents.
**The `resolution` phase** needs installation context: submitted values,
organization variables, an acquired connection. Neither omission is a gap in
what is here; each is a thing this repository has not been given the means to
decide, and saying so is the same discipline `capability` gets.

### Why `rules.test.ts` exists

A suite that passes on a clean corpus proves nothing on its own — it passes just
as readily when a rule is silently unreachable. Each case there breaks one thing
in a synthetic item and asserts the normative diagnostic fires, so the checks
guarding `items/` are themselves guarded.

They are not conformance fixtures. `musher-dev/specifications` publishes those
under `specifications/<family>/v1/conformance/`, alongside a shared core corpus
at `specifications/core/v1/conformance/`, and those are the authority on what an
implementation must report; these cases pin the subset this repository enforces.

## Where the rules come from

Nothing is restated from the spec where it can be read from it instead. The
media-path grammar and the component input defaults are pulled out of the
fetched bundles at run time rather than copied, so the two places the semantic
phase needs them cannot drift.

What is written down here is what JSON Schema cannot express, and each rule
carries the clause it implements: `CORE-ITEM-001`, `LIST-MEDIA-003`, `COMP-SRC-003`
and the rest. A rule whose spelling has to live in this repository — the
floating-tag blocklist, for instance, which is `semantic` precisely so it can
grow in a minor release — says so at the definition.

The reverse also applies, and the v1 bundles took several rules back: that a
binding names exactly one supplier, that `node` and `output` go together, that
an output names exactly one origin, that a parameter carries at most one of
`default`, `generator` and `from` and no `schema` at all, and that `workload` is
required off `EXTERNAL` and forbidden on it are all structural now. None of them
is restated here, because a second copy of a rule is a second thing to keep
true.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MUSHER_SPEC_TIMEOUT_MS` | `15000` | Per-request timeout when fetching a schema. |

That is the whole of it. The timeout is the only knob because it is the only one
that changes how a schema is fetched rather than *which* schema is fetched.

## Adding a rule

Put it in the phase it belongs to. If JSON Schema can express it, it belongs in
`musher-dev/specifications` and not here — opening a PR there is the fix, and
this suite picks it up on the next run with no change. If it needs a second
document or the filesystem, it is `semantic`: add it to `tests/lib/semantic.ts`
with its diagnostic code, wire it into `semantic.test.ts`, and add a case to
`rules.test.ts` proving it fires.
