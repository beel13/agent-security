import type { ClientProfile } from "../db/conversations"

export type ServiceAreaReason =
  | "in_area"
  | "out_of_area"
  | "no_zip_extracted"
  | "service_area_unconfigured"

export interface ServiceAreaCheck {
  allowed: boolean
  zip_extracted: string | null
  reason: ServiceAreaReason
}

/** Check if an address/input string is in the client's service area.
 *
 *  FAILS CLOSED when service_area.zips is empty/missing OR when no ZIP
 *  can be extracted from the input. The caller (book_appointment) must
 *  escalate to human in both failure modes — silently allowing would
 *  be a security bypass (Wave 7 adversarial review finding).
 */
export function isInServiceArea(
  clientProfile: ClientProfile | null,
  input: string,
): ServiceAreaCheck {
  // Extract the LAST 5-digit ZIP (optionally +4) from input.
  // Using "last" avoids treating a street number like "1234" in
  // "1234 5678 Main St" as the ZIP when the real ZIP is at the end.
  const zipRegex = /\b(\d{5})(?:-\d{4})?\b/g
  const matches = [...input.matchAll(zipRegex)]
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : null
  const zipExtracted = lastMatch ? lastMatch[1] : null

  if (!zipExtracted) {
    return { allowed: false, zip_extracted: null, reason: "no_zip_extracted" }
  }

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
