/**
 * The Dash0 API origins the token may be sent to.
 *
 * **A fixed list, compiled in, and that is the security property.** The connect surface passes an
 * *id* from this table to the worker, never a URL; the worker looks the id up in its own copy and
 * refuses anything else. A page that could name an arbitrary origin could name one it controls, and
 * the worker would attach the token to it. Ids are environment-qualified (`prod:eu-west-1`) because
 * region names repeat across environments.
 *
 * **Two independent sources that agree**, which is why this is a list and not a guess.
 *
 * The configuration: `dash0hq/dash0-configuration`, `platform/environments/<cloud>/`, one file per
 * cluster. Only `-regional` clusters are customer-facing (`-global` is the control plane, `-syn` are
 * check runners), so only those belong in a picker.
 *
 * The probe — every host below confirmed live, three ways:
 *
 * ```
 *                                          issuer   GET /api/spans   OPTIONS, foreign Origin
 * api.eu-west-1.aws.dash0.com              self     401              204, allow-origin: *
 * api.eu-central-1.aws.dash0.com           self     401              204, allow-origin: *
 * api.us-west-2.aws.dash0.com              self     401              204, allow-origin: *
 * api.europe-west4.gcp.dash0.com           self     401              204, allow-origin: *
 * api.eu-west-1.aws.dash0-dev.com          self     401              204, allow-origin: *
 * api.europe-west4.gcp.dash0-dev.com       self     401              204, allow-origin: *
 * ```
 *
 * `401` not `404` separates a region that serves the data API from a name that merely resolves. The
 * preflight column is what makes the design work: `OPTIONS /api/spans` from a foreign origin asking
 * for `Authorization` answers `204` with `allow-origin: *`. The OAuth endpoints on these same hosts
 * are origin-allowlisted, which is why d0bar asks for a pasted token instead of running a sign-in.
 *
 * What one source alone would have got wrong: a DNS sweep of AWS region names finds four and misses
 * two, because GCP regions are named `europe-west4` (crt.sh surfaced the pattern). Going the other
 * way, `us-east-2` has a wildcard cert and a `-global` cluster but no `api.` host — it is the
 * production control plane — and `api.dash0.com` has a cert and does not resolve. Certificates alone
 * would have listed both.
 *
 * A region not carried here uses the escape hatch, which is host-controlled rather than
 * page-controlled — chosen when the site is built, not by whatever runs in the page later:
 *
 *   navigator.serviceWorker.register("/d0bar-sw.js?api=https://api.<region>.aws.dash0.com")
 */

export interface Region {
  /** Environment-qualified, e.g. `prod:eu-west-1`. Unique across the whole table. */
  id: string;
  /** The environment this region belongs to. */
  env: EnvironmentId;
  /** The region on its own, for the picker. The environment is shown by the toggle. */
  label: string;
  origin: string;
}

export type EnvironmentId = "prod" | "dev";

export interface Environment {
  id: EnvironmentId;
  label: string;
  /**
   * Shown next to the toggle. `dev` gets a warning rather than a description, because picking it
   * by accident produces a `401` that reads exactly like a revoked token.
   */
  note: string;
}

/** Production stays first in the toggle; development is the default for this developer tool. */
export const ENVIRONMENTS: readonly Environment[] = [
  {
    id: "prod",
    label: "Production",
    note: "app.dash0.com — where your organization is unless you work at Dash0.",
  },
  {
    id: "dev",
    label: "Development",
    note: "app.dash0-dev.com — Dash0's own environment. A production token is rejected here, and the rejection looks the same as a revoked token.",
  },
];

/* Labels carry the cloud, because two of these differ only by it: `eu-west-1` on AWS and
   `europe-west4` on GCP are both "EU", and a picker that said so twice would be unusable. */
export const REGIONS: readonly Region[] = [
  {
    id: "prod:eu-west-1",
    env: "prod",
    label: "EU · Ireland (AWS)",
    origin: "https://api.eu-west-1.aws.dash0.com",
  },
  {
    id: "prod:eu-central-1",
    env: "prod",
    label: "EU · Frankfurt (AWS)",
    origin: "https://api.eu-central-1.aws.dash0.com",
  },
  {
    id: "prod:europe-west4",
    env: "prod",
    label: "EU · Netherlands (GCP)",
    origin: "https://api.europe-west4.gcp.dash0.com",
  },
  {
    id: "prod:us-west-2",
    env: "prod",
    label: "US · Oregon (AWS)",
    origin: "https://api.us-west-2.aws.dash0.com",
  },
  {
    id: "dev:eu-west-1",
    env: "dev",
    label: "EU · Ireland (AWS)",
    origin: "https://api.eu-west-1.aws.dash0-dev.com",
  },
  {
    id: "dev:europe-west4",
    env: "dev",
    label: "EU · Netherlands (GCP)",
    origin: "https://api.europe-west4.gcp.dash0-dev.com",
  },
];

export const DEFAULT_ENVIRONMENT: EnvironmentId = "dev";
export const DEFAULT_REGION = "prod:eu-west-1";

/** The origin for an id, or `""`. `""` is a refusal and every caller treats it as one. */
export function originFor(id: string): string {
  const known = REGIONS.find((region) => region.id === id);
  if (known) return known.origin;
  return extra.find((region) => region.id === id)?.origin ?? "";
}

/** The regions offered for one environment, in table order. */
export function regionsIn(env: EnvironmentId): readonly Region[] {
  return allRegions().filter((region) => region.env === env);
}

/** The environment an id belongs to, or the default for an id nothing carries. */
export function environmentOf(id: string): EnvironmentId {
  return allRegions().find((region) => region.id === id)?.env ?? DEFAULT_ENVIRONMENT;
}

/**
 * Host-supplied origins, added at worker startup from the script URL. Separate from `REGIONS` by
 * trust level: that is a constant the page may pick from, this is what the site's own build added.
 * The lookup searches both, so `originFor` stays the one place a destination is resolved. An
 * override lands in `prod` — the environment a host deploying d0bar is in.
 */
const extra: Region[] = [];

export function addRegion(region: Region): void {
  if (originFor(region.id) !== "") return;
  extra.push(region);
}

/** Every region the worker will send a token to. */
export function allRegions(): readonly Region[] {
  return [...REGIONS, ...extra];
}
