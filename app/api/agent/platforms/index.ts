import type { PlatformAdapter, Platform } from "./types"

/** Platform adapter registry — STUB for the public snapshot.
 *
 * Real adapter implementations (Twilio REST, Gmail API, Meta Graph API)
 * live in the private production repo and are not included here. The
 * scheduled-send and handler code paths that call adapter.sendMessage are
 * exercised in this snapshot only via mocked boundaries in tests. A
 * runtime call to getAdapter in this snapshot will throw.
 */
export function getAdapter(platform: Platform): PlatformAdapter {
  throw new Error(
    `[snapshot] Platform adapter for "${platform}" is not included. ` +
      "This snapshot is for code review and test verification only.",
  )
}
