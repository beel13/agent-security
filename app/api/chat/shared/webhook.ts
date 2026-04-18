/**
 * Shared constants for external service calls across all demos.
 * The webhook hostname is configured via environment at runtime.
 * Consumers must treat an empty URL as "webhook disabled", not "use default".
 */

export const LEAD_WEBHOOK_URL = process.env.LEAD_WEBHOOK_URL ?? ""

/** Timeout for webhook and external API calls (ms). */
export const EXTERNAL_TIMEOUT_MS = 5000
