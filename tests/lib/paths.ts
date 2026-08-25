import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root — this file lives at `<root>/tests/lib/`. */
export const REPO_ROOT: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const ITEMS_DIR: string = path.join(REPO_ROOT, 'items');

/** Repo-relative path, so a failure message is something a reader can paste into an editor. */
export const rel = (absolute: string): string => path.relative(REPO_ROOT, absolute);
