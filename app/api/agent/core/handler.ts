/** Agent core handler — orchestrates the full message lifecycle.
 *
 * Receives a normalized InboundMessage from any platform adapter,
 * runs the routing safety stack (known contacts, ownership, escalation),
 * and only processes through Gemini if the agent is allowed to respond.
 *
 * Safety stack order:
 * 1. Known contact? -> Skip agent, notify owner.
 * 2. Thread owned by human? -> Skip entirely.
 * 3. Thread escalated/unassigned? -> Skip, waiting on owner.
 * 4. All clear -> Agent responds via Gemini agentic loop.
 */

import { type Content, FunctionCallingMode } from "@google/generative-ai"
import { getGenAI, sanitize } from "@/app/api/chat/shared/gemini-helpers"
import {
  getOrCreateThread,
  appendMessage,
  getMessageHistory,
  checkRouting,
  markHumanOwned,
  getClientCredentials,
  getClientProfile,
  getOwnerDisplayName,
  updateConversation,
} from "../db/conversations"
import { buildAgentPrompt, historyToGeminiFormat } from "./prompts"
import { AGENT_TOOL_DECLARATIONS, executeAction } from "./actions"
import { filterOutbound } from "../lib/outbound-firewall"
import { escalateThread } from "../lib/escalate"
import type { InboundMessage, OutboundMessage, PlatformCredentials, StoredMessage } from "../platforms/types"

const MODEL = "gemini-2.5-flash-lite"
const MAX_TOKENS = 512
const MAX_TOOL_ITERATIONS = 5

export interface AgentResponse {
  /** The text response to send back to the customer */
  responseText: string
  /** The outbound message ready for the platform adapter */
  outbound: OutboundMessage
  /** Whether the agent actually responded (false = skipped by safety stack) */
  agentResponded: boolean
  /** Why the agent skipped, if it did */
  skipReason?: string
  /** Per-client platform credentials for the adapter to use */
  credentials?: PlatformCredentials
}

/** Process an inbound message through the full agent pipeline. */
export async function handleInboundMessage(
  message: InboundMessage,
): Promise<AgentResponse> {
  // 1. Get or create conversation thread
  const conversation = await getOrCreateThread(
    message.thread_id,
    message.sender_id,
    message.platform,
    message.client_id,
  )

  // 1b. Look up per-client platform credentials (falls back to env vars in adapter)
  //     and per-client agent personalization profile.
  const clientId = message.client_id ?? conversation.client_id ?? undefined
  let credentials: PlatformCredentials | undefined
  let clientProfile = null
  if (clientId) {
    credentials = (await getClientCredentials(clientId, message.platform)) ?? undefined
    clientProfile = await getClientProfile(clientId)
  }

  // 2. Persist the inbound message (always, even if agent won't respond)
  const customerMessage: StoredMessage = {
    role: "customer",
    content: message.message_text,
    platform: message.platform,
    timestamp: message.timestamp,
  }
  await appendMessage(message.thread_id, customerMessage)

  // 3. Run the routing safety stack
  const routing = await checkRouting(conversation, message.sender_id, message.platform)

  if (!routing.allowed) {
    console.log(`[agent] Skipped thread ${message.thread_id}: ${routing.reason}`)

    // Log a system message so the owner can see why the agent didn't respond
    const systemMessage: StoredMessage = {
      role: "system",
      content: `Agent skipped: ${routing.reason}`,
      platform: message.platform,
      timestamp: new Date().toISOString(),
      metadata: { routing_action: routing.action },
    }
    await appendMessage(message.thread_id, systemMessage)

    // For escalated threads, send a one-time customer-facing handoff ack
    // so the customer doesn't get dead silence after escalation. The flag
    // lives in conversation.context to ensure we only send the ack once.
    if (routing.action === "handoff_ack") {
      const ctx = (conversation.context as Record<string, unknown> | null) ?? {}
      if (ctx.escalation_ack_sent !== true) {
        const ownerName = await getOwnerDisplayName(conversation.client_id ?? null)
        const ackText = `Got it — ${ownerName} is on this and will be in touch shortly.`

        const ackMessage: StoredMessage = {
          role: "agent",
          content: ackText,
          platform: message.platform,
          timestamp: new Date().toISOString(),
          metadata: { source: "escalation_ack" },
        }
        await appendMessage(message.thread_id, ackMessage)

        // Mark the flag so subsequent messages on the same thread stay silent
        await updateConversation(message.thread_id, {
          context: { escalation_ack_sent: true },
        })

        return {
          responseText: ackText,
          outbound: {
            recipient_id: message.sender_id,
            platform: message.platform,
            message_text: ackText,
            thread_id: message.thread_id,
          },
          agentResponded: true,
          skipReason: routing.reason,
          credentials,
        }
      }
    }

    return {
      responseText: "",
      outbound: {
        recipient_id: message.sender_id,
        platform: message.platform,
        message_text: "",
        thread_id: message.thread_id,
      },
      agentResponded: false,
      skipReason: routing.reason,
      credentials,
    }
  }

  // 4. Load full message history
  const messageHistory = await getMessageHistory(message.thread_id)

  // 4a. Per-conversation rate limit / loop detection.
  // If the agent has already sent 3+ messages in the last 60 seconds on this
  // thread, skip this turn. Prevents agent-to-agent ping-pong (another bot
  // on the other end), prevents customer spam from causing reply storms, and
  // gives the owner time to take over an out-of-control conversation.
  const AGENT_REPLY_BURST_WINDOW_MS = 60_000
  const AGENT_REPLY_BURST_LIMIT = 3
  const recentAgentReplies = messageHistory.filter((m) => {
    if (m.role !== "agent") return false
    const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0
    return ts > Date.now() - AGENT_REPLY_BURST_WINDOW_MS
  })
  if (recentAgentReplies.length >= AGENT_REPLY_BURST_LIMIT) {
    console.warn(
      `[agent] Per-conversation rate limit hit on thread ${message.thread_id}: ` +
      `${recentAgentReplies.length} agent replies in the last ${AGENT_REPLY_BURST_WINDOW_MS}ms`,
    )
    return {
      responseText: "",
      outbound: {
        recipient_id: message.sender_id,
        platform: message.platform,
        message_text: "",
        thread_id: message.thread_id,
      },
      agentResponded: false,
      skipReason: "Per-conversation rate limit (3 agent replies / 60s)",
      credentials,
    }
  }

  // 5. Build the system prompt with context + per-client personalization
  const systemPrompt = buildAgentPrompt(conversation, messageHistory, message.platform, clientProfile)

  // 6. Convert history to Gemini format
  const geminiHistory = historyToGeminiFormat(messageHistory.slice(0, -1)) as Content[]

  // 7. Set up Gemini with tools
  const ai = getGenAI()
  const model = ai.getGenerativeModel({
    model: MODEL,
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: MAX_TOKENS },
    tools: [{ functionDeclarations: AGENT_TOOL_DECLARATIONS }],
  })

  // 8. Start chat with history and send the new message
  const chat = model.startChat({ history: geminiHistory })
  const safeMessage = sanitize(message.message_text, 2000)

  let response = await chat.sendMessage(safeMessage)
  let responseObj = response.response
  let finalText = ""

  // Track which tool calls fired so we can build a contextual fallback
  // when Gemini calls a tool but returns no text afterwards.
  const toolCallsMade: Array<{ name: string; result: Record<string, unknown> }> = []

  // 9. Agentic tool-use loop
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const fnCalls = responseObj.functionCalls()
    if (!fnCalls || fnCalls.length === 0) break

    // Capture any text from this response
    try {
      const text = responseObj.text?.() ?? ""
      if (text) finalText = text
    } catch { /* text() throws if response only has function calls */ }

    // Execute each tool call
    const fnResponses: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = []

    for (const call of fnCalls) {
      const { result } = await executeAction(
        call.name,
        call.args as Record<string, unknown>,
        message.thread_id,
      )
      toolCallsMade.push({ name: call.name, result })
      fnResponses.push({
        functionResponse: { name: call.name, response: result },
      })
    }

    // Feed results back to Gemini
    response = await chat.sendMessage(fnResponses)
    responseObj = response.response
  }

  // 10. Extract final text response
  try {
    const text = responseObj.text?.() ?? ""
    if (text) finalText = text
  } catch { /* text() throws if response only has function calls */ }

  // 10a. Escalation handoff override: if escalate_to_human was called,
  // replace Gemini's text with the configured handoff_message so customers
  // get consistent wording per client rather than Gemini's paraphrase.
  // The handoff_message is built by executeAction from the client's
  // owner_display_name (e.g. "Let me get Gian on this for you."), which
  // is the single source of truth for escalation wording.
  const escalateCall = toolCallsMade.find((c) => c.name === "escalate_to_human")
  if (escalateCall && typeof escalateCall.result.handoff_message === "string") {
    finalText = escalateCall.result.handoff_message
  }

  // 10b. Smart fallback: if Gemini didn't produce text AND no escalation
  // handoff was set above, build a contextual message from other tool calls
  // instead of the bland generic fallback.
  if (!finalText) {
    // Followup confirmation if schedule_followup was called.
    // Phrase the confirmation based on delay_minutes (or legacy delay_hours).
    const followupCall = toolCallsMade.find((c) => c.name === "schedule_followup")
    if (followupCall) {
      const minutesRaw = followupCall.result.delay_minutes
      const hoursRaw = followupCall.result.delay_hours
      const delayMinutes = typeof minutesRaw === "number"
        ? minutesRaw
        : (typeof hoursRaw === "number" ? hoursRaw * 60 : 0)
      let delayText: string
      if (delayMinutes <= 0) {
        delayText = "shortly"
      } else if (delayMinutes < 60) {
        delayText = `in about ${Math.max(1, Math.round(delayMinutes))} minutes`
      } else if (delayMinutes < 60 * 24) {
        delayText = "later today"
      } else if (delayMinutes < 60 * 48) {
        delayText = "tomorrow"
      } else {
        delayText = `in about ${Math.round(delayMinutes / (60 * 24))} days`
      }
      finalText = `Got it — I'll check back in with you ${delayText}.`
    } else {
      // Booking confirmation if book_appointment was called with confirmed=true
      const bookCall = toolCallsMade.find((c) => c.name === "book_appointment")
      if (bookCall && bookCall.result.status === "booking_confirmed") {
        const slot = typeof bookCall.result.slot === "string" ? bookCall.result.slot : "your selected time"
        finalText = `You're locked in for ${slot}. We'll see you then.`
      } else {
        // Generic last-resort fallback.
        finalText = "Thanks for reaching out! Let me look into that and get back to you shortly."
      }
    }
  }

  // 10c. Outbound URL firewall. Blocks any http(s) URL in the agent's
  //      reply that isn't on the client's allowlist. Runs before we persist
  //      the reply or hand it to the adapter for sending.
  const filterResult = filterOutbound(finalText, clientProfile)
  if (filterResult.allowed === false) {
    console.warn(
      `[agent] Outbound filter blocked thread ${message.thread_id}:`,
      { blocked_urls: filterResult.blocked_urls },
    )

    await escalateThread({
      threadId: message.thread_id,
      reason: "outbound_filter_triggered",
      priority: "urgent",
      source: "outbound_filter",
      skipLeadCreation: true,
    })

    try {
      await appendMessage(message.thread_id, {
        role: "system",
        content: `[outbound filter blocked send: ${(filterResult.blocked_urls ?? []).join(", ")}]`,
        platform: message.platform,
        timestamp: new Date().toISOString(),
        metadata: {
          source: "outbound_filter",
          blocked_urls: filterResult.blocked_urls,
          original_message: finalText,
          allowlist_used: filterResult.allowlist_used,
        },
      })
    } catch (err) {
      console.error(`[agent] Failed to append filter system message:`, err)
    }

    // Skip the send. Callers inspect agentResponded before invoking
    // adapter.sendMessage, so returning false keeps the blocked URL off
    // the wire while still giving callers a structured response.
    return {
      responseText: "",
      outbound: {
        recipient_id: message.sender_id,
        platform: message.platform,
        message_text: "",
        thread_id: message.thread_id,
      },
      agentResponded: false,
      skipReason: "outbound_filter_triggered",
      credentials,
    }
  }

  // 11. Persist the agent's response
  const agentMessage: StoredMessage = {
    role: "agent",
    content: finalText,
    platform: message.platform,
    timestamp: new Date().toISOString(),
  }
  await appendMessage(message.thread_id, agentMessage)

  // 12. Build the outbound message
  const outbound: OutboundMessage = {
    recipient_id: message.sender_id,
    platform: message.platform,
    message_text: finalText,
    thread_id: message.thread_id,
  }

  return { responseText: finalText, outbound, agentResponded: true, credentials }
}

/**
 * Handle an outbound message sent by the business owner (not the agent).
 * Flips thread ownership to human so the agent backs off.
 *
 * Call this from webhook routes when detecting the message sender
 * is the page/business account rather than a customer.
 */
export async function handleOwnerReply(threadId: string): Promise<void> {
  await markHumanOwned(threadId)
  console.log(`[agent] Thread ${threadId} now human-owned. Agent will not respond.`)
}
