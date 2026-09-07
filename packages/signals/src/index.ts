/**
 * The reactive core's public surface, and the entry `size-limit` measures.
 *
 * Kept as a barrel purely so the core has one measurable boundary — the panel imports from
 * the individual modules, so nothing here is on any critical path.
 */
export * from "./signal";
export * from "./bind";
export * from "./list";
