import { bindHidden, bindText, on } from "spark-signals/bind";
import { effect, scope } from "spark-signals/signal";
import { ATTR_CAP, type LogRecord, type LogValueKind } from "../../../shared/protocol";
import { popToTrace, selectedLog } from "../../shell";

/**
 * One correlated log record, in full.
 *
 * Pushed over the trace rather than nested inside it, so dismissal, focus and Escape come from the
 * shell's existing stack — `shell.ts`'s `View` gained `"log"` and `escape()` pops it to `"trace"`,
 * not to the list, because clearing `selected` would abort the query whose summary holds this
 * record. A nested overlay would need its own dismissal, focus trap and Escape handling, three
 * things the shell already owns, inside a panel that is itself a `popover`.
 *
 * The record arrives through {@link selectedLog} as an **index**, resolved against the live summary
 * on every read. Holding the object would leave this view rendering a record that a re-layout has
 * already replaced in the trace behind it.
 */

/** Rendered where a value is present but is not text. Never blank — see {@link LogValueKind}. */
const KIND_LABEL: Record<LogValueKind, string> = {
  string: "",
  int: "",
  double: "",
  bool: "",
  array: "⟨array⟩",
  kvlist: "⟨kvlist⟩",
  bytes: "⟨bytes⟩",
  absent: "⟨no value⟩",
};

/**
 * A value as one string: its text where it has readable text, and its kind where it does not.
 *
 * The old reader collapsed every non-string to `""`, so a `kvlistValue` body rendered as a level, a
 * time and nothing at all — indistinguishable from an empty log line. Numbers and booleans *are*
 * readable and the worker returns their text; only the container kinds have none.
 */
export function valueText(value: string, kind: LogValueKind): string {
  return kind === "string" || value !== "" ? value : KIND_LABEL[kind];
}

export interface LogViewHandle {
  el: HTMLElement;
  focus(): void;
  destroy(): void;
}

export interface LogViewOptions {
  /** The live log list, read on demand. Never captured — see the note on `selectedLog`. */
  logs: () => readonly LogRecord[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

export function logView(options: LogViewOptions): LogViewHandle {
  const bindings = scope();
  const root = el("div", "logview");

  /** The open record, or `undefined` — a stale index after a re-layout resolves to nothing. */
  const current = (): LogRecord | undefined => {
    const index = selectedLog();
    if (index < 0) return undefined;
    return options.logs()[index];
  };

  /* ── sub-header ── */
  const head = el("div", "logview-head");
  const back = el("button", "logview-back");
  back.type = "button";
  back.textContent = "← trace";
  bindings.add(on(back, "click", () => popToTrace()));

  const level = el("span", "logview-level");
  const levelText = bindableText(level);
  const when = el("span", "logview-when");
  const whenText = bindableText(when);
  head.append(back, level, when);

  bindings.add(bindText(levelText, () => current()?.level ?? ""));
  bindings.add(
    bindText(whenText, () => {
      const log = current();
      if (!log) return "";
      /* Both, because they answer different questions: the offset places the record inside the
         trace, and the wall clock is what a reader pastes into a log search. */
      return `+${formatOffset(log.offsetNs)} · ${isoOf(log.timeNs)}`;
    }),
  );

  /* ── body ── */
  const bodyEl = el("div", "logview-body");
  const bodyText = bindableText(bodyEl);
  bindings.add(
    bindText(bodyText, () => {
      const log = current();
      if (!log) return "";
      const shown = valueText(log.body, log.bodyKind);
      /* A record with a genuinely empty string body is not the same as one with no body, and
         `⟨no body⟩` would misreport the first as the second. */
      return log.bodyKind === "absent" ? "⟨no body⟩" : shown === "" ? "⟨empty⟩" : shown;
    }),
  );
  bindings.add(
    bindHidden(bodyEl, () => {
      const log = current();
      return log === undefined;
    }),
  );

  /* ── attributes ── */
  const attrsHead = el("div", "logview-attrs-head");
  const attrsHeadText = bindableText(attrsHead);
  bindings.add(
    bindText(attrsHeadText, () => {
      const log = current();
      if (!log) return "";
      if (log.attrsSeen === 0) return "no attributes";
      /* Both numbers when truncated. "64 attributes" on a record holding 300 is a count of what
         this panel chose to show, presented as a count of what the record has. */
      return log.attrs.length < log.attrsSeen
        ? `attributes · showing ${log.attrs.length} of ${log.attrsSeen} (capped at ${ATTR_CAP})`
        : `attributes · ${log.attrsSeen}`;
    }),
  );

  const attrs = el("dl", "logview-attrs");

  /**
   * Rebuilt on each change rather than pooled.
   *
   * This is not the virtualized path: the list is bounded by `ATTR_CAP`, it is built only when a
   * reader has opened one record, and the panel is already open over a page nobody is measuring at
   * that point. A row pool here would be machinery for a list that never grows.
   */
  function paintAttrs(): void {
    const log = current();
    attrs.replaceChildren();
    if (!log) return;
    for (const attr of log.attrs) {
      const key = el("dt");
      key.textContent = attr.key;
      const value = el("dd");
      value.textContent = valueText(attr.value, attr.kind);
      /* So the stylesheet can mute a named kind — it is this panel's word, not the record's. */
      value.dataset["kind"] = attr.kind;
      attrs.append(key, value);
    }
  }

  /* An `effect`, not a `bindText`: this writes a subtree rather than one text node, and reading
     `current()` inside it is what subscribes the repaint to `selectedLog`. */
  bindings.add(effect(paintAttrs));

  const unattached = el("div", "logview-unattached");
  const unattachedText = bindableText(unattached);
  bindings.add(
    bindText(unattachedText, () => {
      const log = current();
      if (!log || log.unattached === 0) return "";
      return UNATTACHED_COPY[log.unattached];
    }),
  );
  bindings.add(bindHidden(unattached, () => (current()?.unattached ?? 0) === 0));

  const gone = el("div", "logview-gone");
  gone.textContent = "This log record is no longer part of the trace being shown.";
  bindings.add(bindHidden(gone, () => current() !== undefined));

  root.append(head, bodyEl, unattached, attrsHead, attrs, gone);

  return {
    el: root,
    focus() {
      back.focus();
    },
    destroy() {
      bindings.dispose();
      root.remove();
    },
  };
}

/**
 * Why a record has no span, said in full where the reader is looking at that one record.
 *
 * `span-capped` exists as its own sentence because the alternative is telling someone a span is
 * absent from a trace that in fact contains it — a confident claim about their own data that is
 * false, and one only the worker could have avoided making.
 */
export const UNATTACHED_COPY: Record<Exclude<LogRecord["unattached"], 0>, string> = {
  "no-span-id":
    "This record names no span, so it belongs to the trace rather than to any one operation in it. Nothing here can attach it to a row — a timestamp is not evidence of which span emitted it.",
  "span-not-in-trace":
    "This record names a span that is not in the response for this trace. Either that span has not been ingested yet, or it belongs to a part of the trace the query did not return.",
  "span-capped":
    "This record names a span that exists in this trace but was not rendered — the response held more spans than the waterfall's cap. The span is real; the row is not there to select.",
};

/** Nanoseconds since the trace's start, in the unit the waterfall would use for it. */
function formatOffset(offsetNs: number): string {
  const ms = offsetNs / 1e6;
  if (ms < 1) return `${(offsetNs / 1e3).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Wall clock, or a stated absence — a record with no timestamp is real and must not read as 1970. */
function isoOf(timeNs: number): string {
  if (!(timeNs > 0)) return "no timestamp";
  try {
    return new Date(timeNs / 1e6).toISOString();
  } catch {
    /* An out-of-range timestamp throws rather than returning "Invalid Date" on `toISOString`. */
    return "unreadable timestamp";
  }
}

function bindableText(parent: HTMLElement): Text {
  const node = document.createTextNode("");
  parent.appendChild(node);
  return node;
}
