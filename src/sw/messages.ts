import type { BrokerReply, BrokerRequest } from "../shared/broker";
import { query } from "./query";
import { clear, restore, set } from "./token";

/**
 * The worker's message surface.
 *
 * **Why there is one at all, when `protocol.ts` refuses one.** That refusal is specific and
 * still correct: a message handler for the *request log* would run the toolbar's correlation
 * work on the host's main thread during load, which is exactly when TBT is being measured. This
 * surface is four messages — a user-initiated paste, a disconnect, a status read, and one query
 * per panel interaction — none of them on the load path, and none of them per-request. The log
 * stays in IndexedDB.
 *
 * The whole surface is below. It is small on purpose: every message is something the page may
 * ask for, and there is deliberately no message that returns the token. That is not enforced by
 * remembering not to add one — `token.ts` exports `bearer()` for `query.ts` alone, and nothing
 * in this file can reach it.
 *
 * Replies go back over the `MessagePort` the caller supplied, not broadcast to every client. A
 * broadcast would hand one tab's answer to every other page on the origin.
 */

/* The contract itself lives in `src/shared/broker.ts` — both realms need it, and `src/sw` is
   excluded from the main tsconfig, so a shared file is the only thing the panel can import. */
export type { BrokerReply as Reply, BrokerRequest as Request };

/** Structural, so this module typechecks under `lib.dom` and is testable without a worker. */
export interface Replier {
  postMessage(message: BrokerReply): void;
}

/**
 * Handles one message.
 *
 * Returns without replying for anything unrecognised. An unknown message is not echoed, not
 * answered with an error naming what it was, and not logged — a page probing for a message that
 * returns the token learns nothing from the shape of the silence.
 */
export async function handle(data: unknown, reply: Replier): Promise<void> {
  if (typeof data !== "object" || data === null) return;
  const message = data as { kind?: unknown };

  switch (message.kind) {
    case "connect": {
      const { token, persist, region, dataset } = data as Extract<
        BrokerRequest,
        { kind: "connect" }
      >;
      if (typeof token !== "string" || typeof region !== "string") return;
      reply.postMessage({
        kind: "status",
        /* Narrowed rather than trusted, like `query`'s `method` and `body`: anything that is
           not a string becomes blank, which `set` resolves to the default. A malformed message
           connects to `default` instead of putting a non-string in a request body. */
        status: await set(
          token,
          persist === true,
          region,
          typeof dataset === "string" ? dataset : "",
        ),
      });
      return;
    }
    case "disconnect":
      reply.postMessage({ kind: "status", status: await clear() });
      return;
    case "status":
      /* `restore()` rather than `status()`: a worker that was terminated and revived has an
         empty in-memory copy while the persisted token is still on disk, and answering from
         memory alone would tell the user they are disconnected and ask for the credential
         again. */
      reply.postMessage({ kind: "status", status: await restore() });
      return;
    case "query": {
      const { url, method, body } = data as Extract<BrokerRequest, { kind: "query" }>;
      if (typeof url !== "string") return;
      /* Narrowed here rather than trusted from the message. Anything that is not a string
         becomes the default, so a malformed message produces a plain GET instead of a
         `fetch` that throws inside the worker and never replies. */
      reply.postMessage({
        kind: "query",
        outcome: await query(url, {
          ...(typeof method === "string" ? { method } : {}),
          ...(typeof body === "string" ? { body } : {}),
        }),
      });
      return;
    }
    default:
      return;
  }
}

/** The port a caller supplied, or the client that sent the message. */
export function replierFor(event: {
  ports?: readonly MessagePort[];
  source?: { postMessage(message: unknown): void } | null;
}): Replier | undefined {
  const port = event.ports?.[0];
  if (port) return port as unknown as Replier;
  const source = event.source;
  if (source) return source as Replier;
  return undefined;
}
