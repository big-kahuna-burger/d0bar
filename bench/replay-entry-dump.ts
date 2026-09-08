import { pushResource } from "../src/collector/ring";

/** JSON shape written by the fixture recorder. Vitals stay available to benchmark consumers. */
export interface EntryDump {
  recordedAt: string;
  userAgent: string;
  resource: PerformanceResourceTiming[];
  [entryType: string]: unknown;
}

const NUMBERS = [
  "startTime",
  "duration",
  "connectStart",
  "requestStart",
  "responseStart",
  "responseEnd",
  "transferSize",
  "encodedBodySize",
] as const;

/** Parse and validate the part of a recorded dump needed by the request ring. */
export function parseEntryDump(json: string): EntryDump {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object") throw new TypeError("entry dump must be an object");

  const dump = value as Record<string, unknown>;
  if (!Array.isArray(dump.resource)) throw new TypeError("entry dump has no resource entries");

  for (const [index, candidate] of dump.resource.entries()) {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError(`resource entry ${index} must be an object`);
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.name !== "string" || typeof entry.initiatorType !== "string") {
      throw new TypeError(`resource entry ${index} has no name or initiatorType`);
    }
    for (const field of NUMBERS) {
      if (typeof entry[field] !== "number" || !Number.isFinite(entry[field])) {
        throw new TypeError(`resource entry ${index} has an invalid ${field}`);
      }
    }
  }

  return dump as unknown as EntryDump;
}

/** Replay recorded browser entries through the production ring writer, preserving arrival order. */
export function replayEntryDump(dump: EntryDump): number {
  for (const entry of dump.resource) pushResource(entry);
  return dump.resource.length;
}

export function parseAndReplayEntryDump(json: string): EntryDump {
  const dump = parseEntryDump(json);
  replayEntryDump(dump);
  return dump;
}
