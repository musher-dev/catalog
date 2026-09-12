/**
 * The `semantic` validation phase — the rules JSON Schema cannot express.
 *
 * Component spec §7 splits validation into four phases and forbids reporting a
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

/** Which address form each platform-default source reads (component spec §6.1). */
const SOURCE_ADDRESS_FORM: Record<string, 'url' | 'host-port'> = {
  PUBLIC_URL: 'url',
  PUBLIC_HOSTNAME: 'url',
  PUBLIC_ADDRESS: 'host-port',
  PUBLIC_PORT: 'host-port',
};

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

/** BP-ID-001, BP-ID-002, LIST-ID-001, LIST-ID-002. */
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

  // The rule takes two operands. A COMPONENT item holding no blueprint has no
  // second one — not a different one — so it goes silent rather than failing.
  // The field is `revision` and the code is still ERR_VERSION_MISMATCH: ADR 0007
  // §3 renamed the field and left the diagnostic, which the spec's §7 table keeps.
  const listingRevision = metadataOf(documents.listing)['revision'];
  const blueprintRevision = metadataOf(documents.blueprint)['revision'];
  if (documents.listing?.value && documents.blueprint?.value && listingRevision !== blueprintRevision) {
    found.push(
      diag(
        'ERR_VERSION_MISMATCH',
        `${documents.blueprint.label} /metadata/revision`,
        `blueprint revision ${JSON.stringify(blueprintRevision)} disagrees with listing revision ${JSON.stringify(listingRevision)}`,
      ),
    );
  }

  return found;
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

/** Component spec §6.1 — platform-default endpoint resolution and the address-form pairing. */
export function checkPlatformDefaults(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const [componentPath, doc] of context.documents.components) {
    if (!doc.value) continue;
    const spec = specOf(doc);
    const workload = record(spec['workload']);
    const inputs = record(record(spec['contract'])['inputs']);

    for (const [inputName, rawInput] of Object.entries(inputs)) {
      const platformDefault = record(rawInput)['platformDefault'];
      if (!isRecord(platformDefault)) continue;

      const where = `${rel(componentPath)} /spec/contract/inputs/${inputName}/platformDefault`;
      const resolved = resolveEndpoint(workload, platformDefault['endpoint']);

      if (!resolved.ok) {
        found.push(diag(resolved.code, `${where}/endpoint`, resolved.message));
        continue;
      }

      // Every source derives an externally reachable address, and a PRIVATE
      // endpoint has none to give.
      if (resolved.endpoint['visibility'] !== 'PUBLIC') {
        found.push(
          diag('ERR_ENDPOINT_NOT_PUBLIC', `${where}/endpoint`, `endpoint ${JSON.stringify(resolved.name)} is PRIVATE`),
        );
        continue;
      }

      const source = platformDefault['source'];
      const wanted = typeof source === 'string' ? SOURCE_ADDRESS_FORM[source] : undefined;
      const protocol = resolved.endpoint['protocol'];
      if (wanted === undefined || typeof protocol !== 'string') continue;

      if (wanted === 'url' && !HTTP_FAMILY.has(protocol)) {
        found.push(
          diag(
            'ERR_ENDPOINT_NOT_HTTP',
            `${where}/source`,
            `${source} reads a URL, but endpoint ${JSON.stringify(resolved.name)} speaks ${protocol}`,
          ),
        );
      } else if (wanted === 'host-port' && !L4_FAMILY.has(protocol)) {
        found.push(
          diag(
            'ERR_ENDPOINT_NOT_L4',
            `${where}/source`,
            `${source} reads a host:port address, but endpoint ${JSON.stringify(resolved.name)} speaks ${protocol} and is published through the shared ingress`,
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

const suppliedBy = (input: Record<string, unknown>): string =>
  typeof input['suppliedBy'] === 'string' ? input['suppliedBy'] : 'USER';

const isRequired = (input: Record<string, unknown>): boolean => input['required'] !== false;

const isExternal = (component: Record<string, unknown> | null): boolean =>
  isRecord(record(record(component ?? {})['spec'])['external']);

/* ---------------------------------------------------------- output inputs */

/**
 * Component spec §6.2 — COMP-OUT-002 and COMP-OUT-003.
 *
 * An `INPUT` output republishes one of its own component's inputs. The name has
 * to resolve, and the input must not be `CONNECTION`-supplied: that one resolves
 * only after an edge is bound, and an output reading it would make blueprint
 * §4.2's legal cycles unresolvable rather than merely cyclic.
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
      } else if (suppliedBy(input) === 'CONNECTION') {
        found.push(
          diag(
            'ERR_INPUT_NOT_REFERENCEABLE',
            where,
            `input ${JSON.stringify(named)} is CONNECTION-supplied, so it resolves only after an edge is bound`,
          ),
        );
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

      // BP-CONN-001. A wire and the install form would otherwise both claim one
      // value with nothing saying which arrives — and component §6.2's INPUT
      // output is sound only because a USER input cannot arrive over an edge.
      if (isRecord(consumerInput) && suppliedBy(consumerInput) !== 'CONNECTION') {
        found.push(
          diag(
            'ERR_INPUT_NOT_CONNECTABLE',
            where,
            `input ${JSON.stringify(inputKey)} is supplied by ${suppliedBy(consumerInput)}, and a connection may fill only a CONNECTION input`,
          ),
        );
      }

      const fromRole = connection['fromRole'];
      const producer = typeof fromRole === 'string' ? byName.get(fromRole) : undefined;
      if (!producer) {
        found.push(diag('ERR_UNKNOWN_ROLE', `${where}/fromRole`, `${JSON.stringify(fromRole)} names no node in this blueprint`));
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

    // A required CONNECTION input is satisfied by a wire and by nothing else —
    // it never reaches the install form, so a graph that leaves one unwired has
    // no later chance to supply it.
    if (consumer.unreadable) continue;
    for (const [inputKey, rawInput] of Object.entries(consumerInputs)) {
      const input = record(rawInput);
      if (suppliedBy(input) !== 'CONNECTION' || !isRequired(input)) continue;
      if (!(inputKey in connections)) {
        found.push(
          diag(
            'ERR_UNWIRED_REQUIRED_INPUT',
            `${blueprint.label} /spec/components/${consumer.name}/connections`,
            `required CONNECTION input ${JSON.stringify(inputKey)} is satisfied by no connection`,
          ),
        );
      }
    }
  }

  return found;
}

/* -------------------------------------------------------------- parameters */

/** Blueprint spec §5.2 and §5.3. Absent and empty `parameters` both mean "derive". */
export function checkParameters(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint;
  if (!blueprint?.value) return [];

  const parameters = record(specOf(blueprint)['parameters']);
  return Object.keys(parameters).length === 0
    ? checkDerivedParameters(context)
    : checkAuthoredParameters(context, parameters);
}

/** ERR_CONFLICTING_INPUT_SCHEMA — first-wins in lexicographic node-name order. */
function checkDerivedParameters(context: SemanticContext): Diagnostic[] {
  const blueprint = context.documents.blueprint!;
  const found: Diagnostic[] = [];
  const taken = new Map<string, { node: string; schema: Record<string, unknown> }>();

  // Node name because it is the only total order the document itself supplies.
  const ordered = [...context.nodes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const binding of ordered) {
    if (binding.unreadable) continue;
    for (const [key, rawInput] of Object.entries(inputsOf(binding.component))) {
      const input = record(rawInput);
      if (suppliedBy(input) !== 'USER') continue; // never derived — satisfied by a wire

      const schema = normaliseValueSchema(record(input['schema']), context.valueSchemaDefaults);
      const first = taken.get(key);
      if (!first) {
        taken.set(key, { node: binding.name, schema });
        continue;
      }

      // An identical redeclaration is absorbed in silence — two components that
      // agree on what adminPassword is are not in conflict. `ui` and `required`
      // are not compared: they describe how a value is asked for, not what it is.
      if (!deepEqual(first.schema, schema)) {
        found.push(
          diag(
            'ERR_CONFLICTING_INPUT_SCHEMA',
            `${blueprint.label} /spec/components/${binding.name}`,
            `input ${JSON.stringify(key)} is declared by ${JSON.stringify(first.node)} and ${JSON.stringify(binding.name)} with different schemas`,
          ),
        );
      }
    }
  }

  return found;
}

/** ERR_UNBOUND_PARAMETER, ERR_UNCOVERED_REQUIRED_INPUT, ERR_INCOMPATIBLE_PARAMETER_TYPE. */
function checkAuthoredParameters(context: SemanticContext, parameters: Record<string, unknown>): Diagnostic[] {
  const blueprint = context.documents.blueprint!;
  const found: Diagnostic[] = [];

  // ERR_UNBOUND_PARAMETER asserts that *no* node declares the key, which is a
  // claim about every node's inputs. Where any node's component is unreadable the
  // claim stops being decidable, and a diagnostic an implementation cannot
  // substantiate is worse than a silence.
  const everyNodeReadable = context.nodes.every((binding) => !binding.unreadable);

  const userInputs = new Map<string, { node: string; input: Record<string, unknown> }[]>();
  for (const binding of context.nodes) {
    if (binding.unreadable) continue;
    for (const [key, rawInput] of Object.entries(inputsOf(binding.component))) {
      const input = record(rawInput);
      if (suppliedBy(input) !== 'USER') continue;
      const list = userInputs.get(key) ?? [];
      list.push({ node: binding.name, input });
      userInputs.set(key, list);
    }
  }

  for (const [key, rawParameter] of Object.entries(parameters)) {
    const parameter = record(rawParameter);
    const covered = userInputs.get(key);

    if (!covered) {
      if (everyNodeReadable) {
        found.push(
          diag(
            'ERR_UNBOUND_PARAMETER',
            `${blueprint.label} /spec/parameters/${key}`,
            'the install form asks a deploying user for a value that no node ever reads',
          ),
        );
      }
      continue;
    }

    const parameterType = record(parameter['schema'])['type'];
    const parameterTag = record(parameter['schema'])['resourceType'] ?? null;
    for (const { node, input } of covered) {
      const inputType = record(input['schema'])['type'];
      if (parameterType !== inputType) {
        found.push(
          diag(
            'ERR_INCOMPATIBLE_PARAMETER_TYPE',
            `${blueprint.label} /spec/parameters/${key}/schema/type`,
            `parameter type ${JSON.stringify(parameterType)} disagrees with input type ${JSON.stringify(inputType)} on node ${JSON.stringify(node)}`,
          ),
        );
      }

      // The opposite asymmetry to a wire's. A parameter naming no identifier
      // covers an input that names one — an install form is not where a value
      // acquires a tag. Naming a *different* one is a form collecting the wrong value.
      const inputTag = record(input['schema'])['resourceType'] ?? null;
      if (parameterTag !== null && parameterTag !== inputTag) {
        found.push(
          diag(
            'ERR_INCOMPATIBLE_PARAMETER_RESOURCE_TYPE',
            `${blueprint.label} /spec/parameters/${key}/schema/resourceType`,
            `parameter resourceType ${JSON.stringify(parameterTag)} disagrees with input resourceType ${JSON.stringify(inputTag)} on node ${JSON.stringify(node)}`,
          ),
        );
      }
    }
  }

  // An input the deploying user must supply must be covered, and covered by a
  // parameter that will actually ask for it. `required` reads in opposite
  // directions on the two documents, so this tests what a parameter guarantees
  // rather than only which keys it names.
  for (const [key, declarations] of userInputs) {
    for (const { node, input } of declarations) {
      if (!mustBeCovered(input)) continue;
      const parameter = parameters[key];
      if (isRecord(parameter) && guaranteesValue(parameter)) continue;
      found.push(
        diag(
          'ERR_UNCOVERED_REQUIRED_INPUT',
          `${blueprint.label} /spec/parameters`,
          `input ${JSON.stringify(key)} on node ${JSON.stringify(node)} must be supplied by the deploying user, and no parameter guarantees it a value`,
        ),
      );
    }
  }

  return found;
}

/** Blueprint spec §5.3 — the five properties that make an input one the user must supply. */
function mustBeCovered(input: Record<string, unknown>): boolean {
  return (
    suppliedBy(input) === 'USER' &&
    isRequired(input) &&
    (input['generator'] ?? null) === null &&
    (input['platformDefault'] ?? null) === null &&
    (record(input['schema'])['default'] ?? null) === null
  );
}

/**
 * A parameter covers such an input only if it guarantees a value. A platform
 * default guarantees one for the reason a generator does: the value arrives
 * without the deploying user supplying it.
 */
function guaranteesValue(parameter: Record<string, unknown>): boolean {
  return (
    parameter['required'] === true ||
    (parameter['generator'] ?? null) !== null ||
    (parameter['platformDefault'] ?? null) !== null ||
    (record(parameter['schema'])['default'] ?? null) !== null
  );
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
