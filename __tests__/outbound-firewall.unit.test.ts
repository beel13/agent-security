import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { filterOutbound } from "../app/api/agent/lib/outbound-firewall"
import type { ClientProfile } from "../app/api/agent/db/conversations"

describe("filterOutbound", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it("allows a URL whose hostname exactly matches an allowlist entry", () => {
    const profile: ClientProfile = {
      booking_link: "https://cal.acme.com/book",
      website: "https://acme.com",
    }
    const result = filterOutbound(
      "Book here: https://cal.acme.com/book/slot-42",
      profile,
    )
    expect(result.allowed).toBe(true)
    expect(result.blocked_urls).toBeUndefined()
    expect(result.allowlist_used).toContain("cal.acme.com")
  })

  it("allows a URL that is a subdomain of an allowlist parent domain", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["example.com"],
    }
    const result = filterOutbound(
      "See https://booking.example.com/checkout for details.",
      profile,
    )
    expect(result.allowed).toBe(true)
    expect(result.blocked_urls).toBeUndefined()
    expect(result.allowlist_used).toContain("example.com")
  })

  it("blocks a URL whose hostname is not on the allowlist", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "Check this: https://evil.example.org/phish",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("url_not_in_allowlist")
    expect(result.blocked_urls).toEqual(["https://evil.example.org/phish"])
    expect(result.allowlist_used).toContain("acme.com")
  })

  it("allows a message that contains zero URLs", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "Thanks for reaching out! I'll get back to you soon.",
      profile,
    )
    expect(result.allowed).toBe(true)
    expect(result.blocked_urls).toBeUndefined()
    // No allowlist resolution needed when there are no URLs.
    expect(result.allowlist_used).toBeUndefined()
  })

  it("allows sends with no_allowlist_configured when client profile is null", () => {
    const result = filterOutbound(
      "Visit https://anything.example.com for info.",
      null,
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe("no_allowlist_configured")
    expect(warnSpy).toHaveBeenCalled()
  })

  it("always includes ggautomate.com in the allowlist even with no booking_link or website", () => {
    // Empty profile (no outbound_url_allowlist, no booking_link, no website).
    const profile: ClientProfile = {}
    const result = filterOutbound(
      "More info at https://ggautomate.com/demo",
      profile,
    )
    expect(result.allowed).toBe(true)
    expect(result.allowlist_used).toContain("ggautomate.com")
  })

  it("blocks when profile only has baseline and URL is elsewhere", () => {
    const profile: ClientProfile = {}
    const result = filterOutbound(
      "Click https://malicious.example.net/grab",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("url_not_in_allowlist")
    expect(result.blocked_urls).toEqual(["https://malicious.example.net/grab"])
    expect(result.allowlist_used).toEqual(["ggautomate.com"])
  })

  it("strips trailing punctuation from extracted URLs when matching", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "See https://acme.com/page, then reply.",
      profile,
    )
    expect(result.allowed).toBe(true)
  })

  it("blocks one URL and allows another in the same message", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "Good: https://acme.com/ok — Bad: https://bad.example.org/x",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.blocked_urls).toEqual(["https://bad.example.org/x"])
  })

  it("blocks a whitespace-obfuscated scheme with spaces around the colon", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "visit https : //evil.com/phish now",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("url_not_in_allowlist")
    expect(result.blocked_urls).toBeDefined()
    expect(result.blocked_urls?.length).toBe(1)
    // The blocked URL should reference evil.com in either raw or normalized form.
    expect(result.blocked_urls?.[0]).toMatch(/evil\.com/)
  })

  it("allows a newline-obfuscated scheme when hostname is on the allowlist", () => {
    const profile: ClientProfile = {
      booking_link: "https://example.com",
    }
    const result = filterOutbound(
      "book at https:\n//example.com/x",
      profile,
    )
    expect(result.allowed).toBe(true)
    expect(result.blocked_urls).toBeUndefined()
    expect(result.allowlist_used).toContain("example.com")
  })

  it("blocks a scheme with a stray space inside the slashes", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "visit https:/ /weird.com/x",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("url_not_in_allowlist")
    expect(result.blocked_urls).toBeDefined()
    expect(result.blocked_urls?.[0]).toMatch(/weird\.com/)
  })

  // ── Unicode-invisible + non-HTTP(S) scheme bypass fixes ─────────────────

  it("blocks a URL that uses zero-width separators inside the hostname", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    // ZWSP (U+200B) inserted between `evil` and `.com` — a renderer that
    // strips invisibles would still linkify evil.com, so the firewall
    // must normalize before matching.
    const result = filterOutbound(
      "visit https://evil\u200B.com/phish now",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("url_not_in_allowlist")
    expect(result.blocked_urls?.[0]).toMatch(/evil\.com/)
  })

  it("still allows an allowlisted URL even when zero-width chars are sprinkled in", () => {
    const profile: ClientProfile = {
      booking_link: "https://example.com/book",
    }
    // ZWJ (U+200D) inside the path — doesn't change the hostname.
    const result = filterOutbound(
      "book at https://example.com/bo\u200Dok/slot",
      profile,
    )
    expect(result.allowed).toBe(true)
  })

  it("blocks a javascript: URI even when no allowlist is configured", () => {
    const result = filterOutbound(
      "click here: javascript:alert(1)",
      null, // null profile would normally be fail-permissive
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("url_not_in_allowlist")
    expect(result.blocked_urls?.[0]).toMatch(/javascript:/i)
  })

  it("blocks a data: URI that tries to smuggle HTML", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "preview: data:text/html;base64,PHNjcmlwdD4=",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.blocked_urls?.[0]).toMatch(/^data:/i)
  })

  it("blocks file: and about: schemes alongside any http URLs", () => {
    const profile: ClientProfile = {
      outbound_url_allowlist: ["acme.com"],
    }
    const result = filterOutbound(
      "open file:///etc/passwd and about:blank",
      profile,
    )
    expect(result.allowed).toBe(false)
    expect(result.blocked_urls?.some((u) => /^file:/i.test(u))).toBe(true)
    expect(result.blocked_urls?.some((u) => /^about:/i.test(u))).toBe(true)
  })
})
