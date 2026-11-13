# Authoring guide

The conventions this catalog keeps and the lessons its reviews kept repeating.
The [README](../README.md) states the hard contracts; this page says how to meet
them, and why. A rule with a `CATALOG_*` code is enforced by the policy suite
([`tests/lib/policy.ts`](../tests/lib/policy.ts)); a deliberate exception goes in
[`tests/policy-exceptions.ts`](../tests/policy-exceptions.ts) with its reason
and the issue that would remove it.

## Inputs

- `required` defaults to `true` (component spec §6.1). An input meant to be
  optional says `required: false` or carries a `default`; one that is required
  may say `required: true` for the reader, but needs nothing.
- In a `COMPONENT` item every value input states one or the other
  (`CATALOG_REQUIRED_WITHOUT_DEFAULT`). Nothing deploys a `COMPONENT` item
  offline, so an input left to the default passed every test and became a
  mandatory deploy-form field at the first live deploy (platform#3841).

## Ports

- Every `targetPort` is 1024 or above (`CATALOG_PRIVILEGED_PORT`). The platform
  rejects a lower one at publish with `ERR_PRIVILEGED_PORT`, after `validate`
  has passed (platform-api#1437). Move an image that defaults to port 80 with
  its own setting, not by asking for privileges.
- An input that sets the process's listen port, by name or by an environment
  variable ending in `PORT`, defaults to one of its component's target ports
  (`CATALOG_PORT_INPUT_MISMATCH`). Moving one and not the other leaves the
  process listening where no endpoint routes. An input bound from another
  node's output is that node's port, and is not checked.

## Probes

- Every `SERVICE` has a readiness probe (`CATALOG_SERVICE_WITHOUT_READINESS`).
  Without one a service is ready the moment it starts, and everything that
  depends on it races its first boot.
- Probes are HTTP-only (platform-api#1446). A service that answers no HTTP —
  PostgreSQL, Redis, Valkey — either carries an exception citing that issue or
  runs a supervisor that answers HTTP for it, as `pgvector`'s does.
- `pg_isready` run as root, from a probe or a supervisor, logs
  `FATAL: role "root" does not exist` on every call unless it is given
  `-U <user> -d <db>`.

## Secrets in URLs and JSON

- A sensitive input interpolated into a URL's userinfo
  (`scheme://user:${PASSWORD}@host`) declares the URL-safe pattern
  `^[A-Za-z0-9._~-]+$` (`CATALOG_URL_UNSAFE_SECRET`). One `/`, `@` or `:` in a
  password otherwise breaks the URL, and only for the deployments that drew it.
- Generated parameters use `HEX` or `BASE64URL`, never `BASE64`, whose `+/=`
  are not URL-safe.
- A JSON body assembled in shell escapes every interpolated string — the
  password as well as the email — even when today's generator could not
  produce a quote.

## Command wrappers

A component that runs inline code — `sh -c`, `perl -e`, `python -c`,
`node -e` — instead of the image's own process does so because the platform
cannot yet say what it needs. The comment block directly above `command:`
names the issue it waits on (`CATALOG_WORKAROUND_UNTAGGED`):

```yaml
    # WORKAROUND(platform-api#1448): DATABASE_URL holds a generated password,
    # and a binding cannot compose a string.
    command:
      - sh
      - -c
      - |
        …
```

| Issue | Limitation |
| --- | --- |
| platform-api#1448 | Bindings and templates cannot compose strings (URLs carrying generated passwords) |
| platform-api#1447 | No ENTRYPOINT override, no mounted config file, no lower-case env name |
| platform-api#1446 | Probes are HTTP-only |
| platform-api#1439, platform-api#1445 | No start ordering between nodes |
| platform-api#1443 | The runtime overrides an image's `HOSTNAME` |
| platform-api#1440 | A WORKER with no endpoint is killed after 15 s |

A wrapper with several reasons carries one tag line per issue. When an issue
closes, `grep -rn 'WORKAROUND(platform-api#1448)' items/` finds every wrapper
it made removable.

## Building-block copies

An item-local `componentRef` cannot leave its item, so a blueprint that needs
`postgres`, `valkey` or another building block carries a copy. The copy's first
comment lines say so:

```yaml
# copy-of: items/postgres/components/postgres.yaml@9
# copy-differs: /metadata/description, /spec/contract/inputs/postgresPassword/schema
```

`CATALOG_COPY_DRIFT` parses both documents and compares them. Comments, layout
and `/metadata/revision` never count, and the pointers in `copy-differs` are set
aside; any other difference fails, a listed pointer that no longer differs
fails, and so does a cited revision that is not the source's current one. So
raising a building block's revision fails every copy until each is brought in
step. A component merely modelled on another declares no copy and says
"modelled on" in prose. The longer-term fix is a cross-item reference resolved
at sync (platform#3842).

## Revisions

Any change to a component or blueprint document raises its
`metadata.revision`: a revision names one document. A changed component raises
its blueprint's revision too, because a published blueprint revision carries
the component documents it was published with. A listing carries no revision.

## Naming

- The deployer's first account is `owner*` — `ownerEmail`, `ownerPassword`,
  `ownerName`, `ownerUsername` — whatever the app calls the role; the
  parameter's `ui.label` may use the app's own word.
- The deployment's own database password parameter is `dbPassword`.
- The node that creates the first account, and its component, are
  `bootstrap-owner`.
- An input setting the component's own bind address is `host` for a bare
  address, `listenAddress` for `host:port`.
- A node is named for the role it plays in this deployment — `db`, `cache`,
  `queue`, `search`, `blob` — so one image can be `cache` in one item and
  `queue` in another.
- A generated parameter's name is its credential's identity. Renaming it
  regenerates the secret for every existing deployment (blueprint §5.2), so a
  name is settled before release. That is why `litellm-stack` keeps
  `databasePassword` and `label-studio` keeps `admin*`.

## First-account bootstraps

- A bootstrap can run as a one-shot `JOB` node that polls the app's private
  address until it answers; `gitea`, `metabase`, `uptime-kuma`, `coder` and
  `temporal`'s schema setup all run that way live. `activepieces` and `sim` run
  theirs in-process on loopback, the form their live tests passed.
- Exempt setup routes are public for a few seconds after readiness
  (platform-api#1444), so a bootstrap claims the account as soon as it can.

## Sign-in

An app that signs viewers in through the platform's OIDC links an existing
account only by **verified email**, never by a username derived from it.
Gitea's `ACCOUNT_LINKING=auto` matches by username, so `alice@a.example` could
sign in to `alice@b.example`'s account; the `gitea` item sets `login`, which
asks for the existing account's password once.

## Language models

- Check the upstream feature flags that gate the AI feature you wire. Langfuse
  hides its in-app agent unless `LANGFUSE_IN_APP_AGENT_ENABLED=true`; the
  listing claims only what is switched on.
- A model is one connection entering through an `EXTERNAL` node. A
  `COMPONENT` item cannot carry that node, so its model inputs are plain
  optional inputs (`required: false`), and the overview says how to wire them
  from a blueprint (`crawl4ai` is the example). Never present them as wired.

## Listings

- **Category** answers "what am I looking for". `MODELS` holds reaching,
  serving and improving models, chat frontends over models included, even
  when they offer agents (`open-webui`, `librechat`, `anythingllm`). `AGENTS`
  holds agents, agent builders, agent gateways and MCP servers, and tools whose
  consumer is an agent: scrapers and document converters (`firecrawl`,
  `crawl4ai`, `docling-serve`, `playwright-mcp`).
- **Lifecycle stage** claims no more than is verified. `EXPERIMENTAL` until a
  live deploy has passed its functional checks; `BETA` once one has; `STABLE`
  after it has run live over time.
- **Icons** are square PNGs at least 256 px a side and at most 1 MiB
  (`CATALOG_ICON_SIZE`; a screenshot is at most 4096 px a side,
  `CATALOG_SCREENSHOT_SIZE`). An item with no logo of its own follows
  [ICONS.md](../ICONS.md#an-item-with-no-logo-of-its-own).

## Files

Text files under `items/` use LF only (`CATALOG_LINE_ENDINGS`);
`.gitattributes` normalizes what git stores. This repository is public:
comments cite issues, upstream files and releases, never internal run IDs
(`CATALOG_INTERNAL_REFERENCE`). Write "in a live deploy test" and cite the
issue the run produced.

## Recorded follow-ups

- **Metabase Metabot** (platform#3843): Metabase 65 OSS takes a
  bring-your-own AI provider through the environment (`MB_LLM_ANTHROPIC_*`),
  but it validates model ids against its own list, and an organization's LLM
  connection names any model. Wiring Metabot to it is declined for now;
  revisit if Metabase accepts arbitrary model ids or an OpenAI-compatible base
  URL.
