/** Shared escalation helper: flag a thread for human follow-up.
 *
 * Called by two paths:
 *   1. The escalate_to_human Gemini tool case in app/api/agent/core/actions.ts
 *      (when the main agent decides mid-conversation to escalate)
 *   2. The email classifier in /api/agent/webhooks/email/route.ts (when the
 *      upstream gate classifies an inbound email as escalate)
 *
 * Responsibilities:
 *   - Update conversation state to "escalated"
 *   - Mark owner ownership as "unassigned" so the agent backs off
 *   - Create a leads row with status="escalated"
 *   - Fire the n8n Agent Escalation Notifier webhook → Discord embed
 *   - Return an owner-aware handoff message the caller can use as a
 *     customer-facing ack
 *
 * Never throws. Webhook failures are logged and swallowed so a broken
 * n8n/Discord path doesn't break the main agent flow.
 */

import {
  updateConversation,
  markUnassigned,
  getThread,
  getOwnerDisplayName,
  getClientConfig,
  getClientById,
} from "../db/conversations"
import { createLeadFromConversation } from "./leads"
import type { StoredMessage } from "../platforms/types"

export interface EscalateThreadOptions {
  threadId: string
  reason: string
  priority?: "urgent" | "normal"
  /** Tags the escalation so analytics/dashboards can distinguish between
   *  Gemini-tool-triggered escalations and upstream-classifier escalations. */
  source?: string
  /** Wave 7: when an existing lead is being escalated (e.g. a reminder
   *  reply for reschedule/cancel), skip creating a new leads row.
   *  Without this flag, escalating a thread that already has a booking
   *  creates a duplicate escalated-status row for the same conversation. */
  skipLeadCreation?: boolean
}

export interface EscalateThreadResult {
  status: "escalated"
  owner_name: string
  handoff_message: string
}

/** Fire-and-forget POST to the n8n escalation webhook. Never throws. */
async function fireEscalationWebhook(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.N8N_ESCALATION_WEBHOOK_URL
  if (!url) return
  const secret = process.env.AGENT_WEBHOOK_SECRET?.trim()
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-webhook-secret": secret } : {}),
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      console.error(
        `[escalate] n8n webhook responded ${response.status}:`,
        await response.text(),
      )
    }
  } catch (err) {
    console.error("[escalate] n8n webhook fetch failed:", err)
  }
}

/** Escalate a conversation to a human. Updates state, marks unassigned,
 *  creates a leads row, fires the Discord webhook, returns a handoff
 *  message for the caller to display to the customer. */
export async function escalateThread(opts: EscalateThreadOptions): Promise<EscalateThreadResult> {
  const { threadId, reason, priority = "normal", source, skipLeadCreation = false } = opts

  // 1. State + context update
  const contextUpdate: Record<string, unknown> = {
    escalation_reason: reason,
    escalation_priority: priority,
  }
  if (source) contextUpdate.escalation_source = source

  await updateConversation(threadId, {
    state: "escalated",
    context: contextUpdate,
  })

  // 2. Mark thread unassigned so the agent stops responding
  await markUnassigned(threadId)

  // 3. Create a leads row for the dashboard (skipped when the caller is
  //    escalating an already-booked lead — reschedule/cancel reminder
  //    replies mutate the existing lead instead of creating a duplicate).
  if (!skipLeadCreation) {
    await createLeadFromConversation(threadId, "escalated")
  }

  // 4. Build and fire the Discord webhook payload
  const conv = await getThread(threadId)
  const ownerName = await getOwnerDisplayName(conv?.client_id ?? null)

  if (conv?.client_id) {
    const [config, clientRow] = await Promise.all([
      getClientConfig(conv.client_id),
      getClientById(conv.client_id),
    ])
    const lastMessages = ((conv.messages as unknown as StoredMessage[] | null) ?? []).slice(-3)
    await fireEscalationWebhook({
      client_id: conv.client_id,
      business_name: clientRow?.business_name ?? "Unknown",
      owner_display_name: config?.owner_display_name ?? ownerName,
      notification_channel: config?.notification_channel ?? "discord",
      notification_target: config?.notification_target ?? null,
      thread_id: threadId,
      platform: conv.platform,
      sender_id: conv.sender_id,
      reason,
      priority,
      source: source ?? null,
      last_messages: lastMessages,
    })
  }

  return {
    status: "escalated",
    owner_name: ownerName,
    handoff_message: `Let me get ${ownerName} on this for you. They'll reach out shortly.`,
  }
}
