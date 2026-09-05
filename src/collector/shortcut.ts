/**
 * The keyboard shortcut — and the toolbar's one and only listener on the host page.
 *
 * Everything else in d0bar takes its signals from performance entries specifically to avoid
 * this: load, visibility and first input all arrive as entry types, so `phase.ts` registers
 * nothing. There is no entry type for "the user pressed a key", so a shortcut that opens the
 * panel *before* stage 2 exists cannot be had any other way. That is a deliberate trade, made
 * explicitly, and the cost is stated rather than hidden — `non-perturbation.spec.ts` asserts
 * that the host's listener registry gains exactly this one listener and nothing else.
 *
 * Three properties keep the cost at one listener rather than a class of behaviour:
 *
 * - **Bubble phase, not capture.** The host page's own handlers see the key first and can
 *   stop it. A devtool that claims a chord out from under the application it is measuring is
 *   the same category of mistake as patching `fetch`.
 * - **Never while the user is typing.** An editable target — including one inside the host's
 *   own shadow DOM, which is why this reads `composedPath()` rather than `event.target` —
 *   means the keystroke belongs to the application.
 * - **One comparison on the common path.** The handler runs on every keydown the host page
 *   does not stop, so it rejects on a single boolean before looking at anything else.
 */

/** The default chord: the platform's command modifier, shift, and `0`. */
const DEFAULT_CHORD = "Mod+Shift+0";

export interface Chord {
  /** `metaKey` on Apple platforms, `ctrlKey` elsewhere, when the chord asked for `Mod`. */
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Matched against `event.code`, so the chord is layout-independent. */
  code: string;
}

/**
 * Parses `"Mod+Shift+0"` into a chord.
 *
 * Matched on `event.code` rather than `event.key`: `key` is what the layout produced, so a
 * chord written as `0` would not fire on a layout where shift-0 is `)`, and would fire on an
 * unrelated physical key elsewhere. `code` is the physical key, which is what a shortcut
 * means.
 */
export function parseChord(spec: string): Chord | undefined {
  const parts = spec.split("+").map((part) => part.trim());
  const chord: Chord = { mod: false, ctrl: false, shift: false, alt: false, code: "" };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "cmd" || lower === "meta") chord.mod = true;
    else if (lower === "ctrl" || lower === "control") chord.ctrl = true;
    else if (lower === "shift") chord.shift = true;
    else if (lower === "alt" || lower === "option") chord.alt = true;
    else if (/^[0-9]$/.test(part)) chord.code = `Digit${part}`;
    else if (/^[a-z]$/i.test(part)) chord.code = `Key${part.toUpperCase()}`;
    else chord.code = part;
  }

  return chord.code ? chord : undefined;
}

/** True on Apple platforms, where the command modifier is `metaKey`. */
function usesMeta(): boolean {
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * True when the keystroke belongs to something the user is typing into.
 *
 * `composedPath()[0]` rather than `event.target`: a host page that puts its editor inside a
 * shadow root retargets `target` to the shadow host, and the toolbar would swallow a chord
 * typed into a rich-text field. The path's first entry is the real innermost node.
 */
function isEditable(event: KeyboardEvent): boolean {
  const path = event.composedPath();
  const node = (path.length > 0 ? path[0] : event.target) as HTMLElement | null;
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return node.isContentEditable === true;
}

export interface ShortcutOptions {
  /**
   * The chord, or `false` to register no listener at all — which restores the property that
   * the toolbar touches the host page's event surface not at all, for anyone who would rather
   * have that than the shortcut.
   */
  shortcut?: string | false | undefined;
  onToggle(): void;
}

/**
 * Registers the shortcut. Returns a teardown that removes the listener; it is a no-op when
 * the shortcut is disabled or the chord could not be parsed.
 */
export function installShortcut(options: ShortcutOptions): () => void {
  const spec = options.shortcut === undefined ? DEFAULT_CHORD : options.shortcut;
  if (spec === false) return () => {};

  const chord = parseChord(spec);
  if (!chord) {
    if (__DEV__)
      console.warn(`d0bar: could not parse the shortcut "${spec}". None registered.`);
    return () => {};
  }

  const meta = usesMeta();

  function onKeydown(event: KeyboardEvent): void {
    /* Cheapest possible rejection first: this runs on every keystroke the host page does not
       stop, and the overwhelming majority are not ours. */
    if (event.code !== chord!.code) return;
    /* A held key repeats; a toggle that fires per repeat flickers the panel. */
    if (event.repeat) return;

    const wantMod = chord!.mod;
    const modDown = meta ? event.metaKey : event.ctrlKey;
    if (wantMod && !modDown) return;
    if (!wantMod && chord!.ctrl !== event.ctrlKey) return;
    if (chord!.shift !== event.shiftKey) return;
    if (chord!.alt !== event.altKey) return;
    if (isEditable(event)) return;

    /* Claimed only once it is certain the chord matched and the target is not editable, so a
       key the host page wanted is never swallowed. */
    event.preventDefault();
    options.onToggle();
  }

  /* Bubble phase, so a host handler that wants this chord can stop it before we see it. */
  document.addEventListener("keydown", onKeydown);
  return () => document.removeEventListener("keydown", onKeydown);
}
