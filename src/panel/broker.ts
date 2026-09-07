import {
  DISCONNECTED,
  type BrokerReply,
  type BrokerRequest,
  type QueryOutcome,
  type TokenStatus,
} from "../shared/broker";

/**
 * The page's side of the token broker.
 *
 * One `MessageChannel` per call, so a reply is matched to its request by construction rather
 * than by a correlation id and a shared listener. The worker replies on the port it was given
 * and to nothing else — a broadcast would hand one tab's answer to every other page on the
 * origin.
 *
 * Everything here resolves rather than rejects. The panel calls this from a click handler; an
 * unhandled rejection in the host page's console is d0bar making noise in someone else's
 * application, and there is a real answer for every failure anyway.
 */

/** Long enough for a cold worker to be woken and answer; short enough to stop a stuck spinner. */
const TIMEOUT_MS = 8000;

function ask(message: BrokerRequest): Promise<BrokerReply | undefined> {
  const controller = navigator.serviceWorker?.controller;
  /* No controller means no worker controls this page — a first load before registration, or a
     host that never registered one. Not an error; a state the caller renders. */
  if (!controller) return Promise.resolve(undefined);

  return new Promise<BrokerReply | undefined>((resolve) => {
    let settled = false;
    const finish = (reply: BrokerReply | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(reply);
    };

    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<BrokerReply>) => finish(event.data);
    /* A worker can be terminated between receiving the message and replying. `waitUntil` in the
       broker makes that unlikely rather than impossible, and a panel waiting forever on a
       promise nothing will settle is worse than one that says it could not reach the worker. */
    const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);

    try {
      controller.postMessage(message, [channel.port2]);
    } catch {
      finish(undefined);
    }
  });
}

async function askStatus(message: BrokerRequest): Promise<TokenStatus> {
  const reply = await ask(message);
  if (reply?.kind !== "status") return DISCONNECTED;
  return reply.status;
}

/**
 * Whether a worker controls this page at all.
 *
 * Exported so the connect surface can tell its two failures apart. `askStatus` collapses them —
 * no controller, a timeout and a refusal all arrive as a disconnected status — and the surface
 * was reporting all three as "no worker is controlling this page", which is a false explanation
 * for a token the worker received and declined. The same check `ask` makes, read by the caller.
 */
export function controlled(): boolean {
  return Boolean(navigator.serviceWorker?.controller);
}

/** Current custody state. Answers `DISCONNECTED` when there is no worker to ask. */
export function status(): Promise<TokenStatus> {
  return askStatus({ kind: "status" });
}

/**
 * Hands the worker a token.
 *
 * This is the one moment the token is in the page realm at all, and it is unavoidable: the user
 * pastes it into a field this code owns. What the design guarantees is everything after — the
 * token is not stored here, not held in a variable that outlives this call, and never returned
 * by any message. The caller is expected to clear its input on success.
 */
export function connect(
  token: string,
  persist: boolean,
  region: string,
  dataset: string,
): Promise<TokenStatus> {
  return askStatus({ kind: "connect", token, persist, region, dataset });
}

export function disconnect(): Promise<TokenStatus> {
  return askStatus({ kind: "disconnect" });
}

/**
 * Runs one API call through the worker. The token never crosses back.
 *
 * `init` carries a method and a body for the endpoints that need them — the trace query is a
 * POST. Absent, this is the GET it has always been.
 */
export async function query(
  url: string,
  init: { method?: string; body?: string } = {},
): Promise<QueryOutcome> {
  const reply = await ask({ kind: "query", url, ...init });
  if (reply?.kind !== "query") return { ok: false, reason: "unreachable" };
  return reply.outcome;
}
