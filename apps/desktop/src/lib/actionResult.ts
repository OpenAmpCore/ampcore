/** The outcome of a user-triggered request — a device write, a project save,
 * a preset recall. Resolves, never rejects: a failure is an ordinary value the
 * caller can branch on, not an exception it has to remember to catch.
 *
 * This exists because the requests already *had* an outcome and the layer
 * above them threw it away. `bindings.ts`'s `typedError` envelope resolves
 * with `{ status: "error" }` rather than rejecting, and the action wrappers
 * turned that into a toast (live) or nothing at all (project) and then
 * resolved `void` either way. Anything that wanted to react to the result
 * itself — a pill showing a check or a cross — could not tell the two apart. */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export const ACTION_OK: ActionResult = { ok: true };

export function actionFailed(message: string): ActionResult {
  return { ok: false, message };
}

/** For a handler whose underlying action does not exist for the current
 * source. Deliberately a failure, never a success: a control that did nothing
 * must not flash a green check. */
export const ACTION_UNAVAILABLE: ActionResult = actionFailed("Not available for this device or project.");

/** Maps a `bindings.ts` command envelope onto an `ActionResult`. */
export function toActionResult(
  result: { status: "ok" } | { status: "error"; error: { message: string } },
): ActionResult {
  return result.status === "ok" ? ACTION_OK : actionFailed(result.error.message);
}

export function isActionResult(value: unknown): value is ActionResult {
  return typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean";
}
