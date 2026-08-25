/**
 * The rules, exercised against deliberately broken items.
 *
 * A suite that passes on a clean corpus proves nothing on its own — it passes
 * just as readily when a rule is silently unreachable. Each case here breaks one
 * thing in a synthetic item and asserts the normative diagnostic fires, so the
 * checks that guard `items/` are themselves guarded.
 *
 * These are not conformance fixtures. `musher-dev/spec` publishes those, and its
 * corpus is the authority on what an implementation must report; these cases pin
 * the subset this repository enforces.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import YAML from 'yaml';

import { loadItemDocuments, readItem } from './lib/catalog.ts';
import { mediaPathPatternFrom } from './lib/media.ts';
import { KIND_OF, formatAjvErrors, loadSchema, validatorFor } from './lib/spec-schemas.ts';
import {
  buildContext,
  checkComponentReferences,
  checkConnections,
  checkDescription,
  checkHealthProbes,
  checkIdentity,
  checkImagePinning,
  checkMedia,
  checkParameters,
  checkPlatformDefaults,
  tagOf,
  valueSchemaDefaultsFrom,
  type Diagnostic,
} from './lib/semantic.ts';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musher-catalog-rules-'));
after(() => fs.rmSync(workspace, { recursive: true, force: true }));

/* ----------------------------------------------------------------- builder */

type Doc = Record<string, unknown>;

const listing = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'LISTING',
  metadata: { slug: 'acme-wiki', version: 1 },
  spec: {
    listingKind: 'BLUEPRINT',
    displayName: 'Acme Wiki',
    summary: 'A wiki',
    description: 'Long-form copy.',
    category: 'DEVELOPER_TOOLS',
    lifecycleStage: 'STABLE',
    ...(over['spec'] as Doc),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'spec')),
});

const blueprint = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'BLUEPRINT',
  metadata: { slug: 'acme-wiki', version: 1 },
  spec: {
    components: { web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} } },
    parameters: {},
    ...(over['spec'] as Doc),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'spec')),
});

const component = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'COMPONENT',
  metadata: { version: 1 },
  spec: {
    workload: {
      kind: 'SERVICE',
      source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
      endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
      health: { readiness: { path: '/healthz' } },
    },
    contract: { inputs: {}, outputs: {} },
    ...(over['spec'] as Doc),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'spec')),
});

let caseCounter = 0;

type Fixture = {
  slug?: string;
  listing?: Doc | null;
  blueprint?: Doc | null;
  components?: Record<string, Doc>;
  /** Media files to create, by item-relative path. */
  media?: string[];
};

function build(fixture: Fixture): string {
  const slug = fixture.slug ?? 'acme-wiki';
  const root = path.join(workspace, `case-${caseCounter++}`, slug);
  fs.mkdirSync(root, { recursive: true });

  const write = (relative: string, document: Doc) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, YAML.stringify(document));
  };

  if (fixture.listing !== null) write('listing.yaml', fixture.listing ?? listing());
  if (fixture.blueprint !== null) write('blueprint.yaml', fixture.blueprint ?? blueprint());
  for (const [name, document] of Object.entries(fixture.components ?? { 'components/web.yaml': component() })) {
    write(name, document);
  }
  for (const relative of fixture.media ?? []) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }

  return root;
}

async function diagnose(root: string): Promise<Diagnostic[]> {
  const [listingBundle, componentBundle] = await Promise.all([loadSchema('listing'), loadSchema('component')]);
  const item = readItem(root);
  const documents = await loadItemDocuments(item);
  const pattern = mediaPathPatternFrom(listingBundle.schema);
  const context = buildContext(item, documents, (value) => pattern.test(value), valueSchemaDefaultsFrom(componentBundle.schema));

  return [
    ...checkIdentity(context),
    ...checkComponentReferences(context),
    ...checkMedia(context),
    ...checkDescription(context),
    ...checkImagePinning(context),
    ...checkHealthProbes(context),
    ...checkPlatformDefaults(context),
    ...checkConnections(context),
    ...checkParameters(context),
  ];
}

async function assertReports(fixture: Fixture, code: string): Promise<void> {
  const diagnostics = await diagnose(build(fixture));
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === code),
    `expected ${code}, got ${diagnostics.map((d) => `${d.code} (${d.where})`).join('; ') || 'no diagnostics'}`,
  );
}

async function assertClean(fixture: Fixture): Promise<void> {
  const diagnostics = await diagnose(build(fixture));
  assert.deepEqual(
    diagnostics.map((d) => `${d.code} at ${d.where}: ${d.message}`),
    [],
  );
}

/* ------------------------------------------------------------------- cases */

describe('a well-formed item', () => {
  it('reports nothing', async () => {
    await assertClean({});
  });

  it('validates structurally against all three fetched schemas', async () => {
    // The baseline the broken cases are mutations of must itself be a real item,
    // or a case could "pass" by tripping a rule the mutation never touched.
    const item = readItem(build({ media: ['media/icon.png'], listing: listing({ spec: { icon: 'media/icon.png' } }) }));
    const documents = await loadItemDocuments(item);

    for (const [family, document] of [
      ['listing', documents.listing],
      ['blueprint', documents.blueprint],
      ...[...documents.components.values()].map((doc) => ['component', doc] as const),
    ] as const) {
      assert.ok(document?.value);
      assert.equal(document.value['kind'], KIND_OF[family]);
      const validate = await validatorFor(family);
      assert.ok(validate(document.value), `${document.label}:\n${formatAjvErrors(validate.errors)}`);
    }
  });
});

describe('identity — blueprint §3, listing §3', () => {
  it('ERR_SLUG_MISMATCH when metadata.slug disagrees with the directory name', async () => {
    await assertReports({ blueprint: blueprint({ metadata: { slug: 'other', version: 1 } }) }, 'ERR_SLUG_MISMATCH');
  });

  it('ERR_VERSION_MISMATCH when the two halves of the item disagree', async () => {
    await assertReports({ blueprint: blueprint({ metadata: { slug: 'acme-wiki', version: 2 } }) }, 'ERR_VERSION_MISMATCH');
  });
});

describe('component references — blueprint §4.1', () => {
  it('ERR_COMPONENT_NOT_FOUND when a reference names no document', async () => {
    await assertReports(
      { blueprint: blueprint({ spec: { components: { web: { component: './components/missing.yaml', size: 'general.standard.small', connections: {} } } } }) },
      'ERR_COMPONENT_NOT_FOUND',
    );
  });

  it('ERR_REFERENCE_ESCAPE when a reference resolves outside the item root', async () => {
    await assertReports(
      { blueprint: blueprint({ spec: { components: { web: { component: '../shared/web.yaml', size: 'general.standard.small', connections: {} } } } }) },
      'ERR_REFERENCE_ESCAPE',
    );
  });

  it('ERR_UNREFERENCED_COMPONENT when a document sits beside the one in use', async () => {
    await assertReports(
      { components: { 'components/web.yaml': component(), 'components/web-legacy.yaml': component() } },
      'ERR_UNREFERENCED_COMPONENT',
    );
  });

  it('finds a component document outside components/, which the spec permits', async () => {
    // The local form imposes no directory layout: ./component-web.yaml and
    // ./components/web.yaml are equally valid.
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: { component: './component-web.yaml', size: 'general.standard.small', connections: {} } } } }),
      components: { 'component-web.yaml': component() },
    });
  });
});

describe('media — listing §5', () => {
  it('ERR_MEDIA_NOT_FOUND when a declared path names no file', async () => {
    await assertReports({ listing: listing({ spec: { icon: 'media/icon.png' } }) }, 'ERR_MEDIA_NOT_FOUND');
  });

  it('ERR_DUPLICATE_MEDIA_BASENAME when two screenshots collide', async () => {
    // media/desktop/overview.png and media/mobile/overview.png are one gallery entry.
    await assertReports(
      {
        media: ['media/desktop/overview.png', 'media/mobile/overview.png'],
        listing: listing({
          spec: {
            screenshots: [{ file: 'media/desktop/overview.png' }, { file: 'media/mobile/overview.png' }],
          },
        }),
      },
      'ERR_DUPLICATE_MEDIA_BASENAME',
    );
  });

  it('accepts an icon that exists', async () => {
    await assertClean({ media: ['media/icon.png'], listing: listing({ spec: { icon: 'media/icon.png' } }) });
  });
});

describe('the description Markdown profile — listing §4.1', () => {
  it('ERR_RAW_HTML for an inline element', async () => {
    await assertReports({ listing: listing({ spec: { description: 'Press <b>go</b>.' } }) }, 'ERR_RAW_HTML');
  });

  it('ERR_RAW_HTML for an HTML block', async () => {
    await assertReports({ listing: listing({ spec: { description: '<div>hello</div>\n' } }) }, 'ERR_RAW_HTML');
  });

  it('permits angle brackets inside a code fence', async () => {
    // A lexical rule would reject the authors writing honest documentation,
    // which is most of them.
    await assertClean({ listing: listing({ spec: { description: 'Set it up:\n\n```html\n<script src="x"></script>\n```\n' } }) });
  });

  it('ERR_DISALLOWED_SCHEME for a javascript: link', async () => {
    await assertReports({ listing: listing({ spec: { description: '[go](javascript:alert(1))' } }) }, 'ERR_DISALLOWED_SCHEME');
  });

  it('permits https, mailto and a fragment', async () => {
    await assertClean({
      listing: listing({ spec: { description: '[a](https://x.test) [b](mailto:h@x.test) [c](#usage)\n\n## Usage\n' } }),
    });
  });

  it('ERR_IMAGE_NOT_LOCAL for a remote image', async () => {
    // A remote image discloses every storefront viewer's IP address to a host
    // the listing author chose, on every page view, with no interaction.
    await assertReports(
      { listing: listing({ spec: { description: '![shot](https://cdn.test/shot.png)' } }) },
      'ERR_IMAGE_NOT_LOCAL',
    );
  });

  it('ERR_MEDIA_NOT_FOUND for a local description image the item does not ship', async () => {
    await assertReports({ listing: listing({ spec: { description: '![shot](media/shot.png)' } }) }, 'ERR_MEDIA_NOT_FOUND');
  });
});

describe('image pinning — COMP-SRC-001', () => {
  for (const tag of ['latest', 'main', 'LATEST', 'edge', 'nightly', 'rolling']) {
    it(`ERR_UNPINNED_IMAGE for :${tag}`, async () => {
      await assertReports(
        { components: { 'components/web.yaml': component({ spec: { workload: { kind: 'SERVICE', source: { type: 'IMAGE', ref: `ghcr.io/acme/web:${tag}` }, endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } }, health: { readiness: { path: '/healthz' } } } } }) } },
        'ERR_UNPINNED_IMAGE',
      );
    });
  }

  it('reads the tag as the colon after the final slash', () => {
    // A registry port must not read as a tag.
    assert.equal(tagOf('localhost:5000/nginx'), null);
    assert.equal(tagOf('localhost:5000/nginx:1.27'), '1.27');
    assert.equal(tagOf('redis:8.8.1-alpine'), '8.8.1-alpine');
  });

  it('accepts a floating tag accompanied by a digest', () => {
    // A digest pin satisfies the rule whatever tag accompanies it, because the
    // digest is what resolves.
    assert.equal(tagOf(`ghcr.io/acme/web:latest@sha256:${'a'.repeat(64)}`), null);
  });
});

describe('endpoint resolution — component §5.2, §5.4, §6.1', () => {
  const workloadWith = (endpoints: Doc, health: Doc = {}, contract?: Doc): Doc =>
    component({
      spec: {
        workload: { kind: 'SERVICE', source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' }, endpoints, health },
        contract: contract ?? { inputs: {}, outputs: {} },
      },
    });

  it('ERR_UNKNOWN_ENDPOINT when a probe names an endpoint the workload does not declare', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(
            { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
            { readiness: { path: '/healthz', endpoint: 'console' } },
          ),
        },
      },
      'ERR_UNKNOWN_ENDPOINT',
    );
  });

  it('ERR_AMBIGUOUS_ENDPOINT when a probe omits the endpoint and none is elected', async () => {
    // Electing the first name in sort order would let a new endpoint silently
    // re-point a probe that has worked for a year.
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(
            {
              api: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' },
              console: { containerPort: 9090, protocol: 'HTTP', visibility: 'PUBLIC' },
            },
            { readiness: { path: '/healthz' } },
          ),
        },
      },
      'ERR_AMBIGUOUS_ENDPOINT',
    );
  });

  it('ERR_ENDPOINT_NOT_HTTP when a probe resolves to a TCP endpoint', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(
            { primary: { containerPort: 6379, protocol: 'TCP', visibility: 'PRIVATE' } },
            { liveness: { path: '/healthz' } },
          ),
        },
      },
      'ERR_ENDPOINT_NOT_HTTP',
    );
  });

  it('elects the sole PUBLIC endpoint as primary', async () => {
    await assertClean({
      components: {
        'components/web.yaml': workloadWith(
          {
            api: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' },
            metrics: { containerPort: 9090, protocol: 'HTTP', visibility: 'PRIVATE' },
          },
          { readiness: { path: '/healthz' } },
        ),
      },
    });
  });

  it('ERR_ENDPOINT_NOT_PUBLIC when a platform default reads a private endpoint', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(
            { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PRIVATE' } },
            {},
            {
              inputs: { host: { schema: { type: 'STRING' }, suppliedBy: 'USER', ui: { label: 'Host' }, platformDefault: { source: 'PUBLIC_HOSTNAME' } } },
              outputs: {},
            },
          ),
        },
      },
      'ERR_ENDPOINT_NOT_PUBLIC',
    );
  });

  it('ERR_ENDPOINT_NOT_L4 when PUBLIC_ADDRESS reads an HTTP endpoint', async () => {
    // Such an endpoint is published through the shared ingress, so what the
    // derivation would yield is the ingress address — true, and not the thing
    // an author asking for an edge address is asking for.
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(
            { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' }, },
            { readiness: { path: '/healthz' } },
            {
              inputs: { addr: { schema: { type: 'STRING' }, suppliedBy: 'USER', ui: { label: 'Address' }, platformDefault: { source: 'PUBLIC_ADDRESS' } } },
              outputs: {},
            },
          ),
        },
      },
      'ERR_ENDPOINT_NOT_L4',
    );
  });

  it('ERR_ENDPOINT_NOT_HTTP when PUBLIC_URL reads a TCP endpoint', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(
            { broker: { containerPort: 1883, protocol: 'TCP', visibility: 'PUBLIC' } },
            {},
            {
              inputs: { url: { schema: { type: 'STRING' }, suppliedBy: 'USER', ui: { label: 'URL' }, platformDefault: { source: 'PUBLIC_URL' } } },
              outputs: {},
            },
          ),
        },
      },
      'ERR_ENDPOINT_NOT_HTTP',
    );
  });
});

describe('connections — blueprint §4.2', () => {
  const db = component({
    spec: {
      workload: {
        kind: 'SERVICE',
        source: { type: 'IMAGE', ref: 'postgres:18.2-alpine' },
        endpoints: { primary: { containerPort: 5432, protocol: 'TCP', visibility: 'PRIVATE' } },
      },
      contract: {
        inputs: {},
        outputs: { connectionString: { schema: { type: 'STRING', semanticType: 'POSTGRES' }, valueFrom: 'DERIVED', value: null } },
      },
    },
  });

  const webConsuming = (inputSchema: Doc): Doc =>
    component({
      spec: {
        workload: {
          kind: 'SERVICE',
          source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
          health: { readiness: { path: '/healthz' } },
        },
        contract: {
          inputs: { DATABASE_URL: { schema: inputSchema, suppliedBy: 'CONNECTION', ui: null, target: { envVarKey: 'DATABASE_URL' } } },
          outputs: {},
        },
      },
    });

  const twoNode = (connections: Doc): Doc =>
    blueprint({
      spec: {
        components: {
          db: { component: './components/db.yaml', size: 'general.standard.small', connections: {} },
          web: { component: './components/web.yaml', size: 'general.standard.small', connections },
        },
        parameters: {},
      },
    });

  const files = (inputSchema: Doc) => ({ 'components/db.yaml': db, 'components/web.yaml': webConsuming(inputSchema) });

  it('accepts a wire whose two ends fit', async () => {
    await assertClean({
      blueprint: twoNode({ DATABASE_URL: { fromRole: 'db', fromOutput: 'connectionString' } }),
      components: files({ type: 'STRING', semanticType: 'POSTGRES' }),
    });
  });

  it('ERR_UNKNOWN_ROLE when fromRole names no node', async () => {
    await assertReports(
      { blueprint: twoNode({ DATABASE_URL: { fromRole: 'cache', fromOutput: 'connectionString' } }), components: files({ type: 'STRING', semanticType: 'POSTGRES' }) },
      'ERR_UNKNOWN_ROLE',
    );
  });

  it('ERR_UNKNOWN_OUTPUT when fromOutput names no output of the producer', async () => {
    await assertReports(
      { blueprint: twoNode({ DATABASE_URL: { fromRole: 'db', fromOutput: 'dsn' } }), components: files({ type: 'STRING', semanticType: 'POSTGRES' }) },
      'ERR_UNKNOWN_OUTPUT',
    );
  });

  it('ERR_UNKNOWN_INPUT when the map key names no input of the consumer', async () => {
    // A wire whose two ends are each checked and whose consumer end is not is a
    // wire that can be misspelled at one end only.
    await assertReports(
      { blueprint: twoNode({ DATABSE_URL: { fromRole: 'db', fromOutput: 'connectionString' } }), components: files({ type: 'STRING', semanticType: 'POSTGRES' }) },
      'ERR_UNKNOWN_INPUT',
    );
  });

  it('ERR_UNWIRED_REQUIRED_INPUT when a required CONNECTION input has no wire', async () => {
    await assertReports({ blueprint: twoNode({}), components: files({ type: 'STRING', semanticType: 'POSTGRES' }) }, 'ERR_UNWIRED_REQUIRED_INPUT');
  });

  it('ERR_INCOMPATIBLE_TYPE when the two ends declare different types', async () => {
    // No widening in either direction: 5432, 5432.0 and 5.432e3 are one value
    // with three spellings.
    await assertReports(
      { blueprint: twoNode({ DATABASE_URL: { fromRole: 'db', fromOutput: 'connectionString' } }), components: files({ type: 'NUMBER', semanticType: 'POSTGRES' }) },
      'ERR_INCOMPATIBLE_TYPE',
    );
  });

  it('ERR_INCOMPATIBLE_SEMANTIC_TYPE when a constrained consumer meets a differently tagged producer', async () => {
    await assertReports(
      { blueprint: twoNode({ DATABASE_URL: { fromRole: 'db', fromOutput: 'connectionString' } }), components: files({ type: 'STRING', semanticType: 'MYSQL' }) },
      'ERR_INCOMPATIBLE_SEMANTIC_TYPE',
    );
  });

  it('accepts an untagged consumer taking a tagged producer', async () => {
    // A consumer declaring null has said the value is not specific to a backing
    // service, and nothing it receives can contradict that.
    await assertClean({
      blueprint: twoNode({ DATABASE_URL: { fromRole: 'db', fromOutput: 'connectionString' } }),
      components: files({ type: 'STRING' }),
    });
  });

  it('ERR_INCOMPATIBLE_SEMANTIC_TYPE when a tagged consumer meets an untagged producer', async () => {
    const untaggedDb = component({
      spec: {
        workload: { kind: 'SERVICE', source: { type: 'IMAGE', ref: 'postgres:18.2-alpine' }, endpoints: { primary: { containerPort: 5432, protocol: 'TCP', visibility: 'PRIVATE' } } },
        contract: { inputs: {}, outputs: { connectionString: { schema: { type: 'STRING' }, valueFrom: 'DERIVED', value: null } } },
      },
    });
    await assertReports(
      {
        blueprint: twoNode({ DATABASE_URL: { fromRole: 'db', fromOutput: 'connectionString' } }),
        components: { 'components/db.yaml': untaggedDb, 'components/web.yaml': webConsuming({ type: 'STRING', semanticType: 'POSTGRES' }) },
      },
      'ERR_INCOMPATIBLE_SEMANTIC_TYPE',
    );
  });
});

describe('parameters — blueprint §5.2, §5.3', () => {
  const withInput = (input: Doc): Doc =>
    component({
      spec: {
        workload: {
          kind: 'SERVICE',
          source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
          health: { readiness: { path: '/healthz' } },
        },
        contract: { inputs: { adminPassword: input }, outputs: {} },
      },
    });

  const required: Doc = { schema: { type: 'STRING' }, isRequired: true, suppliedBy: 'USER', ui: { label: 'Admin password' } };

  it('ERR_UNBOUND_PARAMETER when a parameter key names no USER input', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} } }, parameters: { legacyMode: { schema: { type: 'STRING' }, isRequired: true } } } }),
        components: { 'components/web.yaml': withInput(required) },
      },
      'ERR_UNBOUND_PARAMETER',
    );
  });

  it('ERR_UNCOVERED_REQUIRED_INPUT when an override forgets a required input', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} } }, parameters: { other: { schema: { type: 'STRING' }, isRequired: true } } } }),
        components: { 'components/web.yaml': withInput({ ...required, schema: { type: 'STRING' } }) },
      },
      'ERR_UNCOVERED_REQUIRED_INPUT',
    );
  });

  it('ERR_UNCOVERED_REQUIRED_INPUT when a parameter names the key but guarantees no value', async () => {
    // isRequired defaults to true on a component input and false on a blueprint
    // parameter, so an override that copies the key and says nothing else has
    // quietly made it optional.
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} } }, parameters: { adminPassword: { schema: { type: 'STRING' } } } } }),
        components: { 'components/web.yaml': withInput(required) },
      },
      'ERR_UNCOVERED_REQUIRED_INPUT',
    );
  });

  it('ERR_INCOMPATIBLE_PARAMETER_TYPE when a parameter and the input it covers disagree', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} } }, parameters: { adminPassword: { schema: { type: 'NUMBER' }, isRequired: true } } } }),
        components: { 'components/web.yaml': withInput(required) },
      },
      'ERR_INCOMPATIBLE_PARAMETER_TYPE',
    );
  });

  it('accepts an override that guarantees the value', async () => {
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} } }, parameters: { adminPassword: { schema: { type: 'STRING', isSensitive: true }, isRequired: true, ui: { label: 'Admin password' } } } } }),
      components: { 'components/web.yaml': withInput(required) },
    });
  });

  it('ERR_CONFLICTING_INPUT_SCHEMA when two nodes declare one key differently', async () => {
    const api = component({
      spec: {
        workload: { kind: 'WORKER', source: { type: 'IMAGE', ref: 'ghcr.io/acme/api:1.2.3' } },
        contract: { inputs: { adminPassword: { schema: { type: 'NUMBER' }, suppliedBy: 'USER', ui: { label: 'Admin password' } } }, outputs: {} },
      },
    });
    await assertReports(
      {
        blueprint: blueprint({
          spec: {
            components: {
              api: { component: './components/api.yaml', size: 'general.standard.small', connections: {} },
              web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} },
            },
            parameters: {},
          },
        }),
        components: { 'components/api.yaml': api, 'components/web.yaml': withInput(required) },
      },
      'ERR_CONFLICTING_INPUT_SCHEMA',
    );
  });

  it('absorbs an identical redeclaration in silence', async () => {
    // Two components that agree on what adminPassword is are not in conflict,
    // and `ui` and `isRequired` take no part in the comparison.
    const api = component({
      spec: {
        workload: { kind: 'WORKER', source: { type: 'IMAGE', ref: 'ghcr.io/acme/api:1.2.3' } },
        contract: { inputs: { adminPassword: { schema: { type: 'STRING' }, isRequired: false, suppliedBy: 'USER', ui: { label: 'Password (api)' } } }, outputs: {} },
      },
    });
    await assertClean({
      blueprint: blueprint({
        spec: {
          components: {
            api: { component: './components/api.yaml', size: 'general.standard.small', connections: {} },
            web: { component: './components/web.yaml', size: 'general.standard.small', connections: {} },
          },
          parameters: {},
        },
      }),
      components: { 'components/api.yaml': api, 'components/web.yaml': withInput(required) },
    });
  });
});
