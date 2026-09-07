import type { QueryFailure, TokenStatus } from "../../../shared/broker";

/**
 * What the connect surface says.
 *
 * Two sentences here are the whole reason this change exists rather than a text field and a
 * save button, and neither may be softened:
 *
 *   - persisting a token puts it where the host page can read it, and
 *   - d0bar cannot check that the token is as restricted as it asks for.
 *
 * Both are admissions. A connect screen that omits them reads better and tells the developer
 * something false about their own credential.
 */

export const TITLE = "Connect to Dash0";

export const INTRO =
  "The panel reads spans and logs from your Dash0 organization. That needs a token — d0bar cannot get one for you, because Dash0's sign-in flow refuses browser requests from any origin but its own app.";

/** What the token must be, stated as a requirement because it cannot be enforced. */
export const REQUIRED_TITLE = "Create the token with these restrictions";

export const REQUIREMENTS: ReadonlyArray<{ setting: string; value: string; why: string }> = [
  {
    setting: "Permissions",
    value: "Reading",
    why: "d0bar never writes. A token with more could change dashboards and alert rules.",
  },
  {
    setting: "Dataset access",
    value: "just this page's",
    why: "Keeps a leaked token to one environment. Name that dataset in the field below.",
  },
  {
    setting: "Signal types",
    value: "Spans, Logs",
    why: "The two the panel reads.",
  },
];

/**
 * The admission that the list above is a request rather than a check.
 *
 * Dash0 exposes no endpoint reporting a token's own permissions, and the only way to discover
 * that a token can write is to attempt a write — which is not something a toolbar does to find
 * out. So this says so, rather than letting the list imply a validation that never runs.
 */
export const UNVERIFIABLE =
  "d0bar cannot check any of this. Nothing here tells it what your token is allowed to do, so a token with broader access will be accepted without complaint.";

/**
 * The region picker's label and its footnote.
 *
 * Worth a footnote because the failure it prevents is unreadable otherwise: a token issued in
 * one region is simply rejected by another, and a 401 from the wrong region looks exactly like
 * a revoked token.
 */
export const REGION_LABEL = "Dash0 region";

export const REGION_NOTE =
  "The region your organization is in. A token from one region is rejected by every other, and the rejection looks the same as a revoked token.";

export const ENVIRONMENT_LABEL = "Environment";

/**
 * The dataset field's label and its footnote.
 *
 * The footnote is the third admission on this screen, and it earned its place the same way the
 * other two did — by the failure happening. A token scoped to a dataset that is not `default`
 * previously could not resolve a single trace: the query went to `default`, Dash0 answered 404,
 * and the panel spent five retries and then told the developer their trace "did not become
 * queryable". The name is asked for now, and this says what happens when it is wrong, because
 * d0bar can no more check a dataset name against a token than it can check its permissions.
 *
 * `REQUIREMENTS` also has a "Dataset" row. That one is advice about how to *scope the token*
 * when creating it; this is the *name*. Labelled distinctly so the two are not read as one
 * control.
 */
export const DATASET_LABEL = "Dataset to query";

export const DATASET_NOTE =
  "The dataset your spans are in. Leave it blank for `default`. d0bar cannot check the name against your token, and a wrong one is indistinguishable from a trace that is not there — the query succeeds and returns nothing.";

export interface CustodyOption {
  id: "session" | "stored";
  label: string;
  detail: string;
}

/**
 * The custody choice, with the cost of each stated at the point of choosing.
 *
 * `session` is first and is the default. A default that silently persists a credential is a
 * decision made on the user's behalf, and the more convenient option is the one that gives the
 * host page a copy.
 */
export const CUSTODY: readonly CustodyOption[] = [
  {
    id: "session",
    label: "This session only",
    detail:
      "Held in the service worker's memory, which this page cannot read. The browser shuts an idle worker down, so you will paste it again after a quiet spell.",
  },
  {
    id: "stored",
    label: "Remember on this device",
    detail:
      "Saved in the service worker's storage, which survives reloads — and which this page can read, because browser storage is shared by origin, not by worker. Convenient, and not a secret from the site you are debugging.",
  },
];

/** The connected line in the header and on the surface. */
export function connectedLine(status: TokenStatus): string {
  if (!status.connected) return "Not connected";
  const where = status.source === "stored" ? "remembered on this device" : "this session only";
  /* The dataset is named here because it is the one part of the connection that fails silently.
     A wrong region or a revoked token produces a rejection; a wrong dataset produces an empty
     answer, so the only place it can be caught is by being visible before anything is queried. */
  const head = status.hint === "" ? "Connected" : `Connected · …${status.hint}`;
  return `${head} · ${status.dataset} · ${where}`;
}

/** One sentence per way a query can fail, each naming a different next step. */
export const FAILURE: Record<QueryFailure, string> = {
  "not-connected": "No token is connected, so the panel cannot read anything back from Dash0.",
  "refused-origin":
    "That request was for another origin, so d0bar refused to attach your token to it.",
  rejected:
    "Dash0 rejected the token. It may have been revoked, or it may not have Reading permission for this dataset.",
  unreachable:
    "The Dash0 API could not be reached. This is a network or worker problem, not a token problem.",
};

/**
 * Shown when Connect is pressed with nothing in the token field.
 *
 * The handler returned early and silently before, which is indistinguishable from a dead button —
 * and it is the first thing anyone does when a click appears to do nothing.
 */
export const EMPTY_TOKEN = "Paste a token first — the field is empty.";

/** Shown when the page has no controlling worker, which is where connecting is impossible. */
export const NO_WORKER =
  "d0bar's service worker is not controlling this page yet, and it is what holds the token. On a first visit it takes control after one reload.";

/**
 * Shown when a worker *is* controlling the page and the connection still came back disconnected.
 *
 * Distinct from {@link NO_WORKER}, which was previously shown for both. The two have opposite
 * next steps — reload, versus check the region — and telling someone to reload a page whose
 * worker is working sends them round a loop that cannot fix anything.
 *
 * The region is named because it is the failure the worker produces silently: `set()` refuses a
 * region that is not in its compiled table and returns a cleared status rather than an error, so
 * a stale `D0BAR_REGION` or a region dropped from the table lands here.
 */
export const REFUSED =
  "The worker did not accept that connection. It refuses a region it does not recognise, and returns no reason — check the region and try again.";
