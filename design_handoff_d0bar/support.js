/* Minimal runtime for .dc.html design-canvas artboards.
   Not part of d0bar. Renders the handoff prototype locally so it can be used as a
   visual reference: <helmet>, <sc-if>, <sc-for>, {{ path }}, onClick/onMouseEnter/
   onMouseLeave, style-hover, and a props panel built from data-props. */
(function () {
  "use strict";

  class DCLogic {
    constructor() {
      this.props = {};
      this.state = {};
    }
    setState(patch) {
      const next = typeof patch === "function" ? patch(this.state) : patch;
      this.state = Object.assign({}, this.state, next);
      if (this._onChange) this._onChange();
    }
  }
  window.DCLogic = DCLogic;

  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;

  function resolve(expr, scope) {
    const e = expr.trim();
    if (e === "true") return true;
    if (e === "false") return false;
    if (e === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    let cur = scope;
    for (const part of e.split(".")) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  /* A value that is exactly one hole keeps its runtime type (functions, booleans).
     Anything else is stringified and spliced. */
  function interp(text, scope) {
    const whole = text.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) return resolve(whole[1], scope);
    return text.replace(HOLE, (_, expr) => {
      const v = resolve(expr, scope);
      return v == null ? "" : String(v);
    });
  }

  const EVENTS = { onclick: "click", onmouseenter: "mouseenter", onmouseleave: "mouseleave" };

  function renderNode(node, scope, out) {
    if (node.nodeType === 3) {
      const v = interp(node.nodeValue, scope);
      out.appendChild(document.createTextNode(v == null ? "" : String(v)));
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();

    if (tag === "sc-if") {
      if (resolve(node.getAttribute("value").replace(/^\{\{|\}\}$/g, ""), scope)) {
        renderChildren(node, scope, out);
      }
      return;
    }

    if (tag === "sc-for") {
      const list = resolve(node.getAttribute("list").replace(/^\{\{|\}\}$/g, ""), scope) || [];
      const as = node.getAttribute("as") || "item";
      list.forEach((item, i) => {
        const inner = Object.create(scope);
        inner[as] = item;
        inner[as + "Index"] = i;
        renderChildren(node, inner, out);
      });
      return;
    }

    const el = document.createElement(tag);
    let hover = null;

    for (const attr of node.attributes) {
      const name = attr.name;
      if (name.startsWith("hint-placeholder")) continue;
      if (name === "style-hover") {
        hover = interp(attr.value, scope);
        continue;
      }
      const ev = EVENTS[name.toLowerCase()];
      if (ev) {
        const fn = interp(attr.value, scope);
        if (typeof fn === "function") el.addEventListener(ev, fn);
        continue;
      }
      const v = interp(attr.value, scope);
      if (v === false || v == null) continue;
      el.setAttribute(name, String(v));
    }

    if (hover) {
      const base = el.getAttribute("style") || "";
      el.addEventListener("mouseenter", () => el.setAttribute("style", base + ";" + hover));
      el.addEventListener("mouseleave", () => el.setAttribute("style", base));
    }

    renderChildren(node, scope, el);
    out.appendChild(el);
  }

  function renderChildren(node, scope, out) {
    for (const child of Array.from(node.childNodes)) renderNode(child, scope, out);
  }

  function buildPropsPanel(schema, props, onChange) {
    const box = document.createElement("div");
    box.setAttribute(
      "style",
      "position:fixed;top:0;right:0;z-index:2147483647;display:flex;gap:14px;align-items:center;" +
        "padding:8px 12px;background:#111;color:#ddd;font:11px/1.4 ui-monospace,monospace;" +
        "border-bottom-left-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.4)"
    );
    for (const [key, def] of Object.entries(schema)) {
      if (key.startsWith("$")) continue;
      const wrap = document.createElement("label");
      wrap.setAttribute("style", "display:flex;gap:6px;align-items:center;white-space:nowrap");
      wrap.append(document.createTextNode(key));
      let input;
      if (def.editor === "enum") {
        input = document.createElement("select");
        for (const o of def.options) {
          const opt = document.createElement("option");
          opt.value = opt.textContent = o;
          input.appendChild(opt);
        }
        input.value = props[key];
        input.onchange = () => onChange(key, input.value);
      } else if (def.editor === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!props[key];
        input.onchange = () => onChange(key, input.checked);
      } else {
        input = document.createElement("input");
        input.value = props[key] ?? "";
        input.oninput = () => onChange(key, input.value);
      }
      input.setAttribute("style", "font:inherit;background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:2px 4px");
      wrap.appendChild(input);
      box.appendChild(wrap);
    }
    return box;
  }

  function boot() {
    const tpl = document.querySelector("x-dc");
    const script = document.querySelector("script[data-dc-script]");
    if (!tpl || !script) return;

    /* <helmet> is hoisted to <head> once, then removed from the render template. */
    const helmet = tpl.querySelector("helmet");
    if (helmet) {
      for (const child of Array.from(helmet.childNodes)) document.head.appendChild(child);
      helmet.remove();
    }

    /* Full re-render on every setState would replay the entry animation; suppress it
       after first paint. d0-pulse (the ingest-lag dots) must keep running. */
    const rule = document.createElement("style");
    rule.textContent = '.dc-settled [style*="d0-rise"]{animation:none!important}';
    document.head.appendChild(rule);

    const schema = JSON.parse(script.dataset.props || "{}");
    const props = {};
    for (const [k, d] of Object.entries(schema)) if (!k.startsWith("$")) props[k] = d.default;

    /* Evaluating the artboard's own inline logic class is this runtime's purpose — the
       same thing Claude Design does with it. The input is the local .dc.html sitting
       next to this file, never anything fetched. Do not extend this to remote sources. */
    const Component = new Function("DCLogic", script.textContent + "\nreturn Component;")(DCLogic);
    const inst = new Component();
    inst.props = props;

    const mount = document.createElement("div");
    tpl.replaceWith(mount);

    let painted = false;
    function paint() {
      inst.props = props;
      const frag = document.createDocumentFragment();
      renderChildren(tpl, inst.renderVals(), frag);
      mount.replaceChildren(frag);
      if (painted) mount.classList.add("dc-settled");
      painted = true;
    }
    inst._onChange = paint;
    paint();

    document.body.appendChild(
      buildPropsPanel(schema, props, (k, v) => {
        props[k] = v;
        paint();
      })
    );

    /* ⌘⇧0 / Escape, per the handoff's keyboard spec. */
    addEventListener("keydown", (e) => {
      if (e.key === "0" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inst.setState((s) => ({ open: !s.open }));
      } else if (e.key === "Escape") {
        inst.setState((s) => (s.view === "trace" ? { view: "list" } : { open: false }));
      }
    });
  }

  if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot);
  else boot();
})();
