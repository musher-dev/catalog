/**
 * Fetches the normative JSON Schema bundles from the public `musher-dev/spec`
 * repository at run time.
 *
 * The catalog is not the authority on what a valid item looks like; the spec is.
 * A vendored or disk-cached copy of its schemas is a second authority that
 * drifts, and a stale one passes a corpus the live spec would reject — silently,
 * which is the failure this module exists to prevent. So the schemas are fetched
 * over the network on every run and memoised only for the lifetime of the
 * process.
 *
 * There is exactly one source, and it is constant:
 *
 *   https://raw.githubusercontent.com/musher-dev/spec/main/
 *     specifications/<family>/v1/schemas/dist/<family>.schema.json
 *
 * `main` is the tip of the contract, and the tip is what this corpus is held to.
 * `musher-dev/spec` is public, so this is fetched with no credential — nothing
 * here reads a token, and none should be configured.
 *
 * Nothing about the source is configurable. A knob for the ref, a mirror, or a
 * local checkout would each be a second answer to "what is the contract", which
 * is the thing this module exists to have only one of.
 */
import { createHash } from 'node:crypto';
import ajvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

// Ajv 8 ships CommonJS with no `exports` map, so under module:nodenext TypeScript
// types the default import as the module namespace while Node hands back the class
// itself. Re-point the binding at the constructor the namespace declares.
const Ajv2020 = ajvModule as unknown as typeof ajvModule.default;

export const FAMILIES = ['listing', 'blueprint', 'component'] as const;
export type Family = (typeof FAMILIES)[number];

/** The `kind` discriminator each family's documents must carry. */
export const KIND_OF: Record<Family, string> = {
  listing: 'LISTING',
  blueprint: 'BLUEPRINT',
  component: 'COMPONENT',
};

const TIMEOUT_MS = Number(process.env.MUSHER_SPEC_TIMEOUT_MS ?? 15_000);

/** The one place a schema comes from. */
const schemaUrl = (family: Family): string =>
  'https://raw.githubusercontent.com/musher-dev/spec/main' +
  `/specifications/${family}/v1/schemas/dist/${family}.schema.json`;

async function read(url: string): Promise<string> {
  // No credential is sent, and no code path here reads one. `musher-dev/spec` is
  // public; a token attached to a public read is a secret handed to a host that
  // never asked for one, and it would make the suite pass on a machine that has
  // it and fail on one that does not.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/schema+json, application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return await response.text();
}

/** Every `$ref` in a published bundle resolves inside `$defs`; anything else is external. */
export function externalRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) externalRefs(child, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) found.push(value);
      else externalRefs(value, found);
    }
  }
  return found;
}

/**
 * Sanity on the artifact itself, before the corpus is validated with it. A fetch
 * that succeeds and returns an error page, a redirect stub, or another family's
 * bundle would otherwise validate every item against nothing at all.
 */
function assertIsFamilyBundle(family: Family, schema: Record<string, unknown>, origin: string): void {
  const where = `${family} schema from ${origin}`;

  if (schema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error(`${where}: expected a JSON Schema 2020-12 document, got $schema=${String(schema['$schema'])}`);
  }

  // The `kind` discriminator is what establishes the family, and it is the only
  // thing that does. Matching `$id` as well would assert the same fact twice and
  // pin a hostname this module does not read from.
  const properties = schema['properties'] as Record<string, { const?: unknown }> | undefined;
  const kind = properties?.['kind']?.const;
  if (kind !== KIND_OF[family]) {
    throw new Error(`${where}: root kind discriminator is ${JSON.stringify(kind)}, expected ${KIND_OF[family]}`);
  }

  // spec README: "Every published schema is a self-contained compound document."
  const external = externalRefs(schema);
  if (external.length > 0) {
    throw new Error(`${where}: not self-contained — external $ref(s): ${external.join(', ')}`);
  }
}

export type FetchedSchema = {
  family: Family;
  schema: Record<string, unknown>;
  origin: string;
  sha256: string;
};

const inFlight = new Map<Family, Promise<FetchedSchema>>();

/** Fetch (once per process) and structurally vet one family's bundle. */
export function loadSchema(family: Family): Promise<FetchedSchema> {
  let pending = inFlight.get(family);
  if (!pending) {
    pending = resolveSchema(family);
    inFlight.set(family, pending);
  }
  return pending;
}

export const loadAllSchemas = (): Promise<FetchedSchema[]> => Promise.all(FAMILIES.map(loadSchema));

async function resolveSchema(family: Family): Promise<FetchedSchema> {
  const url = schemaUrl(family);

  let text: string;
  try {
    text = await read(url);
  } catch (error) {
    throw new Error(
      `Could not fetch the ${family} schema from ${url}: ${(error as Error).message}\n` +
        'These tests validate against musher-dev/spec, so they need network access to ' +
        'raw.githubusercontent.com. There is no fallback source and no cache: a second ' +
        'answer to "what is the contract" is the thing this suite exists to not have.',
    );
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${family} schema from ${url} is not valid JSON: ${(error as Error).message}`);
  }
  assertIsFamilyBundle(family, schema, url);

  return {
    family,
    schema,
    origin: url,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

/**
 * `validateFormats: false` is not a convenience. Component spec §7.2 makes the
 * JSON Schema `format` keyword an annotation that asserts nothing, and forbids a
 * validator from rejecting a document because a value fails one.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

const validators = new Map<Family, ValidateFunction>();

export async function validatorFor(family: Family): Promise<ValidateFunction> {
  let validate = validators.get(family);
  if (!validate) {
    const { schema } = await loadSchema(family);
    validate = ajv.compile(schema);
    validators.set(family, validate);
  }
  return validate;
}

/** Ajv errors as one readable block, deepest instance path first so the specific cause leads. */
export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice()
    .sort((a, b) => b.instancePath.length - a.instancePath.length)
    .map((error) => {
      const at = error.instancePath === '' ? '/' : error.instancePath;
      const params = Object.entries(error.params ?? {})
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      return `  ${at} ${error.message}${params ? ` (${params})` : ''}`;
    })
    .join('\n');
}
