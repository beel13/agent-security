/** Shared helper: deliver a scheduled agent message to a live thread.
 *
 * Used by two callers:
 *   1. POST /api/agent/outbound     — direct send (legacy n8n followup path,
 *      external callers, tests)
 *   2. GET  /api/cron/process-followups — Vercel Cron polling scheduled_followups
 *
 * Responsibilities:
 *   - Load the conversation thread
 *   - Re-run the routing safety stack (may have become human-owned after scheduling)
 *   - Load per-client platform credentials
 *   - Persist the agent message to the conversation history
 *   - Send via the correct platform adapter
 *
 * All error paths return a structured result object so callers can persist
 * the outcome without wrapping in try/catch themselves.
 */

import {
  getThread,
  getClientCredentials,
  getClientProfile,
  checkRouting,
  appendMessage,
} from "../db/conversations"
import { getAdapter } from "../platforms"
import type { Platform, StoredMessage } from "../platforms/types"
import { filterOutbound } from "./outbound-firewall"
import { escalateThread } from "./escalate"

export type SendScheduledResult =
  | { status: "sent"; thread_id: string }
  | { status: "skipped"; thread_id: string; reason: string }
  | { status: "not_found"; thread_id: string }
  | { status: "failed"; thread_id: string; error: string }

export interface SendScheduledOptions {
  thread_id: string
  message: string
  /** Tags the persisted agent message so we can filter for scheduled-vs-live
   * replies in analytics. Defaults to "scheduled_followup". */
  source?: string
}

/** Send a scheduled message into a live thread. Never throws. */
export async function sendScheduledMessage(
  opts: SendScheduledOptions,
): Promise<SendScheduledResult> {
  const threadId = opts.thread_id.trim()
  const messageText = opts.message.trim()
  const source = opts.source ?? "scheduled_followup"

  if (!threadId || !messageText) {
    return { status: "failed", thread_id: threadId, error: "thread_id and message are required" }
  }

  // 1. Load thread
  const conversation = await getThread(threadId)
  if (!conversation) {
    return { status: "not_found", thread_id: threadId }
  }

  // Supabase stores platform as plain string; cast to the internal Platform union.
  const platform = conversation.platform as Platform

  // 2. Re-run the routing safety stack. Human may have taken over since the
  //    schedule was created; cron invocations can fire hours/days after the
  //    original schedule_followup call.
  const routing = await checkRouting(conversation, conversation.sender_id, platform)
  if (!routing.allowed) {
    console.log(`[scheduled-send] Skipped ${threadId}: ${routing.reason}`)
    return { status: "skipped", thread_id: threadId, reason: routing.reason }
  }

  // 3. Load per-client platform credentials (falls back to env vars in adapter)
  const credentials = conversation.client_id
    ? (await getClientCredentials(conversation.client_id, platform)) ?? undefined
    : undefined

  // 3b. Outbound URL firewall — block LLM-authored URLs that aren't on the
  //     client's allowlist. Runs before we persist or send.
  const clientProfile = conversation.client_id
    ? await getClientProfile(conversation.client_id)
    : null
  const filterResult = filterOutbound(messageText, clientProfile)
  if (filterResult.allowed === false) {
    console.warn(
      `[scheduled-send] Outbound filter blocked ${threadId}:`,
      { blocked_urls: filterResult.blocked_urls },
    )

    await escalateThread({
      threadId,
      reason: "outbound_filter_triggered",
      priority: "urgent",
      source,
      skipLeadCreation: true,
    })

    try {
      await appendMessage(threadId, {
        role: "system",
        content: `[outbound filter blocked send: ${(filterResult.blocked_urls ?? []).join(", ")}]`,
        platform,
        timestamp: new Date().toISOString(),
        metadata: {
          source: "outbound_filter",
          blocked_urls: filterResult.blocked_urls,
          original_message: messageText,
          allowlist_used: filterResult.allowlist_used,
        },
      })
    } catch (err) {
      console.error(`[scheduled-send] Failed to append filter system message:`, err)
    }

    return {
      status: "skipped",
      thread_id: threadId,
      reason: "outbound_filter_triggered",
    }
  }

  // 4. Persist the agent message
  const agentMessage: StoredMessage = {
    role: "agent",
    content: messageText,
    platform,
    timestamp: new Date().toISOString(),
    metadata: { source },
  }
  await appendMessage(threadId, agentMessage)

  // 5. Send via the platform adapter
  try {
    const adapter = getAdapter(platform)
    await adapter.sendMessage(
      {
        recipient_id: conversation.sender_id,
        platform,
        message_text: messageText,
        thread_id: threadId,
      },
      credentials,
    )
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : "unknown send error"
    console.error(`[scheduled-send] Send failed for ${threadId}:`, err)
    return { status: "failed", thread_id: threadId, error: errMessage }
  }

  return { status: "sent", thread_id: threadId }
}
