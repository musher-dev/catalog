# Catalog media (icons + screenshots)

Each item directory may carry media assets under `media/` and declare them in
`listing.yaml`:

```yaml
spec:
  icon: media/icon.png
  screenshots:
    - file: media/screenshots/01-home.png
      caption: The home screen
```

Media paths are **item-relative**, must live under that item's own `media/`
directory, must not contain `..`, and must use a supported extension
(`.png`, `.jpg`, `.jpeg`, `.webp`). Every declared path must exist on disk.

A listing without an `icon:` key ships no icon. Screenshot basenames must be
unique within a listing.

## Provenance — official upstream project marks

Every committed `media/icon.png` is the **official mark of the upstream
project**, sourced from the project's own repository asset or its GitHub
organization avatar. Each mark identifies the deployable third-party software
to storefront visitors — nominative use — and remains the property of its
respective owner. Inclusion here is not an endorsement by those projects, and
these files are **not** covered by this repository's `LICENSE`. See `NOTICE`.

All 14 items carry an icon; none currently ship screenshots.

| Item | Source | Method | License note |
|---|---|---|---|
| `code-server` | <https://raw.githubusercontent.com/coder/code-server/main/src/browser/media/pwa-icon-512.png> | in-repo asset | code-server product icon from the coder/code-server repository (MIT-licensed repo); nominative use. |
| `flowise` | <https://github.com/FlowiseAI.png?size=512> | GitHub org avatar | Flowise mark via the FlowiseAI GitHub org avatar; nominative use. |
| `label-studio` | <https://github.com/HumanSignal.png?size=512> | GitHub org avatar | Label Studio maintainer (HumanSignal) GitHub org avatar; nominative use. |
| `langflow` | <https://github.com/langflow-ai.png?size=512> | GitHub org avatar | Langflow mark via the langflow-ai GitHub org avatar; nominative use. |
| `litellm` | <https://github.com/BerriAI.png?size=512> | GitHub org avatar | LiteLLM maintainer (BerriAI) GitHub org avatar; nominative use. |
| `litellm-stack` | <https://github.com/BerriAI.png?size=512> | GitHub org avatar | Same BerriAI mark as `litellm`, copied byte-for-byte rather than re-fetched, since the item lists the same upstream software; nominative use. |
| `meilisearch` | <https://github.com/meilisearch.png?size=512> | GitHub org avatar | Meilisearch mark via the meilisearch GitHub org avatar; nominative use. |
| `mlflow` | <https://github.com/mlflow.png?size=512> | GitHub org avatar | MLflow mark via the mlflow GitHub org avatar; nominative use. |
| `n8n` | <https://github.com/n8n-io.png?size=512> | GitHub org avatar | n8n mark via the n8n-io GitHub org avatar; nominative use. |
| `openclaw` | <https://github.com/openclaw.png?size=512> | GitHub org avatar | OpenClaw (formerly Clawdbot/Moltbot) mark via the openclaw GitHub org avatar (MIT-licensed project); nominative use. Avatar served as JPEG; converted losslessly to PNG. |
| `open-webui` | <https://github.com/open-webui.png?size=512> | GitHub org avatar | Open WebUI mark via the open-webui GitHub org avatar; nominative use. |
| `postgres` | <https://github.com/postgres.png?size=512> | GitHub org avatar | The PostgreSQL elephant (Slonik) mark belongs to the PostgreSQL Global Development Group / PostgreSQL Community Association; nominative use. |
| `qdrant` | <https://github.com/qdrant.png?size=512> | GitHub org avatar | Qdrant mark via the qdrant GitHub org avatar; nominative use. |
| `redis` | <https://github.com/redis.png?size=512> | GitHub org avatar | The Redis mark belongs to Redis Ltd.; nominative use. |


## Swapping or updating an icon

To refresh an item's icon — an upstream rebrand, or a higher-resolution
official asset:

1. Replace that item's `media/icon.png` in place. A square PNG with a short
   side of at least 128 px works best; the platform re-encodes to WebP and
   generates its own size variants.
2. Update that item's row in the provenance table above (source URL, method,
   license note).
3. Open a PR. The change is picked up on the platform's next catalog sync.

Prefer the project's official brand or press page, or a repository asset, over
third-party icon packs — and record the license before committing.

Do not re-encode an icon you are not intentionally changing. The platform
detects a swap by content hash, so a gratuitous re-encode reads as a real
change and re-uploads the asset.
