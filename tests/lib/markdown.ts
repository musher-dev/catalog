/**
 * The `description` Markdown profile — listing spec §4.1.
 *
 * `description` is CommonMark 0.31.2 narrowed by three rules. It is authored by a
 * third party and rendered by the storefront, so it is untrusted content
 * displayed in a first-party origin.
 *
 * The rules are written in CommonMark's terms rather than as a search for angle
 * brackets, and this module parses accordingly: a code fence or a code span is
 * its own construct, so a listing MAY document `<script>` inside one and remain
 * conforming. A lexical scan would reject the authors writing honest
 * documentation, which is most of them.
 */
import { Parser } from 'commonmark';

export type DescriptionFinding = {
  code: 'ERR_RAW_HTML' | 'ERR_DISALLOWED_SCHEME' | 'ERR_IMAGE_NOT_LOCAL';
  detail: string;
};

/** LIST-MD-002 / listing spec §4: compared case-insensitively, per RFC 3986 §3.1. */
const PERMITTED_SCHEMES = new Set(['https', 'http', 'mailto']);

const parser = new Parser();

export type DescriptionScan = {
  findings: DescriptionFinding[];
  /** Image destinations, for the caller to hold to the §5 media rules. */
  imageDestinations: string[];
};

export function scanDescription(description: string, isMediaPath: (value: string) => boolean): DescriptionScan {
  const findings: DescriptionFinding[] = [];
  const imageDestinations: string[] = [];

  const walker = parser.parse(description).walker();
  for (let step = walker.next(); step; step = walker.next()) {
    if (!step.entering) continue;
    const node = step.node;

    switch (node.type) {
      // LIST-MD-001.
      case 'html_block':
      case 'html_inline':
        findings.push({
          code: 'ERR_RAW_HTML',
          detail: `raw HTML ${JSON.stringify(truncate(node.literal ?? ''))}`,
        });
        break;

      // LIST-MD-002. A fragment is permitted alongside the three schemes.
      case 'link': {
        const destination = node.destination ?? '';
        if (!destination.startsWith('#') && !hasPermittedScheme(destination)) {
          findings.push({
            code: 'ERR_DISALLOWED_SCHEME',
            detail: `link destination ${JSON.stringify(truncate(destination))}`,
          });
        }
        break;
      }

      // LIST-MD-003. A remote image is not merely discouraged, it is unspellable:
      // it would disclose every storefront viewer's IP to a host the listing
      // author chose, on every page view, with no interaction.
      case 'image': {
        const destination = node.destination ?? '';
        imageDestinations.push(destination);
        if (!isMediaPath(destination)) {
          findings.push({
            code: 'ERR_IMAGE_NOT_LOCAL',
            detail: `image destination ${JSON.stringify(truncate(destination))} is not an item media path`,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return { findings, imageDestinations };
}

function hasPermittedScheme(destination: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(destination);
  // A destination carrying no scheme is relative; it addresses the storefront's
  // own origin and is not what LIST-MD-002 is about.
  if (!match) return true;
  return PERMITTED_SCHEMES.has(match[1]!.toLowerCase());
}

const truncate = (value: string, limit = 80): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;
