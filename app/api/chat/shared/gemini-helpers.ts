/** Shared Gemini utilities for lightweight one-off AI calls.
 *
 * Used as fallback intelligence when rule-based matching fails.
 * Each call is ~50-100 tokens, costs <$0.00001.
 */

import { GoogleGenerativeAI } from "@google/generative-ai"
import { EXTERNAL_TIMEOUT_MS } from "./webhook"

// Helper model — immutable, same as main model for consistency.
// No mutable setter — prevents cross-request contamination in serverless.
const HELPER_MODEL = "gemini-2.5-flash-lite"

/** Sanitize user input before embedding in prompts.
 *  Truncates, escapes quotes, and strips control characters.
 */
export function sanitize(input: string, maxLen = 500): string {
  return input
    .slice(0, maxLen)
    .replace(/[\x00-\x1f]/g, "")  // strip control chars
    .replace(/"/g, '\\"')          // escape quotes
    .trim()
}

let genai: GoogleGenerativeAI | null = null

export function getGenAI(): GoogleGenerativeAI {
  if (!genai) {
    genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY ?? "")
  }
  return genai
}

/** Make a one-off Gemini call for classification/extraction.
 *  Returns the raw text response, or null on any error.
 *  Uses generateContent (NOT startChat) — no history needed.
 *  Pass `jsonMode: true` to enable native JSON response mode (sets
 *  `responseMimeType: "application/json"`).
 */
export async function quickGenerate(
  prompt: string,
  options?: { maxOutputTokens?: number; jsonMode?: boolean },
): Promise<string | null> {
  try {
    const ai = getGenAI()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationConfig: any = {
      maxOutputTokens: options?.maxOutputTokens ?? 100,
      temperature: 0,
    }
    if (options?.jsonMode) {
      generationConfig.responseMimeType = "application/json"
    }
    const model = ai.getGenerativeModel({
      model: HELPER_MODEL,
      generationConfig,
    })

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), EXTERNAL_TIMEOUT_MS),
      ),
    ])

    return result.response.text()?.trim() ?? null
  } catch {
    return null
  }
}

// ── Intent classification (hybrid: regex fast-path + AI fallback) ────────

/** Per-request call counter — reset via resetIntentCallCount() at start of each request. */
let _intentCallCount = 0
const _intentCache = new Map<string, string | null>()

export function resetIntentCallCount(): void {
  _intentCallCount = 0
  _intentCache.clear()
}

const FAST_ACCEPT = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|absolutely|definitely|sounds good|that works|works for me|perfect|great|let'?s do it|let'?s go|book it|sign me up|i'?m in|deal)\s*[.!]*\s*$/i
const FAST_DECLINE = /^\s*(?:no|nah|nope|no thanks|no thank you|pass|not interested|skip|not now|never mind|forget it)\s*[.!]*\s*$/i
const FAST_QUESTION = /^(?:how|what|when|where|why|who|can you|do you|is there|could you|would you|are there)\b/i

/** Synchronous regex fast-path for unambiguous intent.
 *  Returns matched option or null (defer to AI).
 *  Only matches when input has zero ambiguity — mixed signals return null.
 */
export function classifyIntentFast(message: string, options: string[]): string | null {
  const trimmed = message.trim()
  if (!trimmed) return null

  // Mixed signals → always defer to AI
  const hasAcceptSignal = FAST_ACCEPT.test(trimmed)
  const hasDeclineSignal = FAST_DECLINE.test(trimmed)
  if (hasAcceptSignal && hasDeclineSignal) return null

  if (options.includes("accept") && hasAcceptSignal) return "accept"
  if (options.includes("decline") && hasDeclineSignal) return "decline"
  if (options.includes("question") && (FAST_QUESTION.test(trimmed) || trimmed.endsWith("?"))) return "question"

  return null
}

/** Async AI fallback for ambiguous intent classification.
 *  Calls quickGenerate (~80 tokens in, ~5 out, <$0.00001).
 *  Max 2 calls per request — third call returns null immediately.
 */
export async function classifyIntent(
  message: string,
  options: string[],
  context?: string,
): Promise<string | null> {
  // Per-request call cap — warn when hit so regressions are visible in logs
  if (_intentCallCount >= 3) {
    console.warn(`classifyIntent cap hit (${_intentCallCount} calls this request)`)
    return null
  }

  // Cache check
  const cacheKey = `${message}|${options.join(",")}`
  if (_intentCache.has(cacheKey)) return _intentCache.get(cacheKey) ?? null

  _intentCallCount++

  const safe = sanitize(message)
  const prompt = `Classify this message into one of these categories: ${JSON.stringify(options)}
Message: "${safe}"
${context ? `Context: ${context}` : ""}

Rules:
- Match the user's INTENT, not just their words
- "no that's fine" = acceptance (dismissing a concern, agreeing to proceed)
- "oh sure, right" with sarcasm = rejection or ambiguous
- "sounds good but let me think" = ambiguous
- If unclear, return NONE

Return ONLY the exact option text from the list above, or NONE. Nothing else.`

  const start = Date.now()
  const result = await quickGenerate(prompt)
  const elapsed = Date.now() - start

  if (elapsed > 500) console.warn(`classifyIntent took ${elapsed}ms`)

  if (!result || result.toUpperCase().trim() === "NONE") {
    _intentCache.set(cacheKey, null)
    return null
  }

  const exactMatch = options.find(
    (o) => o.toLowerCase() === result.toLowerCase().trim(),
  )
  _intentCache.set(cacheKey, exactMatch ?? null)
  return exactMatch ?? null
}

/** Extract contact info from a messy free-text message.
 *  Returns structured data, or null on failure.
 */
export async function extractContact(
  userMessage: string,
): Promise<{
  name: string | null
  phone: string | null
  email: string | null
  preferred_contact: "phone" | "email" | "text" | null
} | null> {
  const safe = sanitize(userMessage)
  const prompt = `Extract contact info from this message. Only include fields you're confident about.
Message: "${safe}"
Return JSON only, no markdown: {"name": string|null, "phone": string|null, "email": string|null, "preferred_contact": "phone"|"email"|"text"|null}`

  const result = await quickGenerate(prompt)
  if (!result) return null

  try {
    // Strip markdown code fences if present
    const cleaned = result.replace(/```json?\s*/g, "").replace(/```/g, "").trim()
    const parsed = JSON.parse(cleaned)
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      phone: typeof parsed.phone === "string" ? parsed.phone : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      preferred_contact: ["phone", "email", "text"].includes(parsed.preferred_contact)
        ? parsed.preferred_contact
        : null,
    }
  } catch {
    return null
  }
}
