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

Listing v2 also bounds every file
([listing v2 §5](https://github.com/musher-dev/specifications/blob/main/specifications/listing/v2/spec.md#media)):
an icon is at most 1 MiB, square, and at least 256 px a side; a screenshot or
overview image is at most 5 MiB and at most 4096 px a side. `npm test` checks
the sizes (`ERR_MEDIA_TOO_LARGE`); the dimensions are an `admission` rule
(`ERR_MEDIA_DIMENSIONS`) the platform decides at sync.

A listing without an `icon:` key ships no icon. Two screenshots must not declare
the same item-relative path — `media/desktop/overview.png` and
`media/mobile/overview.png` are two gallery entries, not a collision.

## Provenance — official upstream project marks

Every committed `media/icon.png` is the **official mark of the upstream
project**, sourced from the project's own repository asset or its GitHub
organization avatar. Each mark identifies the deployable third-party software
to storefront visitors — nominative use — and remains the property of its
respective owner. Inclusion here is not an endorsement by those projects, and
these files are **not** covered by this repository's `LICENSE`. See `NOTICE`.

Every item except `llm-endpoint`, which runs nothing, carries an icon; none
currently ship screenshots.

| Item | Source | Method | License note |
| --- | --- | --- | --- |
| `activepieces` | <https://github.com/activepieces.png?size=512> | GitHub org avatar (served at its native 460 px) | Activepieces mark via the activepieces GitHub org avatar (MIT-licensed community edition); nominative use. |
| `agent-zero` | <https://raw.githubusercontent.com/agent0ai/agent-zero/v2.15/docs/res/favicon.png> | in-repo asset, resampled from 960 px to 512 px | Agent Zero mark from the agent0ai/agent-zero repository (MIT-licensed project); nominative use. |
| `aio-sandbox` | <https://raw.githubusercontent.com/agent-infra/sandbox/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/public/aio-icon.png> | in-repo asset, padded to square and resampled from 1424 x 1410 to 512 px | AIO Sandbox cube icon from the agent-infra/sandbox repository's docs site (Apache-2.0-licensed repo); nominative use. |
| `anythingllm` | <https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/v1.19.0/frontend/src/media/logo/anything-llm-icon.png> | in-repo asset, center-cropped from 1025x1024 to square and resampled to 512 px | AnythingLLM app icon from the Mintplex-Labs/anything-llm repository (MIT-licensed project); nominative use. |
| `code-server` | <https://raw.githubusercontent.com/coder/code-server/main/src/browser/media/pwa-icon-512.png> | in-repo asset | code-server product icon from the coder/code-server repository (MIT-licensed repo); nominative use. |
| `coder` | <https://github.com/coder.png?size=512> | GitHub org avatar | Coder mark via the coder GitHub org avatar (AGPL-3.0-licensed project); nominative use. |
| `contextforge` | <https://raw.githubusercontent.com/IBM/mcp-context-forge/v1.1.1/mcpgateway/static/contextforge-logo_horizontal_color.svg> | in-repo asset: the icon part of the colour logo (its red spark and light anvil, the logo's two icon paths), rendered at 420 px and centred on a 512 px #161616 square, the dark ground the colour logo is drawn for | ContextForge mark from the IBM/mcp-context-forge repository (Apache-2.0-licensed project); nominative use. |
| `crawl4ai` | <https://raw.githubusercontent.com/unclecode/crawl4ai/v0.9.5/deploy/docker/static/assets/logo.png> | in-repo asset, the mark cropped from the 746 x 130 wordmark and centred at 512 px on black, as upstream's own square `crawl4ai-logo.jpg` presents it | Crawl4AI mark from the unclecode/crawl4ai repository (Apache-2.0-licensed project); nominative use. |
| `docling-serve` | <https://raw.githubusercontent.com/docling-project/docling/v2.150.0/docs/assets/logo.png> | in-repo asset (1024 px, cropped to the mark and padded square, resized to 512 px) | Docling duck mark from the docling-project/docling repository (MIT-licensed LF AI & Data project); nominative use. |
| `doom` | <https://github.com/chocolate-doom.png?size=512> | GitHub org avatar, resampled from its native 221 px to 256 px, the listing v2 minimum | Chocolate Doom mark via the chocolate-doom GitHub org avatar (GPL-2.0-licensed project); nominative use. |
| `firecrawl` | <https://raw.githubusercontent.com/firecrawl/firecrawl/v2.11.0/img/firecrawl_logo.png> | in-repo asset | Firecrawl flame mark from the firecrawl/firecrawl repository (AGPL-3.0-licensed project), 512 px square, used as is; nominative use. |
| `flowise` | <https://github.com/FlowiseAI.png?size=512> | GitHub org avatar | Flowise mark via the FlowiseAI GitHub org avatar; nominative use. |
| `gitea` | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/public/assets/img/logo.png> | in-repo asset (512 px, used as is) | Gitea teacup mark from the go-gitea/gitea repository (MIT-licensed project); nominative use. |
| `graphiti` | <https://github.com/getzep.png?size=512> | GitHub org avatar (served at its native 460 px) | Zep mark via the getzep GitHub org avatar (Graphiti is an Apache-2.0 project by Zep Software, Inc., which owns the mark); nominative use. |
| `hermes-agent` | <https://github.com/NousResearch.png?size=512> | GitHub org avatar | Hermes Agent maintainer (Nous Research) GitHub org avatar (MIT-licensed project); nominative use. |
| `hindsight` | <https://raw.githubusercontent.com/vectorize-io/hindsight/v1.2.0/hindsight-control-plane/public/icon-512.png> | in-repo asset | Hindsight mark from the vectorize-io/hindsight repository (MIT-licensed project); nominative use. |
| `label-studio` | <https://github.com/HumanSignal.png?size=512> | GitHub org avatar | Label Studio maintainer (HumanSignal) GitHub org avatar; nominative use. |
| `langflow` | <https://github.com/langflow-ai.png?size=512> | GitHub org avatar | Langflow mark via the langflow-ai GitHub org avatar; nominative use. |
| `langfuse` | <https://raw.githubusercontent.com/langfuse/langfuse/v4.79.0/web/public/icon512.png> | in-repo asset | Langfuse app icon from the langfuse/langfuse repository (MIT-licensed core); nominative use. 512 px square, used unmodified. |
| `librechat` | <https://raw.githubusercontent.com/LibreChat-AI/LibreChat/v0.8.8/client/public/assets/maskable-icon.png> | in-repo asset | LibreChat feather-and-orb mark (the app's PWA maskable icon) from the LibreChat-AI/LibreChat repository (MIT-licensed project), 512 px square, used unmodified; nominative use. |
| `litellm` | <https://github.com/BerriAI.png?size=512> | GitHub org avatar | LiteLLM maintainer (BerriAI) GitHub org avatar; nominative use. |
| `litellm-stack` | <https://github.com/BerriAI.png?size=512> | GitHub org avatar | The same LiteLLM mark as `litellm`; nominative use. |
| `llama-cpp` | <https://raw.githubusercontent.com/ggml-org/llama.cpp/cd959bae99ff4bed22bef2604f45241c09bbb8c8/media/llama1-icon.png> | in-repo asset | llama.cpp mark from the ggml-org/llama.cpp repository at v0.9.0 (MIT-licensed project); nominative use. |
| `meilisearch` | <https://github.com/meilisearch.png?size=512> | GitHub org avatar | Meilisearch mark via the meilisearch GitHub org avatar; nominative use. |
| `metabase` | <https://github.com/metabase.png?size=512> | GitHub org avatar (served at its native 256 px, the listing v2 minimum; used as is) | Metabase mark via the metabase GitHub org avatar (AGPL-3.0-licensed open-source edition); nominative use. |
| `mlflow` | <https://github.com/mlflow.png?size=512> | GitHub org avatar | MLflow mark via the mlflow GitHub org avatar; nominative use. |
| `n8n` | <https://github.com/n8n-io.png?size=512> | GitHub org avatar | n8n mark via the n8n-io GitHub org avatar; nominative use. |
| `ollama` | <https://github.com/ollama.png?size=512> | GitHub org avatar, resampled from its native 460 px to 512 px | Ollama llama mark via the ollama GitHub org avatar (MIT-licensed project); nominative use. |
| `open-webui` | <https://github.com/open-webui.png?size=512> | GitHub org avatar | Open WebUI mark via the open-webui GitHub org avatar; nominative use. |
| `open-webui-stack` | <https://github.com/open-webui.png?size=512> | GitHub org avatar, served at its native 460 px (the same file as `open-webui`) | Open WebUI mark via the open-webui GitHub org avatar; nominative use. The Open WebUI License's branding clause (clause 4) asks that the Open WebUI name and logo stay intact, which this item does. |
| `openclaw` | <https://github.com/openclaw.png?size=512> | GitHub org avatar | OpenClaw (formerly Clawdbot/Moltbot) mark via the openclaw GitHub org avatar (MIT-licensed project); nominative use. Avatar served as JPEG; converted losslessly to PNG. |
| `opencode` | <https://raw.githubusercontent.com/anomalyco/opencode/v1.18.34/packages/ui/src/assets/favicon/web-app-manifest-512x512.png> | in-repo asset | OpenCode web-app icon from the anomalyco/opencode repository (MIT-licensed project); nominative use. |
| `openhands-agent-canvas` | <https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/public/android-chrome-512x512.png> | in-repo asset | OpenHands mark (raised-hands icon) from the OpenHands/OpenHands repository (MIT-licensed repo); nominative use. |
| `paperclip` | <https://github.com/paperclipai.png?size=512> | GitHub org avatar | Paperclip mark via the paperclipai GitHub org avatar (MIT-licensed project); nominative use. |
| `pgvector` | <https://github.com/postgres.png?size=512> | GitHub org avatar (the same file as `postgres`) | The PostgreSQL elephant (Slonik) mark belongs to the PostgreSQL Global Development Group / PostgreSQL Community Association; nominative use. pgvector publishes no logo of its own (its pgvector GitHub org avatar is a plain blue square), and the item deploys a PostgreSQL server, so it carries the PostgreSQL mark. |
| `playwright-mcp` | <https://raw.githubusercontent.com/microsoft/playwright/v1.65.0/browser_patches/webkit/embedder/Playwright/Images.xcassets/AppIcon.appiconset/logo-512.png> | in-repo asset | Playwright masks mark from the microsoft/playwright repository (Apache-2.0 project); nominative use. |
| `postgres` | <https://github.com/postgres.png?size=512> | GitHub org avatar | The PostgreSQL elephant (Slonik) mark belongs to the PostgreSQL Global Development Group / PostgreSQL Community Association; nominative use. |
| `qdrant` | <https://github.com/qdrant.png?size=512> | GitHub org avatar | Qdrant mark via the qdrant GitHub org avatar; nominative use. |
| `redis` | <https://github.com/redis.png?size=512> | GitHub org avatar | The Redis mark belongs to Redis Ltd.; nominative use. |
| `searxng` | <https://github.com/searxng.png?size=512> | GitHub org avatar (served at its native 460 px) | SearXNG magnifier mark via the searxng GitHub org avatar (AGPL-3.0-or-later project); nominative use. |
| `seaweedfs` | <https://raw.githubusercontent.com/seaweedfs/seaweedfs/4.53/note/seaweedfs.png> | in-repo asset | SeaweedFS logo from the seaweedfs/seaweedfs repository (Apache-2.0-licensed project); nominative use. Served at 437 px square, used unmodified. |
| `sim` | <https://raw.githubusercontent.com/simstudioai/sim/v0.9.56/apps/sim/public/favicon/web-app-manifest-512x512.png> | in-repo asset (512 px, used as-is) | Sim web-app icon from the simstudioai/sim repository (Apache-2.0-licensed repo); nominative use. |
| `temporal` | <https://github.com/temporalio.png?size=512> | GitHub org avatar | Temporal mark via the temporalio GitHub org avatar (MIT-licensed project); nominative use. Served at 460 px square. |
| `text-embeddings-inference` | <https://github.com/huggingface.png?size=512> | GitHub org avatar (served at its native 460 px) | Hugging Face mark via the huggingface GitHub org avatar (Text Embeddings Inference is an Apache-2.0 Hugging Face project; the mark belongs to Hugging Face, Inc.); nominative use. |
| `uptime-kuma` | <https://raw.githubusercontent.com/louislam/uptime-kuma/2.5.11/public/icon-512x512.png> | in-repo asset | Uptime Kuma mark from the louislam/uptime-kuma repository (MIT-licensed project); nominative use. |
| `valkey` | <https://github.com/valkey-io.png?size=512> | GitHub org avatar | Valkey mark via the valkey-io GitHub org avatar (BSD-3-Clause project; the mark belongs to the Linux Foundation); nominative use. Served at 460 px square. |
| `voicestudio` | <https://raw.githubusercontent.com/debpalash/VoiceStudio/v0.5.6/docs/logo.png> | in-repo asset | VoiceStudio logo from the debpalash/VoiceStudio repository (AGPL-3.0-licensed project); nominative use. |
| `zeroclaw` | <https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/v0.8.5/web/public/logo.png> | in-repo asset | ZeroClaw web dashboard logo from the zeroclaw-labs/zeroclaw repository (MIT OR Apache-2.0-licensed project); nominative use. |

## An item with no logo of its own

Some items deploy a project that publishes no mark: `pgvector` is a PostgreSQL
extension whose organization avatar is a plain square. Such an item reuses the
mark of the upstream project it is built on, here the PostgreSQL elephant, and
only then:

- the project itself has no mark of its own (checked, and said so in the item's
  row above);
- the item really runs the project whose mark it borrows (pgvector runs a
  PostgreSQL server); and
- the listing's `displayName` and `summary` make the difference from the other
  tile with that mark plain at a glance.

Never borrow a mark from a project the item merely works with, and never make
one up: an item with no fitting mark ships no `icon:`.

## Swapping or updating an icon

To refresh an item's icon — an upstream rebrand, or a higher-resolution
official asset:

1. Replace that item's `media/icon.png` in place: a square PNG at least
   256 px a side (512 px works best) and at most 1 MiB, the listing v2 bounds
   above. The platform re-encodes to WebP and generates its own size variants.
2. Update that item's row in the provenance table above (source URL, method,
   license note).
3. Open a PR. The change is picked up on the platform's next catalog sync.

Prefer the project's official brand or press page, or a repository asset, over
third-party icon packs — and record the license before committing.

Do not re-encode an icon you are not intentionally changing. The platform
detects a swap by content hash, so a gratuitous re-encode reads as a real
change and re-uploads the asset.
