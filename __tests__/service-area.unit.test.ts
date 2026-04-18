import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { isInServiceArea } from "../app/api/agent/lib/service-area"
import type { ClientProfile } from "../app/api/agent/db/conversations"

describe("isInServiceArea — positional ZIP enforcement", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  const allowlistedProfile: ClientProfile = {
    service_area: { zips: ["92672", "92673"] },
  }

  it("accepts a ZIP at the end of a canonical US address", () => {
    const result = isInServiceArea(
      allowlistedProfile,
      "1234 Main St, San Clemente, CA 92672",
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe("in_area")
    expect(result.zip_extracted).toBe("92672")
  })

  it("accepts a ZIP followed by trailing punctuation", () => {
    const result = isInServiceArea(
      allowlistedProfile,
      "1234 Main St, San Clemente, CA 92672.",
    )
    expect(result.allowed).toBe(true)
    expect(result.zip_extracted).toBe("92672")
  })

  it("accepts a ZIP+4 at the end", () => {
    const result = isInServiceArea(
      allowlistedProfile,
      "1234 Main St, San Clemente, CA 92672-1234",
    )
    expect(result.allowed).toBe(true)
    expect(result.zip_extracted).toBe("92672")
  })

  it("blocks an out-of-area ZIP even when at the end", () => {
    const result = isInServiceArea(
      allowlistedProfile,
      "1234 Main St, Detroit, MI 48201",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("out_of_area")
    expect(result.zip_extracted).toBe("48201")
  })

  it("rejects an address with no ZIP at all", () => {
    const result = isInServiceArea(
      allowlistedProfile,
      "1234 Main St, Detroit, MI",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("no_zip_extracted")
  })

  // ── The positional-enforcement / spoofing-bypass case ────────────────

  it("rejects an allowlisted ZIP appended AFTER a real out-of-area address", () => {
    // Attacker appends an allowlisted ZIP to spoof the service-area check.
    // The old regex took the last ZIP anywhere; the new regex requires
    // end-of-string placement with only trailing punctuation. Anything
    // between the ZIP and end-of-string should reject.
    const result = isInServiceArea(
      allowlistedProfile,
      "1234 Main St, Detroit, MI 48201, 92672 extra trailing text",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("zip_not_at_end")
    expect(result.zip_extracted).toBe(null)
  })

  it("rejects when an allowlisted ZIP sits mid-sentence with a fake suffix", () => {
    const result = isInServiceArea(
      allowlistedProfile,
      "my address is 92672 but send the tech to 12345",
    )
    // Both ZIPs exist; the last one (12345) is at the end and is
    // out-of-area. Regex accepts end-of-string position, so this is
    // correctly classified as out_of_area (allowed: false), NOT as
    // zip_not_at_end.
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("out_of_area")
    expect(result.zip_extracted).toBe("12345")
  })

  it("rejects when the allowlisted ZIP is far from the end of input", () => {
    const result = isInServiceArea(
      allowlistedProfile,
      "92672 Main St, then some other text here",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("zip_not_at_end")
  })

  it("fails closed when the profile has no service_area.zips configured", () => {
    const result = isInServiceArea(
      { service_area: { zips: [] } } as ClientProfile,
      "1234 Main St, San Clemente, CA 92672",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("service_area_unconfigured")
  })

  it("fails closed when the profile is null", () => {
    const result = isInServiceArea(
      null,
      "1234 Main St, San Clemente, CA 92672",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("service_area_unconfigured")
  })
})
