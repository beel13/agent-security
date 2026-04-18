/** Shared constants for external service calls across all demos. */

export const LEAD_WEBHOOK_URL =
  process.env.LEAD_WEBHOOK_URL ??
  "https://webhook.ggautomate.com/webhook/gg-lead-form"

/** Timeout for webhook and external API calls (ms). */
export const EXTERNAL_TIMEOUT_MS = 5000
