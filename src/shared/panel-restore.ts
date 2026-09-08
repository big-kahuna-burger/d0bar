/** Serializable panel state only. Credentials and trace payloads never enter session storage. */
export interface PanelRestoreState {
  path: string;
  tab: "requests" | "vitals" | "untraced";
  view: "list" | "trace" | "connect" | "log";
  selected: number;
  selectedLog: number;
  selectedSpan: number;
  scroll: Partial<Record<"requests" | "vitals" | "untraced", number>>;
  width: number;
  height: number;
}

export type RestoredPictureInPictureWindow = Window & { closed: boolean };

const KEY = "d0bar:panel-restore:v1";

export function readPanelRestore(path: string): PanelRestoreState | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return undefined;
    const state = value as Partial<PanelRestoreState>;
    if (
      state.path !== path ||
      !["requests", "vitals", "untraced"].includes(state.tab ?? "") ||
      !["list", "trace", "connect", "log"].includes(state.view ?? "") ||
      !Number.isFinite(state.width) ||
      !Number.isFinite(state.height)
    ) {
      return undefined;
    }
    return state as PanelRestoreState;
  } catch {
    return undefined;
  }
}

export function savePanelRestore(state: PanelRestoreState): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* Private browsing or disabled storage means restoration is unavailable, not an error. */
  }
}

export function clearPanelRestore(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* See savePanelRestore. */
  }
}
