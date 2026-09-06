/**
 * Naming d0bar's own callbacks so the browser reports them as d0bar's.
 *
 * `add-self-attribution` task 3 asked for `performance.measure` with a `d0bar:` prefix. That was
 * wrong twice over, and the spec has been corrected rather than worked around:
 *
 *   - measure entries never appear in `long-animation-frame`'s `scripts[]`, which is the only
 *     thing attribution actually reads. Marking with them would have produced entries nothing
 *     looked at, while `selfcost.ts` stayed unable to recognise a frame.
 *   - a `measure` pair costs two calls and an entry allocation *inside* the work it measures,
 *     which is the one thing this repo will not do to a callback on the host's main thread.
 *
 * What Chrome reports for each script in a frame is the root callback's `sourceFunctionName`, and
 * a colon is not a legal identifier character. A quoted method key is, and it names the function
 * at no runtime cost: `{ "d0bar:tick"() {} }`.
 *
 * **The key must be a literal in the source.** `.name` is not what Chrome reads — it reads V8's
 * compiled debug name, fixed at parse time. Two functions, both with `.name === "d0bar:x"`, one
 * from a quoted literal key and one from a computed key built at runtime:
 *
 * ```
 *   { "d0bar:literal"() {} }      ──▶  sourceFunctionName "d0bar:literal"
 *   { [PREFIX + "runtime"]() {} } ──▶  sourceFunctionName ""
 * ```
 *
 * The first shape of this file was the second row. It looked right at every checkpoint — the
 * names were correct in `.name`, the strings were in the minified bundle — and produced zero
 * attributed frames, because a `marked(name, fn)` helper can only build its key at runtime.
 * Hence the awkward signature: the literal has to be written where the callback is.
 * `Object.defineProperty(fn, "name", …)` fails for the same reason.
 *
 * Chrome also leaves the name empty for scripts it has no source location for at all — an
 * `eval`'d or injected function, which is why this cannot be probed from `page.evaluate`.
 *
 * Cost is one call frame per invocation, which is why marks go on batch-level callbacks — an
 * observer batch, a clock tick, a repaint — and never inside `pushResource`.
 */

/** Reserved prefix. Anything d0bar names for its own attribution starts with it. */
export const SELF_MARK = "d0bar:";

/**
 * Unwraps a one-entry object literal whose key is a `d0bar:` string literal:
 *
 *     const tick = marked({ "d0bar:pill-tick"() { … } });
 *
 * The object exists only so the key can be written once. Do not pass a variable key — see above,
 * it silently produces an unnamed function and an attribution total of zero.
 */
export function marked<F>(one: Record<string, F>): F {
  for (const key in one) return one[key] as F;
  /* Unreachable from any callsite the type allows; thrown rather than returned undefined so a
     refactor that empties the literal fails at the mark instead of at the callback. */
  throw new Error("d0bar: marked() needs exactly one entry.");
}
