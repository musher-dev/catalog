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
import { KIND_OF, formatAjvErrors, validatorFor, type Family } from './lib/spec-schemas.ts';
import { contextForItem, runSemanticChecks, type Diagnostic } from './lib/semantic.ts';

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

/**
 * One node, deploying `components/web.yaml`. The default carries `exposure`
 * because the default component carries a readiness probe: the two belong
 * together, and separating them would make the happy path of COMP-EP-003
 * unreachable.
 */
const node = (over: Doc = {}): Doc => ({
  componentRef: './components/web.yaml',
  compute: { profile: 'general.standard.small' },
  exposure: { primary: 'PUBLIC' },
  bindings: {},
  ...over,
});

const blueprint = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'BLUEPRINT',
  metadata: { slug: 'acme-wiki', revision: 1, description: 'Synthetic rules fixture blueprint.' },
  spec: {
    components: { web: node() },
    parameters: {},
    ...(over['spec'] as Doc),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'spec')),
});

const component = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'COMPONENT',
  metadata: { revision: 1, description: 'Synthetic rules fixture component.' },
  spec: {
    type: 'SERVICE',
    workload: {
      source: { image: 'ghcr.io/acme/web:1.2.3' },
      endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
      health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
    },
    contract: { inputs: {}, outputs: {} },
    ...(over['spec'] as Doc),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'spec')),
});

/** The default component, with a different image — the image-pinning fixtures. */
const withImage = (image: string): Doc =>
  component({ spec: { type: 'SERVICE', workload: { source: { image }, endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } }, health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } } }, contract: { inputs: {}, outputs: {} } } });

/** One input of a workload component, with the two fields every input needs. */
const input = (over: Doc = {}): Doc => ({
  description: 'Synthetic rules fixture input.',
  schema: { type: 'string' },
  target: { envVarKey: 'VALUE' },
  ...over,
});

/**
 * A node this platform does not run — component spec §5.6, after the spec's
 * external-endpoint example. No `workload`, no `target` on any input, and a
 * non-empty `outputs`: an EXTERNAL component exists to publish values.
 */
const externalDatabase = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'COMPONENT',
  metadata: { revision: 1, description: 'Synthetic rules fixture external component.' },
  spec: {
    type: 'EXTERNAL',
    contract: {
      inputs: {
        host: { description: 'Hostname of the managed database server.', schema: { type: 'string' }, presentationHint: 'HOSTNAME' },
      },
      outputs: {
        host: { description: 'Hostname a client connects to.', schema: { type: 'string' }, from: { input: 'host' } },
      },
      ...(over['contract'] as Doc),
    },
  },
});

/**
 * The EXTERNAL node a language model enters through — component spec §6.4,
 * after ADR 0033. One connection input, and three outputs handing its members
 * to whatever wires to them. `apiKey` is sensitive because the member is.
 */
const llmProvider = (over: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'COMPONENT',
  metadata: { revision: 1, description: 'Synthetic rules fixture connection provider.' },
  spec: {
    type: 'EXTERNAL',
    contract: {
      inputs: {
        llm: {
          description: 'Language-model connection this node stands for.',
          connection: { protocol: 'OPENAI_CHAT_COMPLETIONS', capabilities: ['STREAMING'] },
        },
      },
      outputs: {
        baseURL: { description: 'Base URL of the API.', schema: { type: 'string' }, from: { input: 'llm', member: 'baseURL' } },
        apiKey: { description: 'Credential for the API.', schema: { type: 'string' }, sensitive: true, from: { input: 'llm', member: 'apiKey' } },
        model: { description: 'Model the API answers with.', schema: { type: 'string' }, from: { input: 'llm', member: 'model' } },
      },
      ...(over['contract'] as Doc),
    },
  },
});

/**
 * The workload that calls the model. After ADR 0033 it holds three ordinary
 * value inputs and cannot demand a protocol: the external node declares that,
 * and the blueprint wires the two together.
 */
const llmConsumer = (inputs: Doc = {}): Doc => ({
  specVersion: 'v1',
  kind: 'COMPONENT',
  metadata: { revision: 1, description: 'Synthetic rules fixture connection consumer.' },
  spec: {
    type: 'WORKER',
    workload: { source: { image: 'ghcr.io/acme/worker:1.2.3' } },
    contract: {
      inputs: {
        llmBaseURL: input({ description: 'Base URL of the chat-completions API.', target: { envVarKey: 'OPENAI_API_BASE_URL' } }),
        llmAPIKey: input({ description: 'Bearer credential for the API above.', sensitive: true, target: { envVarKey: 'OPENAI_API_KEY' } }),
        llmModel: input({ description: 'Model the service selects.', target: { envVarKey: 'OPENAI_MODEL' } }),
        ...inputs,
      },
      outputs: {},
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
  return runSemanticChecks(await contextForItem(readItem(root)));
}

async function assertReports(fixture: Fixture, code: string): Promise<void> {
  const diagnostics = await diagnose(build(fixture));
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === code),
    `expected ${code}, got ${diagnostics.map((d) => `${d.code} (${d.where})`).join('; ') || 'no diagnostics'}`,
  );
}

/**
 * Every code the item reports, and no other. `assertReports` tolerates extras,
 * which is right for a case proving one rule fires — but a rule whose content
 * is "this code, and nothing else" needs the stronger assertion.
 */
async function assertReportsExactly(fixture: Fixture, codes: string[]): Promise<void> {
  const diagnostics = await diagnose(build(fixture));
  assert.deepEqual(
    [...new Set(diagnostics.map((d) => d.code))].sort(),
    [...codes].sort(),
    diagnostics.map((d) => `${d.code} (${d.where})`).join('; ') || 'no diagnostics',
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
      { blueprint: blueprint({ spec: { components: { web: node({ componentRef: './components/missing.yaml' }) } } }) },
      'ERR_COMPONENT_NOT_FOUND',
    );
  });

  it('ERR_REFERENCE_ESCAPE when a reference resolves outside the item root', async () => {
    await assertReports(
      { blueprint: blueprint({ spec: { components: { web: node({ componentRef: '../shared/web.yaml' }) } } }) },
      'ERR_REFERENCE_ESCAPE',
    );
  });

  it('ERR_UNREFERENCED_COMPONENT when a document sits beside the one in use', async () => {
    await assertReports(
      { components: { 'components/web.yaml': component(), 'components/web-legacy.yaml': component() } },
      'ERR_UNREFERENCED_COMPONENT',
    );
  });

  it('ERR_INVALID_DEPENDENCY when the referenced document is not a valid component — blueprint §10', async () => {
    const broken = component();
    delete (broken['spec'] as Doc)['workload'];
    await assertReports({ components: { 'components/web.yaml': broken } }, 'ERR_INVALID_DEPENDENCY');
  });

  it('finds a component document outside components/, which the spec permits', async () => {
    // The local form imposes no directory layout: ./component-web.yaml and
    // ./components/web.yaml are equally valid.
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: node({ componentRef: './component-web.yaml' }) } } }),
      components: { 'component-web.yaml': component() },
    });
  });
});

describe('media — listing §5', () => {
  it('ERR_MEDIA_NOT_FOUND when a declared path names no file', async () => {
    await assertReports({ listing: listing({ spec: { icon: 'media/icon.png' } }) }, 'ERR_MEDIA_NOT_FOUND');
  });

  it('ERR_DUPLICATE_MEDIA_PATH when one screenshot is declared twice', async () => {
    await assertReports(
      {
        media: ['media/overview.png'],
        listing: listing({
          spec: { screenshots: [{ file: 'media/overview.png' }, { file: 'media/overview.png' }] },
        }),
      },
      'ERR_DUPLICATE_MEDIA_PATH',
    );
  });

  it('accepts two screenshots sharing a basename under different directories', async () => {
    // LIST-MEDIA-003 keys on the whole item-relative path, so these are two
    // gallery entries rather than one collision.
    await assertClean({
      media: ['media/desktop/overview.png', 'media/mobile/overview.png'],
      listing: listing({
        spec: { screenshots: [{ file: 'media/desktop/overview.png' }, { file: 'media/mobile/overview.png' }] },
      }),
    });
  });

  it('accepts an icon that exists', async () => {
    await assertClean({ media: ['media/icon.png'], listing: listing({ spec: { icon: 'media/icon.png' } }) });
  });

  it('ERR_PATH_ESCAPE when the icon is a dangling symlink pointing outside the item — LIST-MEDIA-002', async () => {
    // The target need not exist: containment is a property of where the link
    // points, not of whether anything is there (conformance listing 004).
    const root = build({ listing: listing({ spec: { icon: 'media/icon.png' } }) });
    fs.mkdirSync(path.join(root, 'media'), { recursive: true });
    fs.symlinkSync('../../../secrets.png', path.join(root, 'media', 'icon.png'));
    const diagnostics = await diagnose(root);
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code === 'ERR_PATH_ESCAPE'),
      `expected ERR_PATH_ESCAPE, got ${diagnostics.map((d) => d.code).join(', ') || 'no diagnostics'}`,
    );
  });
});

describe('workload contract — component §5.3, §5.5, §5.7', () => {
  const withWorkload = (workload: Doc, inputs: Doc = {}): Doc =>
    component({
      spec: {
        type: 'SERVICE',
        workload: {
          source: { image: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
          health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
          ...workload,
        },
        contract: { inputs, outputs: {} },
      },
    });

  const job = (cron: string): Doc =>
    component({
      spec: {
        type: 'JOB',
        workload: { source: { image: 'ghcr.io/acme/backup:1.2.3' }, command: ['/bin/backup'], schedule: { cron } },
        contract: { inputs: {}, outputs: {} },
      },
    });

  it('ERR_CONFLICTING_ENV_KEY when two inputs target one name — COMP-ENVVAR-002', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': withWorkload({}, {
            first: input({ required: false, target: { envVarKey: 'VALUE' } }),
            second: input({ required: false, target: { envVarKey: 'VALUE' } }),
          }),
        },
      },
      'ERR_CONFLICTING_ENV_KEY',
    );
  });

  it('ERR_INVALID_MOUNT when one volume mounts inside another — §5.5', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ volumes: { data: { sizeGiB: 1 }, nested: { sizeGiB: 1 } } }) } } }),
        components: {
          'components/web.yaml': withWorkload({
            volumes: { data: { mountPath: '/data', minSizeGiB: 1 }, nested: { mountPath: '/data/cache', minSizeGiB: 1 } },
          }),
        },
      },
      'ERR_INVALID_MOUNT',
    );
  });

  it('ERR_INVALID_MOUNT when a mount path is not canonical — §5.5', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ volumes: { data: { sizeGiB: 1 } } }) } } }),
        components: { 'components/web.yaml': withWorkload({ volumes: { data: { mountPath: '/var/lib/../data/', minSizeGiB: 1 } } }) },
      },
      'ERR_INVALID_MOUNT',
    );
  });

  it('accepts sibling mounts sharing a name prefix — §5.5', async () => {
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: node({ volumes: { data: { sizeGiB: 1 }, other: { sizeGiB: 1 } } }) } } }),
      components: {
        'components/web.yaml': withWorkload({
          volumes: { data: { mountPath: '/data', minSizeGiB: 1 }, other: { mountPath: '/database', minSizeGiB: 1 } },
        }),
      },
    });
  });

  for (const cron of ['99 * * * *', '* * * JAN *', '* * * * 7', '* * 5-1 * *', '*/0 * * * *']) {
    it(`ERR_INVALID_SCHEDULE for ${JSON.stringify(cron)} — COMP-JOB-002`, async () => {
      await assertReports(
        { blueprint: blueprint({ spec: { components: { web: node({ exposure: {} }) } } }), components: { 'components/web.yaml': job(cron) } },
        'ERR_INVALID_SCHEDULE',
      );
    });
  }

  it('accepts lists, ranges and steps — COMP-JOB-002', async () => {
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: node({ exposure: {} }) } } }),
      components: { 'components/web.yaml': job('*/15 9-17  1,15 1-12/3\t1-5') },
    });
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

describe('image references — COMP-SRC-002', () => {
  // ADR 0033 §3 retired the floating-tag blocklist: an image reference follows
  // Docker, so a bare name means `latest` and every tag is accepted. This is the
  // inverse of the rule this suite used to hold, and it is here so the rule
  // cannot quietly come back — a tag was never a pin, and only a digest
  // identifies content.
  for (const ref of ['ghcr.io/acme/web:latest', 'ghcr.io/acme/web:main', 'nginx', 'localhost:5000/nginx']) {
    it(`accepts ${ref}`, async () => {
      await assertClean({ components: { 'components/web.yaml': withImage(ref) } });
    });
  }
});

describe('endpoints — component §5.2, §5.4; blueprint §4.3', () => {
  const workloadWith = (endpoints: Doc, health: Doc = {}, contract?: Doc, type = 'SERVICE'): Doc =>
    component({
      spec: {
        type,
        workload: { source: { image: 'ghcr.io/acme/web:1.2.3' }, endpoints, health },
        contract: contract ?? { inputs: {}, outputs: {} },
      },
    });

  const httpEndpoint = { primary: { targetPort: 8080, protocol: 'HTTP' } };
  const tcpEndpoint = { primary: { targetPort: 5432, protocol: 'TCP' } };
  const readiness = { readiness: { http: { endpoint: 'primary', path: '/healthz' } } };

  it('ERR_UNKNOWN_ENDPOINT when a probe names an endpoint the workload does not declare', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(httpEndpoint, { readiness: { http: { endpoint: 'console', path: '/healthz' } } }),
        },
      },
      'ERR_UNKNOWN_ENDPOINT',
    );
  });

  it('ERR_ENDPOINT_NOT_HTTP when a probe names a TCP endpoint', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ exposure: {} }) } } }),
        components: {
          'components/web.yaml': workloadWith(tcpEndpoint, { readiness: { http: { endpoint: 'primary', path: '/healthz' } } }),
        },
      },
      'ERR_ENDPOINT_NOT_HTTP',
    );
  });

  it('ERR_ENDPOINT_NOT_HTTP when a probe names a WS endpoint', async () => {
    // WS and GRPC publish a URL, so they are HTTP-family for addressing — but
    // neither answers a plain GET, so neither is a probe target.
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(
            { primary: { targetPort: 8080, protocol: 'WS' } },
            { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
          ),
        },
      },
      'ERR_ENDPOINT_NOT_HTTP',
    );
  });

  it('ERR_UNKNOWN_ENDPOINT when an endpoint output names no endpoint', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(httpEndpoint, readiness, {
            inputs: {},
            outputs: { address: { description: 'An address.', schema: { type: 'string' }, from: { endpoint: 'console', property: 'privateAddress' } } },
          }),
        },
      },
      'ERR_UNKNOWN_ENDPOINT',
    );
  });

  it('ERR_UNKNOWN_ADDRESS_PROPERTY when an endpoint output names no property', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(httpEndpoint, readiness, {
            inputs: {},
            outputs: { address: { description: 'An address.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'publicIp' } } },
          }),
        },
      },
      'ERR_UNKNOWN_ADDRESS_PROPERTY',
    );
  });

  it('ERR_ENDPOINT_NOT_HTTP when publicURL reads a TCP endpoint', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ exposure: { primary: 'PUBLIC' } }) } } }),
        components: {
          'components/web.yaml': workloadWith(tcpEndpoint, {}, {
            inputs: {},
            outputs: { url: { description: 'A URL.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'publicURL' } } },
          }),
        },
      },
      'ERR_ENDPOINT_NOT_HTTP',
    );
  });

  it('ERR_ENDPOINT_NOT_L4 when publicAddress reads an HTTP endpoint', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': workloadWith(httpEndpoint, readiness, {
            inputs: {},
            outputs: { address: { description: 'An address.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'publicAddress' } } },
          }),
        },
      },
      'ERR_ENDPOINT_NOT_L4',
    );
  });

  it('ERR_ENDPOINT_NOT_PUBLIC when an output reads a public property of an endpoint the node keeps private', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ exposure: {} }) } } }),
        components: {
          'components/web.yaml': workloadWith(httpEndpoint, readiness, {
            inputs: {},
            outputs: { url: { description: 'A URL.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'publicURL' } } },
          }),
        },
      },
      'ERR_ENDPOINT_NOT_PUBLIC',
    );
  });

  it('ERR_ENDPOINT_NOT_EXPOSABLE when a WORKER output reads a public property', async () => {
    // COMP-TYPE-003. No node exposes a worker, so no public property of one ever
    // has a value — the component can decide this without a blueprint.
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ exposure: {} }) } } }),
        components: {
          'components/web.yaml': workloadWith(httpEndpoint, {}, {
            inputs: {},
            outputs: { url: { description: 'A URL.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'publicURL' } } },
          }, 'WORKER'),
        },
      },
      'ERR_ENDPOINT_NOT_EXPOSABLE',
    );
  });

  it('accepts an output reading a private property of a private endpoint', async () => {
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: node({ exposure: {} }) } } }),
      components: {
        'components/web.yaml': workloadWith(tcpEndpoint, {}, {
          inputs: {},
          outputs: { address: { description: 'An address.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'privateAddress' } } },
        }),
      },
    });
  });
});

describe('output templates — component §6.2, COMP-REF-001', () => {
  const withTemplate = (template: string, endpoints: Doc = { primary: { targetPort: 8080, protocol: 'HTTP' } }): Doc =>
    component({
      spec: {
        type: 'SERVICE',
        workload: { source: { image: 'ghcr.io/acme/web:1.2.3' }, endpoints, health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } } },
        contract: {
          inputs: {},
          outputs: { callback: { description: 'A callback URL.', schema: { type: 'string' }, from: { template } } },
        },
      },
    });

  it('accepts a template reading one of its own endpoints', async () => {
    await assertClean({ components: { 'components/web.yaml': withTemplate('https://${{ self.endpoints.primary.publicHostname }}/oauth/cb') } });
  });

  it('ERR_UNKNOWN_ENDPOINT for the withdrawn property-first order', async () => {
    // `${{ self.publicHostname.primary }}` is the property-first order v1 does
    // not have. It lands here as an endpoint named `publicHostname`.
    await assertReports(
      { components: { 'components/web.yaml': withTemplate('https://${{ self.publicHostname.primary }}/cb') } },
      'ERR_UNKNOWN_ENDPOINT',
    );
  });

  it('ERR_UNKNOWN_ENDPOINT when a template names an endpoint the component does not declare', async () => {
    await assertReports(
      { components: { 'components/web.yaml': withTemplate('https://${{ self.endpoints.console.publicHostname }}/cb') } },
      'ERR_UNKNOWN_ENDPOINT',
    );
  });

  it('ERR_REFERENCE_NOT_IN_SCOPE when a template reads a namespace other than self', async () => {
    await assertReports(
      { components: { 'components/web.yaml': withTemplate('https://${{ variables.cloud.region }}/cb') } },
      'ERR_REFERENCE_NOT_IN_SCOPE',
    );
  });

  it('ERR_UNKNOWN_REFERENCE_NAMESPACE for the withdrawn config namespace', async () => {
    await assertReports(
      { components: { 'components/web.yaml': withTemplate('https://${{ config.llm.baseURL }}/cb') } },
      'ERR_UNKNOWN_REFERENCE_NAMESPACE',
    );
  });

  it('ERR_MALFORMED_REFERENCE when an unescaped ${{ begins no reference — CORE-REF-001', async () => {
    await assertReports({ components: { 'components/web.yaml': withTemplate('https://${{ nope /cb') } }, 'ERR_MALFORMED_REFERENCE');
  });

  it('reads $${{ as a single escape rather than a reference', async () => {
    await assertClean({ components: { 'components/web.yaml': withTemplate('literal $${{ self.endpoints.primary.publicHostname }}') } });
  });
});

describe('node compute — blueprint §4.3, BP-NODE-001/002', () => {
  it('ERR_CONFLICTING_NODE_COMPUTE when a node that runs a workload names no compute', async () => {
    await assertReports(
      { blueprint: blueprint({ spec: { components: { web: { componentRef: './components/web.yaml', exposure: { primary: 'PUBLIC' }, bindings: {} } } } }) },
      'ERR_CONFLICTING_NODE_COMPUTE',
    );
  });

  it('ERR_CONFLICTING_NODE_COMPUTE when a node names compute for a component that runs nothing', async () => {
    await assertReports(
      {
        blueprint: blueprint({
          spec: {
            parameters: { host: { ui: { label: 'Host' } } },
            components: {
              db: { componentRef: './components/db.yaml', compute: { profile: 'general.standard.small' }, bindings: { host: { parameter: 'host' } } },
              web: node(),
            },
          },
        }),
        components: { 'components/web.yaml': component(), 'components/db.yaml': externalDatabase() },
      },
      'ERR_CONFLICTING_NODE_COMPUTE',
    );
  });

  it('accepts an EXTERNAL node with no compute feeding a workload', async () => {
    await assertClean({
      blueprint: blueprint({
        spec: {
          parameters: { host: { ui: { label: 'Host' } } },
          components: {
            db: { componentRef: './components/db.yaml', bindings: { host: { parameter: 'host' } } },
            web: node({ bindings: { dbHost: { node: 'db', output: 'host' } } }),
          },
        },
      }),
      components: {
        'components/web.yaml': component({
          spec: {
            type: 'SERVICE',
            workload: { source: { image: 'ghcr.io/acme/web:1.2.3' }, endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } }, health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } } },
            contract: { inputs: { dbHost: input({ target: { envVarKey: 'DB_HOST' } }) }, outputs: {} },
          },
        }),
        'components/db.yaml': externalDatabase(),
      },
    });
  });

  it('the accepted composition is a real item', async () => {
    await assertStructurallyValid(
      build({
        blueprint: blueprint({
          spec: {
            parameters: { host: { ui: { label: 'Host' } } },
            components: {
              db: { componentRef: './components/db.yaml', bindings: { host: { parameter: 'host' } } },
              web: node(),
            },
          },
        }),
        components: { 'components/web.yaml': component(), 'components/db.yaml': externalDatabase() },
      }),
    );
  });

  it('ERR_UNKNOWN_INPUT_REFERENCE when an input output names no input — COMP-OUT-002', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { parameters: { host: { ui: { label: 'Host' } } }, components: { db: { componentRef: './components/db.yaml', bindings: { host: { parameter: 'host' } } }, web: node() } } }),
        components: {
          'components/web.yaml': component(),
          'components/db.yaml': externalDatabase({ contract: { inputs: { host: { description: 'A host.', schema: { type: 'string' } } }, outputs: { host: { description: 'A host.', schema: { type: 'string' }, from: { input: 'hostname' } } } } }),
        },
      },
      'ERR_UNKNOWN_INPUT_REFERENCE',
    );
  });
});

describe('storage — blueprint §4.3', () => {
  const withVolume = (minSizeGiB = 10): Doc =>
    component({
      spec: {
        type: 'SERVICE',
        workload: {
          source: { image: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
          health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
          volumes: { data: { mountPath: '/var/lib/data', minSizeGiB } },
        },
        contract: { inputs: {}, outputs: {} },
      },
    });

  it('ERR_INVALID_VOLUME_ALLOCATION when a declared volume is allocated nothing', async () => {
    await assertReports({ components: { 'components/web.yaml': withVolume() } }, 'ERR_INVALID_VOLUME_ALLOCATION');
  });

  it('ERR_INVALID_VOLUME_ALLOCATION when an allocation names no declared volume', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ volumes: { data: { sizeGiB: 10 }, cache: { sizeGiB: 1 } } }) } } }),
        components: { 'components/web.yaml': withVolume() },
      },
      'ERR_INVALID_VOLUME_ALLOCATION',
    );
  });

  it('ERR_INVALID_VOLUME_ALLOCATION when an allocation sits below the component minimum', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { web: node({ volumes: { data: { sizeGiB: 4 } } }) } } }),
        components: { 'components/web.yaml': withVolume(10) },
      },
      'ERR_INVALID_VOLUME_ALLOCATION',
    );
  });

  it('accepts an allocation at the component minimum', async () => {
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: node({ volumes: { data: { sizeGiB: 10 } } }) } } }),
      components: { 'components/web.yaml': withVolume(10) },
    });
  });
});

describe('exposure — blueprint §4.3, COMP-EP-003', () => {
  it('ERR_UNKNOWN_ENDPOINT when exposure names an endpoint the component does not declare', async () => {
    await assertReports({ blueprint: blueprint({ spec: { components: { web: node({ exposure: { console: 'PUBLIC' } }) } } }) }, 'ERR_UNKNOWN_ENDPOINT');
  });

  it('ERR_READINESS_REQUIRED when a PUBLIC HTTP endpoint has no readiness probe', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': component({
            spec: {
              type: 'SERVICE',
              workload: { source: { image: 'ghcr.io/acme/web:1.2.3' }, endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } } },
              contract: { inputs: {}, outputs: {} },
            },
          }),
        },
      },
      'ERR_READINESS_REQUIRED',
    );
  });

  it('ERR_ENDPOINT_NOT_EXPOSABLE when a WORKER endpoint is exposed PUBLIC', async () => {
    // Rejected even with a readiness probe: a worker is not request-driven, so
    // there is nothing for public traffic to reach.
    await assertReports(
      {
        components: {
          'components/web.yaml': component({
            spec: {
              type: 'WORKER',
              workload: {
                source: { image: 'ghcr.io/acme/web:1.2.3' },
                endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
                health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
              },
              contract: { inputs: {}, outputs: {} },
            },
          }),
        },
      },
      'ERR_ENDPOINT_NOT_EXPOSABLE',
    );
  });

  it('accepts a WORKER keeping its endpoint private', async () => {
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: node({ exposure: {} }) } } }),
      components: {
        'components/web.yaml': component({
          spec: {
            type: 'WORKER',
            workload: {
              source: { image: 'ghcr.io/acme/web:1.2.3' },
              endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
              health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
            },
            contract: { inputs: {}, outputs: {} },
          },
        }),
      },
    });
  });
});

describe('bindings — blueprint §4.2', () => {
  const producer = component({
    spec: {
      type: 'SERVICE',
      workload: {
        source: { image: 'ghcr.io/acme/db:1.2.3' },
        endpoints: { primary: { targetPort: 5432, protocol: 'TCP' } },
      },
      contract: {
        inputs: {},
        outputs: { address: { description: 'The address.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'privateAddress' } } },
      },
    },
  });

  const consumer = (schema: Doc = { type: 'string' }): Doc =>
    component({
      spec: {
        type: 'SERVICE',
        workload: {
          source: { image: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
          health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
        },
        contract: { inputs: { dbAddress: input({ schema, target: { envVarKey: 'DB_ADDRESS' } }) }, outputs: {} },
      },
    });

  const wired = (binding: Doc = { node: 'db', output: 'address' }, schema?: Doc): Fixture => ({
    blueprint: blueprint({
      spec: {
        components: {
          db: { componentRef: './components/db.yaml', compute: { profile: 'general.standard.small' }, exposure: {}, bindings: {} },
          web: node({ bindings: { dbAddress: binding } }),
        },
      },
    }),
    components: { 'components/web.yaml': consumer(schema), 'components/db.yaml': producer },
  });

  it('accepts a binding whose two ends fit', async () => {
    await assertClean(wired());
  });

  it('the accepted binding is a real item', async () => {
    await assertStructurallyValid(build(wired()));
  });

  it('ERR_UNKNOWN_NODE when a binding names no node — BP-PARAM-006', async () => {
    await assertReports(wired({ node: 'cache', output: 'address' }), 'ERR_UNKNOWN_NODE');
  });

  it('ERR_UNKNOWN_OUTPUT when a binding names no output of the producer — BP-PARAM-006', async () => {
    await assertReports(wired({ node: 'db', output: 'connectionString' }), 'ERR_UNKNOWN_OUTPUT');
  });

  it('ERR_UNKNOWN_INPUT when the map key names no input of the consumer — BP-PARAM-007', async () => {
    await assertReports(
      {
        ...wired(),
        blueprint: blueprint({
          spec: {
            components: {
              db: { componentRef: './components/db.yaml', compute: { profile: 'general.standard.small' }, exposure: {}, bindings: {} },
              web: node({ bindings: { databaseAddress: { node: 'db', output: 'address' } } }),
            },
          },
        }),
      },
      'ERR_UNKNOWN_INPUT',
    );
  });

  it('ERR_UNKNOWN_PARAMETER when a binding names no declared parameter — BP-PARAM-007', async () => {
    await assertReports(wired({ parameter: 'databaseAddress' }), 'ERR_UNKNOWN_PARAMETER');
  });

  it('ERR_INCOMPATIBLE_TYPE when the two ends declare different types — BP-PARAM-008', async () => {
    await assertReports(wired({ node: 'db', output: 'address' }, { type: 'boolean' }), 'ERR_INCOMPATIBLE_TYPE');
  });

  it('accepts an integer output supplying a number input — BP-PARAM-008', async () => {
    // The one widening the rule grants. The reverse is not granted.
    await assertClean({
      blueprint: blueprint({
        spec: {
          components: {
            db: { componentRef: './components/db.yaml', compute: { profile: 'general.standard.small' }, exposure: {}, bindings: {} },
            web: node({ bindings: { dbAddress: { node: 'db', output: 'port' } } }),
          },
        },
      }),
      components: {
        'components/web.yaml': consumer({ type: 'number' }),
        'components/db.yaml': component({
          spec: {
            type: 'SERVICE',
            workload: { source: { image: 'ghcr.io/acme/db:1.2.3' }, endpoints: { primary: { targetPort: 5432, protocol: 'TCP' } } },
            contract: { inputs: {}, outputs: { port: { description: 'The port.', schema: { type: 'integer' }, from: { endpoint: 'primary', property: 'privatePort' } } } },
          },
        }),
      },
    });
  });

  it('accepts a node binding its own endpoint output', async () => {
    // A discovery dependency, not a value cycle: an endpoint address is
    // allocated before anything runs, so the chain ends at the endpoint.
    await assertClean({
      blueprint: blueprint({ spec: { components: { web: node({ bindings: { ownURL: { node: 'web', output: 'publicURL' } } }) } } }),
      components: {
        'components/web.yaml': component({
          spec: {
            type: 'SERVICE',
            workload: {
              source: { image: 'ghcr.io/acme/web:1.2.3' },
              endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
              health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
            },
            contract: {
              inputs: { ownURL: input({ target: { envVarKey: 'PUBLIC_URL' } }) },
              outputs: { publicURL: { description: 'Its own URL.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'publicURL' } } },
            },
          },
        }),
      },
    });
  });
});

describe('value cycles — blueprint §4.2, BP-CONN-002', () => {
  const relay = component({
    spec: {
      type: 'WORKER',
      workload: { source: { image: 'ghcr.io/acme/relay:1.2.3' } },
      contract: {
        inputs: { upstream: input({ target: { envVarKey: 'UPSTREAM' } }) },
        outputs: { forwarded: { description: 'The received value.', schema: { type: 'string' }, from: { input: 'upstream' } } },
      },
    },
  });
  const relayNode = (from: string): Doc => node({ componentRef: './components/relay.yaml', exposure: {}, bindings: { upstream: { node: from, output: 'forwarded' } } });

  it('ERR_VALUE_CYCLE when three nodes feed each other in a ring', async () => {
    await assertReports(
      {
        blueprint: blueprint({ spec: { components: { a: relayNode('c'), b: relayNode('a'), c: relayNode('b') } } }),
        components: { 'components/relay.yaml': relay },
      },
      'ERR_VALUE_CYCLE',
    );
  });

  it('accepts two nodes reading each other\'s addresses — a discovery loop, not a value cycle', async () => {
    const peer = component({
      spec: {
        type: 'SERVICE',
        workload: {
          source: { image: 'ghcr.io/acme/peer:1.2.3' },
          endpoints: { primary: { targetPort: 8080, protocol: 'TCP' } },
        },
        contract: {
          inputs: { peerAddress: input({ target: { envVarKey: 'PEER' } }) },
          outputs: { address: { description: 'The address.', schema: { type: 'string' }, from: { endpoint: 'primary', property: 'privateAddress' } } },
        },
      },
    });
    const peerNode = (other: string): Doc =>
      node({ componentRef: './components/peer.yaml', exposure: {}, bindings: { peerAddress: { node: other, output: 'address' } } });
    await assertClean({
      blueprint: blueprint({ spec: { components: { a: peerNode('b'), b: peerNode('a') } } }),
      components: { 'components/peer.yaml': peer },
    });
  });
});

describe('connections — component §6.4, blueprint §5.3', () => {
  /**
   * The shape ADR 0033 settles on: an EXTERNAL node holding the connection,
   * and the workload wired to its three outputs. The external node carries no
   * `compute` — it runs nothing — and both component files are referenced, so
   * neither is unreferenced.
   */
  const composed = (over: { consumerInputs?: Doc; blueprintSpec?: Doc; provider?: Doc } = {}): Fixture => ({
    blueprint: blueprint({
      spec: over.blueprintSpec ?? {
        parameters: { llm: { from: '${{ connections.llm.default }}', ui: { label: 'Language model' } } },
        components: {
          llm: { componentRef: './components/llm.yaml', bindings: { llm: { parameter: 'llm' } } },
          worker: {
            componentRef: './components/web.yaml',
            compute: { profile: 'general.standard.small' },
            bindings: {
              llmBaseURL: { node: 'llm', output: 'baseURL' },
              llmAPIKey: { node: 'llm', output: 'apiKey' },
              llmModel: { node: 'llm', output: 'model' },
            },
          },
        },
      },
    }),
    components: {
      'components/web.yaml': llmConsumer(over.consumerInputs),
      'components/llm.yaml': llmProvider(over.provider),
    },
  });

  it('accepts a language model reached through an external node', async () => {
    await assertClean(composed());
  });

  it('the accepted composition is a real item', async () => {
    await assertStructurallyValid(build(composed()));
  });

  /* --- COMP-OUT-004: a connection publishes members, a value input does not - */

  it('ERR_UNKNOWN_INPUT_REFERENCE when an output forwards a connection and names no member', async () => {
    await assertReports(
      composed({
        provider: {
          contract: {
            inputs: { llm: { description: 'Connection.', connection: { protocol: 'OPENAI_CHAT_COMPLETIONS' } } },
            outputs: { baseURL: { description: 'Base URL.', schema: { type: 'string' }, from: { input: 'llm' } } },
          },
        },
      }),
      'ERR_UNKNOWN_INPUT_REFERENCE',
    );
  });

  it('ERR_UNKNOWN_INPUT_REFERENCE when an output names a member of a value input', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': externalDatabase({
            contract: {
              inputs: { host: { description: 'Hostname.', schema: { type: 'string' } } },
              outputs: { host: { description: 'Hostname.', schema: { type: 'string' }, from: { input: 'host', member: 'baseURL' } } },
            },
          }),
        },
      },
      'ERR_UNKNOWN_INPUT_REFERENCE',
    );
  });

  /* --- COMP-OUT-003: every declared output must be producible -------------- */

  it('ERR_OUTPUT_NOT_PRODUCIBLE when an output forwards an optional input with no default', async () => {
    await assertReports(
      {
        components: {
          'components/web.yaml': externalDatabase({
            contract: {
              inputs: { host: { description: 'Hostname.', schema: { type: 'string' }, required: false } },
              outputs: { host: { description: 'Hostname.', schema: { type: 'string' }, from: { input: 'host' } } },
            },
          }),
        },
      },
      'ERR_OUTPUT_NOT_PRODUCIBLE',
    );
  });

  it('accepts an optional input carrying a default as an output origin', async () => {
    await assertClean({
      blueprint: blueprint({
        spec: { components: { web: { componentRef: './components/web.yaml', bindings: {} } }, parameters: {} },
      }),
      components: {
        'components/web.yaml': externalDatabase({
          contract: {
            inputs: { host: { description: 'Hostname.', schema: { type: 'string' }, required: false, default: 'db.internal' } },
            outputs: { host: { description: 'Hostname.', schema: { type: 'string' }, from: { input: 'host' } } },
          },
        }),
      },
    });
  });

  /* --- BP-CONNECTION-001, read from both sides ----------------------------- */

  const boundBy = (binding: Doc, parameters?: Doc): Fixture =>
    composed({
      blueprintSpec: {
        parameters: parameters ?? { llm: { from: '${{ connections.llm.default }}', ui: { label: 'Language model' } } },
        components: {
          llm: { componentRef: './components/llm.yaml', bindings: { llm: binding } },
          worker: {
            componentRef: './components/web.yaml',
            compute: { profile: 'general.standard.small' },
            bindings: {
              llmBaseURL: { node: 'llm', output: 'baseURL' },
              llmAPIKey: { node: 'llm', output: 'apiKey' },
              llmModel: { node: 'llm', output: 'model' },
            },
          },
        },
      },
    });

  it('ERR_INVALID_CONNECTION_BINDING for a literal value bound to a connection input', async () => {
    await assertReports(boundBy({ value: 'https://api.example.com/v1' }), 'ERR_INVALID_CONNECTION_BINDING');
  });

  it('ERR_INVALID_CONNECTION_BINDING for a node output bound to a connection input', async () => {
    await assertReports(boundBy({ node: 'worker', output: 'anything' }), 'ERR_INVALID_CONNECTION_BINDING');
  });

  it('ERR_INVALID_CONNECTION_BINDING when a connection input names a variables parameter', async () => {
    await assertReports(
      boundBy({ parameter: 'llm' }, { llm: { from: '${{ variables.llm.default }}', ui: { label: 'Language model' } } }),
      'ERR_INVALID_CONNECTION_BINDING',
    );
  });

  it('ERR_INVALID_CONNECTION_BINDING when a connection parameter is bound to a value input', async () => {
    await assertReports(
      composed({
        blueprintSpec: {
          parameters: { llm: { from: '${{ connections.llm.default }}', ui: { label: 'Language model' } } },
          components: {
            llm: { componentRef: './components/llm.yaml', bindings: { llm: { parameter: 'llm' } } },
            worker: {
              componentRef: './components/web.yaml',
              compute: { profile: 'general.standard.small' },
              bindings: {
                llmBaseURL: { parameter: 'llm' },
                llmAPIKey: { node: 'llm', output: 'apiKey' },
                llmModel: { node: 'llm', output: 'model' },
              },
            },
          },
        },
      }),
      'ERR_INVALID_CONNECTION_BINDING',
    );
  });

  it('ERR_UNSATISFIED_REQUIRED_INPUT when a connection input is bound to nothing', async () => {
    await assertReports(
      composed({
        blueprintSpec: {
          parameters: {},
          components: {
            llm: { componentRef: './components/llm.yaml', bindings: {} },
            worker: {
              componentRef: './components/web.yaml',
              compute: { profile: 'general.standard.small' },
              bindings: {
                llmBaseURL: { node: 'llm', output: 'baseURL' },
                llmAPIKey: { node: 'llm', output: 'apiKey' },
                llmModel: { node: 'llm', output: 'model' },
              },
            },
          },
        },
      }),
      'ERR_UNSATISFIED_REQUIRED_INPUT',
    );
  });

  it('ERR_UNBOUND_PARAMETER when nothing binds a connection parameter', async () => {
    await assertReports(
      composed({
        blueprintSpec: {
          parameters: {
            llm: { from: '${{ connections.llm.default }}', ui: { label: 'Language model' } },
            spare: { from: '${{ connections.llm.spare }}', ui: { label: 'Spare model' } },
          },
          components: {
            llm: { componentRef: './components/llm.yaml', bindings: { llm: { parameter: 'llm' } } },
            worker: {
              componentRef: './components/web.yaml',
              compute: { profile: 'general.standard.small' },
              bindings: {
                llmBaseURL: { node: 'llm', output: 'baseURL' },
                llmAPIKey: { node: 'llm', output: 'apiKey' },
                llmModel: { node: 'llm', output: 'model' },
              },
            },
          },
        },
      }),
      'ERR_UNBOUND_PARAMETER',
    );
  });

  it('ERR_UNKNOWN_PARAMETER, and nothing else, when a binding to a connection input names no parameter', async () => {
    // BP-CONNECTION-001 defers here rather than adding a second code: a
    // binding naming no parameter is one mistake, reported once.
    await assertReportsExactly(boundBy({ parameter: 'missing' }, {}), ['ERR_UNKNOWN_PARAMETER']);
  });
});

describe('parameters — blueprint §5', () => {
  const withInput = (over: Doc = {}): Doc =>
    component({
      spec: {
        type: 'SERVICE',
        workload: {
          source: { image: 'ghcr.io/acme/web:1.2.3' },
          endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
          health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
        },
        contract: { inputs: { adminPassword: input({ sensitive: true, target: { envVarKey: 'ADMIN_PASSWORD' }, ...over }) }, outputs: {} },
      },
    });

  const form = (parameters: Doc, bindings: Doc = { adminPassword: { parameter: 'adminPassword' } }): Fixture => ({
    blueprint: blueprint({ spec: { parameters, components: { web: node({ bindings }) } } }),
    components: { 'components/web.yaml': withInput() },
  });

  it('accepts a form supplying the one input the graph needs', async () => {
    await assertClean(form({ adminPassword: { generator: { byteLength: 32, encoding: 'HEX' }, ui: { label: 'Admin password' } } }));
  });

  it('the accepted form is a real item', async () => {
    await assertStructurallyValid(build(form({ adminPassword: { generator: { byteLength: 32, encoding: 'HEX' }, ui: { label: 'Admin password' } } })));
  });

  it('ERR_UNBOUND_PARAMETER when no node binds the parameter — BP-PARAM-001', async () => {
    await assertReports(
      form({ adminPassword: { generator: { byteLength: 32, encoding: 'HEX' }, ui: { label: 'Admin password' } }, siteTitle: { ui: { label: 'Site title' } } }),
      'ERR_UNBOUND_PARAMETER',
    );
  });

  it('ERR_UNSATISFIED_REQUIRED_INPUT when a required input is bound to nothing — BP-PARAM-003', async () => {
    await assertReports(form({}, {}), 'ERR_UNSATISFIED_REQUIRED_INPUT');
  });

  it('accepts a required input that declares its own default', async () => {
    await assertClean({
      blueprint: blueprint({ spec: { parameters: {}, components: { web: node() } } }),
      components: { 'components/web.yaml': withInput({ default: 'hunter2' }) },
    });
  });

  it('accepts a generated parameter bound to an input not marked sensitive — BP-PARAM-004', async () => {
    // The generated value is sensitive regardless (BP-PARAM-002's union). The
    // v1.0.0 corpus pins this as a pass: blueprint semantic-033.
    await assertClean(
      {
        blueprint: blueprint({
          spec: {
            parameters: { adminPassword: { generator: { byteLength: 32, encoding: 'HEX' }, ui: { label: 'Admin password' } } },
            components: { web: node({ bindings: { adminPassword: { parameter: 'adminPassword' } } }) },
          },
        }),
        components: {
          'components/web.yaml': component({
            spec: {
              type: 'SERVICE',
              workload: {
                source: { image: 'ghcr.io/acme/web:1.2.3' },
                endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
                health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
              },
              contract: { inputs: { adminPassword: input({ target: { envVarKey: 'ADMIN_PASSWORD' } }) }, outputs: {} },
            },
          }),
        },
      },
    );
  });

  it('ERR_CONFLICTING_INPUT_SCHEMA when two nodes bind one parameter to different schemas — BP-PARAM-002', async () => {
    await assertReports(
      {
        blueprint: blueprint({
          spec: {
            parameters: { shared: { ui: { label: 'Shared' } } },
            components: {
              web: node({ bindings: { adminPassword: { parameter: 'shared' } } }),
              api: node({ componentRef: './components/api.yaml', bindings: { adminPassword: { parameter: 'shared' } } }),
            },
          },
        }),
        components: {
          'components/web.yaml': withInput(),
          'components/api.yaml': component({
            spec: {
              type: 'SERVICE',
              workload: {
                source: { image: 'ghcr.io/acme/api:1.2.3' },
                endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
                health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
              },
              contract: { inputs: { adminPassword: input({ sensitive: true, schema: { type: 'integer' }, target: { envVarKey: 'ADMIN_PASSWORD' } }) }, outputs: {} },
            },
          }),
        },
      },
      'ERR_CONFLICTING_INPUT_SCHEMA',
    );
  });

  it('ERR_UNKNOWN_ENUM_MEMBER when an enumLabels key names no member — BP-UI-003', async () => {
    await assertReports(
      {
        blueprint: blueprint({
          spec: {
            parameters: { backend: { ui: { label: 'Backend', enumLabels: { GCS: 'Google Cloud Storage' } } } },
            components: { web: node({ bindings: { backend: { parameter: 'backend' } } }) },
          },
        }),
        components: {
          'components/web.yaml': component({
            spec: {
              type: 'SERVICE',
              workload: {
                source: { image: 'ghcr.io/acme/web:1.2.3' },
                endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
                health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
              },
              contract: { inputs: { backend: input({ schema: { type: 'string', enum: ['S3', 'LOCAL'] }, target: { envVarKey: 'BACKEND' } }) }, outputs: {} },
            },
          }),
        },
      },
      'ERR_UNKNOWN_ENUM_MEMBER',
    );
  });
});

describe('parameter sources — blueprint §5.2, BP-REF-001', () => {
  const sourced = (from: string): Fixture => ({
    blueprint: blueprint({
      spec: {
        parameters: { region: { from } },
        components: { web: node({ bindings: { region: { parameter: 'region' } } }) },
      },
    }),
    components: {
      'components/web.yaml': component({
        spec: {
          type: 'SERVICE',
          workload: {
            source: { image: 'ghcr.io/acme/web:1.2.3' },
            endpoints: { primary: { targetPort: 8080, protocol: 'HTTP' } },
            health: { readiness: { http: { endpoint: 'primary', path: '/healthz' } } },
          },
          contract: { inputs: { region: input({ target: { envVarKey: 'REGION' } }) }, outputs: {} },
        },
      }),
    },
  });

  it('accepts a parameter reading one organization variable', async () => {
    await assertClean(sourced('${{ variables.cloud.region }}'));
  });

  it('the accepted source is a real item', async () => {
    await assertStructurallyValid(build(sourced('${{ variables.cloud.region }}')));
  });

  it('ERR_INVALID_PARAMETER_SOURCE when a source interpolates a reference into text', async () => {
    await assertReports(sourced('https://${{ variables.cloud.region }}/x'), 'ERR_INVALID_PARAMETER_SOURCE');
  });

  it('ERR_INVALID_PARAMETER_SOURCE when a source names two references', async () => {
    await assertReports(sourced('${{ variables.a.b }}${{ variables.c.d }}'), 'ERR_INVALID_PARAMETER_SOURCE');
  });

  it('ERR_MALFORMED_REFERENCE when a source begins no well-formed reference — CORE-REF-001', async () => {
    await assertReports(sourced('${{ variables.cloud.region'), 'ERR_MALFORMED_REFERENCE');
  });

  it('ERR_UNKNOWN_REFERENCE_NAMESPACE for the withdrawn config namespace — CORE-REF-002', async () => {
    await assertReports(sourced('${{ config.cloud.region }}'), 'ERR_UNKNOWN_REFERENCE_NAMESPACE');
  });

  it('ERR_REFERENCE_NOT_IN_SCOPE when a reserved namespace is not one a parameter may read', async () => {
    await assertReports(sourced('${{ self.endpoints.primary.publicURL }}'), 'ERR_REFERENCE_NOT_IN_SCOPE');
  });
});
