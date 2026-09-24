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
this repo — though not all of them are caught before that: the ones marked
**(sync only)** are `capability`-phase obligations that `npm test` cannot see,
because an offline validator is forbidden to report them.

- the directory name equals both `listing.yaml`'s and `blueprint.yaml`'s
  `metadata.slug`;
- the listing's `spec.itemType` is `BLUEPRINT` exactly when the item holds a
  `blueprint.yaml`, and `COMPONENT` otherwise;
- every blueprint node's `componentRef` resolves to a `components/<name>.yaml`
  file **in the same item directory**, and every such file is referenced — no
  unreferenced components;
- media paths are item-relative, live under `media/`, contain no `..`, use a
  supported extension, and exist on disk;
- every node whose component runs carries `compute.profile`, naming a Compute
  Profile the platform offers — and a node deploying an `EXTERNAL` component,
  which runs nothing, carries no `compute` at all;
- every volume a component declares is allocated a `sizeGiB` on the node, at or
  above the component's own `minSizeGiB`;
- no two inputs claim one `envVarKey`: a workload's environment is exactly its
  inputs' targets, and nothing else writes it;
- volume mount paths are canonical, and no two are the same or nested;
- a `JOB`'s `schedule.cron` is five numeric fields, each within its range;
- no value depends on itself through `{node, output}` bindings;
- component shape follows `spec.type`: a `WORKER` may declare private endpoints
  but is never exposed, and a `JOB` declares none. A `PUBLIC` HTTP endpoint
  needs a readiness probe;
- **(sync only)** a runnable component carries a `workload`, a workload carries
  a `source`, a `SERVICE` declares at least one endpoint, a `JOB` carries a
  `command`, an `EXTERNAL` component publishes at least one output, and every
  input and output is described.

Per the spec, a `BLUEPRINT` item deploys exactly one blueprint, and compute is a
per-node concern on the blueprint node rather than on the component. The
blueprint's `metadata.revision` is the item's revision; a listing carries none.
Component and blueprint documents each carry a required `metadata.description`:
plain text, at most 280 characters, describing the thing itself. The listing's
`summary` remains the storefront copy.

## Adding an item

Create `items/<slug>/` with a component file per building block.

**`components/my-app.yaml`**

```yaml
specVersion: v1
kind: COMPONENT
metadata:
  revision: 1                   # the revision this document is released at
  description: What this component is, in a sentence.   # REQUIRED
spec:
  type: SERVICE                 # SERVICE | WORKER | JOB | EXTERNAL
  workload:                     # required unless EXTERNAL; forbidden on it
    source:
      image: ghcr.io/example/my-app:1.2.3   # a bare name means :latest, as in Docker
    endpoints:
      primary:
        targetPort: 8080        # the port the process listens on
        protocol: HTTP
    health:
      readiness:
        http: { endpoint: primary, path: /healthz }   # the endpoint is named
        initialDelaySeconds: 30
    volumes:
      data:
        mountPath: /var/lib/my-app
        minSizeGiB: 5           # the floor; the blueprint allocates the size
  contract:                     # what the component needs, never where it comes from
    inputs:
      adminPassword:
        description: Password for the bootstrap admin account.   # REQUIRED
        schema: { type: string }        # lowercase JSON Schema types
        sensitive: true                 # beside the schema, not inside it
        required: true
        target: { envVarKey: ADMIN_PASSWORD }
      dataDir:                          # a constant is an input with a default
        description: Directory my-app keeps its data files in.
        schema: { type: string }
        default: /var/lib/my-app
        target: { envVarKey: DATA_DIR }
    outputs: {}
```

The key that is present says where a value comes from. A workload `source` is
`{image}` or `{git: …}`; an output's `from` is `{value}`, `{input}`,
`{endpoint, property}` or `{template}`; a node binding is `{parameter}`,
`{node, output}` or `{value}`. A `type` appears only where the variant is a
*category* — `spec.type`, `schema.type` — and a field naming another key in the
same document is a bare noun: `input`, `endpoint`, `parameter`, `node`,
`output`. Only `componentRef`, which points at another document, takes a suffix.

**`blueprint.yaml`** — references the component file by repo-local path, binds
compute, storage and exposure per node, wires every input explicitly, and
authors the install form:

```yaml
specVersion: v1
kind: BLUEPRINT
metadata:
  slug: my-app                  # equals the directory name
  revision: 1                   # the item's revision
  description: What this deployment is, in a sentence.   # REQUIRED
spec:
  components:
    web:                        # graph-local node name
      componentRef: ./components/my-app.yaml   # must begin ./ and end .yaml
      compute:
        profile: general.standard.small
      volumes:
        data: { sizeGiB: 5 }    # at or above the component's minSizeGiB
      exposure:
        primary: PUBLIC         # an endpoint left out is PRIVATE
      bindings:                 # one entry per input this node takes a value for
        adminPassword: { parameter: adminPassword }
  parameters:                   # everything the installation takes from outside
    adminPassword:
      generator: { byteLength: 32, encoding: HEX }   # HEX | BASE64 | BASE64URL
      ui: { label: Admin password }
```

**Nothing binds by name.** A parameter reaches an input because some node's
`bindings` says so, which is what makes adding an unrelated node safe. A
parameter carries `ui` plus at most one of `default`, `generator` and `from`,
and states no `schema`, no `required` and no `description`: the input it is
bound to declares all three, and the form field reads them from there. An
absent or empty `parameters` is a form with no fields, which is right only when
every required input is bound to something else or already carries a `default`.

A parameter `default` is a literal — it interpolates nothing. A value from
outside the documents arrives through `from`, which is exactly one whole
reference in one of two namespaces: `${{ variables.cloud.region }}` names one
organization variable, and `${{ connections.llm.default }}` names an atomic
connection. A node's own allocated address is not a parameter source; the
component publishes it as an output and the node binds it back:

```yaml
# components/my-app.yaml
    outputs:
      publicURL:
        description: Public URL this deployment answers at.
        schema: { type: string }
        from: { endpoint: primary, property: publicURL }

# blueprint.yaml
      bindings:
        siteURL: { node: web, output: publicURL }
```

A node reading its own endpoint output is a discovery dependency and not a value
cycle: the address is allocated before anything runs.

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
names, one `components/<name>.yaml` per reference — and binds a consumer's input
to a producer's output with `{node, output}`. The two ends agree on
`schema.type`, with one widening: an integer output satisfies a number input.
Input, output, parameter and connection names are `lowerCamelCase`, and an
acronym keeps its conventional case (`baseURL`, `publicURL`, `homepageURL`) —
the environment-variable key is what `target.envVarKey` carries, not the input's
name.

A node the platform does not run — a service addressed elsewhere, such as a
managed database — is a component declaring `spec.type: EXTERNAL`. It has no
`workload`, its inputs carry no `target`, its `outputs` are non-empty, and its
blueprint node carries no `compute`.

A language model is **one connection**, never three values — and the connection
enters through a node, not a field. A component declaring `spec.type: EXTERNAL`
takes the connection whole on a **connection input**, and publishes its three
members as outputs; the workload that calls the model declares three ordinary
string inputs, and the blueprint wires them together:

```yaml
# components/llm.yaml — the node that supplies the model
spec:
  type: EXTERNAL
  contract:
    inputs:
      llm:
        description: Language-model connection this node stands for.
        connection:
          protocol: OPENAI_CHAT_COMPLETIONS   # or ANTHROPIC_MESSAGES
          capabilities: [STREAMING]
    outputs:
      baseURL:
        description: Base URL of the API.
        schema: { type: string }
        from: { input: llm, member: baseURL }
      apiKey:
        description: Credential for the API above.
        schema: { type: string }
        sensitive: true                       # the member is secret, so this is
        from: { input: llm, member: apiKey }
      model:
        description: Model the API answers with.
        schema: { type: string }
        from: { input: llm, member: model }

# blueprint.yaml
  parameters:
    llm:
      from: "${{ connections.llm.default }}"
      ui: { label: Language model }
  components:
    llm:
      componentRef: ./components/llm.yaml     # EXTERNAL, so no compute
      bindings:
        llm: { parameter: llm }
    web:
      componentRef: ./components/my-app.yaml
      compute: { profile: general.standard.small }
      bindings:
        llmBaseURL: { node: llm, output: baseURL }
        llmAPIKey:  { node: llm, output: apiKey }
        llmModel:   { node: llm, output: model }
```

A connection input declares only `description` and `connection`, is always
required, and is the one kind of input **only** an `EXTERNAL` component may
declare. A connection parameter binds to a connection input and to nothing else,
and a connection input takes no other kind of binding. So one connection
parameter fills one external node, and its endpoint, credential and model always
come from one selection — wiring `apiKey` from one node and `baseURL` from
another is possible, but it has to be written down.

A workload never asks for a protocol. It sees three strings, and the node that
supplies them declares what it requires, which is the same shape a node already
uses to read a managed database's host and port.

An item holding **no** `blueprint.yaml` is an `itemType: COMPONENT` item: a
single building block rather than a composition — `postgres` and `redis`, which
wrap a workload, and `llm-endpoint`, the `EXTERNAL` component a language model
enters through. Listing spec §3 binds the two together, so a `COMPONENT` item
cannot carry a blueprint and a
`BLUEPRINT` item cannot omit one. Such an item has no item revision; its
component documents carry their own. A blueprint that needs one of these
building blocks carries its own copy under `components/`, because a repo-local
reference cannot leave its item directory.

## Validation

```sh
npm install
npm test
```

Every item is validated against an **exact release of each family** of
[`musher-dev/specifications`](https://github.com/musher-dev/specifications):
`core/v1.0.0`, `listing/v1.0.0`, `component/v1.3.0` and `blueprint/v1.3.0`.
Families release independently, so they sit at different numbers — component and
blueprint are past `1.0.0` because
[ADR 0033](https://github.com/musher-dev/specifications/blob/main/docs/adr/0033-inputs-are-the-only-way-into-a-component.md)
made inputs the only way into a component, which was breaking for both. Nothing is vendored. The schemas are fetched from their exact release
URLs at `specifications.musher.dev`, and the release's conformance corpus from
its GitHub release assets. Every byte is checked against the digest the release
records, so the corpus is judged against exactly the contract it names, and
adopting a newer release is a deliberate change of one version and its
digests. The origins are
public, so no credential is involved.

The suite covers the three phases a client can decide offline: the YAML
profile, the JSON Schema bundles, and the semantic rules that bind an item's
documents to each other and to its directory. It also runs the specification's
own conformance cases through those phases, so a rule here that disagrees with
the specification fails by case id. See [`tests/README.md`](tests/README.md). For
what each field means, read the generated
[field reference](https://specifications.musher.dev/reference/) rather than a
copy of it.

The Musher platform remains the **sole authority**. These tests are the same
contracts applied early, not a second one: they run the phases that need no
network, and they cannot see the `capability` phase at all — whether a Compute
Profile is actually offered, whether a published component exists, whether a
version is monotonic, and, since component `v1.3.0`, the runtime minimums listed
as **(sync only)** above. An item that passes here can still be rejected at
sync.

Keep changes to one item per pull request, so a rejection that only the platform
can raise is easy to attribute. Adopting a new specification release is the
standing exception: a release that narrows what validates makes every
unmigrated item fail at once, so the pins and the documents move together.

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
