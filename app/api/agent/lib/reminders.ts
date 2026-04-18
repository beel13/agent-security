/** Schedule appointment reminders (24h + 2h before the appointment).
 *
 * Called after a successful booking tool (e.g. book_appointment) to enqueue
 * two rows into `scheduled_followups` with `kind = reminder_24h | reminder_2h`.
 * The Vercel Cron job (/api/cron/process-followups) picks them up and delivers
 * them via the standard scheduled-send path.
 *
 * Idempotency is guaranteed by the partial unique index
 * `idx_scheduled_followups_one_pending_per_lead_kind` on
 * (lead_id, kind) WHERE status = 'pending'. We use upsert with
 * `onConflict: "lead_id,kind"` and `ignoreDuplicates: true` so replays
 * (Gemini tool retries, cron re-drives) are no-ops instead of errors.
 *
 * Never throws. Logs errors with the `[reminders]` prefix.
 */

import { createServiceClient } from "@/lib/supabase/server"

export interface ScheduleRemindersOptions {
  threadId: string
  clientId: string
  leadId: string
  /** ISO datetime of the appointment */
  appointmentAt: string
  /** Customer's verified phone (displayed in reminder for their reassurance) */
  customerPhone: string
  businessName: string
}

export interface ScheduleRemindersResult {
  scheduled_24h: boolean
  scheduled_2h: boolean
  skipped_reasons: Array<"past_due" | "duplicate">
}

const HOUR_MS = 60 * 60 * 1000

/** Format an appointment time in a human-friendly, customer-facing way.
 *
 * Examples (relative to now):
 *   today  -> "today at 3pm"
 *   +1d    -> "tomorrow at 9am"
 *   +2..6d -> "Mon at 9am"
 *   >7d    -> "Mon, Apr 28 at 9am"
 *
 * Uses Intl.DateTimeFormat with en-US for stable wording regardless of
 * server locale.
 */
export function formatAppointmentTime(date: Date): string {
  const now = new Date()
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
  // "3:00 PM" -> "3pm" ; "3:30 PM" -> "3:30pm"
  const rawTime = timeFmt.format(date).toLowerCase().replace(/\s/g, "")
  const timeStr = rawTime.replace(":00", "")

  const startOfDay = (d: Date) => {
    const x = new Date(d)
    x.setHours(0, 0, 0, 0)
    return x
  }
  const dayDiff = Math.round(
    (startOfDay(date).getTime() - startOfDay(now).getTime()) / (24 * HOUR_MS),
  )

  if (dayDiff === 0) return `today at ${timeStr}`
  if (dayDiff === 1) return `tomorrow at ${timeStr}`
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date)
    return `${weekday} at ${timeStr}`
  }
  // Far out or in the past — include the date.
  const dateStr = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date)
  return `${dateStr} at ${timeStr}`
}

export async function scheduleAppointmentReminders(
  opts: ScheduleRemindersOptions,
): Promise<ScheduleRemindersResult> {
  const result: ScheduleRemindersResult = {
    scheduled_24h: false,
    scheduled_2h: false,
    skipped_reasons: [],
  }

  const appointmentAt = new Date(opts.appointmentAt)
  if (Number.isNaN(appointmentAt.getTime())) {
    console.error(
      "[reminders] Invalid appointmentAt, skipping all reminders:",
      opts.appointmentAt,
    )
    result.skipped_reasons.push("past_due")
    return result
  }

  const now = new Date()
  const diffMs = appointmentAt.getTime() - now.getTime()

  // If the appointment is less than 2h out, neither reminder is useful —
  // the booking tool should have rejected this, but be defensive.
  if (diffMs < 2 * HOUR_MS) {
    result.skipped_reasons.push("past_due")
    return result
  }

  const timeStr = formatAppointmentTime(appointmentAt)
  const fire24h = new Date(appointmentAt.getTime() - 24 * HOUR_MS)
  const fire2h = new Date(appointmentAt.getTime() - 2 * HOUR_MS)

  const message24h =
    `Reminder: your ${opts.businessName} appointment is ${timeStr}. ` +
    `Reply C to confirm, R to reschedule, or X to cancel.`
  const message2h =
    `Reminder: ${opts.businessName} will be heading over in about 2 hours ` +
    `for your ${timeStr} appointment. Reply C to confirm or X to cancel.`

  const supabase = createServiceClient()

  // Idempotency note: Postgres ON CONFLICT requires a non-partial unique
  // constraint to infer the conflict target, but our uniqueness is
  // enforced by the PARTIAL index
  // idx_scheduled_followups_one_pending_per_lead_kind (WHERE status='pending').
  // Supabase upsert can't target partial indexes, so we do a plain
  // INSERT and swallow the 23505 (unique_violation) error when the
  // partial index rejects a duplicate pending row. Adversarial-review fix.
  const DUPLICATE_KEY_CODE = "23505"

  const tryInsertReminder = async (
    kind: "reminder_24h" | "reminder_2h",
    message: string,
    fireAt: Date,
  ): Promise<"inserted" | "duplicate" | "error"> => {
    const { error } = await supabase.from("scheduled_followups").insert({
      thread_id: opts.threadId,
      client_id: opts.clientId,
      lead_id: opts.leadId,
      kind,
      message,
      fire_at: fireAt.toISOString(),
      status: "pending",
    })

    if (!error) return "inserted"

    // Supabase error shape: { code, message, ... }. The partial unique
    // index returns Postgres 23505 on conflict.
    const code = (error as { code?: string }).code
    const message_ = error.message ?? ""
    if (code === DUPLICATE_KEY_CODE || /duplicate key/i.test(message_)) {
      return "duplicate"
    }

    console.error(`[reminders] Failed to enqueue ${kind}:`, error)
    return "error"
  }

  // --- 24h reminder ---
  if (diffMs < 24 * HOUR_MS) {
    // Appointment is within 24h, skip the 24h reminder but keep the 2h.
    result.skipped_reasons.push("past_due")
  } else {
    const outcome = await tryInsertReminder("reminder_24h", message24h, fire24h)
    if (outcome === "inserted") result.scheduled_24h = true
    else if (outcome === "duplicate") result.skipped_reasons.push("duplicate")
  }

  // --- 2h reminder ---
  const outcome2h = await tryInsertReminder("reminder_2h", message2h, fire2h)
  if (outcome2h === "inserted") result.scheduled_2h = true
  else if (outcome2h === "duplicate") result.skipped_reasons.push("duplicate")

  return result
}
