/**
 * The `semantic` validation phase — the rules JSON Schema cannot express.
 *
 * Core spec §6 splits validation into four phases and forbids reporting a
 * later-phase diagnostic before the earlier ones pass. `parser` is
 * yaml-profile.ts and `structural` is the fetched bundle; this module is the
 * third: reference resolution, path containment, and uniqueness across
 * collections — everything that needs a second document or the filesystem, and
 * nothing that needs the network.
 *
 * `capability` is deliberately absent. Whether a Compute Profile is offered,
 * whether a published component exists, and whether a version is monotonic are
 * all decided against the platform catalog, and an implementation MUST NOT
 * report a rule it has not been given the means to check.
 */
import path from 'node:path';

import {
  isRecord,
  loadItemDocuments,
  resolvesInside,
  type Item,
  type ItemDocuments,
  type LoadedDocument,
} from './catalog.ts';
import { declaredMediaPaths, mediaPathPatternFrom } from './media.ts';
import { scanDescription } from './markdown.ts';
import { rel } from './paths.ts';
import { loadSchema, validatorFor } from './spec-schemas.ts';

export type Diagnostic = { code: string; where: string; message: string };

const diag = (code: string, where: string, message: string): Diagnostic => ({ code, where, message });

/* ------------------------------------------------------------------ shapes */

/** HTTP family — the protocols whose PUBLIC endpoint publishes a URL (component spec §5.2). */
const HTTP_FAMILY = new Set(['HTTP', 'HTTPS', 'WS', 'GRPC']);
/** L4 — the protocols whose PUBLIC endpoint publishes a `host:port` address. */
const L4_FAMILY = new Set(['TCP', 'UDP']);

/** The protocols a probe may address — component spec §5.4, COMP-EP-002. */
const PROBE_FAMILY = new Set(['HTTP', 'HTTPS']);

/**
 * Every address property an endpoint publishes, and the protocol family each
 * one needs (component spec §5.2, COMP-EP-004). A private property is published
 * by every endpoint, whatever it speaks.
 */
const ADDRESS_PROPERTIES: Record<string, 'url' | 'host-port' | 'any'> = {
  privateHostname: 'any',
  privatePort: 'any',
  privateAddress: 'any',
  publicURL: 'url',
  publicHostname: 'url',
  publicAddress: 'host-port',
  publicPort: 'host-port',
};

/** The four properties that only exist once a node exposes the endpoint PUBLIC. */
const PUBLIC_PROPERTIES = new Set(['publicURL', 'publicHostname', 'publicAddress', 'publicPort']);

/**
 * The closed namespace set core spec §5.2 reserves, as ADR 0031 §5 re-spells it:
 * `config` became `variables`, `params` became `parameters`, and `connections`
 * was added. Two positions are open, and each admits a different subset —
 * a component's output template admits `self` alone (COMP-REF-001), and a
 * blueprint parameter's `from` admits `variables` and `connections` alone
 * (BP-REF-001). Everything else here is reserved so it can never become a name
 * an author addresses, and writing one is CORE-REF-003 rather than CORE-REF-002.
 */
const RESERVED_NAMESPACES = new Set([
  'self',
  'parameters',
  'variables',
  'connections',
  'deployment',
  'environment',
  'organization',
  'output',
]);

/** The namespaces a blueprint parameter's `from` may name — BP-REF-001. */
const PARAMETER_SOURCE_NAMESPACES = new Set(['variables', 'connections']);

/**
 * COMP-SRC-003. Held here rather than in the schema so it can grow in a minor
 * release: growing a `pattern` makes a previously valid document invalid.
 */
const FLOATING_TAGS = new Set([
  'latest',
  'main',
  'main-stable',
  'master',
  'stable',
  'edge',
  'nightly',
  'dev',
  'rolling',
]);

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const specOf = (doc: LoadedDocument | null | undefined): Record<string, unknown> => record(doc?.value?.['spec']);
const metadataOf = (doc: LoadedDocument | null | undefined): Record<string, unknown> => record(doc?.value?.['metadata']);

/* ----------------------------------------------------------------- context */

export type NodeBinding = {
  name: string;
  node: Record<string, unknown>;
  reference: string;
  form: 'repo-local' | 'published' | 'unrecognised';
  /** Repo-local only, and only once it resolves to a document inside the root. */
  componentPath: string | null;
  component: Record<string, unknown> | null;
  /** True where the reference was repo-local and could not be read. */
  unreadable: boolean;
};

export type SemanticContext = {
  item: Item;
  documents: ItemDocuments;
  nodes: NodeBinding[];
  /** Media-path grammar, read out of the fetched listing bundle. */
  isMediaPath: (value: string) => boolean;
  /** ComponentInput property defaults, read out of the fetched component bundle. */
  inputDefaults: Record<string, unknown>;
  /**
   * Component documents that fail the parser or the component schema, by
   * absolute path. A node deploying one is ERR_INVALID_DEPENDENCY: the contract
   * it supplies is not a contract.
   */
  invalidComponents: ReadonlySet<string>;
};

export function buildContext(
  item: Item,
  documents: ItemDocuments,
  isMediaPath: (value: string) => boolean,
  inputDefaults: Record<string, unknown>,
  invalidComponents: ReadonlySet<string> = new Set(),
): SemanticContext {
  const components = record(specOf(documents.blueprint)['components']);

  const nodes: NodeBinding[] = Object.entries(components).map(([name, raw]) => {
    const node = record(raw);
    const reference = typeof node['componentRef'] === 'string' ? node['componentRef'] : '';

    if (/^\.{1,2}\//.test(reference)) {
      const componentPath = path.resolve(item.root, reference);
      const inside = resolvesInside(item.root, componentPath);
      const loaded = inside ? documents.components.get(componentPath) : undefined;
      return {
        name,
        node,
        reference,
        form: 'repo-local',
        componentPath,
        component: loaded?.value ? record(loaded.value) : null,
        unreadable: !loaded?.value,
      };
    }

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference)) {
      // Resolving this needs the catalog, which needs the network. `capability`.
      return { name, node, reference, form: 'published', componentPath: null, component: null, unreadable: true };
    }

    return { name, node, reference, form: 'unrecognised', componentPath: null, component: null, unreadable: true };
  });

  return { item, documents, nodes, isMediaPath, inputDefaults, invalidComponents };
}

/**
 * The whole context for one item, as every suite builds it. The media-path
 * grammar and the component-input defaults are read back out of the fetched
 * bundles rather than restated here, so the two places this phase needs them
 * cannot drift from what the spec publishes.
 */
export async function contextForItem(item: Item): Promise<SemanticContext> {
  const [listingBundle, componentBundle, validateComponent, documents] = await Promise.all([
    loadSchema('listing'),
    loadSchema('component'),
    validatorFor('component'),
    loadItemDocuments(item),
  ]);

  const invalidComponents = new Set<string>();
  for (const [componentPath, doc] of documents.components) {
    if (doc.parserDiagnostics.length > 0 || !doc.value || !validateComponent(doc.value)) invalidComponents.add(componentPath);
  }

  const mediaPathPattern = mediaPathPatternFrom(listingBundle.schema);
  return buildContext(
    item,
    documents,
    (value) => mediaPathPattern.test(value),
    inputDefaultsFrom(componentBundle.schema),
    invalidComponents,
  );
}

/** Every rule in this phase, in the order the suites report them. */
export const SEMANTIC_CHECKS: readonly ((context: SemanticContext) => Diagnostic[])[] = [
  checkIdentity,
  checkItemType,
  checkComponentReferences,
  checkMedia,
  checkDescription,
  checkImagePinning,
  checkEnvKeys,
  checkMounts,
  checkSchedule,
  checkHealthProbes,
  checkOutputOrigins,
  checkConnectionRequirements,
  checkNodeCompute,
  checkVolumeAllocations,
  checkExposure,
  checkBindings,
  checkValueCycles,
  checkConnectionBindings,
  checkParameters,
];

export const runSemanticChecks = (context: SemanticContext): Diagnostic[] =>
  SEMANTIC_CHECKS.flatMap((check) => check(context));

/* ---------------------------------------------------------------- identity */

/** CORE-ITEM-001. */
export function checkIdentity(context: SemanticContext): Diagnostic[] {
  const { item, documents } = context;
  const found: Diagnostic[] = [];

  for (const [doc, label] of [
    [documents.listing, 'listing'],
    [documents.blueprint, 'blueprint'],
  ] as const) {
    if (!doc?.value) continue;
    const slug = metadataOf(doc)['slug'];
    if (slug !== item.slug) {
      found.push(
        diag(
          'ERR_SLUG_MISMATCH',
          `${doc.label} /metadata/slug`,
          `${label} declares slug ${JSON.stringify(slug)}, but the item directory is named ${JSON.stringify(item.slug)}`,
        ),
      );
    }
  }

  return found;
}

/**
 * LIST-ITEM-001 — listing spec §3. `spec.itemType` is `BLUEPRINT` if and only if
 * the item root holds `blueprint.yaml`.
 *
 * It reads the directory rather than the document, which is what makes it
 * `semantic`. Holding the file is what counts, not whether it parses: a broken
 * blueprint is still a blueprint, and the parser phase reports it.
 */
export function checkItemType(context: SemanticContext): Diagnostic[] {
  const listing = context.documents.listing;
  if (!listing?.value) return [];

  const declared = specOf(listing)['itemType'];
  if (typeof declared !== 'string') return [];

  const holdsBlueprint = context.item.blueprintPath !== null;
  if (declared === (holdsBlueprint ? 'BLUEPRINT' : 'COMPONENT')) return [];

  return [
    diag(
      'ERR_ITEM_TYPE_MISMATCH',
      `${listing.label} /spec/itemType`,
      holdsBlueprint
        ? `itemType is ${declared}, but the item root holds a blueprint.yaml`
        : `itemType is ${declared}, but the item root holds no blueprint.yaml`,
    ),
  ];
}

/* -------------------------------------------------------------- references */

/** Blueprint spec §4.1 and BP-ID-003. */
export function checkComponentReferences(context: SemanticContext): Diagnostic[] {
  const { item, documents } = context;
  if (!documents.blueprint?.value) return [];

  const found: Diagnostic[] = [];
  const referenced = new Set<string>();

  for (const binding of context.nodes) {
    const where = `${documents.blueprint.label} /spec/components/${binding.name}/componentRef`;

    if (binding.form === 'published') continue; // capability — not decidable offline
    if (binding.form === 'unrecognised') {
      found.push(diag('ERR_INVALID_VALUE', where, `${JSON.stringify(binding.reference)} matches neither reference form`));
      continue;
    }

    const componentPath = binding.componentPath!;

    // Containment is decided on the resolved location, not on the spelling: a
    // reference is an escape if what it resolves to lies outside the item root,
    // whether it got there by `../`, by an absolute path, or by a symlink.
    if (!resolvesInside(item.root, componentPath)) {
      found.push(
        diag('ERR_REFERENCE_ESCAPE', where, `${JSON.stringify(binding.reference)} resolves outside the item root`),
      );
      continue;
    }

    referenced.add(componentPath);

    if (!documents.components.has(componentPath)) {
      found.push(
        diag('ERR_COMPONENT_NOT_FOUND', where, `${JSON.stringify(binding.reference)} names no document (${rel(componentPath)})`),
      );
    } else if (context.invalidComponents.has(componentPath)) {
      // Blueprint §10. The component's own diagnostics say what is wrong with
      // it; this one says the node deploying it cannot be judged against it.
      found.push(
        diag('ERR_INVALID_DEPENDENCY', where, `${JSON.stringify(binding.reference)} is not a valid component document (${rel(componentPath)})`),
      );
    }
  }

  // BP-ID-003. A component nothing references is not deployed, not checked
  // against any node, and not visible to a reader working out what the item
  // contains. The diagnostic anchors at the mapping that should have named it.
  for (const componentPath of documents.components.keys()) {
    if (!referenced.has(componentPath)) {
      found.push(
        diag(
          'ERR_UNREFERENCED_COMPONENT',
          `${documents.blueprint.label} /spec/components`,
          `${rel(componentPath)} is referenced by no node`,
        ),
      );
    }
  }

  return found;
}

/* ------------------------------------------------------------------- media */

/** LIST-MEDIA-001, LIST-MEDIA-002, LIST-MEDIA-003. */
export function checkMedia(context: SemanticContext): Diagnostic[] {
  const { item, documents } = context;
  const listing = documents.listing;
  if (!listing?.value) return [];

  const found: Diagnostic[] = [];
  const listingSpec = specOf(listing);

  for (const { pointer, value } of declaredMediaPaths(listingSpec)) {
    found.push(...checkOneMediaPath(context, `${listing.label} ${pointer}`, value));
  }

  // LIST-MEDIA-003. A gallery entry is its whole item-relative path, so
  // media/desktop/overview.png and media/mobile/overview.png are two entries and
  // only an exact repeat is a collision. It stops at the gallery: listing §4.1
  // exempts a description image, which may reuse a screenshot's path.
  const screenshots = listingSpec['screenshots'];
  if (Array.isArray(screenshots)) {
    const seen = new Map<string, number>();
    screenshots.forEach((shot, index) => {
      const file = record(shot)['file'];
      if (typeof file !== 'string') return;
      const first = seen.get(file);
      if (first === undefined) seen.set(file, index);
      else
        found.push(
          diag(
            'ERR_DUPLICATE_MEDIA_PATH',
            `${listing.label} /spec/screenshots/${index}/file`,
            `${JSON.stringify(file)} is already declared by screenshot ${first}`,
          ),
        );
    });
  }

  void item;
  return found;
}

function checkOneMediaPath(context: SemanticContext, where: string, value: string): Diagnostic[] {
  const target = path.resolve(context.item.root, value);
  const found: Diagnostic[] = [];

  // ERR_PATH_ESCAPE outlives the grammar: `..` is unspellable, but a symlink
  // inside the tree is a legal spelling resolving to an illegal target.
  if (!resolvesInside(context.item.root, target)) {
    found.push(diag('ERR_PATH_ESCAPE', where, `${JSON.stringify(value)} resolves outside the item root`));
    return found;
  }

  if (!context.item.mediaPaths.includes(target)) {
    found.push(diag('ERR_MEDIA_NOT_FOUND', where, `${JSON.stringify(value)} names no file on disk`));
  }

  return found;
}

/* ------------------------------------------------------------- description */

/** LIST-MD-001, LIST-MD-002, LIST-MD-003, and §5's rules reaching a description image. */
export function checkDescription(context: SemanticContext): Diagnostic[] {
  const listing = context.documents.listing;
  if (!listing?.value) return [];

  const description = specOf(listing)['description'];
  if (typeof description !== 'string') return [];

  const where = `${listing.label} /spec/description`;
  const { findings, imageDestinations } = scanDescription(description, context.isMediaPath);

  const found: Diagnostic[] = findings.map((finding) => diag(finding.code, where, finding.detail));

  // §5's semantic rules reach a description image too — it must resolve to a
  // file that exists and must lie inside the item root — reported at
  // /spec/description. Basename uniqueness does not: that is the gallery's rule.
  for (const destination of imageDestinations) {
    if (context.isMediaPath(destination)) found.push(...checkOneMediaPath(context, where, destination));
  }

  return found;
}

/* ------------------------------------------------------------------ source */

/** COMP-SRC-001 — the floating-tag blocklist. */
export function checkImagePinning(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const source = record(record(specOf(doc)['workload'])['source']);

    // `image` and `git` are the two sources; only an image carries a tag.
    const ref = source['image'];
    if (typeof ref !== 'string') continue;

    const tag = tagOf(ref);
    if (tag !== null && FLOATING_TAGS.has(tag.toLowerCase())) {
      found.push(
        diag(
          'ERR_UNPINNED_IMAGE',
          `${rel(componentPath)} /spec/workload/source/image`,
          `tag ${JSON.stringify(tag)} floats; it mutates under whoever curates the registry, shifting the deployment with no change to any document in the item`,
        ),
      );
    }
  }

  return found;
}

/**
 * The tag of an image reference, or null where it carries a digest or none.
 *
 * The tag colon is the one after the final slash, which is what keeps a registry
 * port (`localhost:5000/nginx`) from reading as a tag. A digest pin satisfies the
 * rule whatever tag accompanies it, because the digest is what resolves.
 */
export function tagOf(ref: string): string | null {
  const lastSegment = ref.slice(ref.lastIndexOf('/') + 1);
  if (lastSegment.includes('@')) return null;
  const colon = lastSegment.indexOf(':');
  return colon === -1 ? null : lastSegment.slice(colon + 1);
}

/* --------------------------------------------------------------- endpoints */

/**
 * Component spec §5.2 — COMP-EP-001. Every endpoint reference names its
 * endpoint, including on a single-endpoint workload: there is no primary
 * endpoint to elect. A probe with no `endpoint` fails structurally, because
 * `ComponentHttpProbe` requires it.
 */
export function lookupEndpoint(
  component: Record<string, unknown> | null,
  named: unknown,
): Record<string, unknown> | null {
  if (typeof named !== 'string') return null;
  const endpoint = endpointsOf(component)[named];
  return isRecord(endpoint) ? endpoint : null;
}

/** Component spec §5.4 — probe endpoint resolution, COMP-EP-002. */
export function checkHealthProbes(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;

    const health = record(record(specOf(doc)['workload'])['health']);

    for (const probe of ['startup', 'readiness', 'liveness']) {
      const block = health[probe];
      if (!isRecord(block)) continue;

      const named = record(block['http'])['endpoint'];
      const where = `${rel(componentPath)} /spec/workload/health/${probe}/http/endpoint`;
      const endpoint = lookupEndpoint(doc.value, named);

      if (!endpoint) {
        found.push(diag('ERR_UNKNOWN_ENDPOINT', where, `the workload declares no endpoint named ${JSON.stringify(named)}`));
        continue;
      }

      // A probe sends an HTTP request and reads a status. WS and GRPC are in the
      // HTTP family for addressing — they publish a URL — but neither answers a
      // plain GET, so a workload serving one declares a separate HTTP endpoint
      // for its probe rather than pointing the probe at the wrong protocol.
      const protocol = endpoint['protocol'];
      if (typeof protocol === 'string' && !PROBE_FAMILY.has(protocol)) {
        found.push(
          diag('ERR_ENDPOINT_NOT_HTTP', where, `the probe names endpoint ${JSON.stringify(named)}, whose protocol is ${protocol}`),
        );
      }
    }
  }

  return found;
}

/* ------------------------------------------------------------- connections */

const contractOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(record(record(component ?? {})['spec'])['contract']);

const inputsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(contractOf(component)['inputs']);

const outputsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(contractOf(component)['outputs']);

const connectionRequirementsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(contractOf(component)['connectionRequirements']);

const isRequired = (input: Record<string, unknown>): boolean => input['required'] !== false;

/** Component spec §5 — the category, which ADR 0031 made a tag rather than a shape. */
const categoryOf = (component: Record<string, unknown> | null): string => {
  const type = record(record(component ?? {})['spec'])['type'];
  return typeof type === 'string' ? type : '';
};

const runsNothing = (component: Record<string, unknown> | null): boolean => categoryOf(component) === 'EXTERNAL';

const workloadOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(record(record(component ?? {})['spec'])['workload']);

const endpointsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(workloadOf(component)['endpoints']);

const volumesOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(workloadOf(component)['volumes']);

/** The exposure a node selects for one endpoint; an endpoint left out is PRIVATE. */
const exposureOf = (node: Record<string, unknown>, endpoint: string): string =>
  record(node['exposure'])[endpoint] === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE';

/**
 * The input names a connection requirement owns. Those inputs take no ordinary
 * binding of their own: the connection supplies all three at once.
 */
const connectionOwnedInputs = (component: Record<string, unknown> | null): Set<string> => {
  const owned = new Set<string>();
  for (const requirement of Object.values(connectionRequirementsOf(component))) {
    for (const named of Object.values(record(record(requirement)['inputs']))) {
      if (typeof named === 'string') owned.add(named);
    }
  }
  return owned;
};

/* -------------------------------------------------------- output origins */

/**
 * Component spec §6.2 — where an output's value comes from.
 *
 * `from` names exactly one origin, which the schema decides; what needs a second
 * look is whether the names inside it resolve. An `input` origin names one of
 * this component's own inputs (COMP-OUT-002). An `endpoint` origin names one of
 * its own endpoints and a property that endpoint publishes (COMP-EP-004), and a
 * `template` reads the same pair through a `self` reference (COMP-REF-001).
 *
 * Whether a `public…` property is actually published is the blueprint's to
 * decide, because exposure lives on the node — see `checkExposure`.
 */
export function checkOutputOrigins(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const component = record(doc.value);
    const inputs = inputsOf(component);

    for (const [outputName, rawOutput] of Object.entries(outputsOf(component))) {
      const from = record(record(rawOutput)['from']);
      const at = `${rel(componentPath)} /spec/contract/outputs/${outputName}/from`;

      if ('input' in from) {
        const named = from['input'];
        if (!isRecord(typeof named === 'string' ? inputs[named] : undefined)) {
          found.push(diag('ERR_UNKNOWN_INPUT_REFERENCE', `${at}/input`, `${JSON.stringify(named)} names no input this component declares`));
        }
        continue;
      }

      if ('endpoint' in from) {
        found.push(...checkAddressOrigin(component, from['endpoint'], from['property'], `${at}/endpoint`));
        continue;
      }

      if (typeof from['template'] === 'string') {
        found.push(...checkOutputTemplate(component, from['template'], `${at}/template`));
      }
    }
  }

  return found;
}

/** One `{endpoint, property}` pair, wherever it is written. */
function checkAddressOrigin(
  component: Record<string, unknown>,
  named: unknown,
  property: unknown,
  where: string,
): Diagnostic[] {
  const endpoint = lookupEndpoint(component, named);
  if (!endpoint) {
    return [diag('ERR_UNKNOWN_ENDPOINT', where, `the component declares no endpoint named ${JSON.stringify(named)}`)];
  }

  const family = typeof property === 'string' ? ADDRESS_PROPERTIES[property] : undefined;
  if (family === undefined) {
    return [diag('ERR_UNKNOWN_ADDRESS_PROPERTY', where, `${JSON.stringify(property)} names no address property an endpoint publishes`)];
  }

  // COMP-TYPE-003. A WORKER is never request-driven, so no node may expose one
  // of its endpoints, so no public property of one ever has a value.
  if (PUBLIC_PROPERTIES.has(String(property)) && categoryOf(component) === 'WORKER') {
    return [diag('ERR_ENDPOINT_NOT_EXPOSABLE', where, `endpoint ${JSON.stringify(named)} belongs to a WORKER, which is never exposed, so it publishes no ${property}`)];
  }

  const protocol = endpoint['protocol'];
  if (typeof protocol !== 'string' || family === 'any') return [];

  if (family === 'url' && !HTTP_FAMILY.has(protocol)) {
    return [diag('ERR_ENDPOINT_NOT_HTTP', where, `${property} needs an HTTP-family endpoint, and ${JSON.stringify(named)} speaks ${protocol}`)];
  }
  if (family === 'host-port' && !L4_FAMILY.has(protocol)) {
    return [diag('ERR_ENDPOINT_NOT_L4', where, `${property} needs a TCP or UDP endpoint, and ${JSON.stringify(named)} speaks ${protocol}`)];
  }
  return [];
}

/**
 * Component spec §6.2 — COMP-REF-001. A template is the one position in a
 * component that admits a reference, it admits `self` alone, and the path shape
 * is exactly `endpoints.<name>.<property>`.
 *
 * The withdrawn property-first order, `${{ self.publicHostname.web }}`, lands
 * here as an unknown endpoint named `publicHostname` — which is the right
 * diagnostic and the reason the shape is checked rather than pattern-matched.
 */
function checkOutputTemplate(component: Record<string, unknown>, template: string, where: string): Diagnostic[] {
  const { references, malformed } = scanReferences(template);
  const found = malformed.map((raw) => diag('ERR_MALFORMED_REFERENCE', where, `${JSON.stringify(raw)} begins no well-formed reference`));

  for (const reference of references) {
    if (!RESERVED_NAMESPACES.has(reference.namespace)) {
      found.push(diag('ERR_UNKNOWN_REFERENCE_NAMESPACE', where, `${JSON.stringify(reference.namespace)} names a namespace core reserves none of`));
      continue;
    }
    if (reference.namespace !== 'self') {
      found.push(diag('ERR_REFERENCE_NOT_IN_SCOPE', where, `only self is in scope in a component, and this names ${JSON.stringify(reference.namespace)}`));
      continue;
    }

    // An EXTERNAL component runs nothing, so it has no endpoint of its own to
    // read — COMP-EXT-004, and the same diagnostic a misspelling would get.
    const [head, name, property, ...rest] = reference.path;
    if (head !== 'endpoints' || name === undefined || property === undefined || rest.length > 0) {
      found.push(diag('ERR_UNKNOWN_ENDPOINT', where, `${JSON.stringify(reference.raw)} is not of the form \${{ self.endpoints.<name>.<property> }}`));
      continue;
    }

    found.push(...checkAddressOrigin(component, name, property, where));
  }

  return found;
}

/* ------------------------------------------------------ workload contract */

/** Names in UTF-8 byte order — the order the specification selects "the later declaration" by. */
const utf8Order = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * Component spec §5.3 — COMP-ENVVAR-002. One environment variable has one
 * writer: an input target claims neither a name `envVars` fixes nor a name
 * another input already claims. The later input, in UTF-8 order, is the one
 * reported.
 */
export function checkEnvKeys(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const claimed = new Map<string, string>(
      Object.keys(record(record(specOf(doc)['workload'])['envVars'])).map((key) => [key, 'envVars']),
    );

    const inputs = inputsOf(doc.value);
    for (const name of Object.keys(inputs).sort(utf8Order)) {
      const key = record(record(inputs[name])['target'])['envVarKey'];
      if (typeof key !== 'string') continue;
      const owner = claimed.get(key);
      if (owner !== undefined) {
        const by = owner === 'envVars' ? 'workload.envVars' : `input ${JSON.stringify(owner)}`;
        found.push(
          diag('ERR_CONFLICTING_ENV_KEY', `${rel(componentPath)} /spec/contract/inputs/${name}/target/envVarKey`, `${key} is already claimed by ${by}`),
        );
        continue;
      }
      claimed.set(key, name);
    }
  }

  return found;
}

/** Component spec §5.5: absolute, no dot segments, no doubled separator, no trailing slash but root's. */
const isCanonicalMountPath = (value: string): boolean =>
  value === '/' || (value.startsWith('/') && value.slice(1).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));

/**
 * Component spec §5.5. A mount path is canonical, and no two volumes share one
 * or nest one inside the other: which volume a file under a nested mount lands
 * on is a fact about the runtime, not about the document. The deeper mount —
 * or, for a duplicate, the later volume in UTF-8 order — is the one reported.
 */
export function checkMounts(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const volumes = Object.entries(record(record(specOf(doc)['workload'])['volumes']))
      .map(([name, volume]) => ({ name, mountPath: record(volume)['mountPath'] }))
      .filter((volume): volume is { name: string; mountPath: string } => typeof volume.mountPath === 'string')
      .sort((a, b) => utf8Order(a.name, b.name));

    const at = (name: string) => `${rel(componentPath)} /spec/workload/volumes/${name}/mountPath`;
    const canonical = volumes.filter((volume) => {
      if (isCanonicalMountPath(volume.mountPath)) return true;
      found.push(diag('ERR_INVALID_MOUNT', at(volume.name), `${JSON.stringify(volume.mountPath)} is not a canonical absolute path`));
      return false;
    });

    for (const [index, later] of canonical.entries()) {
      for (const earlier of canonical.slice(0, index)) {
        const [outer, inner] = earlier.mountPath.length <= later.mountPath.length ? [earlier, later] : [later, earlier];
        const prefix = outer.mountPath === '/' ? '/' : `${outer.mountPath}/`;
        if (outer.mountPath === inner.mountPath) {
          found.push(diag('ERR_INVALID_MOUNT', at(later.name), `${later.mountPath} is also volume ${JSON.stringify(earlier.name)}'s mount path`));
        } else if (inner.mountPath.startsWith(prefix)) {
          found.push(diag('ERR_INVALID_MOUNT', at(inner.name), `${inner.mountPath} lies inside volume ${JSON.stringify(outer.name)}'s mount at ${outer.mountPath}`));
        }
      }
    }
  }

  return found;
}

/** Component spec §5.7: minute, hour, day of month, month, day of week. */
const CRON_RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

const CRON_ELEMENT = /^(\*|[0-9]+|[0-9]+-[0-9]+)(?:\/([0-9]+))?$/;

/** Why one cron field is outside §5.7's grammar or range, or null. */
function cronFieldProblem(field: string, [min, max]: [number, number]): string | null {
  for (const element of field.split(',')) {
    const match = CRON_ELEMENT.exec(element);
    if (!match) return `${JSON.stringify(element)} is not *, a number or a range, with an optional step`;
    const [, base, step] = match;
    if (step !== undefined && Number(step) < 1) return `the step in ${JSON.stringify(element)} is not positive`;
    if (base === '*') continue;
    const [low, high = low] = base!.split('-').map(Number) as [number, number?];
    if (low > high!) return `the range ${base} runs backwards`;
    for (const value of [low, high!]) {
      if (value < min || value > max) return `${value} is outside ${min}–${max}`;
    }
  }
  return null;
}

/**
 * Component spec §5.7 — COMP-JOB-002. Five fields is structural; what each field
 * may hold is not. Numbers only — no month or day names — each inside its
 * field's range, with 0 as Sunday and no 7.
 */
export function checkSchedule(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  const names = ['minute', 'hour', 'day of month', 'month', 'day of week'];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const cron = record(record(specOf(doc)['workload'])['schedule'])['cron'];
    if (typeof cron !== 'string') continue;

    const fields = cron.trim().split(/[ \t]+/);
    if (fields.length !== CRON_RANGES.length) continue; // structural

    for (const [index, field] of fields.entries()) {
      const problem = cronFieldProblem(field, CRON_RANGES[index]!);
      if (problem) {
        found.push(diag('ERR_INVALID_SCHEDULE', `${rel(componentPath)} /spec/workload/schedule/cron`, `${names[index]} field: ${problem}`));
        break;
      }
    }
  }

  return found;
}

/* ------------------------------------------------------------ node compute */

/**
 * Blueprint spec §4.3 — BP-NODE-001 and BP-NODE-002. `compute` is required on a
 * node whose component runs and forbidden on one whose component is EXTERNAL.
 *
 * Silent where the component cannot be read offline, because its category is
 * exactly what an unread component hides (BP-REF-002: deferred, not passed).
 */
export function checkNodeCompute(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const found: Diagnostic[] = [];
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;

    const declared = isRecord(binding.node['compute']);
    const external = runsNothing(binding.component);
    if (declared !== external) continue;

    found.push(
      external
        ? diag(
            'ERR_CONFLICTING_NODE_COMPUTE',
            `${blueprint.label} /spec/components/${binding.name}/compute`,
            `the component ${JSON.stringify(binding.reference)} is EXTERNAL and runs nothing, so there is nothing to size or place`,
          )
        : diag(
            'ERR_CONFLICTING_NODE_COMPUTE',
            `${blueprint.label} /spec/components/${binding.name}`,
            `the component ${JSON.stringify(binding.reference)} runs a workload, so the node must name the compute it runs on`,
          ),
    );
  }

  return found;
}

/* ----------------------------------------------------------------- storage */

/**
 * Blueprint spec §4.3. The component declares the volumes and the floor; the
 * node allocates the actual size. Every declared volume needs an allocation, no
 * allocation may name a volume the component does not declare, and none may sit
 * below the component's own minimum. One code covers all three: they are the
 * same disagreement read from three sides.
 */
export function checkVolumeAllocations(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const found: Diagnostic[] = [];
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;

    const declared = volumesOf(binding.component);
    const allocated = record(binding.node['volumes']);
    const at = `${blueprint.label} /spec/components/${binding.name}/volumes`;

    for (const name of Object.keys(declared)) {
      if (!isRecord(allocated[name])) {
        found.push(diag('ERR_INVALID_VOLUME_ALLOCATION', at, `the component declares volume ${JSON.stringify(name)} and the node allocates it nothing`));
      }
    }

    for (const [name, rawAllocation] of Object.entries(allocated)) {
      const declaration = declared[name];
      if (!isRecord(declaration)) {
        found.push(diag('ERR_INVALID_VOLUME_ALLOCATION', `${at}/${name}`, `${JSON.stringify(name)} names no volume the component declares`));
        continue;
      }

      const size = record(rawAllocation)['sizeGiB'];
      const floor = declaration['minSizeGiB'];
      if (typeof size === 'number' && typeof floor === 'number' && size < floor) {
        found.push(
          diag('ERR_INVALID_VOLUME_ALLOCATION', `${at}/${name}/sizeGiB`, `${size} GiB is below the ${floor} GiB the component says it needs`),
        );
      }
    }
  }

  return found;
}

/* ---------------------------------------------------------------- exposure */

/**
 * Blueprint spec §4.3. Exposure is the node's to choose, so every rule that
 * depends on whether an endpoint is public is decided here rather than in the
 * component — including the ones that read a component's own outputs.
 */
export function checkExposure(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const found: Diagnostic[] = [];
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;

    const endpoints = endpointsOf(binding.component);
    const category = categoryOf(binding.component);
    const at = `${blueprint.label} /spec/components/${binding.name}/exposure`;
    const health = record(record(workloadOf(binding.component))['health']);

    for (const [name, selected] of Object.entries(record(binding.node['exposure']))) {
      const endpoint = endpoints[name];
      if (!isRecord(endpoint)) {
        found.push(diag('ERR_UNKNOWN_ENDPOINT', `${at}/${name}`, `${JSON.stringify(name)} names no endpoint the component declares`));
        continue;
      }
      if (selected !== 'PUBLIC') continue;

      // A WORKER is not request-driven. Exposing one is rejected even when it
      // carries a readiness probe, which it now may.
      if (category === 'WORKER') {
        found.push(diag('ERR_ENDPOINT_NOT_EXPOSABLE', `${at}/${name}`, 'a WORKER endpoint is never PUBLIC'));
        continue;
      }

      // COMP-EP-003, decided here because exposure is. Traffic reaching an
      // endpoint with no readiness gate reaches a process that may not be
      // listening yet. The gate has to poll *this* endpoint: a readiness probe
      // on a sibling says nothing about whether this one answers.
      const protocol = endpoint['protocol'];
      if (typeof protocol !== 'string' || !HTTP_FAMILY.has(protocol)) continue;

      if (record(record(health['readiness'])['http'])['endpoint'] !== name) {
        found.push(
          diag('ERR_READINESS_REQUIRED', `${at}/${name}`, `endpoint ${JSON.stringify(name)} is PUBLIC and no readiness probe polls it`),
        );
      }
    }

    // An output reading a public property of an endpoint this node does not
    // expose reads an address that was never allocated. The component cannot
    // decide this; only the node knows what it exposed.
    for (const [outputName, rawOutput] of Object.entries(outputsOf(binding.component))) {
      const from = record(record(rawOutput)['from']);
      const pairs: { endpoint: unknown; property: unknown }[] = [];

      if ('endpoint' in from) pairs.push({ endpoint: from['endpoint'], property: from['property'] });
      if (typeof from['template'] === 'string') {
        for (const reference of scanReferences(from['template']).references) {
          if (reference.namespace === 'self' && reference.path[0] === 'endpoints') {
            pairs.push({ endpoint: reference.path[1], property: reference.path[2] });
          }
        }
      }

      for (const pair of pairs) {
        if (!PUBLIC_PROPERTIES.has(String(pair.property))) continue;
        if (!isRecord(endpoints[String(pair.endpoint)])) continue;
        if (exposureOf(binding.node, String(pair.endpoint)) === 'PUBLIC') continue;

        found.push(
          diag(
            'ERR_ENDPOINT_NOT_PUBLIC',
            `${blueprint.label} /spec/components/${binding.name}/componentRef`,
            `output ${JSON.stringify(outputName)} reads ${pair.property} of endpoint ${JSON.stringify(pair.endpoint)}, which this node keeps PRIVATE`,
          ),
        );
      }
    }
  }

  return found;
}

/* ---------------------------------------------------------------- bindings */

/**
 * Blueprint spec §4.2 — BP-PARAM-006 and BP-PARAM-007.
 *
 * A binding says where one input's value comes from. That it names exactly one
 * supplier is structural (`BlueprintBinding`'s `oneOf`), so what is left here is
 * resolving the names: the input it fills, and — for a `{node, output}` binding
 * — the producer and its output, with the two schemas agreeing.
 *
 * Coverage by matching names does not exist: adding an unrelated node must not
 * change existing recipients, so every recipient is written down.
 */
export function checkBindings(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const parameters = record(specOf(blueprint)['parameters']);
  const byName = new Map(context.nodes.map((binding) => [binding.name, binding]));
  const found: Diagnostic[] = [];

  for (const consumer of context.nodes) {
    const consumerInputs = inputsOf(consumer.component);
    const owned = connectionOwnedInputs(consumer.component);

    for (const [inputKey, rawBinding] of Object.entries(record(consumer.node['bindings']))) {
      const binding = record(rawBinding);
      const where = `${blueprint.label} /spec/components/${consumer.name}/bindings/${inputKey}`;

      const consumerInput = consumerInputs[inputKey];
      if (!consumer.unreadable && !isRecord(consumerInput)) {
        found.push(diag('ERR_UNKNOWN_INPUT', where, `${JSON.stringify(inputKey)} names no input of the component ${JSON.stringify(consumer.name)} deploys`));
        continue;
      }

      // BP-CONNECTION-001. A connection supplies its three roles together, so an
      // ordinary binding onto one of them would put two suppliers behind one
      // value and let a key from one provider sit beside an address from another.
      if (owned.has(inputKey)) {
        found.push(
          diag('ERR_INVALID_CONNECTION_BINDING', where, `${JSON.stringify(inputKey)} is owned by a connection requirement and takes no binding of its own`),
        );
        continue;
      }

      if (typeof binding['parameter'] === 'string') {
        const named = binding['parameter'];
        const parameter = parameters[named];
        if (!isRecord(parameter)) {
          found.push(diag('ERR_UNKNOWN_PARAMETER', `${where}/parameter`, `${JSON.stringify(named)} names no parameter this blueprint declares`));
          continue;
        }
        // A connection is a bundle, not a value; it reaches its consumer through
        // connectionBindings and never through an ordinary one.
        if (namespaceOfSource(parameter['from']) === 'connections') {
          found.push(
            diag('ERR_INVALID_CONNECTION_BINDING', `${where}/parameter`, `parameter ${JSON.stringify(named)} names a connection, which binds only through connectionBindings`),
          );
        }
        continue;
      }

      if (typeof binding['node'] !== 'string') continue; // a literal `value`; nothing to resolve

      const producer = byName.get(binding['node']);
      if (!producer) {
        found.push(diag('ERR_UNKNOWN_NODE', `${where}/node`, `${JSON.stringify(binding['node'])} names no node in this blueprint`));
        continue;
      }
      if (producer.unreadable) continue; // its outputs were never readable

      const named = binding['output'];
      const output = typeof named === 'string' ? outputsOf(producer.component)[named] : undefined;
      if (!isRecord(output)) {
        found.push(
          diag('ERR_UNKNOWN_OUTPUT', `${where}/output`, `${JSON.stringify(named)} names no output of the component ${JSON.stringify(producer.name)} deploys`),
        );
        continue;
      }

      if (!isRecord(consumerInput)) continue;
      found.push(...checkTypeAgreement(record(output['schema']), record(consumerInput['schema']), `${where}/output`));
    }
  }

  return found;
}

/**
 * Blueprint spec §4.2 — BP-CONN-002. The value-dependency graph is acyclic.
 *
 * A vertex is one node's input or output. A `{node, output}` binding makes the
 * consumer's input depend on the producer's output, and an output whose `from`
 * is `{input}` depends on that input. Endpoint and template outputs depend on
 * allocated addresses rather than on values, so a discovery loop — two nodes
 * reading each other's addresses — adds no edge and is permitted.
 */
export function checkValueCycles(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const edges = new Map<string, string[]>();
  const edge = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);

  for (const node of context.nodes) {
    for (const [outputName, output] of Object.entries(outputsOf(node.component))) {
      const input = record(record(output)['from'])['input'];
      if (typeof input === 'string') edge(`${node.name}.outputs.${outputName}`, `${node.name}.inputs.${input}`);
    }
    for (const [inputKey, rawBinding] of Object.entries(record(node.node['bindings']))) {
      const binding = record(rawBinding);
      if (typeof binding['node'] === 'string' && typeof binding['output'] === 'string') {
        edge(`${node.name}.inputs.${inputKey}`, `${binding['node']}.outputs.${binding['output']}`);
      }
    }
  }

  // Iterative depth-first search, so a long chain cannot exhaust the stack.
  const state = new Map<string, 'open' | 'done'>();
  for (const start of edges.keys()) {
    if (state.has(start)) continue;
    const stack: { vertex: string; next: number }[] = [{ vertex: start, next: 0 }];
    state.set(start, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const successors = edges.get(top.vertex) ?? [];
      if (top.next >= successors.length) {
        state.set(top.vertex, 'done');
        stack.pop();
        continue;
      }
      const successor = successors[top.next++]!;
      const seen = state.get(successor);
      if (seen === 'open') {
        const loop = [...stack.slice(stack.findIndex((frame) => frame.vertex === successor)).map((frame) => frame.vertex), successor];
        return [diag('ERR_VALUE_CYCLE', `${blueprint.label} /spec/components`, `values depend on themselves: ${loop.join(' → ')}`)];
      }
      if (seen === undefined) {
        state.set(successor, 'open');
        stack.push({ vertex: successor, next: 0 });
      }
    }
  }

  return [];
}

/**
 * BP-PARAM-008. The two ends of a wire agree on type, with one widening: an
 * integer is a number, so an integer producer satisfies a number consumer. The
 * reverse is not true, and nothing else widens — everything is a string by the
 * time it reaches a container, but *which* string is a decision each language's
 * formatter makes differently.
 */
function checkTypeAgreement(producer: Record<string, unknown>, consumer: Record<string, unknown>, where: string): Diagnostic[] {
  const from = producer['type'];
  const to = consumer['type'];
  if (from === to) return [];
  if (from === 'integer' && to === 'number') return [];

  return [diag('ERR_INCOMPATIBLE_TYPE', where, `output type ${JSON.stringify(from)} does not satisfy input type ${JSON.stringify(to)}`)];
}

/* ------------------------------------------------------------- connections */

/**
 * Component spec §6.4 — COMP-CONNECTION-001.
 *
 * A connection is acquired as one thing, so each of its three roles has to name
 * an input that is genuinely waiting for it: required, a string, and with no
 * default that could stand in when acquisition is what supplies the value. The
 * credential's input is sensitive, because a connection credential is secret
 * material whatever the component calls it.
 */
export function checkConnectionRequirements(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;

    const inputs = inputsOf(record(doc.value));
    const claimed = new Map<string, string>();

    for (const [name, rawRequirement] of Object.entries(connectionRequirementsOf(record(doc.value)))) {
      const at = `${rel(componentPath)} /spec/contract/connectionRequirements/${name}`;

      for (const [role, named] of Object.entries(record(record(rawRequirement)['inputs']))) {
        const where = `${at}/inputs/${role}`;
        if (typeof named !== 'string') continue;

        const input = inputs[named];
        if (!isRecord(input)) {
          found.push(diag('ERR_INVALID_CONNECTION_REQUIREMENT', where, `${JSON.stringify(named)} names no input this component declares`));
          continue;
        }

        const owner = claimed.get(named);
        if (owner !== undefined) {
          found.push(diag('ERR_INVALID_CONNECTION_REQUIREMENT', where, `input ${JSON.stringify(named)} is already claimed by ${owner}`));
          continue;
        }
        claimed.set(named, `${name}.${role}`);

        if (record(input['schema'])['type'] !== 'string') {
          found.push(diag('ERR_INVALID_CONNECTION_REQUIREMENT', where, `a connection role names a string input, and ${JSON.stringify(named)} is not one`));
        }
        if (!isRequired(input)) {
          found.push(diag('ERR_INVALID_CONNECTION_REQUIREMENT', where, `a connection role names a required input, and ${JSON.stringify(named)} is optional`));
        }
        if ('default' in input) {
          found.push(diag('ERR_INVALID_CONNECTION_REQUIREMENT', where, `a connection supplies ${JSON.stringify(named)}, so a default could never apply`));
        }
        if (role === 'apiKey' && input['sensitive'] !== true) {
          found.push(diag('ERR_INVALID_CONNECTION_REQUIREMENT', where, `the credential input ${JSON.stringify(named)} is not marked sensitive`));
        }
      }
    }
  }

  return found;
}

/**
 * Blueprint spec §5.3 — BP-CONNECTION-001. Every requirement the node's
 * component declares gets exactly one binding, each binding names a declared
 * parameter, and that parameter names a connection.
 */
export function checkConnectionBindings(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const parameters = record(specOf(blueprint)['parameters']);
  const found: Diagnostic[] = [];

  for (const binding of context.nodes) {
    const bound = record(binding.node['connectionBindings']);
    const at = `${blueprint.label} /spec/components/${binding.name}/connectionBindings`;
    const required = connectionRequirementsOf(binding.component);

    if (!binding.unreadable) {
      for (const name of Object.keys(required)) {
        if (!isRecord(bound[name])) {
          found.push(diag('ERR_INVALID_CONNECTION_BINDING', at, `the component requires connection ${JSON.stringify(name)} and the node binds nothing to it`));
        }
      }
    }

    for (const [name, rawBinding] of Object.entries(bound)) {
      const where = `${at}/${name}`;
      if (!binding.unreadable && !isRecord(required[name])) {
        found.push(diag('ERR_INVALID_CONNECTION_BINDING', where, `${JSON.stringify(name)} names no connection requirement the component declares`));
        continue;
      }

      const named = record(rawBinding)['parameter'];
      const parameter = typeof named === 'string' ? parameters[named] : undefined;
      if (!isRecord(parameter)) {
        found.push(diag('ERR_UNKNOWN_PARAMETER', `${where}/parameter`, `${JSON.stringify(named)} names no parameter this blueprint declares`));
        continue;
      }

      if (namespaceOfSource(parameter['from']) !== 'connections') {
        found.push(
          diag('ERR_INVALID_CONNECTION_BINDING', `${where}/parameter`, `parameter ${JSON.stringify(named)} names no connection, so it cannot satisfy a connection requirement`),
        );
      }
    }
  }

  return found;
}

/* -------------------------------------------------------------- parameters */

/** One input a parameter supplies, on the node whose binding names it. */
type Bound = { node: string; input: Record<string, unknown> };

/**
 * The namespace a parameter's `from` names, or null where it names nothing
 * usable. Used to tell a connection parameter from every other kind.
 */
function namespaceOfSource(from: unknown): string | null {
  if (typeof from !== 'string') return null;
  const { references, malformed } = scanReferences(from);
  if (malformed.length > 0 || references.length !== 1) return null;
  return references[0]!.raw.trim() === from.trim() ? references[0]!.namespace : null;
}

/** Every input bound to each parameter, keyed by parameter name. */
function boundByParameter(context: SemanticContext): Map<string, Bound[]> {
  const bound = new Map<string, Bound[]>();

  for (const binding of context.nodes) {
    if (binding.unreadable) continue;
    const inputs = inputsOf(binding.component);

    for (const [inputKey, rawBinding] of Object.entries(record(binding.node['bindings']))) {
      const named = record(rawBinding)['parameter'];
      if (typeof named !== 'string') continue;
      const input = inputs[inputKey];
      if (!isRecord(input)) continue;
      bound.set(named, [...(bound.get(named) ?? []), { node: binding.name, input }]);
    }
  }

  return bound;
}

/**
 * Blueprint spec §5 — the parameters, and the install form derived from them.
 *
 * Nothing binds by name any more. A parameter reaches an input because some
 * node's `bindings` says so, which is what makes adding an unrelated node safe.
 * So the rules invert: a parameter is reachable iff something names it, and a
 * required input is supplied iff something binds it.
 *
 * BP-PARAM-001..003 and BP-UI-003.
 */
export function checkParameters(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const parameters = record(specOf(blueprint)['parameters']);
  const bound = boundByParameter(context);
  const found: Diagnostic[] = [];

  // A connection parameter is reached through connectionBindings, which names it
  // the same way an ordinary binding does but from a different map.
  const connectionBound = new Set<string>();
  for (const binding of context.nodes) {
    for (const rawBinding of Object.values(record(binding.node['connectionBindings']))) {
      const named = record(rawBinding)['parameter'];
      if (typeof named === 'string') connectionBound.add(named);
    }
  }

  for (const [key, rawParameter] of Object.entries(parameters)) {
    const parameter = record(rawParameter);
    const at = `${blueprint.label} /spec/parameters/${key}`;
    const supplies = bound.get(key) ?? [];

    // BP-PARAM-001. Asking a deploying user for a value nothing reads is a field
    // that cannot do anything, and it is silent — which is why it is an error.
    if (supplies.length === 0 && !connectionBound.has(key)) {
      const everyNodeReadable = context.nodes.every((binding) => !binding.unreadable);
      if (everyNodeReadable) {
        found.push(diag('ERR_UNBOUND_PARAMETER', at, 'no node binds this parameter, so nothing ever reads the value it asks for'));
      }
      continue;
    }

    // BP-PARAM-002. Two inputs sharing one parameter share one value, so they
    // have to agree on what the value is. Description, target and requiredness
    // say what each component does with it, not what it is.
    const first = supplies[0];
    if (first) {
      const conflict = supplies.find((one) => !deepEqual(record(one.input['schema']), record(first.input['schema'])));
      if (conflict) {
        found.push(
          diag(
            'ERR_CONFLICTING_INPUT_SCHEMA',
            at,
            `nodes ${JSON.stringify(first.node)} and ${JSON.stringify(conflict.node)} bind this parameter to inputs with different schemas`,
          ),
        );
      }
    }

    // BP-PARAM-004 asks nothing of the receiving input. A generated value is
    // sensitive whatever it is bound to, because sensitivity is the union of the
    // receiving contracts and the supplied value (BP-PARAM-002), so an input not
    // marked sensitive is not an error here.

    found.push(...checkParameterSource(parameter, at));
    found.push(...checkEnumLabels(parameter, supplies, at));
  }

  // BP-PARAM-003. A required input with no binding and no default has no value
  // and no way to acquire one.
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;
    const declared = record(binding.node['bindings']);
    const owned = connectionOwnedInputs(binding.component);

    for (const [inputKey, rawInput] of Object.entries(inputsOf(binding.component))) {
      const input = record(rawInput);
      if (!isRequired(input)) continue;
      if ('default' in input) continue;
      if (isRecord(declared[inputKey])) continue;
      if (owned.has(inputKey)) continue; // a connection supplies it

      found.push(
        diag(
          'ERR_UNSATISFIED_REQUIRED_INPUT',
          `${blueprint.label} /spec/components/${binding.name}`,
          `required input ${JSON.stringify(inputKey)} is bound to nothing and declares no default`,
        ),
      );
    }
  }

  return found;
}

/**
 * Blueprint spec §5.2 — BP-REF-001. A parameter's `from` is exactly one whole
 * reference, in `variables` or `connections`.
 *
 * "Whole" is the load-bearing word: a `from` that interpolates a reference into
 * surrounding text, or names two, is not a reference to one entry, and there is
 * nothing for the platform to look up.
 */
function checkParameterSource(parameter: Record<string, unknown>, at: string): Diagnostic[] {
  const from = parameter['from'];
  if (typeof from !== 'string') return [];

  const where = `${at}/from`;
  const { references, malformed } = scanReferences(from);

  if (malformed.length > 0) {
    return [diag('ERR_MALFORMED_REFERENCE', where, `${JSON.stringify(malformed[0])} begins no well-formed reference`)];
  }
  if (references.length !== 1 || references[0]!.raw.trim() !== from.trim()) {
    return [diag('ERR_INVALID_PARAMETER_SOURCE', where, 'a parameter source is exactly one whole reference, with no surrounding text')];
  }

  const { namespace } = references[0]!;
  if (!RESERVED_NAMESPACES.has(namespace)) {
    return [diag('ERR_UNKNOWN_REFERENCE_NAMESPACE', where, `${JSON.stringify(namespace)} names a namespace core reserves none of`)];
  }
  if (!PARAMETER_SOURCE_NAMESPACES.has(namespace)) {
    return [
      diag('ERR_REFERENCE_NOT_IN_SCOPE', where, `a parameter takes a value from variables or connections, and this names ${JSON.stringify(namespace)}`),
    ];
  }
  return [];
}

/** BP-UI-003. A label for a choice that is not on offer labels nothing. */
function checkEnumLabels(parameter: Record<string, unknown>, supplies: Bound[], at: string): Diagnostic[] {
  const labels = record(record(parameter['ui'])['enumLabels']);
  if (Object.keys(labels).length === 0) return [];

  const members = new Set<string>();
  for (const one of supplies) {
    const schema = record(one.input['schema']);
    // A list offers its members through the item schema, not the array's.
    const source = Array.isArray(schema['enum']) ? schema['enum'] : record(schema['items'])['enum'];
    // Members may be integers or booleans; the label key is always a string.
    if (Array.isArray(source)) for (const member of source) members.add(String(member));
  }
  if (members.size === 0) return [];

  return Object.keys(labels)
    .filter((key) => !members.has(key))
    .map((key) => diag('ERR_UNKNOWN_ENUM_MEMBER', `${at}/ui/enumLabels/${key}`, `${JSON.stringify(key)} names no member of the enum this parameter supplies`));
}

/* -------------------------------------------------------------- references */

type Reference = { raw: string; namespace: string; path: string[] };

const SEGMENT = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Core spec §5.2. A reference is `${{`, optional whitespace, a namespace, one or
 * more `.`-separated segments, optional whitespace, `}}`. `$${{` is the only
 * escape and is a single four-character token, not per-`$` doubling.
 *
 * A resolved value is never scanned again, so there is no chain, no cycle and no
 * depth to bound — one left-to-right pass decides the whole string.
 */
export function scanReferences(value: string): { references: Reference[]; malformed: string[] } {
  const references: Reference[] = [];
  const malformed: string[] = [];

  let i = 0;
  while (i < value.length) {
    if (value.startsWith('$${{', i)) {
      i += 4; // a literal `${{`
      continue;
    }
    if (!value.startsWith('${{', i)) {
      i += 1;
      continue;
    }

    const close = value.indexOf('}}', i + 3);
    if (close === -1) {
      malformed.push(value.slice(i));
      break;
    }

    const raw = value.slice(i, close + 2);
    const segments = value.slice(i + 3, close).trim().split('.');
    i = close + 2;

    if (segments.length < 2 || !segments.every((segment) => SEGMENT.test(segment))) {
      malformed.push(raw);
      continue;
    }
    references.push({ raw, namespace: segments[0]!, path: segments.slice(1) });
  }

  return { references, malformed };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * The defaults a component input carries when it declares neither — read out of
 * the fetched component bundle rather than restated here, so the place this
 * phase needs them cannot drift from what the spec publishes.
 *
 * This reads `$defs.ComponentInput`, not `$defs.ComponentValueSchema`. ADR 0028
 * moved `required`, `sensitive` and `default` out of the value schema and beside
 * it, and a value schema now publishes no default at all — so the previous
 * reader found its `$defs` entry, declined to throw, and returned a map of
 * nulls. The assertion below therefore names the two keys this module actually
 * consumes rather than merely checking the object exists: a drift alarm that
 * cannot tell an empty answer from a right one is not an alarm.
 */
export function inputDefaultsFrom(componentSchema: Record<string, unknown>): Record<string, unknown> {
  const defs = componentSchema['$defs'] as Record<string, Record<string, unknown>> | undefined;
  const properties = defs?.['ComponentInput']?.['properties'] as Record<string, Record<string, unknown>> | undefined;
  const missing = ['required', 'sensitive'].filter((key) => properties?.[key]?.['default'] === undefined);

  if (!properties || missing.length > 0) {
    throw new Error(
      `the component schema no longer publishes a default for $defs.ComponentInput.properties.{${missing.join(', ')}}; ` +
        'the spec has changed shape and this module needs updating',
    );
  }
  return Object.fromEntries(Object.entries(properties).map(([key, node]) => [key, node['default'] ?? null]));
}
