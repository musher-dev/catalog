/**
 * The component model the rule modules share: where a component keeps its
 * contract, workload and endpoints, and the two questions every rule asks of
 * an input — which kind it is, and whether it is required.
 *
 * Both the `semantic` phase (semantic.ts) and the catalog's own policy
 * (policy.ts) read components through these, so the two cannot disagree about
 * what a document says.
 */
import { isRecord } from './catalog.ts';

export const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export const contractOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(record(record(component ?? {})['spec'])['contract']);

export const inputsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(contractOf(component)['inputs']);

export const outputsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(contractOf(component)['outputs']);

/**
 * Component spec §6.1 — the key that is present says which kind of input this
 * is. A connection input declares `connection` and no `schema`; a value input
 * declares `schema`. The schema makes them exclusive, so one test decides it.
 */
export const isConnectionInput = (input: Record<string, unknown>): boolean => isRecord(input['connection']);

/**
 * COMP-CONNECTION-002 — a connection input is always required, and declares no
 * `required` of its own to say so.
 */
export const isRequired = (input: Record<string, unknown>): boolean =>
  isConnectionInput(input) || input['required'] !== false;

/** Component spec §5 — the category, which ADR 0031 made a tag rather than a shape. */
export const categoryOf = (component: Record<string, unknown> | null): string => {
  const type = record(record(component ?? {})['spec'])['type'];
  return typeof type === 'string' ? type : '';
};

export const runsNothing = (component: Record<string, unknown> | null): boolean => categoryOf(component) === 'EXTERNAL';

export const workloadOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(record(record(component ?? {})['spec'])['workload']);

export const endpointsOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(workloadOf(component)['endpoints']);

export const volumesOf = (component: Record<string, unknown> | null): Record<string, unknown> =>
  record(workloadOf(component)['volumes']);
