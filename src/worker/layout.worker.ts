import {
  LAYOUT_FAILURE_COPY,
  LAYOUT_PROTOCOL_VERSION,
  type LayoutRequest,
} from "../shared/protocol";
import { layout, toResponse } from "./layout";

/**
 * The layout worker's realm, and nothing else.
 *
 * Every decision lives in `layout.ts`, which is a pure function with node tests. What is left
 * here is the plumbing that only exists inside a worker: the message listener, the clock around
 * the call, and the transfer list. Splitting it this way is what makes the flattening testable
 * without standing up a worker, and it keeps this file short enough to read in one go — which
 * matters, because a bug in *this* file is one no unit test can see.
 *
 * Nothing is imported that touches the DOM, and nothing is retained between messages: the
 * worker holds no trace after it has posted one. A panel left open on a 4000-span trace for an
 * hour costs the same as one that was never opened.
 */

declare const self: {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

function isRequest(value: unknown): value is LayoutRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "layout" &&
    typeof message["id"] === "number" &&
    typeof message["body"] === "string" &&
    typeof message["version"] === "number"
  );
}

self.addEventListener("message", (event) => {
  const request = event.data;
  /* Anything else is not addressed to this worker. Silently ignored rather than answered: a
     reply to a message we did not understand would be a reply with no `id` for the panel to
     match, which is worse than nothing. */
  if (!isRequest(request)) return;

  const started = performance.now();
  let posted: ReturnType<typeof toResponse>;
  try {
    posted = toResponse(request.id, layout(request), performance.now() - started);
  } catch {
    /* `layout` handles every shape it knows how to fail on; reaching here means a bug in it.
       Reported as one — the panel must not render a toolbar defect as a statement about the
       user's trace — and never as an unhandled rejection crossing the boundary, which would
       leave the panel waiting on a reply that is never coming. */
    posted = {
      message: {
        kind: "layout-error",
        version: LAYOUT_PROTOCOL_VERSION,
        id: request.id,
        reason: "internal",
        message: LAYOUT_FAILURE_COPY.internal,
      },
      transfer: [],
    };
  }
  self.postMessage(posted.message, posted.transfer);
});
