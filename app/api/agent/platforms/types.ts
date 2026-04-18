/** Platform abstraction layer — normalized message types and adapter interface.
 *
 * Every platform adapter normalizes inbound webhooks into InboundMessage
 * and accepts OutboundMessage for sending responses. This is the contract
 * that decouples the agent core from any specific messaging platform.
 */

import type { NextRequest } from "next/server"

export type Platform = "sms" | "email" | "instagram" | "facebook"

/** Per-client credentials passed to sendMessage. Falls back to env vars if absent. */
export interface PlatformCredentials {
  [key: string]: string | undefined
}

export interface InboundMessage {
  /** Platform-specific unique sender identifier */
  sender_id: string
  /** Which platform this message arrived on */
  platform: Platform
  /** The message text content */
  message_text: string
  /** ISO 8601 timestamp */
  timestamp: string
  /** Derived thread ID: deterministic from platform + sender_id */
  thread_id: string
  /** Original webhook payload for debugging */
  raw_payload?: unknown
  /** Resolved client ID from webhook payload (via platform identifier lookup) */
  client_id?: string
}

export interface OutboundMessage {
  /** Platform-specific recipient identifier */
  recipient_id: string
  /** Which platform to send through */
  platform: Platform
  /** The response text */
  message_text: string
  /** Thread this message belongs to */
  thread_id: string
}

export interface PlatformAdapter {
  /** Platform identifier */
  platform: Platform
  /** Parse an inbound webhook request into the normalized shape */
  parseInbound(req: NextRequest): Promise<InboundMessage>
  /** Send a message through this platform's API. Uses per-client credentials if provided, env vars as fallback. */
  sendMessage(msg: OutboundMessage, credentials?: PlatformCredentials): Promise<void>
  /** Handle platform-specific webhook verification (e.g. Meta challenge) */
  verifyWebhook?(req: NextRequest): Promise<boolean>
}

/** Conversation state machine states */
export type ConversationState = "new" | "qualifying" | "booking" | "escalated" | "closed"

/** Thread ownership — who controls this conversation */
export type ThreadOwner = "agent" | "human" | "unassigned"

/** Result of the routing safety check */
export interface RoutingDecision {
  allowed: boolean
  reason: string
  /** If not allowed, optional message to silently log (no customer reply) */
  action?: "skip" | "notify_owner" | "handoff_ack"
}

/** Message stored in the conversations JSONB array */
export interface StoredMessage {
  role: "customer" | "agent" | "system"
  content: string
  platform: Platform
  timestamp: string
  metadata?: Record<string, unknown>
}

/** Generate a deterministic thread ID from platform and sender */
export function deriveThreadId(platform: Platform, senderId: string): string {
  return `${platform}:${senderId}`
}
