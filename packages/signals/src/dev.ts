declare const __DEV__: boolean | undefined;

/**
 * Whether development guards are active.
 *
 * Written as a `typeof` check rather than a bare `__DEV__` so the package works in three
 * situations that a published library actually meets: a bundler that defines `__DEV__`
 * (the guard compiles to a constant and the branch is eliminated), a bundler that does not
 * (this resolves to `false` instead of throwing a `ReferenceError` on first use), and a
 * browser loading the ESM build directly with no build step at all.
 */
export const DEV: boolean = typeof __DEV__ !== "undefined" && __DEV__ === true;
