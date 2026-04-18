/** Agent tool declarations and action executors.
 *
 * These are the Gemini function-calling tools available to the agent.
 * Each tool extracts information or triggers a side effect (booking,
 * escalation, follow-up scheduling).
 */

import { SchemaType, type FunctionDeclaration } from "@google/generative-ai"
import {
  updateConversation,
  getThread,
  getClientCredentials,
  getClientProfile,
} from "../db/conversations"
import { createServiceClient } from "@/lib/supabase/server"
import { createLeadFromConversation } from "../lib/leads"
import { escalateThread } from "../lib/escalate"
import { startVerification, checkVerification } from "../lib/twilio-verify"
import { isInServiceArea } from "../lib/service-area"
import { scheduleAppointmentReminders } from "../lib/reminders"
import type { ConversationState, Platform } from "../platforms/types"

// Wave 7 verification constants
const MAX_VERIFICATION_ATTEMPTS = 2

/** Normalize a phone number to E.164-ish form for comparison.
 *  Strips everything except digits, then prefixes '+' if not present.
 *  +1 is assumed for 10-digit US numbers.
 */
function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return digits.length > 0 ? `+${digits}` : ""
}

/** Tool declarations for Gemini function calling. */
export const AGENT_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "extract_contact_info",
    description: "Extract and store customer contact information from the conversation. Call when the customer shares their name, phone, or email.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING, description: "Customer's name" },
        phone: { type: SchemaType.STRING, description: "Phone number" },
        email: { type: SchemaType.STRING, description: "Email address" },
      },
    },
  },
  {
    name: "classify_intent",
    description: "Classify the customer's intent. Call on the first message to understand what they need.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        intent: {
          type: SchemaType.STRING,
          description: "One of: new_lead, existing_customer, spam, wrong_number",
        },
        service_type: {
          type: SchemaType.STRING,
          description: "The service they need (e.g., 'AC repair', 'drain cleaning')",
        },
        issue_summary: {
          type: SchemaType.STRING,
          description: "Brief description of the problem",
        },
      },
      required: ["intent"],
    },
  },
  {
    name: "assess_urgency",
    description: "Assess the urgency of the service request.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        level: {
          type: SchemaType.STRING,
          description: "One of: emergency, same_day, normal, low",
        },
        reason: {
          type: SchemaType.STRING,
          description: "Brief reason for this urgency level",
        },
      },
      required: ["level", "reason"],
    },
  },
  {
    name: "request_phone_verification",
    description:
      "Send a 6-digit verification code via SMS to confirm the customer's phone. Call this AFTER you have the customer's name, service type, and phone — but BEFORE book_appointment. The code is sent by the system; tell the customer to reply with it.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        phone: {
          type: SchemaType.STRING,
          description: "The customer's phone number to verify, in any format (we normalize).",
        },
      },
      required: ["phone"],
    },
  },
  {
    name: "confirm_verification_code",
    description:
      "Validate the 6-digit code the customer replied with. Call this immediately after the customer sends the code.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        code: {
          type: SchemaType.STRING,
          description: "The 6-digit code the customer replied with.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Confirm a booking. Only call this AFTER verification succeeds. Requires the exact appointment datetime (ISO format), the service address including ZIP, and the customer's phone (must match the verified number).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        preferred_time: {
          type: SchemaType.STRING,
          description: "Human-readable time the customer wanted (e.g., 'tomorrow 9am'). Kept for logs.",
        },
        appointment_at: {
          type: SchemaType.STRING,
          description:
            "ISO 8601 datetime of the booked appointment, e.g. '2026-04-18T09:00:00-07:00'. Required.",
        },
        address: {
          type: SchemaType.STRING,
          description:
            "Service address including street, city, and ZIP. We extract the ZIP and check it against the client's service area. Required.",
        },
        customer_phone: {
          type: SchemaType.STRING,
          description:
            "The phone number to book under. Must match the phone that was verified.",
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: "True if the customer confirmed the slot, false if just offering.",
        },
        slot: {
          type: SchemaType.STRING,
          description: "The specific time slot being offered or confirmed.",
        },
      },
      required: ["preferred_time", "appointment_at", "address", "customer_phone"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Flag this conversation for human follow-up. Use for complex issues, frustrated customers, or situations the AI can't handle.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reason: {
          type: SchemaType.STRING,
          description: "Why this needs human attention",
        },
        priority: {
          type: SchemaType.STRING,
          description: "One of: urgent, normal",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "schedule_followup",
    description: "Queue a follow-up message to send to the customer at a later time. Use this when the customer says 'check back later', 'ping me tomorrow', 'I'll think about it', 'remind me in X minutes/hours/days', or any phrasing that asks to be contacted again at a specific delay.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        delay_minutes: {
          type: SchemaType.INTEGER,
          description: "How many MINUTES from now to send the follow-up. Whole numbers only — no fractions, no math expressions. Examples: 2 (for 'in 2 minutes'), 60 (for 'in 1 hour'), 1440 (for 'tomorrow'), 10080 (for 'next week'). Cap at 20160 (14 days).",
        },
        message: {
          type: SchemaType.STRING,
          description: "The exact text to send to the customer when the follow-up fires. Write it now in full as if you were sending it. Example: 'Hey, just checking back in — were you able to think about whether you'd like to set up a quick call?' Do not leave this blank.",
        },
      },
      required: ["delay_minutes", "message"],
    },
  },
]

/** Execute a tool call and return the result + any state transition. */
export async function executeAction(
  toolName: string,
  args: Record<string, unknown>,
  threadId: string,
): Promise<{
  result: Record<string, unknown>
  newState?: ConversationState
}> {
  switch (toolName) {
    case "extract_contact_info": {
      const contactInfo: Record<string, unknown> = {}
      if (args.name) contactInfo.name = args.name
      if (args.phone) contactInfo.phone = args.phone
      if (args.email) contactInfo.email = args.email

      await updateConversation(threadId, { contact_info: contactInfo })
      return { result: { status: "contact_info_saved", ...contactInfo } }
    }

    case "classify_intent": {
      const context: Record<string, unknown> = { intent: args.intent }
      if (args.service_type) context.service_type = args.service_type
      if (args.issue_summary) context.issue_summary = args.issue_summary

      const newState: ConversationState = args.intent === "spam" || args.intent === "wrong_number"
        ? "closed"
        : "qualifying"

      await updateConversation(threadId, { context, state: newState })
      return { result: { status: "intent_classified", ...context }, newState }
    }

    case "assess_urgency": {
      await updateConversation(threadId, {
        context: { urgency: args.level, urgency_reason: args.reason },
      })
      return { result: { status: "urgency_assessed", level: args.level, reason: args.reason } }
    }

    case "request_phone_verification": {
      const conv = await getThread(threadId)
      if (!conv) {
        return { result: { status: "error", error: "conversation_not_found" } }
      }
      const ctx = (conv.context as Record<string, unknown>) ?? {}
      const attempts = typeof ctx.verification_attempts === "number" ? ctx.verification_attempts : 0

      // Server-side cap: refuse if already at max attempts (Wave 7 adversarial finding —
      // prompt-only caps leak through if Gemini loses context).
      if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
        return {
          result: {
            status: "too_many_attempts",
            max_attempts: MAX_VERIFICATION_ATTEMPTS,
            reason: "Verification attempt cap reached. Escalate to a human.",
          },
        }
      }

      const rawPhone = typeof args.phone === "string" ? args.phone : ""
      const phone = normalizePhone(rawPhone)
      if (!phone) {
        return { result: { status: "error", error: "invalid_phone" } }
      }

      // Soft bypass — Twilio Verify is deferred until the Service SID
      // is set up. When PHONE_VERIFICATION_ENABLED is not "true", we
      // skip the actual Verify send, auto-approve locally, and stamp
      // the lead with verification_status='unverified' at book time
      // so it's visible in the dashboard that this booking wasn't
      // phone-verified. Once Twilio Verify is configured, flip the
      // env var to "true" to enforce verification.
      if (process.env.PHONE_VERIFICATION_ENABLED !== "true") {
        await updateConversation(threadId, {
          context: {
            verification_pending: false,
            verification_phone: phone,
            phone_verified: true,
            verification_bypassed: true,
            verification_attempts: 0,
          },
        })
        return {
          result: {
            status: "verification_skipped",
            reason: "verification_disabled",
            phone_masked: phone.replace(/^(\+\d{1,2})\d+(\d{4})$/, "$1****$2"),
          },
        }
      }

      // Load Twilio credentials from the client's SMS platform creds
      const credentials = conv.client_id
        ? (await getClientCredentials(conv.client_id, "sms")) ?? undefined
        : undefined

      const result = await startVerification(phone, credentials)

      if (!result.ok) {
        return {
          result: {
            status: "error",
            error: result.error ?? result.status,
          },
        }
      }

      // Wave 7 adversarial-review fix: when a new verification starts,
      // reset `phone_verified` so a stale "true" from a prior phone
      // can't slip through the book_appointment gate. Also reset the
      // attempt counter if the phone changed (otherwise a typo on
      // phone A would burn attempts needed for the correct phone B).
      const priorPhone =
        typeof ctx.verification_phone === "string" ? ctx.verification_phone : ""
      const phoneChanged = priorPhone && priorPhone !== phone
      await updateConversation(threadId, {
        context: {
          verification_pending: true,
          verification_phone: phone,
          phone_verified: false,
          verification_attempts: phoneChanged ? 0 : attempts,
        },
      })

      return {
        result: {
          status: "verification_sent",
          phone_masked: phone.replace(/^(\+\d{1,2})\d+(\d{4})$/, "$1****$2"),
        },
      }
    }

    case "confirm_verification_code": {
      const conv = await getThread(threadId)
      if (!conv) {
        return { result: { status: "error", error: "conversation_not_found" } }
      }
      const ctx = (conv.context as Record<string, unknown>) ?? {}
      const attempts = typeof ctx.verification_attempts === "number" ? ctx.verification_attempts : 0
      const phone = typeof ctx.verification_phone === "string" ? ctx.verification_phone : ""

      // If the request_phone_verification took the soft-bypass path,
      // phone_verified is already true. Short-circuit the check here
      // so the agent doesn't confuse itself re-verifying.
      if (ctx.verification_bypassed === true && ctx.phone_verified === true) {
        return { result: { status: "verified", bypassed: true } }
      }

      if (!phone) {
        return { result: { status: "error", error: "no_verification_pending" } }
      }

      if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
        return {
          result: {
            status: "too_many_attempts",
            max_attempts: MAX_VERIFICATION_ATTEMPTS,
            reason: "Verification attempt cap reached. Escalate.",
          },
        }
      }

      const code = typeof args.code === "string" ? args.code.trim() : ""
      if (!/^\d{4,10}$/.test(code)) {
        // Don't bill Twilio for obviously-invalid codes. Increment anyway.
        await updateConversation(threadId, {
          context: { verification_attempts: attempts + 1 },
        })
        return {
          result: {
            status: "invalid_code",
            retries_remaining: Math.max(0, MAX_VERIFICATION_ATTEMPTS - (attempts + 1)),
            reason: "Code format invalid.",
          },
        }
      }

      const credentials = conv.client_id
        ? (await getClientCredentials(conv.client_id, "sms")) ?? undefined
        : undefined

      const result = await checkVerification(phone, code, credentials)

      if (result.ok && result.status === "approved") {
        await updateConversation(threadId, {
          context: {
            phone_verified: true,
            verification_pending: false,
            // Keep verification_phone + verification_attempts for book_appointment to inspect
          },
        })
        return { result: { status: "verified" } }
      }

      // Failed — increment and report remaining retries
      const newAttempts = attempts + 1
      await updateConversation(threadId, {
        context: { verification_attempts: newAttempts },
      })

      return {
        result: {
          status: newAttempts >= MAX_VERIFICATION_ATTEMPTS ? "too_many_attempts" : "invalid_code",
          retries_remaining: Math.max(0, MAX_VERIFICATION_ATTEMPTS - newAttempts),
          twilio_status: result.status,
        },
      }
    }

    case "book_appointment": {
      const isConfirmed = args.confirmed === true

      // Wave 7: unconfirmed offers keep legacy behavior — just log the preferred time.
      if (!isConfirmed) {
        const context: Record<string, unknown> = {
          preferred_time: args.preferred_time,
          booking_confirmed: false,
        }
        if (args.slot) context.booking_slot = args.slot
        await updateConversation(threadId, { context, state: "booking" })
        return {
          result: {
            status: "slots_offered",
            slot: args.slot ?? args.preferred_time,
          },
          newState: "booking",
        }
      }

      // ── Confirmed booking path — Wave 7 safety gates ──────────────
      const conv = await getThread(threadId)
      if (!conv) {
        return { result: { status: "error", error: "conversation_not_found" } }
      }
      const ctx = (conv.context as Record<string, unknown>) ?? {}

      // Gate 1: verification bound to a specific phone
      const customerPhoneRaw = typeof args.customer_phone === "string" ? args.customer_phone : ""
      const customerPhone = normalizePhone(customerPhoneRaw)
      const verificationPhone =
        typeof ctx.verification_phone === "string" ? ctx.verification_phone : ""
      const phoneVerified = ctx.phone_verified === true

      if (!phoneVerified || !verificationPhone || customerPhone !== verificationPhone) {
        return {
          result: {
            status: "verification_required",
            reason: !phoneVerified
              ? "no_verification_in_context"
              : "phone_mismatch",
            verified_phone_masked: verificationPhone
              ? verificationPhone.replace(/^(\+\d{1,2})\d+(\d{4})$/, "$1****$2")
              : null,
          },
        }
      }

      // Gate 2: service area
      const address = typeof args.address === "string" ? args.address : ""
      const clientId = conv.client_id ?? null
      const clientProfile = clientId ? await getClientProfile(clientId) : null

      const areaCheck = isInServiceArea(clientProfile, address)
      if (!areaCheck.allowed) {
        return {
          result: {
            status: areaCheck.reason === "service_area_unconfigured"
              ? "service_area_unconfigured"
              : "out_of_service_area",
            reason: areaCheck.reason,
            zip_extracted: areaCheck.zip_extracted,
          },
        }
      }

      // All gates passed — create the leads row
      const appointmentAt =
        typeof args.appointment_at === "string" ? args.appointment_at : null
      if (!appointmentAt) {
        return { result: { status: "error", error: "missing_appointment_at" } }
      }

      const bookingContext: Record<string, unknown> = {
        preferred_time: args.preferred_time,
        booking_confirmed: true,
        booking_slot: args.slot ?? args.preferred_time,
      }
      await updateConversation(threadId, {
        context: bookingContext,
        state: "closed",
      })

      // When verification was bypassed (Twilio Verify not yet set up),
      // mark the lead as unverified so the dashboard + future fraud
      // review can distinguish real-verified bookings from bypassed
      // ones. The booking still goes through.
      const verificationBypassed = ctx.verification_bypassed === true
      const leadId = await createLeadFromConversation(threadId, "booked", {
        appointment_at: appointmentAt,
        address,
        verification_status: verificationBypassed ? "unverified" : "verified",
        verification_method: verificationBypassed ? "bypassed" : "twilio_verify",
        verified_phone: verificationBypassed ? null : verificationPhone,
      })

      if (leadId && clientId) {
        const clientProfileForName = clientProfile ?? {}
        const businessName =
          (clientProfileForName.business_name as string | undefined) ?? "your service team"

        await scheduleAppointmentReminders({
          threadId,
          clientId,
          leadId,
          appointmentAt,
          customerPhone: verificationPhone,
          businessName,
        })
      }

      // Clear verification scope so a future rebook requires fresh
      // verification (or a fresh bypass). DO NOT set
      // awaiting_reminder_reply here — if we did, a routine "ok thanks"
      // right after booking would get interpreted as a reminder
      // confirmation. The flag is armed only when an actual reminder
      // goes out (see process-followups cron).
      await updateConversation(threadId, {
        context: {
          phone_verified: false,
          verification_pending: false,
          verification_phone: null,
          verification_attempts: 0,
          verification_bypassed: false,
          lead_id: leadId,
        },
      })

      return {
        result: {
          status: "booking_confirmed",
          slot: args.slot ?? args.preferred_time,
          appointment_at: appointmentAt,
          lead_id: leadId,
          zip: areaCheck.zip_extracted,
        },
        newState: "closed",
      }
    }

    case "escalate_to_human": {
      // Delegates to the shared escalateThread helper so the email
      // classifier path and this Gemini tool-call path share one
      // implementation. See app/api/agent/lib/escalate.ts.
      const rawPriority = args.priority
      const priority: "urgent" | "normal" = rawPriority === "urgent" ? "urgent" : "normal"
      const result = await escalateThread({
        threadId,
        reason: typeof args.reason === "string" ? args.reason : "no reason provided",
        priority,
        source: "gemini_tool",
      })
      return {
        result: {
          status: result.status,
          reason: args.reason,
          owner_name: result.owner_name,
          handoff_message: result.handoff_message,
        },
        newState: "escalated",
      }
    }

    case "schedule_followup": {
      // Sanitize delay_minutes — Gemini may return strings, floats, or
      // (legacy schema) delay_hours. Normalize to integer minutes.
      const rawMinutes = args.delay_minutes
      const rawHours = args.delay_hours // legacy fallback for in-flight calls
      let delayMinutes: number
      if (typeof rawMinutes === "number") {
        delayMinutes = Math.round(rawMinutes)
      } else if (typeof rawMinutes === "string") {
        delayMinutes = Math.round(parseFloat(rawMinutes))
      } else if (typeof rawHours === "number") {
        delayMinutes = Math.round(rawHours * 60)
      } else if (typeof rawHours === "string") {
        delayMinutes = Math.round(parseFloat(rawHours) * 60)
      } else {
        delayMinutes = 60 * 24 // default: 1 day
      }
      if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) delayMinutes = 60 * 24
      // Floor: model can't schedule sub-minute followups (would race with the
      // current reply and feel like spam). Customer is reading the same
      // thread that's about to send a followup; give it room to breathe.
      const MIN_MINUTES = 60
      if (delayMinutes < MIN_MINUTES) delayMinutes = MIN_MINUTES
      // Ceiling: 14 days to prevent runaway scheduling.
      const MAX_MINUTES = 14 * 24 * 60
      if (delayMinutes > MAX_MINUTES) delayMinutes = MAX_MINUTES

      // Cap message length so a prompt-injected model can't enqueue a
      // novel-length payload that hits SMS/email size limits.
      const MAX_FOLLOWUP_CHARS = 500
      let followupMessage = typeof args.message === "string" && args.message.trim().length > 0
        ? args.message.trim()
        : "Hey, just checking back in — were you able to think it over?"
      if (followupMessage.length > MAX_FOLLOWUP_CHARS) {
        followupMessage = followupMessage.slice(0, MAX_FOLLOWUP_CHARS)
      }

      // Cap pending followups per thread so a hostile conversation can't
      // enqueue dozens of messages in a single tool-loop iteration.
      const MAX_PENDING_PER_THREAD = 3
      const supabaseFollowup = createServiceClient()
      const { count: pendingCount } = await supabaseFollowup
        .from("scheduled_followups")
        .select("id", { count: "exact", head: true })
        .eq("thread_id", threadId)
        .eq("status", "pending")
      if ((pendingCount ?? 0) >= MAX_PENDING_PER_THREAD) {
        console.warn(
          `[schedule_followup] thread ${threadId} already has ${pendingCount} pending followups, refusing to enqueue more`,
        )
        return {
          result: {
            status: "followup_skipped",
            reason: `Already ${pendingCount} pending followups on this thread (max ${MAX_PENDING_PER_THREAD})`,
          },
        }
      }

      await updateConversation(threadId, {
        context: {
          followup_scheduled: true,
          followup_delay_minutes: delayMinutes,
          followup_message: followupMessage,
        },
      })

      // Insert into the scheduled_followups queue. A Vercel Cron job
      // (/api/cron/process-followups) polls the table every minute and
      // delivers due rows via sendScheduledMessage. Replaces the previous
      // n8n Followup Sender webhook architecture (decommissioned).
      const fireAt = new Date(Date.now() + delayMinutes * 60_000).toISOString()
      const conv = await getThread(threadId)
      const { error: insertErr } = await supabaseFollowup
        .from("scheduled_followups")
        .insert({
          thread_id: threadId,
          client_id: conv?.client_id ?? null,
          message: followupMessage,
          fire_at: fireAt,
          status: "pending",
        })
      if (insertErr) {
        console.error("[schedule_followup] Failed to enqueue:", insertErr)
      }

      return {
        result: {
          status: "followup_scheduled",
          delay_minutes: delayMinutes,
          fire_at: fireAt,
        },
      }
    }

    default:
      return { result: { error: `Unknown tool: ${toolName}` } }
  }
}
