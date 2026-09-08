export interface PictureInPictureWindow extends Window {
  closed: boolean;
}

interface DocumentPictureInPictureApi {
  readonly window?: PictureInPictureWindow | null;
  requestWindow(options: { width: number; height: number }): Promise<PictureInPictureWindow>;
}

function api(host: Window): DocumentPictureInPictureApi | undefined {
  return (host as Window & { documentPictureInPicture?: DocumentPictureInPictureApi })
    .documentPictureInPicture;
}

export function detachSupported(host: Window = window): boolean {
  return typeof api(host)?.requestWindow === "function";
}

/** Restores a document-owned sheet once without disturbing sheets owned by the pill. */
export function ensureStyleSheet(root: ShadowRoot, sheet: CSSStyleSheet): void {
  if (!root.adoptedStyleSheets.includes(sheet)) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
}

/** Requests the platform's single PiP document, sized from the panel the user is viewing. */
export async function requestPanelWindow(
  panel: HTMLElement,
  host: Window = window,
): Promise<PictureInPictureWindow> {
  const pictureInPicture = api(host);
  if (!pictureInPicture) throw new Error("Panel detachment is unavailable in this browser.");
  if (pictureInPicture.window && !pictureInPicture.window.closed) {
    throw new Error("A detached panel is already open for this page.");
  }

  const rect = panel.getBoundingClientRect();
  return pictureInPicture.requestWindow({
    width: Math.max(360, Math.ceil(rect.width || 620)),
    height: Math.max(320, Math.ceil(rect.height || 560)),
  });
}

/** Creates the only d0bar node in the PiP document and gives the panel an isolated root. */
export function detachedRoot(target: PictureInPictureWindow): ShadowRoot {
  const host = target.document.createElement("div");
  host.setAttribute("data-detached", "");
  target.document.body.replaceChildren(host);
  target.document.body.style.margin = "0";
  target.document.body.style.overflow = "hidden";
  return host.attachShadow({ mode: "closed" });
}
