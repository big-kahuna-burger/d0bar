/**
 * The Dash0 API origins the token may be sent to.
 *
 * **A fixed list, compiled in, and that is the security property.** The connect surface lets a
 * developer pick an environment and a region, but what crosses to the worker is an *id* from
 * this table, never a URL — the worker looks the id up in its own copy and refuses anything it
 * does not find. A page that could name an arbitrary origin could name one it controls, and the
 * worker would attach the token to it. Choosing from a list cannot do that.
 *
 * Ids are qualified with the environment (`prod:eu-west-1`) because the region names repeat
 * across environments and a bare `eu-west-1` names two different origins. One flat id keeps
 * resolution a single lookup and keeps the message a single field.
 *
 * ## Where this list came from
 *
 * Two independent sources that agree, which is why it is a list and not a guess.
 *
 * **The configuration.** `dash0hq/dash0-configuration`, `platform/environments/<cloud>/` — one
 * file per deployed cluster, suffixed by role. `-regional` clusters are the customer-facing
 * ones; `-global` is the control plane (a comment in the regional values says so: "No org-whois
 * here: it needs a control-plane-api address, which only the global clusters run"), and `-syn`
 * / `-synthetics` are check runners. Only `-regional` belongs in a picker.
 *
 * **The probe.** Every host below was then confirmed live, three ways:
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
 * `401` and not `404` is the test that matters: it separates a region that serves the data API
 * from a name that merely resolves. The preflight column is what makes this whole design work —
 * `OPTIONS /api/spans` from `Origin: https://shop.example.com` asking for `Authorization`
 * answers `204` with `access-control-allow-origin: *`. The OAuth endpoints on these same hosts
 * do not; they are origin-allowlisted, which is why d0bar cannot run a sign-in flow and asks
 * for a pasted token instead.
 *
 * ### What the two sources caught that one would not
 *
 * A DNS sweep of AWS region names found four hosts and missed two: GCP regions are named
 * `europe-west4`, not `eu-west-1`, so a sweep built from AWS names cannot see them. Certificate
 * transparency (`crt.sh`) surfaced `*.europe-west4.gcp.dash0.com` and named the pattern.
 *
 * Going the other way, two names that look like regions are not:
 *
 *   - `us-east-2` has a wildcard certificate and a `production-us-east-2-global` cluster, but
 *     no `api.` host resolves. It is the production control plane, not a region.
 *   - `api.dash0.com` has a certificate and does not resolve. There is still no
 *     region-independent issuer, which is why the picker exists at all.
 *
 * Both would have been listed by reading certificates alone. Neither is reachable.
 *
 * Adding a region from documentation alone would put a guess where a measurement belongs; a host
 * in a region this list does not carry uses the escape hatch below.
 *
 * The escape hatch is the worker's script URL:
 *
 *   navigator.serviceWorker.register("/d0bar-sw.js?api=https://api.<region>.aws.dash0.com")
 *
 * That is host-controlled rather than page-controlled — it is chosen when the site is built,
 * not by whatever is running in the page later — which is why it is allowed to be arbitrary
 * where the picker is not.
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

/**
 * `prod` first and default. A toolbar that quietly defaulted to a Dash0-internal environment
 * would send a customer's token somewhere no customer has an account.
 */
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

export const DEFAULT_ENVIRONMENT: EnvironmentId = "prod";
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
 * Host-supplied origins, added at worker startup from the script URL.
 *
 * Separate from `REGIONS` on purpose. `REGIONS` is a constant the page may pick from; this is
 * what the site's own build added, which is a different trust level — see the note above. The
 * lookup below searches both, so `originFor` remains the one place a destination is resolved.
 *
 * An override lands in `prod`: it is the environment a host deploying d0bar is in, and the `dev`
 * list is Dash0's own.
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
