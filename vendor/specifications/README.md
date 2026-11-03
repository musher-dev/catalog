# Vendored specification releases

The release archives of
[`musher-dev/specifications`](https://github.com/musher-dev/specifications) that
`npm test` validates the catalog against, byte for byte as each release
publishes them:

| Archive | Release |
| --- | --- |
| `core-v2.0.0.tar.gz` | [`core/v2.0.0`](https://github.com/musher-dev/specifications/releases/tag/core/v2.0.0) |
| `component-v2.0.0.tar.gz` | [`component/v2.0.0`](https://github.com/musher-dev/specifications/releases/tag/component/v2.0.0) |
| `blueprint-v2.0.0.tar.gz` | [`blueprint/v2.0.0`](https://github.com/musher-dev/specifications/releases/tag/blueprint/v2.0.0) |
| `listing-v2.0.0.tar.gz` | [`listing/v2.0.0`](https://github.com/musher-dev/specifications/releases/tag/listing/v2.0.0) |

Each archive carries its family's schema bundle, specification, examples,
conformance corpus and whole dependency closure, with the specification's own
`LICENSE` and `NOTICE`. Nothing here is edited. `SHA256SUMS` holds the lines
each release's own `SHA256SUMS` asset gives these files.

The suite never trusts a file for being here. `RELEASES` in
[`tests/lib/spec-schemas.ts`](../../tests/lib/spec-schemas.ts) records the
digest GitHub records for each archive and the `bundleSha256` the release
ledger records for each bundle, and the suite refuses any bytes that differ.

## Verifying an archive

Before adopting a release, verify it as the specification's
[Verifying a release](https://github.com/musher-dev/specifications/blob/main/.github/SECURITY.md#verifying-a-release)
shows:

```sh
cd vendor/specifications
for family in core component blueprint listing; do
  gh release verify "$family/v2.0.0" --repo musher-dev/specifications
  gh release verify-asset "$family/v2.0.0" "$family-v2.0.0.tar.gz" --repo musher-dev/specifications
  gh attestation verify "$family-v2.0.0.tar.gz" --repo musher-dev/specifications
done
sha256sum --check SHA256SUMS
```

## Adopting a new release

Every core release re-releases every family, so the four move together:

1. Replace the archives with the new release assets
   (`gh release download <family>/v<X.Y.Z> -R musher-dev/specifications -p '<family>-v<X.Y.Z>.tar.gz'`),
   verify them as above, and replace `SHA256SUMS` with their lines from each
   release's `SHA256SUMS`.
2. Edit `RELEASES` in `tests/lib/spec-schemas.ts`: each family's `version`,
   `archiveSha256` (`gh release view <family>/v<X.Y.Z> -R musher-dev/specifications --json assets`)
   and `bundleSha256` (the release ledger,
   [`published.json`](https://specifications.musher.dev/published.json)).
3. Point the editor at the same releases: `yaml.schemas` in
   [`.devcontainer/devcontainer.json`](../../.devcontainer/devcontainer.json).
4. Run `npm test`, and migrate every item it rejects in the same pull request.
