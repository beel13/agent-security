/** Twilio Verify helper — Wave 7 booking verification flow.
 *
 * Sends and checks 6-digit SMS verification codes via the Twilio Verify v2 API.
 * Used during the booking flow to confirm a customer controls the phone number
 * they submitted before we commit an appointment or send downstream messages.
 *
 * Credentials resolution mirrors the SMS adapter in ../platforms/twilio.ts:
 *   account_sid / auth_token / verify_service_sid come from per-client
 *   PlatformCredentials with env-var fallback.
 *
 * This module never throws — every failure path returns a structured
 * VerifyResult with ok=false so callers can branch on status/error.
 */

import type { PlatformCredentials } from "../platforms/types"

interface VerifyResult {
  ok: boolean
  status: "pending" | "approved" | "canceled" | "error" | "not_found" | "max_attempts"
  error?: string
}

interface TwilioCreds {
  accountSid: string
  authToken: string
  verifyServiceSid: string
}

function resolveCreds(credentials?: PlatformCredentials): TwilioCreds | null {
  const accountSid = credentials?.account_sid ?? process.env.TWILIO_ACCOUNT_SID
  const authToken = credentials?.auth_token ?? process.env.TWILIO_AUTH_TOKEN
  const verifyServiceSid =
    credentials?.verify_service_sid ?? process.env.TWILIO_VERIFY_SERVICE_SID

  if (!accountSid || !authToken || !verifyServiceSid) {
    return null
  }
  return { accountSid, authToken, verifyServiceSid }
}

function authHeader(sid: string, token: string): string {
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64")
}

/** Map a Twilio API error code to our VerifyResult status. */
function mapErrorCode(code: number | undefined): VerifyResult["status"] {
  // https://www.twilio.com/docs/api/errors
  if (code === 20404) return "not_found"
  if (code === 60202) return "max_attempts"
  if (code === 60200) return "error" // invalid parameter
  return "error"
}

/** Start a Twilio Verify session — sends a 6-digit code to the phone. */
export async function startVerification(
  phone: string,
  credentials?: PlatformCredentials,
): Promise<VerifyResult> {
  const creds = resolveCreds(credentials)
  if (!creds) {
    console.error("[twilio-verify] missing credentials for startVerification")
    return { ok: false, status: "error", error: "missing_credentials" }
  }

  try {
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${creds.verifyServiceSid}/Verifications`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader(creds.accountSid, creds.authToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: phone,
          Channel: "sms",
        }),
      },
    )

    const data = (await response.json().catch(() => ({}))) as {
      status?: string
      code?: number
      message?: string
    }

    if (!response.ok) {
      console.error("[twilio-verify] startVerification failed:", data)
      return {
        ok: false,
        status: mapErrorCode(data.code),
        error: data.message ?? `http_${response.status}`,
      }
    }

    const status = data.status
    if (status === "pending" || status === "approved" || status === "canceled") {
      return { ok: true, status }
    }
    return { ok: false, status: "error", error: `unexpected_status:${status ?? "none"}` }
  } catch (err) {
    console.error("[twilio-verify] startVerification exception:", err)
    return {
      ok: false,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Check a code submitted by the customer. */
export async function checkVerification(
  phone: string,
  code: string,
  credentials?: PlatformCredentials,
): Promise<VerifyResult> {
  const creds = resolveCreds(credentials)
  if (!creds) {
    console.error("[twilio-verify] missing credentials for checkVerification")
    return { ok: false, status: "error", error: "missing_credentials" }
  }

  try {
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${creds.verifyServiceSid}/VerificationCheck`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader(creds.accountSid, creds.authToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: phone,
          Code: code,
        }),
      },
    )

    const data = (await response.json().catch(() => ({}))) as {
      status?: string
      code?: number
      message?: string
    }

    if (!response.ok) {
      console.error("[twilio-verify] checkVerification failed:", data)
      return {
        ok: false,
        status: mapErrorCode(data.code),
        error: data.message ?? `http_${response.status}`,
      }
    }

    const status = data.status
    if (status === "approved") {
      return { ok: true, status: "approved" }
    }
    if (status === "pending" || status === "canceled") {
      return { ok: false, status }
    }
    return { ok: false, status: "error", error: `unexpected_status:${status ?? "none"}` }
  } catch (err) {
    console.error("[twilio-verify] checkVerification exception:", err)
    return {
      ok: false,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
