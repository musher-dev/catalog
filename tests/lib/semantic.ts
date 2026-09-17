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
  resolvesInside,
  type Item,
  type ItemDocuments,
  type LoadedDocument,
} from './catalog.ts';
import { declaredMediaPaths } from './media.ts';
import { scanDescription } from './markdown.ts';
import { rel } from './paths.ts';

export type Diagnostic = { code: string; where: string; message: string };

const diag = (code: string, where: string, message: string): Diagnostic => ({ code, where, message });

/* ------------------------------------------------------------------ shapes */

/** HTTP family — the protocols whose PUBLIC endpoint publishes a URL (component spec §5.2). */
const HTTP_FAMILY = new Set(['HTTP', 'HTTPS', 'WS', 'GRPC']);
/** L4 — the protocols whose PUBLIC endpoint publishes a `host:port` address. */
const L4_FAMILY = new Set(['TCP', 'UDP']);

/** Which address form each `self` path reads (blueprint spec §5.2). */
const SELF_PATH_ADDRESS_FORM: Record<string, 'url' | 'host-port'> = {
  publicUrl: 'url',
  publicHostname: 'url',
  publicAddress: 'host-port',
  publicPort: 'host-port',
};

/**
 * The closed namespace set core spec §5.2 reserves. Only `self` has a meaning at
 * this line; the rest are reserved so they can never become a name an author
 * addresses, and writing one is CORE-REF-003 rather than CORE-REF-002.
 */
const RESERVED_NAMESPACES = new Set([
  'self',
  'params',
  'config',
  'deployment',
  'environment',
  'organization',
  'output',
]);

/**
 * COMP-SRC-001. Held here rather than in the schema so it can grow in a minor
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
  /** ComponentValueSchema property defaults, read out of the fetched component bundle. */
  valueSchemaDefaults: Record<string, unknown>;
};

export function buildContext(
  item: Item,
  documents: ItemDocuments,
  isMediaPath: (value: string) => boolean,
  valueSchemaDefaults: Record<string, unknown>,
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

  return { item, documents, nodes, isMediaPath, valueSchemaDefaults };
}

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

  // LIST-MEDIA-003. A gallery addresses its entries by basename, so two
  // screenshots called overview.png are one entry. It stops at the gallery:
  // the published media set is keyed on the whole path.
  const screenshots = listingSpec['screenshots'];
  if (Array.isArray(screenshots)) {
    const seen = new Map<string, number>();
    screenshots.forEach((shot, index) => {
      const file = record(shot)['file'];
      if (typeof file !== 'string') return;
      const base = path.posix.basename(file);
      const first = seen.get(base);
      if (first === undefined) seen.set(base, index);
      else
        found.push(
          diag(
            'ERR_DUPLICATE_MEDIA_BASENAME',
            `${listing.label} /spec/screenshots/${index}/file`,
            `basename ${JSON.stringify(base)} is already used by screenshot ${first}`,
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
    if (source['type'] !== 'IMAGE') continue;

    const ref = source['ref'];
    if (typeof ref !== 'string') continue;

    const tag = tagOf(ref);
    if (tag !== null && FLOATING_TAGS.has(tag.toLowerCase())) {
      found.push(
        diag(
          'ERR_UNPINNED_IMAGE',
          `${rel(componentPath)} /spec/workload/source/ref`,
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

type EndpointResolution =
  | { ok: true; name: string; endpoint: Record<string, unknown> }
  | { ok: false; code: 'ERR_AMBIGUOUS_ENDPOINT' | 'ERR_UNKNOWN_ENDPOINT'; message: string };

/**
 * The primary endpoint (component spec §5.2): the sole endpoint, failing that
 * the sole PUBLIC one, failing that nothing.
 *
 * Electing the first name in sort order would give every document an answer, and
 * would let a new endpoint called `api` silently re-point a probe that has worked
 * for a year — so "nothing" is an error rather than a tiebreak.
 */
export function resolveEndpoint(workload: Record<string, unknown>, named: unknown): EndpointResolution {
  const endpoints = record(workload['endpoints']);
  const entries = Object.entries(endpoints);

  if (typeof named === 'string') {
    const endpoint = endpoints[named];
    if (!isRecord(endpoint)) {
      return { ok: false, code: 'ERR_UNKNOWN_ENDPOINT', message: `the workload declares no endpoint named ${JSON.stringify(named)}` };
    }
    return { ok: true, name: named, endpoint };
  }

  if (entries.length === 1) {
    const [name, endpoint] = entries[0]!;
    return { ok: true, name, endpoint: record(endpoint) };
  }

  const publicEntries = entries.filter(([, endpoint]) => record(endpoint)['visibility'] === 'PUBLIC');
  if (publicEntries.length === 1) {
    const [name, endpoint] = publicEntries[0]!;
    return { ok: true, name, endpoint: record(endpoint) };
  }

  return {
    ok: false,
    code: 'ERR_AMBIGUOUS_ENDPOINT',
    message:
      entries.length === 0
        ? 'the reference omits an endpoint and the workload declares none'
        : `the reference omits an endpoint and ${entries.length} candidates elect no primary`,
  };
}

/** Component spec §5.4 — probe endpoint resolution and the HTTP-family rule. */
export function checkHealthProbes(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const workload = record(specOf(doc)['workload']);
    const health = record(workload['health']);

    for (const probe of ['startup', 'readiness', 'liveness']) {
      const block = health[probe];
      if (!isRecord(block)) continue;

      const where = `${rel(componentPath)} /spec/workload/health/${probe}/endpoint`;
      const resolved = resolveEndpoint(workload, block['endpoint']);

      if (!resolved.ok) {
        found.push(diag(resolved.code, where, resolved.message));
        continue;
      }

      // Every probe polls an HTTP path, so an endpoint whose protocol is TCP or
      // UDP has nothing for one to poll.
      const protocol = resolved.endpoint['protocol'];
      if (typeof protocol === 'string' && !HTTP_FAMILY.has(protocol)) {
        found.push(
          diag(
            'ERR_ENDPOINT_NOT_HTTP',
            where,
            `the probe resolves to endpoint ${JSON.stringify(resolved.name)}, whose protocol is ${protocol}`,
          ),
        );
      }
    }
  }

  return found;
}

/* ------------------------------------------------------------- connections */

const inputsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(record(record(component ?? {})['spec'])['contract'])['inputs'] as Record<string, unknown>;

const outputsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(record(record(component ?? {})['spec'])['contract'])['outputs'] as Record<string, unknown>;

const isRequired = (input: Record<string, unknown>): boolean => input['required'] !== false;

const isExternal = (component: Record<string, unknown> | null): boolean =>
  isRecord(record(record(component ?? {})['spec'])['external']);

const workloadOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(record(component ?? {})['spec'])['workload'] as Record<string, unknown>;

/** The keys of the inputs a connection on this node fills. A wired input is never covered. */
const wiredInputs = (node: Record<string, unknown>): Set<string> =>
  new Set(Object.keys(record(node['connections'])));

/* ---------------------------------------------------------- output inputs */

/**
 * Component spec §6.2 — COMP-OUT-002.
 *
 * An `INPUT` output republishes one of its own component's inputs, and the name
 * has to resolve. That the input is not also wired is BP-CONN-002, decided by
 * the blueprint: a component cannot tell which of its inputs a composition
 * wires, so it is not the document that can enforce the invariant.
 */
export function checkOutputInputReferences(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const inputs = inputsOf(doc.value);

    for (const [outputName, rawOutput] of Object.entries(outputsOf(doc.value))) {
      const output = record(rawOutput);
      if (output['valueFrom'] !== 'INPUT') continue;

      const named = output['input'];
      const where = `${rel(componentPath)} /spec/contract/outputs/${outputName}/input`;
      const input = typeof named === 'string' ? inputs[named] : undefined;

      if (!isRecord(input)) {
        found.push(diag('ERR_UNKNOWN_INPUT_REFERENCE', where, `${JSON.stringify(named)} names no input this component declares`));
      }
    }
  }

  return found;
}

/* ------------------------------------------------------------ node compute */

/**
 * Blueprint spec §4.3 — BP-NODE-002. `size` is null if and only if the node's
 * component is external. Silent where the component cannot be read offline,
 * because whether it is external is exactly what an unread component hides.
 */
export function checkNodeCompute(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const found: Diagnostic[] = [];
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;

    const runsNothing = binding.node['size'] === null;
    const external = isExternal(binding.component);
    if (runsNothing === external) continue;

    found.push(
      diag(
        'ERR_CONFLICTING_NODE_COMPUTE',
        `${blueprint.label} /spec/components/${binding.name}/size`,
        external
          ? `the component ${JSON.stringify(binding.reference)} is external and runs nothing, so the node names no Compute Profile — write size: null`
          : `the component ${JSON.stringify(binding.reference)} runs a workload, so size: null leaves it nowhere to run`,
      ),
    );
  }

  return found;
}

/** Blueprint spec §4.2. */
export function checkConnections(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const found: Diagnostic[] = [];
  const byName = new Map(context.nodes.map((binding) => [binding.name, binding]));

  for (const consumer of context.nodes) {
    const connections = record(consumer.node['connections']);
    const consumerInputs = inputsOf(consumer.component);

    for (const [inputKey, rawConnection] of Object.entries(connections)) {
      const connection = record(rawConnection);
      const where = `${blueprint.label} /spec/components/${consumer.name}/connections/${inputKey}`;

      // The consumer end is named rather than written: the map key is the input
      // being filled. A wire whose two ends are each checked and whose consumer
      // end is not is a wire that can be misspelled at one end only.
      const consumerInput = consumerInputs[inputKey];
      if (!consumer.unreadable && !isRecord(consumerInput)) {
        found.push(diag('ERR_UNKNOWN_INPUT', where, `${JSON.stringify(inputKey)} names no input of the component ${JSON.stringify(consumer.name)} deploys`));
      }

      // BP-CONN-002. Component §6.2 makes every output resolvable before any
      // edge is bound, which is what lets §4.2's legal cycles resolve. An output
      // reading a wired input would depend on an inbound edge; the component
      // cannot tell which inputs a composition wires, so this document decides.
      const republishes = Object.entries(outputsOf(consumer.component)).find(
        ([, rawOutput]) => record(rawOutput)['valueFrom'] === 'INPUT' && record(rawOutput)['input'] === inputKey,
      );
      if (republishes) {
        found.push(
          diag(
            'ERR_INPUT_NOT_CONNECTABLE',
            where,
            `output ${JSON.stringify(republishes[0])} republishes input ${JSON.stringify(inputKey)}, so a wire filling it would make that output depend on an inbound edge`,
          ),
        );
      }

      const fromNode = connection['fromNode'];
      const producer = typeof fromNode === 'string' ? byName.get(fromNode) : undefined;
      if (!producer) {
        found.push(diag('ERR_UNKNOWN_NODE', `${where}/fromNode`, `${JSON.stringify(fromNode)} names no node in this blueprint`));
        continue;
      }
      if (producer.unreadable) continue; // its outputs were never readable

      const fromOutput = connection['fromOutput'];
      const output = typeof fromOutput === 'string' ? outputsOf(producer.component)[fromOutput] : undefined;
      if (!isRecord(output)) {
        found.push(
          diag('ERR_UNKNOWN_OUTPUT', `${where}/fromOutput`, `${JSON.stringify(fromOutput)} names no output of the component ${JSON.stringify(producer.name)} deploys`),
        );
        continue;
      }

      if (!isRecord(consumerInput)) continue;

      const producerSchema = record(output['schema']);
      const consumerSchema = record(consumerInput['schema']);

      // No widening, in either direction. Everything is a string by the time it
      // reaches a container, but *which* string is a decision each language's
      // formatter makes differently.
      if (producerSchema['type'] !== consumerSchema['type']) {
        found.push(
          diag(
            'ERR_INCOMPATIBLE_TYPE',
            `${where}/fromOutput`,
            `output type ${JSON.stringify(producerSchema['type'])} does not equal input type ${JSON.stringify(consumerSchema['type'])}`,
          ),
        );
      }

      // A consumer declaring none accepts any producer. A consumer declaring an
      // identifier requires the same one — including rejecting a producer that
      // declares none, because an unconstrained producer does not satisfy a
      // constrained consumer. An equality of two strings, so it stays offline:
      // whether the identifier is registered is `capability`.
      const consumerTag = consumerSchema['resourceType'] ?? null;
      const producerTag = producerSchema['resourceType'] ?? null;
      if (consumerTag !== null && producerTag !== consumerTag) {
        found.push(
          diag(
            'ERR_INCOMPATIBLE_RESOURCE_TYPE',
            `${where}/fromOutput`,
            `input requires resourceType ${JSON.stringify(consumerTag)} but the output declares ${JSON.stringify(producerTag)}`,
          ),
        );
      }
    }
  }

  return found;
}

/* -------------------------------------------------------------- parameters */

/** One input a parameter covers, on the node declaring it. */
type Coverage = { node: string; binding: NodeBinding; input: Record<string, unknown> };

/**
 * Blueprint spec §5.1 — binding is by key. A parameter covers every input whose
 * key equals `toInput ?? <the parameter's own key>`, on every node `toNode`
 * admits, **where no connection on that node fills it**.
 *
 * There is no precedence: a wired input is never covered, so a wire and a field
 * never claim one value, and a composition wiring node A's `apiKey` while asking
 * the user for node B's stays expressible.
 */
function coverageOf(context: SemanticContext, key: string, parameter: Record<string, unknown>): Coverage[] {
  const inputKey = typeof parameter['toInput'] === 'string' ? parameter['toInput'] : key;
  const toNode = typeof parameter['toNode'] === 'string' ? parameter['toNode'] : null;

  const covered: Coverage[] = [];
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;
    if (toNode !== null && binding.name !== toNode) continue;
    const input = inputsOf(binding.component)[inputKey];
    if (!isRecord(input)) continue;
    if (wiredInputs(binding.node).has(inputKey)) continue;
    covered.push({ node: binding.name, binding, input });
  }
  return covered;
}

/** `<node>/<inputKey>` — neither grammar admits a slash, so the join is unambiguous. */
const satisfied = (node: string, inputKey: string): string => `${node}/${inputKey}`;

/**
 * Blueprint spec §5 — the install form, always authored. Nothing derives a field
 * from a component any more, so absent and empty both mean a form with no
 * fields, and §5.1 rejects that for any composition with a required input left
 * unsupplied.
 *
 * BP-PARAM-001..008 and BP-UI-003, plus core §5.2's reference grammar at the one
 * position this family opens to references.
 */
export function checkParameters(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const parameters = record(specOf(blueprint)['parameters']);
  const found: Diagnostic[] = [];

  // ERR_UNBOUND_PARAMETER asserts that *no* node has a covered input, which is a
  // claim about every node's inputs. Where any node's component is unreadable the
  // claim stops being decidable, and a diagnostic an implementation cannot
  // substantiate is worse than a silence. The equality and satisfaction rules are
  // the mirror image: they read only the inputs in front of them.
  const everyNodeReadable = context.nodes.every((binding) => !binding.unreadable);

  /** Every input some parameter covers — read by BP-PARAM-003 below. */
  const covered = new Set<string>();

  for (const [key, rawParameter] of Object.entries(parameters)) {
    const parameter = record(rawParameter);
    const at = `${blueprint.label} /spec/parameters/${key}`;
    const inputKey = typeof parameter['toInput'] === 'string' ? parameter['toInput'] : key;
    const toNode = typeof parameter['toNode'] === 'string' ? parameter['toNode'] : null;

    // BP-PARAM-006. Both narrowing failures are the coverage failure below,
    // caught one step earlier and at the field that caused it: a parameter whose
    // `toNode` is a typo covers nothing, and "this names no node" says why.
    if (toNode !== null && !context.nodes.some((binding) => binding.name === toNode)) {
      found.push(diag('ERR_UNKNOWN_NODE', `${at}/toNode`, `${JSON.stringify(toNode)} names no node in this blueprint`));
      continue;
    }

    const coverage = coverageOf(context, key, parameter);
    for (const one of coverage) covered.add(satisfied(one.node, inputKey));

    if (coverage.length === 0) {
      if (!everyNodeReadable) continue;

      // BP-PARAM-007. Distinguished from BP-PARAM-001 by whether the key names
      // an input at all: one that does, covered nowhere, is wired everywhere.
      const inScope = context.nodes.filter((binding) => toNode === null || binding.name === toNode);
      const declared = inScope.some((binding) => isRecord(inputsOf(binding.component)[inputKey]));
      if (typeof parameter['toInput'] === 'string' && !declared) {
        found.push(
          diag('ERR_UNKNOWN_INPUT', `${at}/toInput`, `${JSON.stringify(inputKey)} names no input of any node this parameter covers`),
        );
      } else {
        found.push(diag('ERR_UNBOUND_PARAMETER', at, 'the install form asks a deploying user for a value that no node ever reads'));
      }
      continue;
    }

    // BP-PARAM-002. Two declarations are equal when their `schema` blocks are
    // equal once defaults are applied. `description`, `required` and `target` are
    // not compared: they say what each component does with the value, not what
    // the value is. Reported at the field that joined them.
    const schemas = coverage.map((one) => ({
      node: one.node,
      schema: normaliseValueSchema(record(one.input['schema']), context.valueSchemaDefaults),
    }));
    const first = schemas[0]!;
    const conflict = schemas.find((one) => !deepEqual(first.schema, one.schema));
    if (conflict) {
      found.push(
        diag(
          'ERR_CONFLICTING_INPUT_SCHEMA',
          at,
          `input ${JSON.stringify(inputKey)} is declared by ${JSON.stringify(first.node)} and ${JSON.stringify(conflict.node)} with different schemas`,
        ),
      );
    }

    // BP-PARAM-004. A generator mints a credential, and a value not marked
    // sensitive is echoed back into logs and interfaces. Whether it is sensitive
    // is what the covered input declares, so the rule reads it there.
    if (isRecord(parameter['generator'])) {
      const exposed = coverage.find((one) => record(one.input['schema'])['sensitive'] !== true);
      if (exposed) {
        found.push(
          diag(
            'ERR_GENERATED_INPUT_NOT_SENSITIVE',
            `${at}/generator`,
            `the parameter is generated, but input ${JSON.stringify(inputKey)} on node ${JSON.stringify(exposed.node)} is not marked sensitive`,
          ),
        );
      }
    }

    // BP-UI-003. The members are declared by the inputs the parameter covers, so
    // where they disagree there is no one `enum` to compare against.
    const enumLabels = record(record(parameter['ui'])['enumLabels']);
    if (!conflict && Object.keys(enumLabels).length > 0) {
      const members = new Set((Array.isArray(first.schema['enum']) ? first.schema['enum'] : []) as unknown[]);
      for (const member of Object.keys(enumLabels)) {
        if (!members.has(member)) {
          found.push(
            diag(
              'ERR_UNKNOWN_ENUM_MEMBER',
              `${at}/ui/enumLabels/${member}`,
              `${JSON.stringify(member)} names no member of the covered inputs' enum`,
            ),
          );
        }
      }
    }

    if (typeof parameter['default'] === 'string') {
      found.push(...checkDefaultReferences(parameter['default'], `${at}/default`, coverage));
    }
  }

  // BP-PARAM-003. A required input whose schema declares a default has a value
  // already; every other one MUST be filled by a connection on its node or
  // covered by a parameter. Reported at the node that would start without it,
  // and the message names the input, since a JSON Pointer addresses this document
  // and the input is not in it.
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;
    const wired = wiredInputs(binding.node);
    for (const [inputKey, rawInput] of Object.entries(inputsOf(binding.component))) {
      const input = record(rawInput);
      if (!isRequired(input)) continue;
      if ((record(input['schema'])['default'] ?? null) !== null) continue;
      if (wired.has(inputKey) || covered.has(satisfied(binding.name, inputKey))) continue;
      found.push(
        diag(
          'ERR_UNSATISFIED_REQUIRED_INPUT',
          `${blueprint.label} /spec/components/${binding.name}`,
          `required input ${JSON.stringify(inputKey)} is neither wired nor covered by a parameter`,
        ),
      );
    }
  }

  return found;
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

/**
 * Blueprint spec §5.2 — BP-REF-001, BP-PARAM-005 and BP-PARAM-008, plus core
 * §5.2's CORE-REF-001 and CORE-REF-002, at the one position this family opens to
 * a reference. Every diagnostic is reported at the parameter's `default`, once
 * however the reference is written.
 */
function checkDefaultReferences(value: string, where: string, coverage: Coverage[]): Diagnostic[] {
  const found: Diagnostic[] = [];
  const { references, malformed } = scanReferences(value);

  for (const raw of malformed) {
    // Treating it as text would carry the mistake into the deployed thing as the
    // literal characters, where whatever reads the value discovers it.
    found.push(diag('ERR_MALFORMED_REFERENCE', where, `${JSON.stringify(raw)} does not begin a well-formed reference`));
  }

  for (const reference of references) {
    if (!RESERVED_NAMESPACES.has(reference.namespace)) {
      found.push(
        diag('ERR_UNKNOWN_REFERENCE_NAMESPACE', where, `${JSON.stringify(reference.namespace)} is not a namespace core §5.2 reserves`),
      );
      continue;
    }
    if (reference.namespace !== 'self') {
      found.push(
        diag(
          'ERR_REFERENCE_NOT_IN_SCOPE',
          where,
          `namespace ${JSON.stringify(reference.namespace)} is reserved, and a parameter default admits only self`,
        ),
      );
      continue;
    }

    // BP-PARAM-008. A parameter is one field on one form showing one value, and
    // two nodes have two addresses. `toNode` is how an author says which.
    if (coverage.length !== 1) {
      found.push(
        diag('ERR_AMBIGUOUS_SELF_REFERENCE', where, `${reference.raw} reads self, but the parameter covers ${coverage.length} nodes`),
      );
      continue;
    }

    // BP-PARAM-005. v1 names four paths; a fifth is not a rule this contract
    // declares a diagnostic for, so it passes in silence rather than inventing one.
    const [head, endpoint] = reference.path;
    const wanted = head === undefined ? undefined : SELF_PATH_ADDRESS_FORM[head];
    if (wanted === undefined) continue;

    const one = coverage[0]!;
    const resolved = resolveEndpoint(workloadOf(one.binding.component), endpoint);
    if (!resolved.ok) {
      // A node deploying an external component declares no endpoint and elects
      // none, so a reference covering one lands here: it has no addressing to read.
      found.push(diag(resolved.code, where, resolved.message));
      continue;
    }

    // Every path derives an externally reachable address, and a PRIVATE endpoint
    // has none to give.
    if (resolved.endpoint['visibility'] !== 'PUBLIC') {
      found.push(diag('ERR_ENDPOINT_NOT_PUBLIC', where, `endpoint ${JSON.stringify(resolved.name)} is PRIVATE`));
      continue;
    }

    const protocol = resolved.endpoint['protocol'];
    if (typeof protocol !== 'string') continue;

    if (wanted === 'url' && !HTTP_FAMILY.has(protocol)) {
      found.push(
        diag('ERR_ENDPOINT_NOT_HTTP', where, `self.${head} reads a URL, but endpoint ${JSON.stringify(resolved.name)} speaks ${protocol}`),
      );
    } else if (wanted === 'host-port' && !L4_FAMILY.has(protocol)) {
      // An HTTP-family endpoint is published through the shared ingress rather
      // than on a port allocated to it, so the path would yield the ingress
      // address on the ingress port: true, and not what the author asked for.
      found.push(
        diag(
          'ERR_ENDPOINT_NOT_L4',
          where,
          `self.${head} reads a host:port address, but endpoint ${JSON.stringify(resolved.name)} speaks ${protocol} and is published through the shared ingress`,
        ),
      );
    }
  }

  return found;
}

/**
 * Two declarations are identical when their `schema` blocks are equal **once
 * defaults are applied**. The defaults come out of the fetched component bundle
 * rather than a copy held here.
 */
export function normaliseValueSchema(
  schema: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const normalised: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(schema)])) {
    normalised[key] = schema[key] ?? defaults[key] ?? null;
  }
  return normalised;
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

/** ComponentValueSchema property defaults, read out of the fetched component bundle. */
export function valueSchemaDefaultsFrom(componentSchema: Record<string, unknown>): Record<string, unknown> {
  const defs = componentSchema['$defs'] as Record<string, Record<string, unknown>> | undefined;
  const properties = defs?.['ComponentValueSchema']?.['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) {
    throw new Error(
      'the component schema no longer publishes $defs.ComponentValueSchema.properties; ' +
        'the spec has changed shape and this module needs updating',
    );
  }
  return Object.fromEntries(Object.entries(properties).map(([key, node]) => [key, node['default'] ?? null]));
}
