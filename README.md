# Musher catalog

The platform-curated catalog for [Musher](https://musher.dev) — the one-click
deployable items that appear in the storefront.

Each item is a **self-contained directory** under `items/` holding the three
authoring surfaces a catalog entry spans: its **components** (the building
blocks), its **blueprint** (the composition graph), and its **listing** (the
storefront wrapper). All three use the Musher spec-document envelope, defined
normatively in
[`musher-dev/specifications`](https://github.com/musher-dev/specifications).

> **Third-party marks.** The icons under `items/*/media/` are the official marks
> of the upstream projects they identify. They remain the property of their
> respective owners, are included for nominative identification only, and are
> **not** covered by this repository's `LICENSE`. See [`NOTICE`](./NOTICE) and
> [`ICONS.md`](./ICONS.md).

## Layout

```text
items/
└── <slug>/                     # ONE self-contained item per directory
    ├── listing.yaml            # storefront wrapper
    ├── blueprint.yaml          # composition graph; absent for a COMPONENT item
    ├── components/
    │   └── <name>.yaml         # ≥1; every file referenced by blueprint.yaml
    └── media/                  # optional assets
        ├── icon.png
        └── screenshots/*.png
```

The directory name **is** the slug, so slug uniqueness is structural.

## Item contracts

These are hard requirements. A violation is rejected when the platform syncs
this repo:

- the directory name equals both `listing.yaml`'s and `blueprint.yaml`'s
  `metadata.slug`;
- the listing's `spec.itemType` is `BLUEPRINT` exactly when the item holds a
  `blueprint.yaml`, and `COMPONENT` otherwise;
- every blueprint node's `componentRef` resolves to a `components/<name>.yaml`
  file **in the same item directory**, and every such file is referenced — no
  unreferenced components;
- media paths are item-relative, live under `media/`, contain no `..`, use a
  supported extension, and exist on disk;
- every node's `size` names a Compute Profile the platform offers — or is
  `null` exactly when the node deploys an external component
  (`spec.external`), which runs nothing;
- image refs are **pinned** — `:latest`, `:main` and `:edge` are rejected;
- component shape follows the workload type: `SERVICE` requires endpoints plus
  a readiness probe for a public endpoint; `WORKER`, `JOB` and `CRON` forbid
  endpoints.

Per the spec, a `BLUEPRINT` item deploys exactly one blueprint, and compute is a
per-node concern on the blueprint node rather than on the component. The
blueprint's `metadata.revision` is the item's revision; a listing carries none.

## Adding an item

Create `items/<slug>/` with a component file per building block.

**`components/my-app.yaml`**

```yaml
specVersion: v1
kind: COMPONENT
metadata:
  revision: 1                   # the revision this document is released at
spec:
  workload:
    type: SERVICE               # SERVICE | WORKER | JOB | CRON
    source:
      type: IMAGE
      ref: ghcr.io/example/my-app:1.2.3   # pinned — no :latest
    endpoints:
      primary:
        containerPort: 8080
        protocol: HTTP
        visibility: PUBLIC
    health:
      readiness:
        path: /healthz
        initialDelaySeconds: 30
  contract:                     # what the component needs, never where it comes from
    inputs:
      adminPassword:
        description: Password for the bootstrap admin account.   # REQUIRED
        schema: { type: STRING, sensitive: true }
        required: true
        target: { envVarKey: ADMIN_PASSWORD }
    outputs: {}
```

**`blueprint.yaml`** — references the component file by repo-local path, binds
compute per node, and authors the install form:

```yaml
specVersion: v1
kind: BLUEPRINT
metadata: { slug: my-app, revision: 1 }   # the item's revision
spec:
  components:
    web:                        # graph-local node name (map order = graph order)
      componentRef: ./components/my-app.yaml   # must begin ./ and end .yaml
      size: general.standard.small          # binding Compute Profile
      connections: {}           # inbound wires, keyed by consumer input
  parameters:                   # the install form, always authored
    adminPassword:              # key = the input it covers
      generator: { byteLength: 32, encoding: ALPHANUMERIC }   # or `default`, or neither
      ui: { label: Admin password }
```

A parameter covers every input of its key on every node no connection fills it
on, and carries `ui` plus at most one of `generator` and `default`. It states no
`schema`, no `required` and no `description`: the input it covers declares all
three, and the form field reads them from there. A `default` may name what no
author can write down — `default: "https://${{ self.publicHostname }}/oauth/cb"`
reads the address the platform assigns this node. An absent or empty
`parameters` is a form with no fields, which is right only when every required
input is wired or already has a `schema.default`.

The `./` prefix is load-bearing, not decorative: a bare name is not
distinguishable from the UUID a published reference uses, so without it no
validator could tell which resolver the reference wanted.

**`listing.yaml`**

```yaml
specVersion: v1
kind: LISTING
metadata: { slug: my-app }     # slug only — a listing carries no revision
spec:
  itemType: BLUEPRINT           # BLUEPRINT iff the item holds blueprint.yaml
  displayName: My App
  summary: One-line storefront tagline (≤ 280 chars)
  description: |
    Markdown long-form description.
  category: DEVELOPER_TOOLS
  lifecycleStage: STABLE        # STABLE | BETA | EXPERIMENTAL | SUNSET
  tags: [example]
  homepageURL: https://example.com
  sourceRepoURL: https://github.com/example/my-app
  license: MIT                  # SPDX expression; LicenseRef-… when SPDX has none
  icon: media/icon.png          # optional; see ICONS.md
  screenshots:                  # optional; {file, caption?} in display order
    - file: media/screenshots/01-home.png
      caption: The home screen
```

A multi-service item adds more entries under `spec.components` — unique node
names, one `components/<name>.yaml` per reference — and wires `connections`
between declared component outputs and inputs. Any input may be wired — the one
exception is an input the same component republishes through a `valueFrom: INPUT`
output — and a wire's two ends must agree on `schema.type`, and on
`schema.resourceType` wherever the consuming input names one. A wired input is
never covered by a parameter, so a wire and a form field never claim one value.
Input, output and connection names are `lowerCamelCase` — the
environment-variable key is what `target.envVarKey` carries, not the input's
name.

A node the platform does not run — a service addressed elsewhere, such as a
language-model endpoint — is a component declaring `spec.external` in place of
`spec.workload`. Its blueprint node writes `size: null`, and the values it holds
reach the install form through parameters covering its inputs, like any other
node's.

An item holding **no** `blueprint.yaml` is an `itemType: COMPONENT` item: a
single building block rather than a composition — `postgres` and `redis`, which
wrap a workload, and `llm-endpoint`, which runs nothing. Listing spec §3 binds
the two together, so a `COMPONENT` item cannot carry a blueprint and a
`BLUEPRINT` item cannot omit one. Such an item has no item revision; its
component documents carry their own. A blueprint that needs one of these
building blocks carries its own copy under `components/`, because a repo-local
reference cannot leave its item directory.

## Validation

```sh
npm install
npm test
```

Every item is validated against the v1 schemas
[`musher-dev/specifications`](https://github.com/musher-dev/specifications)
publishes at `specifications.musher.dev`, **fetched at run time rather than
vendored** — so what the corpus is judged against is the contract as it currently
stands, not a copy of it that has quietly fallen behind. The origin is public, so
no credential is involved. The suite covers the three phases a client can decide
offline: the YAML profile, the JSON Schema bundles, and the semantic rules that
bind an item's documents to each other and to its directory. See
[`tests/README.md`](tests/README.md).

The Musher platform remains the **sole authority**. These tests are the same
contracts applied early, not a second one: they run the phases that need no
network, and they cannot see the `capability` phase at all — whether a Compute
Profile is actually offered, whether a published component exists, whether a
version is monotonic. An item that passes here can still be rejected at sync.

Keep changes to one item per pull request, so a rejection that only the platform
can raise is easy to attribute.

## Contributing

This repository holds the **platform-curated** catalog — the items Musher
maintains directly. It is public so the corpus is a browsable worked example
for anyone authoring against
[`musher-dev/specifications`](https://github.com/musher-dev/specifications).

Community-authored catalog items are **not** submitted here. They are created
and managed directly on the Musher platform. Pull requests adding new
third-party listings to this repository will be closed with a pointer to that
flow.

Corrections to existing items — a stale image tag, a broken link, an upstream
rebrand, a clearer summary — are welcome as pull requests.

## License

The YAML and prose in this repository are covered by [`LICENSE`](./LICENSE).
The third-party marks under `items/*/media/` are **not** — see
[`NOTICE`](./NOTICE).
