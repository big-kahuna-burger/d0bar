/**
 * The shape of one captured request.
 *
 * Lives in `shared/` rather than in `ring.ts` because both stages need it and neither may
 * import the other: stage 1 owns the ring's storage, stage 2 renders what it reads out of
 * it, and the two are separate bundles. Declared once here so the boundary in `stage2.ts`
 * describes the same record the ring actually writes, instead of a hand-copied twin that can
 * drift a field at a time.
 *
 * Nothing in this module holds state, so each bundle having its own copy of `scratch()`
 * costs nothing and means nothing — unlike the ring itself, whose second copy in stage 2 was
 * a bug that reported 307 untraced requests on a page where almost everything was traced.
 */

import { ABSENT } from "./intern";

/** A caller-owned scratch record. The ring fills one rather than allocating per read. */
export interface RequestRecord {
  startTime: number;
  duration: number;
  connectStart: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  transferSize: number;
  encodedBodySize: number;
  url: string;
  initiator: string;
  method: string;
  status: number;
  flags: number;
  /** Which epoch this request belongs to. `0` means the document itself. */
  epochId: number;
  /** Handle into the trace-context side table, or {@link ABSENT}. */
  contextId: number;
}

export function scratch(): RequestRecord {
  return {
    startTime: 0,
    duration: 0,
    connectStart: 0,
    requestStart: 0,
    responseStart: 0,
    responseEnd: 0,
    transferSize: 0,
    encodedBodySize: 0,
    url: "",
    initiator: "",
    method: "",
    status: 0,
    flags: 0,
    epochId: 0,
    contextId: ABSENT,
  };
}
