/** Outbound URL allowlist firewall.
 *
 * Runs on every LLM-generated reply BEFORE it reaches a platform adapter.
 * If the reply contains any http(s) URL whose hostname is not covered by
 * the resolved allowlist, OR any dangerous non-HTTP(S) URI scheme, the
 * send is blocked and the caller is expected to escalate to a human.
 *
 * Allowlist resolution priority:
 *   1. clientProfile.outbound_url_allowlist — explicit string[] override.
 *   2. Hostnames derived from clientProfile.booking_link + clientProfile.website.
 *   3. Always appended: "ggautomate.com" (brand baseline — we may always
 *      safely link to our own marketing domain).
 *
 * Matching:
 *   Case-insensitive. A hostname matches if it equals an entry OR is a
 *   subdomain of it (ends with ".{entry}"). So `booking.example.com`
 *   matches an allowlist entry of `example.com`.
 *
 * Whitespace-obfuscated URLs (e.g. `https : // evil.com`, `https:\n//x`,
 * `https:/ /x`) are matched by the tolerant scheme regex and normalized
 * back to `https://...` before hostname parsing. Some messaging clients
 * (iOS data detectors, certain email readers) auto-linkify across
 * whitespace, so this prevents a silent bypass of the allowlist.
 *
 * Unicode invisibles (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, word-joiner
 * U+2060, BOM U+FEFF) are stripped from the message text before URL
 * extraction. Some clients/renderers drop these characters when
 * displaying text, which would let an attacker split a hostname past
 * the regex. Pre-stripping avoids that class of bypass.
 *
 * Dangerous non-HTTP(S) URI schemes — `data:`, `javascript:`, `vbscript:`,
 * `file:`, `about:`, `blob:` — are explicitly detected and blocked even
 * if they don't match the http(s) regex. These schemes almost never
 * belong in an agent reply and several are exploitation vectors when
 * rendered by HTML-capable clients.
 *
 * Limitations (out of scope for v1):
 *   - IDN / punycode hostnames are compared as raw ASCII. Mixed-script
 *     homograph attacks are NOT detected.
 *   - Bare-domain auto-linkification (e.g. `evil.com` with no scheme) is
 *     not detected — the extractor requires an http(s) scheme, even if
 *     whitespace-obfuscated.
 *   - IPv6 hostnames in brackets are not specially handled.
 *   - Trailing punctuation after URLs (`.`, `,`, `)`, `]`, `>`) is
 *     stripped from the matched URL, but not from the hostname itself.
 */

import type { ClientProfile } from "../db/conversations"

export interface OutboundFilterResult {
  allowed: boolean
  reason?: "url_not_in_allowlist" | "no_allowlist_configured"
  blocked_urls?: string[]
  /** Final resolved allowlist used for matching — useful for logging / debugging. */
  allowlist_used?: string[]
}

/** Brand baseline — we always allow links to our own marketing domain. */
const BASELINE_ALLOWLIST_ENTRY = "ggautomate.com"

/** Matches plain http:// and https:// URLs, tolerating whitespace inside
 *  the scheme separator (e.g. `https : // x`, `https:\n//x`, `https:/ /x`).
 *  Greedy up to common trailing punctuation we strip in the consumer. */
const URL_REGEX = /https?\s*:\s*\/\s*\/[^\s<>"'`]+/gi

/** Non-HTTP(S) schemes we proactively block even when they don't match
 *  URL_REGEX. Most of these can execute code or exfiltrate data when
 *  rendered by HTML-capable clients, and they have no legitimate use in
 *  an agent reply. The scheme match tolerates whitespace inside the
 *  scheme separator, same as URL_REGEX. */
const DANGEROUS_SCHEMES = [
  "data",
  "javascript",
  "vbscript",
  "file",
  "about",
  "blob",
] as const
const DANGEROUS_SCHEME_REGEX = new RegExp(
  `\\b(${DANGEROUS_SCHEMES.join("|")})\\s*:[^\\s<>"'\`]*`,
  "gi",
)

/** Unicode invisibles / format characters that some renderers strip. */
const INVISIBLE_CHAR_REGEX = /[\u200B\u200C\u200D\u2060\uFEFF]/g

/** Remove zero-width / word-joiner / BOM characters so they can't be used
 *  to split a URL past the regex. */
function stripInvisibles(text: string): string {
  return text.replace(INVISIBLE_CHAR_REGEX, "")
}

/** Collapse any whitespace inside the scheme separator so downstream
 *  hostname parsing sees a well-formed URL. */
function normalizeScheme(raw: string): string {
  return raw.replace(/^(https?)\s*:\s*\/\s*\//i, "$1://")
}

/** Strip trailing punctuation that is almost never part of the intended URL. */
function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)\]}>'"`]+$/, "")
}

/** Best-effort hostname extraction. Accepts full URLs or bare domain strings.
 *  Returns a lowercase hostname or null if unparseable. */
function extractHostname(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Try WHATWG URL first (covers full URLs).
  try {
    const u = new URL(trimmed)
    const host = u.hostname.toLowerCase()
    return host || null
  } catch {
    // Fall through — may be a bare domain like "example.com" or "example.com/path".
  }

  // Fall back: treat as bare domain. Strip any leading scheme leftover,
  // leading "www."? No — we preserve the user-supplied form so the
  // subdomain-match rule keeps working predictably.
  const bare = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .toLowerCase()
  if (!bare || !bare.includes(".")) return null
  // Remove any leading "@" or whitespace remnants.
  return bare.replace(/^@+/, "") || null
}

/** True if `hostname` equals `entry` or is a subdomain of it. */
function hostnameMatchesEntry(hostname: string, entry: string): boolean {
  const h = hostname.toLowerCase()
  const e = entry.toLowerCase()
  if (!h || !e) return false
  if (h === e) return true
  return h.endsWith("." + e)
}

/** Resolve the final allowlist from a ClientProfile. Always appends the
 *  brand baseline entry. Returns an empty list only when `profile` is null
 *  (see filterOutbound for the "no_allowlist_configured" branch). */
function resolveAllowlist(profile: ClientProfile | null): string[] {
  if (!profile) return []

  const list: string[] = []

  // 1. Explicit override.
  const explicit = (profile as Record<string, unknown>).outbound_url_allowlist
  if (Array.isArray(explicit)) {
    for (const item of explicit) {
      if (typeof item === "string" && item.trim()) {
        const host = extractHostname(item.trim())
        if (host) list.push(host)
      }
    }
  }

  // 2. If no explicit list, derive from booking_link + website.
  if (list.length === 0) {
    const booking = (profile as Record<string, unknown>).booking_link
    const website = (profile as Record<string, unknown>).website
    for (const candidate of [booking, website]) {
      if (typeof candidate === "string" && candidate.trim()) {
        const host = extractHostname(candidate.trim())
        if (host) list.push(host)
      }
    }
  }

  // 3. Always include the brand baseline.
  if (!list.some((h) => h === BASELINE_ALLOWLIST_ENTRY)) {
    list.push(BASELINE_ALLOWLIST_ENTRY)
  }

  return list
}

/** Scan `messageText` for http(s) URLs and dangerous non-HTTP schemes and
 *  decide whether the send is safe to release. Pure function — no I/O,
 *  no mocks needed to test. */
export function filterOutbound(
  messageText: string,
  clientProfile: ClientProfile | null,
): OutboundFilterResult {
  // 0. Strip Unicode invisibles so they can't hide a URL past the regex.
  const normalizedText = stripInvisibles(messageText ?? "")

  // 1. Detect dangerous non-HTTP(S) schemes anywhere in the message.
  //    These are always blocked regardless of allowlist.
  const dangerousMatches = normalizedText.match(DANGEROUS_SCHEME_REGEX) ?? []
  const dangerousBlocked = dangerousMatches
    .map(stripTrailingPunct)
    .filter(Boolean)

  // 2. Extract http(s) URLs. Normalize whitespace-obfuscated schemes
  //    back to canonical form so hostname parsing works predictably.
  const rawMatches = normalizedText.match(URL_REGEX) ?? []
  const urls = rawMatches
    .map(normalizeScheme)
    .map(stripTrailingPunct)
    .filter(Boolean)

  // 3. No URLs and no dangerous schemes → trivially allowed.
  if (urls.length === 0 && dangerousBlocked.length === 0) {
    return { allowed: true }
  }

  // 4. Resolve allowlist.
  const allowlist = resolveAllowlist(clientProfile)

  // 5. Guard against null profile — baseline never gets appended in that
  //    case, so the list is empty. Dangerous schemes are still blocked
  //    regardless; they don't depend on allowlist state.
  if (allowlist.length === 0) {
    if (dangerousBlocked.length > 0) {
      return {
        allowed: false,
        reason: "url_not_in_allowlist",
        blocked_urls: dangerousBlocked,
      }
    }
    console.warn(
      "[outbound-firewall] No allowlist configured (null client profile); allowing send by default.",
    )
    return { allowed: true, reason: "no_allowlist_configured" }
  }

  // 6. Match each URL hostname. Dangerous-scheme matches go straight to
  //    blocked regardless of hostname.
  const blocked: string[] = [...dangerousBlocked]
  for (const url of urls) {
    const host = extractHostname(url)
    if (!host) {
      // Unparseable URL — treat as blocked to be safe.
      blocked.push(url)
      continue
    }
    const ok = allowlist.some((entry) => hostnameMatchesEntry(host, entry))
    if (!ok) blocked.push(url)
  }

  if (blocked.length === 0) {
    return { allowed: true, allowlist_used: allowlist }
  }

  return {
    allowed: false,
    reason: "url_not_in_allowlist",
    blocked_urls: blocked,
    allowlist_used: allowlist,
  }
}
