/**
 * The rules, exercised against deliberately broken items.
 *
 * A suite that passes on a clean corpus proves nothing on its own — it passes
 * just as readily when a rule is silently unreachable. Each case here breaks one
 * thing in a synthetic item and asserts the normative diagnostic fires, so the
 * checks that guard `items/` are themselves guarded.
 *
 * These are not conformance fixtures. `musher-dev/specifications` publishes
 * those, and its corpora are the authority on what an implementation must
 * report; these cases pin the subset this repository enforces.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import YAML from 'yaml';

import { loadItemDocuments, readItem } from './lib/catalog.ts';
import { mediaPathPatternFrom } from './lib/media.ts';
import { KIND_OF, formatAjvErrors, loadSchema, validatorFor, type Family } from './lib/spec-schemas.ts';
import {
  buildContext,
  checkComponentReferences,
  checkConnections,
  checkDescription,
  checkHealthProbes,
  checkIdentity,
  checkImagePinning,
  checkItemType,
  checkMedia,
  checkNodeCompute,
  checkOutputInputReferences,
  checkParameters,
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
  metadata: { slug: 'acme-wiki' },
  spec: {
    itemType: 'BLUEPRINT',
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
  metadata: { slug: 'acme-wiki', revision: 1 },
  spec: {
    components: { web: { componentRef: './components/web.yaml', size: 'general.standard.small', connections: {} } },
    parameters: {},
    ...(over['spec'] as Doc),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'spec')),
});

const component = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'COMPONENT',
  metadata: { revision: 1 },
  spec: {
    workload: {
      type: 'SERVICE',
      source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
      endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
      health: { readiness: { path: '/healthz' } },
    },
    contract: { inputs: {}, outputs: {} },
    ...(over['spec'] as Doc),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'spec')),
});

/** A node this platform does not run — component spec §5.6, after the spec's external-endpoint example. */
const externalModels = (outputs?: Doc): Doc => ({
  specVersion: 'v1',
  kind: 'COMPONENT',
  metadata: { revision: 1 },
  spec: {
    external: { resourceType: 'dev.musher.llm.chat-completions' },
    contract: {
      inputs: {
        baseUrl: { description: 'Base URL of the API this node addresses.', schema: { type: 'STRING', format: 'ENDPOINT_URL', resourceType: 'dev.musher.llm.base-url' } },
        apiKey: { description: 'Bearer credential presented to the service above.', schema: { type: 'STRING', sensitive: true, resourceType: 'dev.musher.llm.api-key' } },
      },
      outputs: outputs ?? {
        baseUrl: { description: 'The base URL, republished.', schema: { type: 'STRING', format: 'ENDPOINT_URL', resourceType: 'dev.musher.llm.base-url' }, valueFrom: 'INPUT', input: 'baseUrl' },
        apiKey: { description: 'The credential, republished.', schema: { type: 'STRING', sensitive: true, resourceType: 'dev.musher.llm.api-key' }, valueFrom: 'INPUT', input: 'apiKey' },
      },
    },
  },
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
    ...checkItemType(context),
    ...checkComponentReferences(context),
    ...checkMedia(context),
    ...checkDescription(context),
    ...checkImagePinning(context),
    ...checkHealthProbes(context),
    ...checkOutputInputReferences(context),
    ...checkNodeCompute(context),
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

/**
 * Every document in a built item against its family's fetched schema. A clean
 * semantic case built on a document the structural phase would reject proves
 * nothing, because a real implementation never reaches `semantic` with it.
 */
async function assertStructurallyValid(root: string): Promise<void> {
  const documents = await loadItemDocuments(readItem(root));
  const all: [Family, (typeof documents)['listing']][] = [
    ['listing', documents.listing],
    ['blueprint', documents.blueprint],
    ...[...documents.components.values()].map((doc) => ['component', doc] as [Family, typeof doc]),
  ];

  for (const [family, document] of all) {
    if (!document) continue;
    assert.ok(document.value);
    assert.equal(document.value['kind'], KIND_OF[family]);
    const validate = await validatorFor(family);
    assert.ok(validate(document.value), `${document.label}:\n${formatAjvErrors(validate.errors)}`);
  }
}

/* ------------------------------------------------------------------- cases */

describe('a well-formed item', () => {
  it('reports nothing', async () => {
    await assertClean({});
  });

  it('validates structurally against all three fetched schemas', async () => {
    // The baseline the broken cases are mutations of must itself be a real item,
    // or a case could "pass" by tripping a rule the mutation never touched.
    await assertStructurallyValid(build({ media: ['media/icon.png'], listing: listing({ spec: { icon: 'media/icon.png' } }) }));
  });
});

describe('identity — blueprint §3, listing §3', () => {
  it('ERR_SLUG_MISMATCH when metadata.slug disagrees with the directory name', async () => {
    await assertReports({ blueprint: blueprint({ metadata: { slug: 'other', revision: 1 } }) }, 'ERR_SLUG_MISMATCH');
  });
});

describe('item type — listing §3, LIST-ITEM-001', () => {
  const componentItem = { blueprint: null, listing: listing({ spec: { itemType: 'COMPONENT' } }) };

  it('ERR_ITEM_TYPE_MISMATCH when a BLUEPRINT listing sits in an item holding no blueprint', async () => {
    // spec listing conformance semantic/015: a composition nobody can install.
    await assertReports({ blueprint: null }, 'ERR_ITEM_TYPE_MISMATCH');
  });

  it('ERR_ITEM_TYPE_MISMATCH when a COMPONENT listing sits beside a blueprint', async () => {
    // spec listing conformance semantic/016.
    await assertReports({ listing: listing({ spec: { itemType: 'COMPONENT' } }) }, 'ERR_ITEM_TYPE_MISMATCH');
  });

  it('accepts a COMPONENT item holding no blueprint', async () => {
    await assertClean(componentItem);
  });

  it('the accepted COMPONENT item is a real item', async () => {
    await assertStructurallyValid(build(componentItem));
  });
});

describe('component references — blueprint §4.1', () => {
  it('ERR_COMPONENT_NOT_FOUND when a reference names no document', async () => {
    await assertReports(
      { blueprint: blueprint({ spec: { components: { web: { componentRef: './components/missing.yaml', size: 'general.standard.small', connections: {} } } } }) },
      'ERR_COMPONENT_NOT_FOUND',
    );
  });

  it('ERR_REFERENCE_ESCAPE when a reference resolves outside the item root', async () => {
    await assertReports(
      { blueprint: blueprint({ spec: { components: { web: { componentRef: '../shared/web.yaml', size: 'general.standard.small', connections: {} } } } }) },
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
      blueprint: blueprint({ spec: { components: { web: { componentRef: './component-web.yaml', size: 'general.standard.small', connections: {} } } } }),
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
        { components: { 'components/web.yaml': component({ spec: { workload: { type: 'SERVICE', source: { type: 'IMAGE', ref: `ghcr.io/acme/web:${tag}` }, endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } }, health: { readiness: { path: '/healthz' } } } } }) } },
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

describe('endpoint resolution — component §5.2, §5.4; blueprint §5.2', () => {
  const workloadWith = (endpoints: Doc, health: Doc = {}, contract?: Doc): Doc =>
    component({
      spec: {
        workload: { type: 'SERVICE', source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' }, endpoints, health },
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

  const covering = (name: string, reference: string): Doc =>
    blueprint({
      spec: {
        components: { web: { componentRef: './components/web.yaml', size: 'general.standard.small', connections: {} } },
        parameters: { [name]: { default: reference, ui: { label: 'Address' } } },
      },
    });

  const needing = (name: string, endpoints: Doc, health: Doc = {}): Doc =>
    workloadWith(endpoints, health, {
      inputs: { [name]: { description: 'An address this deployment answers on.', schema: { type: 'STRING' }, required: false } },
      outputs: {},
    });

  it('ERR_ENDPOINT_NOT_PUBLIC when a self reference reads a private endpoint', async () => {
    // Every path derives an externally reachable address, and a PRIVATE endpoint
    // has none to give.
    await assertReports(
      {
        blueprint: covering('host', '${{ self.publicHostname }}'),
        components: { 'components/web.yaml': needing('host', { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PRIVATE' } }) },
      },
      'ERR_ENDPOINT_NOT_PUBLIC',
    );
  });

  it('ERR_ENDPOINT_NOT_L4 when self.publicAddress reads an HTTP endpoint', async () => {
    // Such an endpoint is published through the shared ingress, so what the path
    // would yield is the ingress address — true, and not the thing an author
    // asking for an edge address is asking for.
    await assertReports(
      {
        blueprint: covering('addr', '${{ self.publicAddress }}'),
        components: {
          'components/web.yaml': needing(
            'addr',
            { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
            { readiness: { path: '/healthz' } },
          ),
        },
      },
      'ERR_ENDPOINT_NOT_L4',
    );
  });

  it('ERR_ENDPOINT_NOT_HTTP when self.publicUrl reads a TCP endpoint', async () => {
    await assertReports(
      {
        blueprint: covering('url', '${{ self.publicUrl }}'),
        components: { 'components/web.yaml': needing('url', { broker: { containerPort: 1883, protocol: 'TCP', visibility: 'PUBLIC' } }) },
      },
      'ERR_ENDPOINT_NOT_HTTP',
    );
  });

  it('ERR_UNKNOWN_ENDPOINT when a third segment names no endpoint of the node', async () => {
    await assertReports(
      {
        blueprint: covering('url', '${{ self.publicUrl.console }}'),
        components: {
          'components/web.yaml': needing(
            'url',
            { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
            { readiness: { path: '/healthz' } },
          ),
        },
      },
      'ERR_UNKNOWN_ENDPOINT',
    );
  });

  it('accepts a reference composed into a longer literal', async () => {
    // The whole requirement is the composition — an OAuth callback is not
    // expressible by a bare address.
    await assertClean({
      blueprint: covering('url', 'https://${{ self.publicHostname }}/oauth/cb'),
      components: {
        'components/web.yaml': needing(
          'url',
          { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
          { readiness: { path: '/healthz' } },
        ),
      },
    });
  });
});

describe('connections — blueprint §4.2', () => {
  const POSTGRES = 'dev.musher.postgresql.connection-string';

  const db = component({
    spec: {
      workload: {
        type: 'SERVICE',
        source: { type: 'IMAGE', ref: 'postgres:18.2-alpine' },
        endpoints: { primary: { containerPort: 5432, protocol: 'TCP', visibility: 'PRIVATE' } },
      },
      contract: {
        inputs: {},
        outputs: { connectionString: { description: 'Mesh-internal DSN of the database.', schema: { type: 'STRING', resourceType: POSTGRES }, valueFrom: 'DERIVED' } },
      },
    },
  });

  // The input is named `databaseUrl`, not `DATABASE_URL`: the environment-variable
  // key is what `target` carries, and the input grammar rejects the other spelling.
  const webConsuming = (inputSchema: Doc, input: Doc = {}): Doc =>
    component({
      spec: {
        workload: {
          type: 'SERVICE',
          source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
          health: { readiness: { path: '/healthz' } },
        },
        contract: {
          inputs: { databaseUrl: { description: 'DSN the app connects with.', schema: inputSchema, ...input, target: { envVarKey: 'DATABASE_URL' } } },
          outputs: {},
        },
      },
    });

  const twoNode = (connections: Doc): Doc =>
    blueprint({
      spec: {
        components: {
          db: { componentRef: './components/db.yaml', size: 'general.standard.small', connections: {} },
          web: { componentRef: './components/web.yaml', size: 'general.standard.small', connections },
        },
        parameters: {},
      },
    });

  const files = (inputSchema: Doc) => ({ 'components/db.yaml': db, 'components/web.yaml': webConsuming(inputSchema) });
  const wired = { databaseUrl: { fromNode: 'db', fromOutput: 'connectionString' } };

  it('accepts a wire whose two ends fit', async () => {
    await assertClean({ blueprint: twoNode(wired), components: files({ type: 'STRING', resourceType: POSTGRES }) });
  });

  it('the accepted wire is a real item', async () => {
    await assertStructurallyValid(build({ blueprint: twoNode(wired), components: files({ type: 'STRING', resourceType: POSTGRES }) }));
  });

  it('ERR_UNKNOWN_NODE when fromNode names no node', async () => {
    await assertReports(
      { blueprint: twoNode({ databaseUrl: { fromNode: 'cache', fromOutput: 'connectionString' } }), components: files({ type: 'STRING', resourceType: POSTGRES }) },
      'ERR_UNKNOWN_NODE',
    );
  });

  it('ERR_UNKNOWN_OUTPUT when fromOutput names no output of the producer', async () => {
    await assertReports(
      { blueprint: twoNode({ databaseUrl: { fromNode: 'db', fromOutput: 'dsn' } }), components: files({ type: 'STRING', resourceType: POSTGRES }) },
      'ERR_UNKNOWN_OUTPUT',
    );
  });

  it('ERR_UNKNOWN_INPUT when the map key names no input of the consumer', async () => {
    // A wire whose two ends are each checked and whose consumer end is not is a
    // wire that can be misspelled at one end only.
    await assertReports(
      { blueprint: twoNode({ databseUrl: { fromNode: 'db', fromOutput: 'connectionString' } }), components: files({ type: 'STRING', resourceType: POSTGRES }) },
      'ERR_UNKNOWN_INPUT',
    );
  });

  it('ERR_INPUT_NOT_CONNECTABLE when a wire fills an input the component republishes — BP-CONN-002', async () => {
    // An INPUT output reading a wired input would depend on an inbound edge, and
    // §4.2's legal cycles would stop being resolvable.
    const relay = component({
      spec: {
        workload: {
          type: 'SERVICE',
          source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
          health: { readiness: { path: '/healthz' } },
        },
        contract: {
          inputs: { databaseUrl: { description: 'DSN the app connects with.', schema: { type: 'STRING', resourceType: POSTGRES } } },
          outputs: { databaseUrl: { description: 'The DSN, republished.', schema: { type: 'STRING', resourceType: POSTGRES }, valueFrom: 'INPUT', input: 'databaseUrl' } },
        },
      },
    });
    await assertReports(
      { blueprint: twoNode(wired), components: { 'components/db.yaml': db, 'components/web.yaml': relay } },
      'ERR_INPUT_NOT_CONNECTABLE',
    );
  });

  it('ERR_UNSATISFIED_REQUIRED_INPUT when a required input is neither wired nor covered', async () => {
    await assertReports({ blueprint: twoNode({}), components: files({ type: 'STRING', resourceType: POSTGRES }) }, 'ERR_UNSATISFIED_REQUIRED_INPUT');
  });

  it('accepts a wire filling an input a parameter could equally have covered', async () => {
    // BP-CONN-001 is withdrawn: any input may be wired, and §5.1 takes a wired
    // one out of coverage so the two never both claim the value.
    await assertClean({
      blueprint: twoNode(wired),
      components: {
        'components/db.yaml': db,
        'components/web.yaml': webConsuming({ type: 'STRING', resourceType: POSTGRES }, { required: true }),
      },
    });
  });

  it('ERR_INCOMPATIBLE_TYPE when the two ends declare different types', async () => {
    // No widening in either direction: 5432, 5432.0 and 5.432e3 are one value
    // with three spellings.
    await assertReports(
      { blueprint: twoNode(wired), components: files({ type: 'NUMBER', resourceType: POSTGRES }) },
      'ERR_INCOMPATIBLE_TYPE',
    );
  });

  it('ERR_INCOMPATIBLE_RESOURCE_TYPE when a constrained consumer meets a differently tagged producer', async () => {
    await assertReports(
      { blueprint: twoNode(wired), components: files({ type: 'STRING', resourceType: 'dev.musher.mysql.connection-string' }) },
      'ERR_INCOMPATIBLE_RESOURCE_TYPE',
    );
  });

  it('accepts an untagged consumer taking a tagged producer', async () => {
    // A consumer declaring none has said the value addresses no particular
    // resource, and nothing it receives can contradict that.
    await assertClean({ blueprint: twoNode(wired), components: files({ type: 'STRING' }) });
  });

  it('ERR_INCOMPATIBLE_RESOURCE_TYPE when a tagged consumer meets an untagged producer', async () => {
    const untaggedDb = component({
      spec: {
        workload: { type: 'SERVICE', source: { type: 'IMAGE', ref: 'postgres:18.2-alpine' }, endpoints: { primary: { containerPort: 5432, protocol: 'TCP', visibility: 'PRIVATE' } } },
        contract: { inputs: {}, outputs: { connectionString: { schema: { type: 'STRING' }, valueFrom: 'DERIVED' } } },
      },
    });
    await assertReports(
      {
        blueprint: twoNode(wired),
        components: { 'components/db.yaml': untaggedDb, 'components/web.yaml': webConsuming({ type: 'STRING', resourceType: POSTGRES }) },
      },
      'ERR_INCOMPATIBLE_RESOURCE_TYPE',
    );
  });
});

describe('external components — component §5.6, §6.2; blueprint §4.3', () => {
  const LLM_BASE_URL = 'dev.musher.llm.base-url';
  const LLM_API_KEY = 'dev.musher.llm.api-key';

  const consumer = component({
    spec: {
      workload: {
        type: 'SERVICE',
        source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
        endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
        health: { readiness: { path: '/healthz' } },
      },
      contract: {
        inputs: {
          llmBaseUrl: { description: 'Base URL the app sends chat requests to.', schema: { type: 'STRING', format: 'ENDPOINT_URL', resourceType: LLM_BASE_URL }, target: { envVarKey: 'OPENAI_API_BASE_URL' } },
          llmApiKey: { description: 'Bearer credential for the API above.', schema: { type: 'STRING', sensitive: true, resourceType: LLM_API_KEY }, target: { envVarKey: 'OPENAI_API_KEY' } },
        },
        outputs: {},
      },
    },
  });

  const composition = (sizes: { models?: string | null; web?: string | null } = {}): Doc =>
    blueprint({
      spec: {
        components: {
          models: { componentRef: './components/models.yaml', size: sizes.models === undefined ? null : sizes.models, connections: {} },
          web: {
            componentRef: './components/web.yaml',
            size: sizes.web === undefined ? 'general.standard.small' : sizes.web,
            connections: {
              llmBaseUrl: { fromNode: 'models', fromOutput: 'baseUrl' },
              llmApiKey: { fromNode: 'models', fromOutput: 'apiKey' },
            },
          },
        },
        parameters: {
          baseUrl: { ui: { label: 'API base URL', order: 1 } },
          apiKey: { ui: { label: 'API key', order: 2 } },
        },
      },
    });

  const files = (models: Doc = externalModels()) => ({ 'components/models.yaml': models, 'components/web.yaml': consumer });

  it('accepts an external node feeding a workload over two wires from one source', async () => {
    // spec blueprint conformance semantic/026: the composition the shape exists for.
    await assertClean({ blueprint: composition(), components: files() });
  });

  it('the accepted composition is a real item', async () => {
    await assertStructurallyValid(build({ blueprint: composition(), components: files() }));
  });

  it('ERR_CONFLICTING_NODE_COMPUTE when a node names compute for a component that runs nothing', async () => {
    await assertReports({ blueprint: composition({ models: 'general.standard.small' }), components: files() }, 'ERR_CONFLICTING_NODE_COMPUTE');
  });

  it('ERR_CONFLICTING_NODE_COMPUTE when a node that runs a workload writes size: null', async () => {
    await assertReports({ blueprint: composition({ web: null }), components: files() }, 'ERR_CONFLICTING_NODE_COMPUTE');
  });

  it('ERR_UNKNOWN_INPUT_REFERENCE when an INPUT output names no input — COMP-OUT-002', async () => {
    const misspelled = externalModels({
      baseUrl: { schema: { type: 'STRING', format: 'ENDPOINT_URL', resourceType: LLM_BASE_URL }, valueFrom: 'INPUT', input: 'baseUrI' },
      apiKey: { schema: { type: 'STRING', sensitive: true, resourceType: LLM_API_KEY }, valueFrom: 'INPUT', input: 'apiKey' },
    });
    await assertReports({ blueprint: composition(), components: files(misspelled) }, 'ERR_UNKNOWN_INPUT_REFERENCE');
  });

  it('accepts a workload republishing one of its own inputs', async () => {
    // spec component conformance structural/067: INPUT is not external-only.
    const republish = component({
      spec: {
        contract: {
          inputs: { adminEmail: { description: 'Email of the bootstrap admin.', schema: { type: 'STRING', format: 'EMAIL' } } },
          outputs: { adminEmail: { description: 'The admin email, republished.', schema: { type: 'STRING', format: 'EMAIL' }, valueFrom: 'INPUT', input: 'adminEmail' } },
        },
      },
    });
    await assertClean({
      blueprint: blueprint({
        spec: {
          components: { web: { componentRef: './components/web.yaml', size: 'general.standard.small', connections: {} } },
          parameters: { adminEmail: { ui: { label: 'Admin email' } } },
        },
      }),
      components: { 'components/web.yaml': republish },
    });
  });
});

describe('parameters — blueprint §5.1, §5.2, §5.3', () => {
  const withInputs = (inputs: Doc): Doc =>
    component({
      spec: {
        workload: {
          type: 'SERVICE',
          source: { type: 'IMAGE', ref: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { containerPort: 8080, protocol: 'HTTP', visibility: 'PUBLIC' } },
          health: { readiness: { path: '/healthz' } },
        },
        contract: { inputs, outputs: {} },
      },
    });

  const secret: Doc = { description: 'Password for the admin account.', schema: { type: 'STRING', sensitive: true }, required: true };
  const withInput = (input: Doc): Doc => withInputs({ adminPassword: input });

  const withParameters = (parameters: Doc): Doc =>
    blueprint({ spec: { components: { web: { componentRef: './components/web.yaml', size: 'general.standard.small', connections: {} } }, parameters } });

  const covering = withParameters({ adminPassword: { ui: { label: 'Admin password' } } });

  it('accepts a form that covers the one input the graph needs', async () => {
    await assertClean({ blueprint: covering, components: { 'components/web.yaml': withInput(secret) } });
  });

  it('the accepted form is a real item', async () => {
    await assertStructurallyValid(build({ blueprint: covering, components: { 'components/web.yaml': withInput(secret) } }));
  });

  it('ERR_UNBOUND_PARAMETER when a parameter key names no input — BP-PARAM-001', async () => {
    // Permitted, these accumulate: last release's `legacyMode` still on the form
    // beside the parameters that do something, with nothing saying which is which.
    await assertReports(
      {
        blueprint: withParameters({ adminPassword: { ui: { label: 'Admin password' } }, legacyMode: { ui: { label: 'Legacy mode' } } }),
        components: { 'components/web.yaml': withInput(secret) },
      },
      'ERR_UNBOUND_PARAMETER',
    );
  });

  it('ERR_UNSATISFIED_REQUIRED_INPUT when the form forgets a required input — BP-PARAM-003', async () => {
    await assertReports(
      {
        blueprint: withParameters({}),
        components: { 'components/web.yaml': withInput(secret) },
      },
      'ERR_UNSATISFIED_REQUIRED_INPUT',
    );
  });

  it('accepts a required input whose schema already declares a default', async () => {
    // It has a value already, and needs nothing supplied.
    await assertClean({
      blueprint: withParameters({}),
      components: { 'components/web.yaml': withInput({ description: 'Role the database is created for.', schema: { type: 'STRING', default: 'postgres' }, required: true }) },
    });
  });

  it('ERR_GENERATED_INPUT_NOT_SENSITIVE when a generated parameter covers a plain input — BP-PARAM-004', async () => {
    // A generator mints a credential, and a value not marked sensitive is echoed
    // back into logs and interfaces.
    await assertReports(
      {
        blueprint: withParameters({ adminPassword: { generator: { byteLength: 32, encoding: 'HEX' }, ui: { label: 'Admin password' } } }),
        components: { 'components/web.yaml': withInput({ description: 'Name of the admin account.', schema: { type: 'STRING' }, required: true }) },
      },
      'ERR_GENERATED_INPUT_NOT_SENSITIVE',
    );
  });

  it('accepts a generated parameter over an input marked sensitive', async () => {
    await assertClean({
      blueprint: withParameters({ adminPassword: { generator: { byteLength: 32, encoding: 'HEX' }, ui: { label: 'Admin password' } } }),
      components: { 'components/web.yaml': withInput(secret) },
    });
  });

  it('ERR_UNKNOWN_NODE when toNode names no node — BP-PARAM-006', async () => {
    // The coverage failure below, caught one step earlier and at the field that
    // caused it: a parameter whose toNode is a typo covers nothing.
    await assertReports(
      {
        blueprint: withParameters({ adminPassword: { toNode: 'wbe', ui: { label: 'Admin password' } } }),
        components: { 'components/web.yaml': withInput(secret) },
      },
      'ERR_UNKNOWN_NODE',
    );
  });

  it('ERR_UNKNOWN_INPUT when toInput names no input — BP-PARAM-007', async () => {
    await assertReports(
      {
        blueprint: withParameters({ adminPassword: { ui: { label: 'Admin password' } }, stripeKey: { toInput: 'apiKey', ui: { label: 'Stripe API key' } } }),
        components: { 'components/web.yaml': withInput(secret) },
      },
      'ERR_UNKNOWN_INPUT',
    );
  });

  it('accepts toInput asking for one input under a name of its own', async () => {
    await assertClean({
      blueprint: withParameters({ stripeKey: { toNode: 'web', toInput: 'adminPassword', ui: { label: 'Stripe API key' } } }),
      components: { 'components/web.yaml': withInput(secret) },
    });
  });

  it('ERR_UNKNOWN_ENUM_MEMBER when an enumLabels key names no member — BP-UI-003', async () => {
    // A typo that changes nothing a validator would otherwise see, and it would
    // stay invisible for the life of the document.
    await assertReports(
      {
        blueprint: withParameters({ logLevel: { ui: { label: 'Log level', enumLabels: { debug: 'Debug', trance: 'Trace' } } } }),
        components: {
          'components/web.yaml': withInputs({
            logLevel: { description: 'How much the workload logs.', schema: { type: 'STRING', enum: ['debug', 'info'], default: 'info' }, required: false },
          }),
        },
      },
      'ERR_UNKNOWN_ENUM_MEMBER',
    );
  });

  it('ERR_MALFORMED_REFERENCE when an unescaped ${{ begins no reference — CORE-REF-001', async () => {
    // Treating it as text carries the mistake through validation and into the
    // deployed thing as the literal characters.
    await assertReports(
      {
        blueprint: withParameters({ adminPassword: { default: 'https://${{ self.publicHostname /cb', ui: { label: 'Admin password' } } }),
        components: { 'components/web.yaml': withInput(secret) },
      },
      'ERR_MALFORMED_REFERENCE',
    );
  });

  it('ERR_UNKNOWN_REFERENCE_NAMESPACE when a reference names a namespace core reserves none of — CORE-REF-002', async () => {
    await assertReports(
      {
        blueprint: withParameters({ adminPassword: { default: '${{ vault.adminPassword }}', ui: { label: 'Admin password' } } }),
        components: { 'components/web.yaml': withInput(secret) },
      },
      'ERR_UNKNOWN_REFERENCE_NAMESPACE',
    );
  });

  it('ERR_REFERENCE_NOT_IN_SCOPE when a reserved namespace is written where only self is admitted — BP-REF-001', async () => {
    // A reserved namespace has no meaning in any document at this line, and
    // reserving it is what keeps it from becoming a name an author can address.
    await assertReports(
      {
        blueprint: withParameters({ adminPassword: { default: '${{ deployment.id }}', ui: { label: 'Admin password' } } }),
        components: { 'components/web.yaml': withInput(secret) },
      },
      'ERR_REFERENCE_NOT_IN_SCOPE',
    );
  });

  it('reads $${{ as a single escape rather than a reference', async () => {
    // Four characters rendering a literal `${{`, not per-`$` doubling.
    await assertClean({
      blueprint: withParameters({ adminPassword: { default: 'literally $${{ self.publicUrl }}', ui: { label: 'Admin password' } } }),
      components: { 'components/web.yaml': withInput(secret) },
    });
  });

  describe('two nodes', () => {
    const api = component({
      spec: {
        workload: { type: 'WORKER', source: { type: 'IMAGE', ref: 'ghcr.io/acme/api:1.2.3' } },
        contract: { inputs: { adminPassword: { description: 'Password the worker authenticates with.', schema: { type: 'STRING', sensitive: true }, required: false } }, outputs: {} },
      },
    });

    const twoNode = (parameters: Doc): Doc =>
      blueprint({
        spec: {
          components: {
            api: { componentRef: './components/api.yaml', size: 'general.standard.small', connections: {} },
            web: { componentRef: './components/web.yaml', size: 'general.standard.small', connections: {} },
          },
          parameters,
        },
      });

    const both = (apiDoc: Doc) => ({ 'components/api.yaml': apiDoc, 'components/web.yaml': withInput(secret) });

    it('absorbs an identical redeclaration in silence', async () => {
      // Two components that agree on what adminPassword is are not in conflict,
      // and `description`, `required` and `target` take no part in the comparison.
      await assertClean({ blueprint: twoNode({ adminPassword: { ui: { label: 'Admin password' } } }), components: both(api) });
    });

    it('ERR_CONFLICTING_INPUT_SCHEMA when one field joins two unequal declarations — BP-PARAM-002', async () => {
      // The second component would receive a value validated against the first
      // one's rules, and nothing fails until deploy time inside its workload.
      const disagreeing = component({
        spec: {
          workload: { type: 'WORKER', source: { type: 'IMAGE', ref: 'ghcr.io/acme/api:1.2.3' } },
          contract: { inputs: { adminPassword: { description: 'Attempts before lockout.', schema: { type: 'NUMBER' } } }, outputs: {} },
        },
      });
      await assertReports(
        { blueprint: twoNode({ adminPassword: { ui: { label: 'Admin password' } } }), components: both(disagreeing) },
        'ERR_CONFLICTING_INPUT_SCHEMA',
      );
    });

    it('ERR_AMBIGUOUS_SELF_REFERENCE when a self default covers two nodes — BP-PARAM-008', async () => {
      // A parameter is one field showing one value, and two nodes have two
      // addresses. `toNode` is how an author says which they meant.
      await assertReports(
        { blueprint: twoNode({ adminPassword: { default: '${{ self.publicUrl }}', ui: { label: 'Admin password' } } }), components: both(api) },
        'ERR_AMBIGUOUS_SELF_REFERENCE',
      );
    });

    it('accepts a self default once toNode makes it single-valued', async () => {
      await assertClean({
        blueprint: twoNode({
          adminPassword: { toNode: 'web', default: '${{ self.publicUrl }}', ui: { label: 'Admin password' } },
          apiPassword: { toNode: 'api', toInput: 'adminPassword', ui: { label: 'Worker password' } },
        }),
        components: both(api),
      });
    });

    it('takes a wired input out of coverage — §5.1', async () => {
      // A node whose adminPassword arrives over a wire and a second whose is
      // typed into the form are both expressible, and the self reference stays
      // single-valued because the wired node is no longer covered.
      const producer = component({
        spec: {
          workload: { type: 'WORKER', source: { type: 'IMAGE', ref: 'ghcr.io/acme/api:1.2.3' } },
          contract: {
            inputs: { adminPassword: { description: 'Password the worker authenticates with.', schema: { type: 'STRING', sensitive: true }, required: true } },
            outputs: { password: { description: 'The password this worker was given, for its peers.', schema: { type: 'STRING', sensitive: true }, valueFrom: 'DERIVED' } },
          },
        },
      });
      await assertClean({
        blueprint: blueprint({
          spec: {
            components: {
              api: { componentRef: './components/api.yaml', size: 'general.standard.small', connections: {} },
              web: {
                componentRef: './components/web.yaml',
                size: 'general.standard.small',
                connections: { adminPassword: { fromNode: 'api', fromOutput: 'password' } },
              },
            },
            parameters: { adminPassword: { ui: { label: 'Worker password' } } },
          },
        }),
        components: { 'components/api.yaml': producer, 'components/web.yaml': withInputs({ adminPassword: secret }) },
      });
    });
  });
});
