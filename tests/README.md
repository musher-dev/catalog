# Catalog validation

These tests hold every item under `items/` to the contracts published in
[`musher-dev/spec`](https://github.com/musher-dev/spec).

The schemas are **fetched at run time** from the tip of the public
`musher-dev/spec` repository, never vendored. The catalog is not the authority on
what a valid item looks like — the spec is — and a copy held here would be a
second authority that drifts. A stale copy is worse than no copy at all, because
it passes a corpus the live spec would reject, silently.

There is exactly one source, and it is constant:

```
https://raw.githubusercontent.com/musher-dev/spec/main/specifications/<family>/v1/schemas/dist/<family>.schema.json
```

`musher-dev/spec` is **public**, so this is fetched with **no credential**.
Nothing in the suite reads a token and none should be configured: a token
attached to a public read is a secret handed to a host that never asked for one,
and it makes the suite pass on a machine that has it and fail on one that does
not.

**Nothing about the source is configurable** — not the ref, not a mirror, not a
local checkout. Each of those would be a second answer to "what is the contract",
which is the thing this suite exists to not have. `main` is the tip of the
contract, and the tip is what this corpus is held to. If the fetch fails the
suite fails, loudly, naming the URL: a run that quietly validated against
something else would be reporting on a contract nobody published.

```sh
npm install
npm test          # validate the corpus
npm run typecheck # tsc --noEmit
```

Tests are TypeScript run directly by Node's type stripping and its built-in test
runner. There is no build step and no test framework to install.

## What runs

The files map to the four validation phases component spec §7 defines, which are
applied in order — a later-phase diagnostic is never reported before the earlier
phases pass.

| File | Phase | What it checks |
|---|---|---|
| `spec.test.ts` | — | The bundles resolve, name their own family, and are self-contained. Fails first, so a corpus is never judged against a 404 page. |
| `parser.test.ts` | `parser` | Every document satisfies the Musher YAML profile (component §7.1): one document per file, string keys, no anchors, aliases, merge keys or explicit tags, and the size, depth and scalar bounds. |
| `structural.test.ts` | `structural` | Every document validates against its family's fetched JSON Schema. |
| `semantic.test.ts` | `semantic` | The cross-document rules: identity agreement, reference resolution, path containment, media, the description Markdown profile, image pinning, endpoint resolution, `INPUT` output references (COMP-OUT-002/003), node compute against external components (BP-NODE-002), connection compatibility including which inputs a wire may fill (BP-CONN-001), and parameter coverage and agreement. |
| `layout.test.ts` | — | The item folder structure, and the catalog's own additions to it. |
| `rules.test.ts` | — | The rules themselves, against deliberately broken synthetic items. |

`capability` is deliberately absent. Whether a Compute Profile is offered,
whether a published component exists, and whether a version is monotonic are all
decided against the platform catalog over the network, and an implementation
MUST NOT report a rule it has not been given the means to check.

### Why `rules.test.ts` exists

A suite that passes on a clean corpus proves nothing on its own — it passes just
as readily when a rule is silently unreachable. Each case there breaks one thing
in a synthetic item and asserts the normative diagnostic fires, so the checks
guarding `items/` are themselves guarded.

They are not conformance fixtures. `musher-dev/spec` publishes those under
`conformance/`, and its corpus is the authority on what an implementation must
report; these cases pin the subset this repository enforces.

## Where the rules come from

Nothing is restated from the spec where it can be read from it instead. The
media-path grammar and the component value-schema defaults are pulled out of the
fetched bundles at run time rather than copied, so the two places the semantic
phase needs them cannot drift.

What is written down here is what JSON Schema cannot express, and each rule
carries the clause it implements: `BP-ID-001`, `LIST-MEDIA-003`, `COMP-SRC-001`
and the rest. A rule whose spelling has to live in this repository — the
floating-tag blocklist, for instance, which is `semantic` precisely so it can
grow in a minor release — says so at the definition.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MUSHER_SPEC_TIMEOUT_MS` | `15000` | Per-request timeout when fetching a schema. |

That is the whole of it. The timeout is the only knob because it is the only one
that changes how a schema is fetched rather than *which* schema is fetched.

## Adding a rule

Put it in the phase it belongs to. If JSON Schema can express it, it belongs in
`musher-dev/spec` and not here — opening a PR there is the fix, and this suite
picks it up on the next run with no change. If it needs a second document or the
filesystem, it is `semantic`: add it to `tests/lib/semantic.ts` with its
diagnostic code, wire it into `semantic.test.ts`, and add a case to
`rules.test.ts` proving it fires.
