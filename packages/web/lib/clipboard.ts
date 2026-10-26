/**
 * Writes text to the clipboard and reports an honest boolean instead of a fake success.
 *
 * `navigator.clipboard.writeText` returns a promise; firing it without awaiting flips the
 * "copied" state even when the browser rejects the permission. On insecure origins — the
 * plain-HTTP LAN deployments this platform explicitly targets — `navigator.clipboard` is
 * undefined and a bare call silently no-ops. `copyText` resolves to `true` only when the
 * write is confirmed; callers surface a manual-copy fallback for `false` (the convention
 * from `organizer/EntryCodesPanel.tsx`).
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
