// Pure path-template helpers, split out of api-explorer.tsx so they're
// directly unit-testable without a DOM — simulating real keystrokes into a
// controlled React <input> requires a browser-accurate value-tracking
// implementation (the native-setter-plus-dispatch trick React's own
// event system depends on to detect a "real" change), which happy-dom
// (this package's DOM test environment, see api-explorer.test.tsx) does not
// yet emulate correctly for controlled inputs. Keeping the actual
// interpolation math here, independent of React state, means the request-URL
// logic itself is still verified directly (this module's own test), while
// api-explorer.test.tsx's DOM-level test stays limited to what a DOM
// environment CAN reliably exercise: a real render + a real click + a real
// fetch round-trip.

/** `/books/{id}/reviews/{reviewId}` -> `["id", "reviewId"]`. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/** Replace every `{name}` segment in `path` with its `values[name]`
 * (percent-encoded), or an empty string when a param has no value yet. */
export function interpolatePath(path: string, values: Readonly<Record<string, string>>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(values[name] ?? ""));
}
