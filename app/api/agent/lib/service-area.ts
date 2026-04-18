import type { ClientProfile } from "../db/conversations"

export type ServiceAreaReason =
  | "in_area"
  | "out_of_area"
  | "no_zip_extracted"
  | "zip_not_at_end"
  | "service_area_unconfigured"

export interface ServiceAreaCheck {
  allowed: boolean
  zip_extracted: string | null
  reason: ServiceAreaReason
}

/** Check if an address/input string is in the client's service area.
 *
 *  FAILS CLOSED when service_area.zips is empty/missing, when no ZIP can
 *  be extracted from the input, or when a ZIP is found but is NOT in the
 *  final-token position of the address (see positional-enforcement note).
 *  The caller (book_appointment) must escalate to human in every failure
 *  mode — silently allowing would be a security bypass.
 */
export function isInServiceArea(
  clientProfile: ClientProfile | null,
  input: string,
): ServiceAreaCheck {
  // Positional enforcement: the ZIP must appear at the END of the input,
  // followed only by trailing whitespace/punctuation (and optional +4).
  //
  // Adversarial review (Codex) found that "last 5-digit token anywhere"
  // was spoofable by appending an allowlisted ZIP after an out-of-area
  // address, e.g. "123 Main St Detroit MI 48201, 92672" would extract
  // 92672 and pass if it were on the allowlist. Requiring end-of-string
  // placement forces an attacker to strip the real ZIP entirely, which
  // is much harder to do without the customer noticing.
  const endZipRegex = /\b(\d{5})(?:-\d{4})?[\s,.;:!?)\]}>'"*\u00A0]*$/
  const endMatch = input.match(endZipRegex)

  if (!endMatch) {
    // No ZIP at end. Distinguish "no ZIP anywhere" from "ZIP found but
    // not at end" so the caller can log/escalate differently.
    const anyZipRegex = /\b(\d{5})(?:-\d{4})?\b/g
    const anyMatches = [...input.matchAll(anyZipRegex)]
    if (anyMatches.length > 0) {
      return {
        allowed: false,
        zip_extracted: null,
        reason: "zip_not_at_end",
      }
    }
    return { allowed: false, zip_extracted: null, reason: "no_zip_extracted" }
  }

  const zipExtracted = endMatch[1]

  // Defensive: ClientProfile is Record<string, unknown>, so every field
  // needs runtime shape checks before we trust it.
  const serviceArea =
    clientProfile && typeof clientProfile === "object"
      ? (clientProfile["service_area"] as unknown)
      : null

  const zipsRaw =
    serviceArea && typeof serviceArea === "object" && serviceArea !== null
      ? (serviceArea as Record<string, unknown>)["zips"]
      : null

  if (!Array.isArray(zipsRaw) || zipsRaw.length === 0) {
    const businessName =
      clientProfile && typeof clientProfile === "object"
        ? (clientProfile["business_name"] as unknown)
        : null
    console.warn(
      `[service-area] service_area.zips missing or empty for client "${
        typeof businessName === "string" ? businessName : "unknown"
      }" — failing closed.`,
    )
    return {
      allowed: false,
      zip_extracted: zipExtracted,
      reason: "service_area_unconfigured",
    }
  }

  // Normalize: trim + take first 5 digits. Accept only string entries.
  const normalizedZips = zipsRaw
    .filter((z): z is string => typeof z === "string")
    .map((z) => {
      const m = z.trim().match(/^(\d{5})/)
      return m ? m[1] : null
    })
    .filter((z): z is string => z !== null)

  if (normalizedZips.includes(zipExtracted)) {
    return { allowed: true, zip_extracted: zipExtracted, reason: "in_area" }
  }

  return {
    allowed: false,
    zip_extracted: zipExtracted,
    reason: "out_of_area",
  }
}
