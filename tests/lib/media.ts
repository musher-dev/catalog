/**
 * Media paths — listing spec §5.
 *
 * The grammar itself is `structural` and the listing schema carries it, so it is
 * read back out of the fetched bundle rather than copied here. Copying it would
 * put a second authority in this repository, and the one place the grammar is
 * needed outside the schema's reach — a description image, listing spec §4.1
 * LIST-MD-003 — is exactly where a drifted copy would go unnoticed.
 */
import type { Family } from './spec-schemas.ts';

type SchemaNode = Record<string, unknown>;

/** Pull the media-path `pattern` the listing bundle publishes for `icon`. */
export function mediaPathPatternFrom(listingSchema: SchemaNode): RegExp {
  const defs = listingSchema['$defs'] as Record<string, SchemaNode> | undefined;
  const spec = defs?.['ListingSpec'] as SchemaNode | undefined;
  const properties = spec?.['properties'] as Record<string, SchemaNode> | undefined;
  const icon = properties?.['icon'];

  const candidates = [icon, ...((icon?.['anyOf'] as SchemaNode[] | undefined) ?? [])];
  for (const candidate of candidates) {
    const pattern = candidate?.['pattern'];
    if (typeof pattern === 'string') return new RegExp(pattern);
  }

  throw new Error(
    'the listing schema no longer publishes a media-path pattern at $defs.ListingSpec.properties.icon; ' +
      'the spec has changed shape and this module needs updating',
  );
}

/** Every media path an item ships, by the field that declares it. */
export type DeclaredMedia = { pointer: string; value: string };

export function declaredMediaPaths(listingSpec: Record<string, unknown>): DeclaredMedia[] {
  const declared: DeclaredMedia[] = [];

  const icon = listingSpec['icon'];
  if (typeof icon === 'string') declared.push({ pointer: '/spec/icon', value: icon });

  const screenshots = listingSpec['screenshots'];
  if (Array.isArray(screenshots)) {
    screenshots.forEach((shot, index) => {
      const file = (shot as Record<string, unknown> | null)?.['file'];
      if (typeof file === 'string') declared.push({ pointer: `/spec/screenshots/${index}/file`, value: file });
    });
  }

  return declared;
}

export const MEDIA_FAMILY: Family = 'listing';
