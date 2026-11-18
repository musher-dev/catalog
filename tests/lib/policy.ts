/**
 * The catalog's own policy — rules this repository holds its items to on top
 * of the specification.
 *
 * Nothing here is a spec rule, and nothing here may move into `semantic.ts`:
 * `SEMANTIC_CHECKS` also runs against the specification's conformance corpus,
 * and that corpus is right to accept every document these rules reject. A
 * `targetPort: 80` is structurally valid (COMP-EP-019 is an `admission` rule);
 * an input that is required by default is a choice the spec leaves to the
 * author. Each rule below is either an obligation the platform enforces only
 * at sync or deploy time, so an offline run would otherwise pass an item the
 * first live attempt rejects, or a convention this catalog keeps so that a
 * class of defect it has already shipped once cannot ship again.
 *
 * Codes are `CATALOG_*`, so a failure can never be mistaken for a normative
 * diagnostic. A finding is anchored at `items/<slug>/<file>#<JSON pointer>`,
 * which is also the key a deliberate exception is recorded under
 * (`tests/policy-exceptions.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { isRecord, type LoadedDocument } from './catalog.ts';
import { declaredMediaPaths } from './media.ts';
import { categoryOf, endpointsOf, inputsOf, isConnectionInput, record, workloadOf } from './model.ts';
import { rel } from './paths.ts';
import type { Diagnostic, SemanticContext } from './semantic.ts';

const at = (file: string, pointer: string): string => `${rel(file)}#${pointer}`;
const diag = (code: string, where: string, message: string): Diagnostic => ({ code, where, message });

/** RFC 6901 — one reference token. */
const token = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

const components = (context: SemanticContext): LoadedDocument[] =>
  [...context.documents.components.values()].filter((doc) => doc.value?.['kind'] === 'COMPONENT');

const itemTypeOf = (context: SemanticContext): string => {
  const type = record(context.documents.listing?.value?.['spec'])['itemType'];
  return typeof type === 'string' ? type : '';
};

/* ------------------------------------------------------- required inputs */

/**
 * CATALOG_REQUIRED_WITHOUT_DEFAULT — platform#3841.
 *
 * Component spec §6.1 makes an input required unless it says otherwise, and
 * the platform holds a deployment to that: an unbound required input is
 * `ERR_UNSATISFIED_REQUIRED_INPUT`. A blueprint node deploying a component is
 * checked for this offline (BP-PARAM-003), but nothing deploys a `COMPONENT`
 * item offline, so an input its author meant to be optional passed every test
 * and became a mandatory field at the first deploy. In a `COMPONENT` item every
 * value input therefore says which it is: `required`, either way, or a
 * `default`. A connection input is always required and cannot say so.
 *
 * The default is read from the vendored component bundle, so if the spec ever
 * flipped it, this rule would stop firing rather than start lying.
 */
export function checkRequiredWithoutDefault(context: SemanticContext): Diagnostic[] {
  if (itemTypeOf(context) !== 'COMPONENT' || context.inputDefaults['required'] !== true) return [];

  const found: Diagnostic[] = [];
  for (const doc of components(context)) {
    for (const [name, raw] of Object.entries(inputsOf(doc.value ?? null))) {
      const input = record(raw);
      if (isConnectionInput(input) || 'required' in input || 'default' in input) continue;
      found.push(
        diag(
          'CATALOG_REQUIRED_WITHOUT_DEFAULT',
          at(doc.path, `/spec/contract/inputs/${token(name)}`),
          `input ${JSON.stringify(name)} states neither \`required\` nor a \`default\`, so it is required (the spec's default) ` +
            'and every deployment of this item must bind it; say `required: true` if that is meant, or `required: false`',
        ),
      );
    }
  }
  return found;
}

/* ------------------------------------------------------------------- ports */

const targetPorts = (component: Record<string, unknown> | null): number[] =>
  Object.values(endpointsOf(component))
    .map((endpoint) => record(endpoint)['targetPort'])
    .filter((port): port is number => typeof port === 'number');

/**
 * CATALOG_PRIVILEGED_PORT — platform#3841, platform-api#1437.
 *
 * The platform runs no workload with the privilege to bind below 1024, and it
 * says so only at publish, as `422 ERR_PRIVILEGED_PORT`, after `validate` has
 * passed. COMP-EP-019 is an `admission` rule, so the semantic phase may not
 * report it; this catalog does.
 */
export function checkPrivilegedPort(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const doc of components(context)) {
    for (const [name, endpoint] of Object.entries(endpointsOf(doc.value ?? null))) {
      const port = record(endpoint)['targetPort'];
      if (typeof port === 'number' && port < 1024) {
        found.push(
          diag(
            'CATALOG_PRIVILEGED_PORT',
            at(doc.path, `/spec/workload/endpoints/${token(name)}/targetPort`),
            `endpoint ${JSON.stringify(name)} listens on ${port}; the platform rejects a target port below 1024 at publish (ERR_PRIVILEGED_PORT)`,
          ),
        );
      }
    }
  }
  return found;
}

const numericDefault = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[0-9]{1,5}$/.test(value)) return Number(value);
  return null;
};

/**
 * Inputs of the component at `componentPath` that some node deploying it binds
 * from another node's output. Such an input names a peer's port — a database's
 * 5432 — and not one this component listens on.
 */
function inputsBoundFromNodes(context: SemanticContext, componentPath: string): Set<string> {
  const names = new Set<string>();
  for (const binding of context.nodes) {
    if (binding.componentPath !== componentPath) continue;
    for (const [input, source] of Object.entries(record(binding.node['bindings']))) {
      if ('node' in record(source)) names.add(input);
    }
  }
  return names;
}

/**
 * CATALOG_PORT_INPUT_MISMATCH.
 *
 * When an image takes its listen port from the environment, the component
 * carries it as an input with a default, and the endpoint's `targetPort` has to
 * say the same number. Moving one without the other — the usual fix for a
 * privileged port — leaves the process listening where no endpoint routes.
 * An input whose name or environment variable ends in `PORT` and whose default
 * is a number is therefore one of its own component's target ports — unless a
 * node binds it from another node's output, which makes it a peer's port.
 */
export function checkPortInputMismatch(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const doc of components(context)) {
    const ports = targetPorts(doc.value ?? null);
    if (ports.length === 0) continue;
    const peerFed = inputsBoundFromNodes(context, doc.path);

    for (const [name, raw] of Object.entries(inputsOf(doc.value ?? null))) {
      const input = record(raw);
      if (peerFed.has(name)) continue;
      const envVar = record(input['target'])['envVar'];
      const named = /port$/i.test(name) || (typeof envVar === 'string' && /PORT$/.test(envVar));
      const value = numericDefault(input['default']);
      if (!named || value === null || ports.includes(value)) continue;

      found.push(
        diag(
          'CATALOG_PORT_INPUT_MISMATCH',
          at(doc.path, `/spec/contract/inputs/${token(name)}/default`),
          `input ${JSON.stringify(name)} defaults to port ${value}, but the component's endpoints listen on ${ports.join(', ')}`,
        ),
      );
    }
  }
  return found;
}

/* --------------------------------------------------------------- readiness */

/**
 * CATALOG_SERVICE_WITHOUT_READINESS.
 *
 * The spec demands a readiness probe only where an HTTP endpoint is public
 * (COMP-EP-003). A private SERVICE without one is reported ready the moment it
 * starts, so every consumer races its first boot. Probes are HTTP-only today
 * (platform-api#1446), so a service that answers no HTTP may stand without
 * one — through an exception that cites that issue, never silently.
 */
export function checkServiceReadiness(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const doc of components(context)) {
    if (categoryOf(doc.value ?? null) !== 'SERVICE') continue;
    const health = record(workloadOf(doc.value ?? null)['health']);
    if (isRecord(health['readiness'])) continue;
    found.push(
      diag(
        'CATALOG_SERVICE_WITHOUT_READINESS',
        at(doc.path, '/spec/workload/health/readiness'),
        'a SERVICE with no readiness probe is ready the moment it starts, so whatever depends on it races its boot',
      ),
    );
  }
  return found;
}

/* ------------------------------------------------------------------- media */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, which the format fixes as the first. */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Listing spec §5 — sync's `ERR_MEDIA_DIMENSIONS` bounds. */
export const ICON_MIN_PX = 256;
export const SCREENSHOT_MAX_PX = 4096;

/**
 * CATALOG_ICON_SIZE and CATALOG_SCREENSHOT_SIZE.
 *
 * Sync rejects an icon that is not square or is under 256 px a side, and a
 * screenshot over 4096 px a side (`ERR_MEDIA_DIMENSIONS`, an `admission` rule
 * the semantic phase may not report). Every image this catalog ships is a PNG,
 * whose header states both, so this reads them; any other format is reported,
 * because a dimension this suite cannot read is one it cannot vouch for.
 */
export function checkMediaDimensions(context: SemanticContext): Diagnostic[] {
  const listing = context.documents.listing;
  if (!listing?.value) return [];

  const found: Diagnostic[] = [];
  for (const { pointer, value } of declaredMediaPaths(record(listing.value['spec']))) {
    const file = path.join(context.item.root, value);
    if (!fs.existsSync(file)) continue; // LIST-MEDIA-002 reports it.
    const icon = pointer === '/spec/icon';
    const code = icon ? 'CATALOG_ICON_SIZE' : 'CATALOG_SCREENSHOT_SIZE';
    const size = pngDimensions(fs.readFileSync(file));

    if (!size) {
      found.push(diag(code, at(listing.path, pointer), `${value} is not a PNG, so its dimensions cannot be checked here`));
    } else if (icon && (size.width !== size.height || size.width < ICON_MIN_PX)) {
      found.push(
        diag(code, at(listing.path, pointer), `${value} is ${size.width}×${size.height}; an icon is square and at least ${ICON_MIN_PX} px a side`),
      );
    } else if (!icon && Math.max(size.width, size.height) > SCREENSHOT_MAX_PX) {
      found.push(
        diag(code, at(listing.path, pointer), `${value} is ${size.width}×${size.height}; a screenshot is at most ${SCREENSHOT_MAX_PX} px a side`),
      );
    }
  }
  return found;
}

/* ------------------------------------------------------------ line endings */

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.gz', '.tgz', '.zip']);

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return entry.isFile() ? [absolute] : [];
  });
}

/**
 * CATALOG_LINE_ENDINGS — platform#3843.
 *
 * `.gitattributes` normalizes what git stores, but a file written with CRLF in
 * a working tree still reaches `yamllint --strict` and the platform's sync
 * from a checkout that predates it. One CR byte is enough to fail a copy that
 * is otherwise identical to its source.
 */
export function checkLineEndings(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const file of filesUnder(context.item.root).sort()) {
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const bytes = fs.readFileSync(file);
    const cr = bytes.indexOf(0x0d);
    if (cr === -1) continue;
    const line = bytes.subarray(0, cr).toString('utf8').split('\n').length;
    found.push(diag('CATALOG_LINE_ENDINGS', at(file, ''), `line ${line} ends in a carriage return; text files under items/ use LF only`));
  }
  return found;
}

/* ---------------------------------------------------- internal references */

/** `run gqs0ef138`, `(catalog run ihc050a6e)`: a nine-character run id, letters and digits. */
const RUN_ID = /\bruns?\s+(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])([a-z0-9]{9})\b/g;

/**
 * CATALOG_INTERNAL_REFERENCE.
 *
 * This repository is public. A comment that cites an internal deploy-test run
 * id points every reader at a record only the platform's staff can open, so
 * the evidence it claims cannot be checked. Cite the public issue the run
 * produced, the upstream file, or say "in a live deploy test".
 */
export function checkInternalReferences(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const file of filesUnder(context.item.root).sort()) {
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(RUN_ID)) {
        found.push(
          diag(
            'CATALOG_INTERNAL_REFERENCE',
            at(file, ''),
            `line ${index + 1} cites internal run ${match[1]}; this repository is public, so cite the issue it produced instead`,
          ),
        );
      }
    });
  }
  return found;
}

/* ------------------------------------------------------------- workarounds */

/** Interpreters a command wrapper runs inline code through, and the flag that does it. */
const INLINE_FLAGS: Record<string, string> = {
  sh: '-c',
  bash: '-c',
  ash: '-c',
  dash: '-c',
  zsh: '-c',
  perl: '-e',
  python: '-c',
  python3: '-c',
  node: '-e',
  bun: '-e',
};

/** Is this `command` an interpreter running inline code — `sh -c`, `perl -e`, `python -c`, `node -e`? */
export function isCommandWrapper(command: unknown): boolean {
  if (!Array.isArray(command) || typeof command[0] !== 'string') return false;
  const program = path.posix.basename(command[0]);
  return Object.hasOwn(INLINE_FLAGS, program) && command[1] === INLINE_FLAGS[program];
}

/** `# WORKAROUND(platform-api#NNNN): why`, one or more issues, then a reason. */
export const WORKAROUND_TAG = /^\s*#\s*WORKAROUND\((?:platform-api#\d+)(?:,\s*platform-api#\d+)*\):\s*\S/;

/** The contiguous comment lines directly above line `index`. */
function commentBlockAbove(lines: string[], index: number): string[] {
  const block: string[] = [];
  for (let i = index - 1; i >= 0 && /^\s*#/.test(lines[i] ?? ''); i--) block.unshift(lines[i] ?? '');
  return block;
}

/**
 * CATALOG_WORKAROUND_UNTAGGED.
 *
 * A component that runs inline code instead of the image's own process does it
 * because the platform cannot yet say what it needs: compose a string, override
 * an entrypoint, order a start, probe something other than HTTP. Each such
 * wrapper names the platform-api issue it waits on in a
 * `# WORKAROUND(platform-api#NNNN): …` line in the comment directly above
 * `command:`, so that when the issue closes, finding every wrapper it made
 * removable is a grep, not an archaeology project.
 */
export function checkWorkaroundTags(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const doc of components(context)) {
    if (!isCommandWrapper(workloadOf(doc.value ?? null)['command'])) continue;

    const lines = fs.readFileSync(doc.path, 'utf8').split('\n');
    const index = lines.findIndex((line) => /^\s*command:\s*$/.test(line));
    const tagged = index !== -1 && commentBlockAbove(lines, index).some((line) => WORKAROUND_TAG.test(line));
    if (tagged) continue;

    found.push(
      diag(
        'CATALOG_WORKAROUND_UNTAGGED',
        at(doc.path, '/spec/workload/command'),
        'this command runs inline code through an interpreter; say which platform limitation it works around with a ' +
          '`# WORKAROUND(platform-api#NNNN): …` line in the comment directly above `command:`',
      ),
    );
  }
  return found;
}

/* ---------------------------------------------------------- interpolation */

/** The one alphabet a value can take inside a URL's userinfo, or a JSON string, unencoded. */
export const URL_SAFE_CHARACTERS = /^[A-Za-z0-9._~-]$/;

/**
 * Does every string `pattern` accepts consist of URL-safe characters? Decided
 * for the one shape such a pattern takes, an anchored single character class
 * with a quantifier (`^[A-Za-z0-9._~-]+$`, `^[0-9a-f]{64}$`); anything else is
 * not shown to be safe, so it is reported.
 */
export function isURLSafePattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  const match = /^\^\[([^\]\\]+)\](?:\+|\{[0-9]+(?:,[0-9]*)?\})\$$/.exec(pattern);
  if (!match) return false;
  const members = (match[1] ?? '').replace(/([A-Za-z0-9])-([A-Za-z0-9])/g, (whole, from: string, to: string) => {
    const sameKind = [/[a-z]/, /[A-Z]/, /[0-9]/].some((kind) => kind.test(from) && kind.test(to));
    return sameKind && from <= to ? '' : whole;
  });
  return [...members].every((character) => URL_SAFE_CHARACTERS.test(character));
}

/** `scheme://…$VAR…@` or `scheme://…${VAR}…@`: a variable expanded inside a URL's userinfo. */
const USERINFO = /[a-z][a-z0-9+.-]*:\/\/([^\s"'@/]*)@/gi;
const EXPANSION = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * CATALOG_URL_UNSAFE_SECRET.
 *
 * A command wrapper that builds a connection URL from a password writes the
 * password into the URL's userinfo unencoded. A `/`, `@`, `:` or `%` in it
 * then changes where the URL points, and a `+` or `=` from a BASE64 generator
 * is enough. The wrapper is right only while the value cannot hold one, so a
 * sensitive input expanded there declares a pattern that confines it to the
 * unreserved characters. The generated value has to satisfy it
 * (BP-PARAM-004), so a blueprint that binds a BASE64 generator to it fails
 * offline instead of at the first connection.
 */
export function checkURLUnsafeSecrets(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const doc of components(context)) {
    const command = workloadOf(doc.value ?? null)['command'];
    if (!isCommandWrapper(command) || !Array.isArray(command)) continue;
    const script = command.slice(2).filter((part): part is string => typeof part === 'string').join('\n');

    const expanded = new Set<string>();
    for (const userinfo of script.matchAll(USERINFO)) {
      for (const variable of (userinfo[1] ?? '').matchAll(EXPANSION)) expanded.add(variable[1] ?? '');
    }

    for (const [name, raw] of Object.entries(inputsOf(doc.value ?? null))) {
      const input = record(raw);
      const envVar = record(input['target'])['envVar'];
      if (input['sensitive'] !== true || typeof envVar !== 'string' || !expanded.has(envVar)) continue;
      if (isURLSafePattern(record(input['schema'])['pattern'])) continue;
      found.push(
        diag(
          'CATALOG_URL_UNSAFE_SECRET',
          at(doc.path, `/spec/contract/inputs/${token(name)}/schema`),
          `${envVar} is written into a URL's userinfo unencoded; confine input ${JSON.stringify(name)} to URL-safe ` +
            'characters with `pattern: ^[A-Za-z0-9._~-]+$`, or encode it in the wrapper',
        ),
      );
    }
  }
  return found;
}

/* -------------------------------------------------------------- copy drift */

export type CopyHeader = { source: string; revision: number; differs: string[] };

const COPY_OF = /^#\s*copy-of:\s*(items\/[a-z0-9-]+\/\S+\.yaml)@([0-9]+)\s*$/;
const COPY_DIFFERS = /^#\s*copy-differs:\s*(.+?)\s*$/;
/** The prose form the copy-of header replaced, which nothing could check. */
const PROSE_COPY_CLAIM = /\bA copy of\s+(?:#\s*)?the\s+(?:#\s*)?`[a-z0-9-]+`\s+(?:#\s*)?item'?s?/i;

/**
 * The `# copy-of:` and `# copy-differs:` lines of a component's leading comment
 * block, or null where it declares no copy. A malformed header is an error
 * rather than an absent one: a typo must not turn the check off.
 */
export function parseCopyHeader(text: string): CopyHeader | { error: string } | null {
  const leading: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('#')) break;
    leading.push(line);
  }

  const claims = leading.filter((line) => /^#\s*copy-of\b/.test(line));
  if (claims.length === 0) return null;
  if (claims.length > 1) return { error: 'declares `copy-of` more than once' };

  const match = COPY_OF.exec(claims[0] ?? '');
  if (!match) return { error: `\`${claims[0]}\` is not \`# copy-of: items/<slug>/<file>.yaml@<revision>\`` };

  const differs: string[] = [];
  for (const line of leading) {
    if (!/^#\s*copy-differs\b/.test(line)) continue;
    const list = COPY_DIFFERS.exec(line);
    if (!list) return { error: `\`${line}\` is not \`# copy-differs: <JSON pointer>, …\`` };
    for (const pointer of (list[1] ?? '').split(',').map((one) => one.trim())) {
      if (!pointer.startsWith('/')) return { error: `copy-differs entry ${JSON.stringify(pointer)} is not a JSON pointer` };
      differs.push(pointer);
    }
  }

  return { source: match[1] ?? '', revision: Number(match[2]), differs };
}

const unescape = (one: string): string => one.replaceAll('~1', '/').replaceAll('~0', '~');

/** The value at a JSON pointer, or undefined. */
function valueAt(document: unknown, pointer: string): unknown {
  let here: unknown = document;
  for (const raw of pointer.split('/').slice(1)) {
    const key = unescape(raw);
    if (Array.isArray(here)) here = here[Number(key)];
    else if (isRecord(here)) here = Object.hasOwn(here, key) ? here[key] : undefined;
    else return undefined;
  }
  return here;
}

/** A deep copy with the value at each pointer taken out. */
function without(document: unknown, pointers: string[]): unknown {
  const copy = structuredClone(document);
  for (const pointer of pointers) {
    const tokens = pointer.split('/').slice(1).map(unescape);
    const last = tokens.pop();
    const parent = valueAt(copy, tokens.length === 0 ? '' : `/${tokens.map(token).join('/')}`);
    if (last === undefined) continue;
    if (isRecord(parent)) delete parent[last];
    else if (Array.isArray(parent)) parent[Number(last)] = undefined;
  }
  return copy;
}

/** Every pointer at which two documents differ, at the deepest level both share. */
export function differences(a: unknown, b: unknown, pointer = ''): string[] {
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) => differences(a[key], b[key], `${pointer}/${token(key)}`));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((value, index) => differences(value, b[index], `${pointer}/${index}`));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [pointer || '/'];
}

const REVISION = '/metadata/revision';

/**
 * CATALOG_COPY_DRIFT — platform#3842.
 *
 * An item-local `componentRef` cannot leave its item, so a blueprint that needs
 * a building block carries a copy of it. A copy says so in its first comment
 * lines:
 *
 *     # copy-of: items/postgres/components/postgres.yaml@9
 *     # copy-differs: /metadata/description, /spec/contract/outputs/url
 *
 * and is then held to it. Both documents are parsed, so comments and layout
 * never count; `/metadata/revision` and each listed pointer are set aside;
 * anything else that differs is drift. The cited revision must be the
 * source's current one, so bumping a building block fails every copy until
 * each is brought in step, and a listed pointer that no longer differs is
 * reported too, so the list cannot outlive its reason. A component that
 * claims in prose to be "a copy of the `x` item's component" without the
 * header is reported as well: that is the unchecked form this replaced.
 */
export function checkCopyDrift(context: SemanticContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  const itemsDir = path.dirname(context.item.root);

  for (const doc of components(context)) {
    const text = fs.readFileSync(doc.path, 'utf8');
    const header = parseCopyHeader(text);
    const report = (pointer: string, message: string) => found.push(diag('CATALOG_COPY_DRIFT', at(doc.path, pointer), message));

    if (header === null) {
      const leading = text.split('\n').filter((line, index, all) => all.slice(0, index + 1).every((one) => one.startsWith('#')));
      if (PROSE_COPY_CLAIM.test(leading.join('\n'))) {
        report('', 'claims in prose to be a copy of another item\'s component; declare it with `# copy-of: items/<slug>/<file>.yaml@<revision>` so the claim is checked');
      }
      continue;
    }
    if ('error' in header) {
      report('', `copy header ${header.error}`);
      continue;
    }

    const source = path.join(itemsDir, header.source.slice('items/'.length));
    if (path.resolve(source) === path.resolve(doc.path)) {
      report('', 'names itself as its own source');
      continue;
    }
    if (!fs.existsSync(source)) {
      report('', `copy-of names ${header.source}, which does not exist`);
      continue;
    }
    const original = context.documents.components.get(source)?.value ?? readYaml(source);
    if (!original) {
      report('', `copy-of names ${header.source}, which does not parse`);
      continue;
    }

    const current = valueAt(original, REVISION);
    if (current !== header.revision) {
      report(REVISION, `cites ${header.source}@${header.revision}, but the source is at revision ${String(current)}; bring the copy in step and cite the new revision`);
    }

    for (const pointer of header.differs) {
      if (pointer === REVISION) report(REVISION, 'lists /metadata/revision, which is always set aside');
      else if (differences(valueAt(doc.value, pointer), valueAt(original, pointer)).length === 0) {
        report(pointer, `copy-differs lists ${pointer}, but the copy and ${header.source} agree there; take it off the list`);
      }
    }

    const ignored = [REVISION, ...header.differs];
    for (const pointer of differences(without(doc.value, ignored), without(original, ignored))) {
      report(pointer, `differs from ${header.source} at ${pointer}; make it equal, or list the pointer in \`# copy-differs:\``);
    }
  }
  return found;
}

/** A source outside this item, which its own documents do not hold. */
function readYaml(file: string): Record<string, unknown> | null {
  const value: unknown = YAML.parse(fs.readFileSync(file, 'utf8'));
  return isRecord(value) ? value : null;
}

/* ---------------------------------------------------------------- registry */

/** Every catalog policy rule, in the order the suite reports them. */
export const POLICY_CHECKS: readonly ((context: SemanticContext) => Diagnostic[])[] = [
  checkRequiredWithoutDefault,
  checkPrivilegedPort,
  checkPortInputMismatch,
  checkServiceReadiness,
  checkMediaDimensions,
  checkLineEndings,
  checkInternalReferences,
  checkWorkaroundTags,
  checkURLUnsafeSecrets,
  checkCopyDrift,
];

export const runPolicyChecks = (context: SemanticContext): Diagnostic[] => POLICY_CHECKS.flatMap((check) => check(context));
