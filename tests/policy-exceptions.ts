/**
 * Deliberate exceptions to the catalog policy (lib/policy.ts).
 *
 * Each entry is keyed by the finding's anchor, `items/<slug>/<file>#<JSON
 * pointer>`, and names the rule it excuses, why, and the issue whose fix
 * would retire it. policy.test.ts fails when an entry no longer matches a
 * finding, so an exception cannot outlive its reason: fix the item, and the
 * stale entry has to go in the same change.
 */
export type PolicyException = {
  /** The `CATALOG_*` code this excuses, and no other. */
  rule: string;
  /** Why the item cannot meet the rule today. */
  reason: string;
  /** The issue whose fix removes the exception, as `owner/repo#number`. */
  issue: string;
};

export const POLICY_EXCEPTIONS: Readonly<Record<string, PolicyException>> = {
  'items/activepieces/components/valkey.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Valkey speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/coder/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/contextforge/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/contextforge/components/valkey.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Valkey speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/firecrawl/components/nuq-postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP and probes are HTTP-only; Firecrawl's own start waits for this port (components/firecrawl.yaml).",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/firecrawl/components/redis.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Redis speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/gitea/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/hermes-agent/components/pgvector.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/langfuse/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/langfuse/components/valkey.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Valkey speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/litellm-stack/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/litellm-stack/components/redis.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Redis speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/metabase/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/open-webui-stack/components/valkey.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Valkey speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/paperclip/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/postgres/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/redis/components/redis.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Redis speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/sim/components/valkey.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Valkey speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
  'items/temporal/components/postgres.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: "PostgreSQL speaks no HTTP, and probes are HTTP-only. The pgvector item's Perl supervisor is the way to add one.",
    issue: 'musher-dev/platform-api#1446',
  },
  'items/valkey/components/valkey.yaml#/spec/workload/health/readiness': {
    rule: 'CATALOG_SERVICE_WITHOUT_READINESS',
    reason: 'Valkey speaks RESP, not HTTP, and probes are HTTP-only.',
    issue: 'musher-dev/platform-api#1446',
  },
};
