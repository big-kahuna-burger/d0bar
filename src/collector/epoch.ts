/**
 * The source used to divide a document into route-sized epochs.
 *
 * Selection is deliberately separate from observer registration. The browser capability is
 * read once when d0bar starts and the answer is frozen, so later code cannot mix browser-issued
 * soft-navigation ids with ids assigned by the Navigation API fallback.
 */

export type EpochTier = 1 | 2 | 3;
export type EpochSource = "soft-navigation" | "navigation-api" | "document";

export interface EpochCapabilities {
  readonly entryTypes: readonly string[];
  readonly navigation: boolean;
}

const DOCUMENT_ONLY =
  "Route boundaries are unavailable on this browser; d0bar is showing the whole document.";

let tier: EpochTier | undefined;

function browserCapabilities(): EpochCapabilities {
  const supported = PerformanceObserver.supportedEntryTypes;
  return {
    entryTypes: Array.isArray(supported) ? supported : [],
    navigation:
      typeof (globalThis as typeof globalThis & { navigation?: unknown }).navigation !==
      "undefined",
  };
}

/** Selects and freezes the epoch tier. Subsequent calls return the first answer. */
export function selectTier(capabilities: EpochCapabilities = browserCapabilities()): EpochTier {
  if (tier !== undefined) return tier;
  if (capabilities.entryTypes.indexOf("soft-navigation") !== -1) tier = 1;
  else if (capabilities.navigation) tier = 2;
  else tier = 3;
  return tier;
}

/** The selected source, for diagnostics and UI disclosure. */
export function epochSource(): EpochSource {
  const selected = tier ?? selectTier();
  if (selected === 1) return "soft-navigation";
  if (selected === 2) return "navigation-api";
  return "document";
}

/** Epoch 0 is the complete document fallback and the pre-mount bucket in tier 2. */
export function currentEpochId(): number {
  return 0;
}

/** Copy owned by the capability model, so a view cannot overstate the document fallback. */
export function epochDisclosure(): string | undefined {
  return epochSource() === "document" ? DOCUMENT_ONLY : undefined;
}

/** Clears module state during d0bar teardown. Browser capabilities themselves do not change. */
export function resetEpoch(): void {
  tier = undefined;
}
