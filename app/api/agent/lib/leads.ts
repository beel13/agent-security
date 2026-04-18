/** Leads table writer.
 *
 * Shared helper used by both the booking and escalation paths in the
 * agent. When a conversation reaches a terminal state — booking confirmed
 * or escalated to a human — we drop a row into the existing `leads` table
 * so the dashboard + outreach pipeline can pick it up.
 *
 * Extracted from app/api/agent/core/actions.ts so it can be reused from
 * lib/escalate.ts without import cycles.
 */

import { createServiceClient } from "@/lib/supabase/server"
import { getThread } from "../db/conversations"

export interface CreateLeadExtras {
  appointment_at?: string | null
  address?: string | null
  verification_status?: "unverified" | "pending" | "verified" | "failed"
  verification_method?: string | null
  verified_phone?: string | null
}

/** Create a leads row from a conversation's current state.
 *  Never throws — on any error we log and drop. The leads row is a
 *  side-effect, not the primary outcome of the caller.
 *
 *  Returns the new lead's id on success, null on failure. (Wave 7:
 *  the caller needs the id to schedule appointment reminders.)
 */
export async function createLeadFromConversation(
  threadId: string,
  status: string,
  extras?: CreateLeadExtras,
): Promise<string | null> {
  const conv = await getThread(threadId)
  if (!conv) return null

  const ctx = (conv.context as Record<string, unknown>) ?? {}
  const contact = (conv.contact_info as Record<string, unknown>) ?? {}
  const clientId = conv.client_id ?? process.env.SUPABASE_DEFAULT_CLIENT_ID

  if (!clientId) return null

  const supabase = createServiceClient()

  try {
    const { data, error } = await supabase
      .from("leads")
      .insert({
        client_id: clientId,
        name: (contact.name as string) ?? null,
        contact: (contact.phone as string) ?? (contact.email as string) ?? conv.sender_id,
        source: `agent_${conv.platform}`,
        business_type: (ctx.business_type as string) ?? null,
        service_type: (ctx.service_type as string) ?? null,
        urgency_level: (ctx.urgency as string) ?? null,
        booking_slot: (ctx.booking_slot as string) ?? null,
        status,
        tags: [conv.platform, ctx.intent as string].filter(Boolean) as string[],
        turn_count: ((conv.messages as unknown[]) ?? []).length,
        // Wave 7 booking safety fields (optional, only set on confirmed bookings)
        appointment_at: extras?.appointment_at ?? null,
        address: extras?.address ?? null,
        verification_status: extras?.verification_status ?? "unverified",
        verification_method: extras?.verification_method ?? null,
        verified_phone: extras?.verified_phone ?? null,
      })
      .select("id")
      .single()

    if (error) {
      console.error("[leads] Failed to create lead from conversation:", error)
      return null
    }
    return data?.id ?? null
  } catch (err) {
    console.error("[leads] Failed to create lead from conversation:", err)
    return null
  }
}
