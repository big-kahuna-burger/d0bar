import { effect } from "@d0bar/signals/signal";
import {
  DEFAULT_REGION,
  ENVIRONMENTS,
  environmentOf,
  originFor,
  regionsIn,
  type EnvironmentId,
} from "../../../shared/regions";
import { connect, controlled, disconnect, status } from "../../broker";
import { connection, popToList, view } from "../../shell";
import { DEFAULT_DATASET } from "../../../shared/broker";
import {
  CUSTODY,
  DATASET_LABEL,
  DATASET_NOTE,
  EMPTY_TOKEN,
  ENVIRONMENT_LABEL,
  INTRO,
  REFUSED,
  REGION_LABEL,
  REGION_NOTE,
  NO_WORKER,
  REQUIREMENTS,
  REQUIRED_TITLE,
  TITLE,
  UNVERIFIABLE,
  connectedLine,
} from "./copy";

/**
 * The connect surface.
 *
 * Pushed over the list like the trace surface rather than added as a fourth tab: connecting is
 * something a developer does once, and a permanent tab for it would sit next to three tabs that
 * are read constantly.
 *
 * The token's whole life in the page realm is inside this file, and it is short by construction:
 * it exists in the input element the user pasted into, is passed to `connect()`, and the input
 * is cleared. Nothing here keeps a copy, and there is nowhere for one to end up — the field is
 * inside the panel's closed shadow root, and the reply carries only a status.
 */

export interface ConnectView {
  readonly el: HTMLElement;
  /** Moves focus onto the surface, so Escape reaches the panel's handler. */
  focus(): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

/**
 * A region id from `window.D0BAR_REGION`, for debugging.
 *
 * A **preselection**, not a destination: it names an id the worker still resolves against its
 * own compiled table, so a page that sets this to something the table does not carry gets the
 * default and nothing else — see the note at the top of `regions.ts`. That is what makes it
 * safe to read off the page's own global. It exists so a developer testing against a non-EU
 * tenant does not re-pick the region on every reload of the fixture.
 */
function debugRegion(): string {
  const value = (globalThis as { D0BAR_REGION?: unknown }).D0BAR_REGION;
  if (typeof value !== "string") return "";
  return originFor(value) === "" ? "" : value;
}

export function connectView(): ConnectView {
  const root = el("div", "conn");
  root.tabIndex = -1;

  const heading = el("h2", "conn-title");
  heading.textContent = TITLE;

  const intro = el("p", "conn-intro");
  intro.textContent = INTRO;

  /* ── the requirements d0bar asks for and cannot enforce ── */
  const reqTitle = el("div", "conn-sub");
  reqTitle.textContent = REQUIRED_TITLE;

  const reqList = el("dl", "conn-req");
  for (const item of REQUIREMENTS) {
    const term = el("dt");
    term.textContent = item.setting;
    const value = el("dd", "conn-req-value");
    value.textContent = item.value;
    const why = el("dd", "conn-req-why");
    why.textContent = item.why;
    reqList.append(term, value, why);
  }

  /* Styled as a warning rather than a footnote, because it is one: the list above looks
     exactly like a form that validates, and it does not. */
  const unverifiable = el("p", "conn-warn");
  unverifiable.textContent = UNVERIFIABLE;

  /* ── the field ── */
  const field = el("label", "conn-field");
  const fieldLabel = el("span", "conn-field-label");
  fieldLabel.textContent = "Auth token";
  const input = el("input", "conn-input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "auth_…";
  field.append(fieldLabel, input);

  /* ── dataset ──
     A plain text input, not a `password` and not a `select`. Not a password because it is not a
     secret and hiding it would hide the one part of the connection that fails without saying so;
     not a select because listing the datasets would mean querying the API before the developer
     asked for anything, which `trace-view` forbids. */
  const dsField = el("label", "conn-field");
  const dsLabel = el("span", "conn-field-label");
  dsLabel.textContent = DATASET_LABEL;
  const dsInput = el("input", "conn-input");
  dsInput.type = "text";
  dsInput.autocomplete = "off";
  dsInput.spellcheck = false;
  dsInput.placeholder = DEFAULT_DATASET;
  dsField.append(dsLabel, dsInput);

  const dsNote = el("p", "conn-intro");
  dsNote.textContent = DATASET_NOTE;

  /* ── environment ── */
  const envField = el("div", "conn-field");
  const envLabel = el("span", "conn-field-label");
  envLabel.textContent = ENVIRONMENT_LABEL;
  const envToggle = el("div", "conn-toggle");
  envToggle.setAttribute("role", "radiogroup");
  envToggle.setAttribute("aria-label", ENVIRONMENT_LABEL);

  const initial = debugRegion() || DEFAULT_REGION;
  let env: EnvironmentId = environmentOf(initial);

  const envButtons = ENVIRONMENTS.map((entry) => {
    const button = el("button", "conn-toggle-btn");
    button.type = "button";
    button.textContent = entry.label;
    button.setAttribute("role", "radio");
    button.addEventListener("click", () => selectEnv(entry.id));
    envToggle.appendChild(button);
    return { entry, button };
  });
  envField.append(envLabel, envToggle);

  const envNote = el("p", "conn-envnote");

  /* ── region ── */
  const regionField = el("div", "conn-field");
  const regionLabel = el("span", "conn-field-label");
  regionLabel.textContent = REGION_LABEL;
  const region = el("select", "conn-select");
  regionField.append(regionLabel, region);

  /* The origin, spelled out under the picker. The label says "EU (Ireland)"; what the token is
     actually attached to is a URL, and the developer checking whether this is their tenant is
     checking the URL. */
  const origin = el("p", "conn-origin");

  function selectEnv(next: EnvironmentId): void {
    env = next;
    fillRegions();
  }

  /** Rebuilds the region control for the current environment. The one writer of `region.value`. */
  function fillRegions(keep?: string): void {
    const available = regionsIn(env);
    region.textContent = "";
    for (const entry of available) {
      const option = el("option");
      option.value = entry.id;
      option.textContent = entry.label;
      region.appendChild(option);
    }
    /* A region carried over from the other environment does not exist here, so the first of the
       new list wins rather than leaving the control showing a value it cannot resolve. */
    const wanted =
      keep && available.some((entry) => entry.id === keep) ? keep : available[0]?.id;
    region.value = wanted ?? "";

    for (const { entry, button } of envButtons) {
      button.setAttribute("aria-checked", String(entry.id === env));
      button.setAttribute("data-on", String(entry.id === env));
    }
    envNote.textContent = ENVIRONMENTS.find((entry) => entry.id === env)?.note ?? "";
    envNote.setAttribute("data-warn", String(env !== "prod"));

    showOrigin();
  }

  function showOrigin(): void {
    origin.textContent = originFor(region.value);
  }

  region.addEventListener("change", showOrigin);
  fillRegions(initial);

  /* ── custody ── */
  const custodyTitle = el("div", "conn-sub");
  custodyTitle.textContent = "Where to keep it";

  const custody = el("div", "conn-custody");
  const radios: HTMLInputElement[] = [];
  for (const option of CUSTODY) {
    const wrap = el("label", "conn-choice");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "d0bar-custody";
    radio.value = option.id;
    /* Session-only is preselected. See the note on `CUSTODY`. */
    radio.checked = option.id === "session";
    radios.push(radio);

    const text = el("span", "conn-choice-text");
    const label = el("span", "conn-choice-label");
    label.textContent = option.label;
    const detail = el("span", "conn-choice-detail");
    detail.textContent = option.detail;
    text.append(label, detail);

    wrap.append(radio, text);
    custody.appendChild(wrap);
  }

  /* ── actions ── */
  const actions = el("div", "conn-actions");
  const submit = el("button", "conn-submit");
  submit.type = "button";
  submit.textContent = "Connect";
  const drop = el("button", "conn-drop");
  drop.type = "button";
  drop.textContent = "Disconnect";
  const back = el("button", "conn-back");
  back.type = "button";
  back.textContent = "Back";
  actions.append(submit, drop, back);

  const regionNote = el("p", "conn-intro");
  regionNote.textContent = REGION_NOTE;

  const state = el("p", "conn-state");

  /**
   * Failures from the last submit, in their own node.
   *
   * **Separate from `state` because sharing it was the bug.** `onSubmit` wrote its message into
   * `state` and then called `render()` in its `finally`, and `render` assigns `state.textContent`
   * unconditionally — so every failed connect wrote an explanation and blanked it in the same
   * tick. Clicking Connect with no worker, or with a region the worker refuses, did visibly
   * nothing at all.
   *
   * One node per writer is the fix, not careful ordering: ordering is a property of two
   * functions staying in step, and this is the second time in this panel that two writers on one
   * text node have produced a surface that looked broken while working.
   */
  const notice = el("p", "conn-warn");
  notice.hidden = true;

  /** The one writer of `notice`. Hidden when empty, so the styled block takes no space unused. */
  function say(message: string): void {
    notice.textContent = message;
    notice.hidden = message === "";
  }

  root.append(
    heading,
    intro,
    reqTitle,
    reqList,
    unverifiable,
    field,
    dsField,
    dsNote,
    envField,
    envNote,
    regionField,
    origin,
    regionNote,
    custodyTitle,
    custody,
    actions,
    state,
    notice,
  );

  function persistChosen(): boolean {
    return radios.some((radio) => radio.checked && radio.value === "stored");
  }

  /**
   * Whether the developer has touched the dataset field.
   *
   * `render` runs on every `connection()` change, and the field has to be prefilled from the
   * connected dataset — otherwise reconnecting a persisted token would submit whatever the box
   * happens to show, which after a reload is the placeholder's meaning rather than the stored
   * dataset. But prefilling unconditionally would overwrite what is being typed the moment a
   * status reply lands, which is exactly the bug that made the `/try/` trace id disappear from
   * under its own status badge. So: prefilled until touched, never after.
   */
  let dsTouched = false;
  dsInput.addEventListener("input", () => {
    dsTouched = true;
  });

  function render(): void {
    const current = connection();
    state.textContent = current.connected ? connectedLine(current) : "";
    drop.hidden = !current.connected;
    if (!dsTouched) dsInput.value = current.dataset === DEFAULT_DATASET ? "" : current.dataset;
  }

  let busy = false;

  async function onSubmit(): Promise<void> {
    if (busy) return;
    const token = input.value.trim();
    /* An empty field is not a failure to explain, but it must not be silent either — the button
       looks identical to a broken one otherwise, which is how the original report arrived. */
    if (token === "") {
      say(EMPTY_TOKEN);
      return;
    }

    say("");
    busy = true;
    submit.disabled = true;
    try {
      /* Sent as typed, including blank — the worker resolves the default, so the value the
         status reports back is the value that will be queried. */
      const result = await connect(token, persistChosen(), region.value, dsInput.value.trim());
      connection.set(result);
      if (result.connected) {
        /* Cleared on success and not before: a failed paste that wiped the field would make
           the user find the token again to retry. */
        input.value = "";
        popToList();
      } else {
        /* Two different failures, two different next steps. `askStatus` collapses them into one
           disconnected status, so the controller is checked here rather than guessed at — this
           previously reported "no worker is controlling this page" for a token the worker had
           received and refused, which sends the developer to reload a page that is fine. */
        say(controlled() ? REFUSED : NO_WORKER);
      }
    } finally {
      busy = false;
      submit.disabled = false;
      render();
    }
  }

  async function onDrop(): Promise<void> {
    connection.set(await disconnect());
    render();
  }

  submit.addEventListener("click", () => void onSubmit());
  drop.addEventListener("click", () => void onDrop());
  back.addEventListener("click", () => popToList());
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") void onSubmit();
  });
  dsInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") void onSubmit();
  });

  /* `effect` rather than a manual subscription: `render` reads `connection()`, so the
     dependency is tracked and the first call happens here. */
  const stop = effect(render);

  /* Ask the worker once, at construction.
   *
   * The chip in the header shows this state, so it has to be true before anyone clicks it —
   * and the panel mounts long after settle, so one message here is not on any hot path. It
   * matters most for a persisted token after a worker restart: the worker's memory is empty
   * and the token is still on disk, and `status` is the message that reconciles the two. */
  void status().then((current) => connection.set(current));

  return {
    el: root,
    focus() {
      /* The surface, not the field, and with `preventScroll`.
       *
       * Focusing the input was the first version and it was wrong in a way only the browser
       * showed: the field sits below the fold, so focusing it scrolled the surface past the
       * title, the intro and the warning — the two admissions that are the entire reason this
       * screen exists rather than a text box. A form that scrolls its own disclosures out of
       * view on open is not disclosing them. The field is one Tab away. */
      if (view.peek() !== "connect") return;
      root.focus({ preventScroll: true });
      /* `.body` is one scroll container shared by every view, so it arrives carrying the
         requests list's offset. Without this the surface opens below its own disclosures. */
      root.scrollIntoView({ block: "start" });
    },
    destroy() {
      stop();
      /* The input holds whatever was typed and not submitted. Clearing it on teardown means a
         closed panel is not carrying a half-pasted credential in a detached node. */
      input.value = "";
      root.remove();
    },
  };
}
