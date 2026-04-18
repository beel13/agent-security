/** Shared types for the multi-demo platform.
 *
 * All demo-specific state models extend BaseDemoState.
 * All UI actions across demos are in the UIAction union.
 * DemoConfig is the plugin interface each demo registers.
 */

import type { FunctionDeclaration } from "@google/generative-ai"
import type { z } from "zod"

// ── Enums ────────────────────────────────────────────────────────────────

export type DemoType = "diagnostic" | "inbound_lead"
export type BusinessType = "hvac" | "plumbing" | "electrical" | "roofing" | "general"
export type UrgencyLevel = "emergency" | "same_day" | "normal" | "low"
export type SentimentLevel = "positive" | "neutral" | "frustrated" | "angry"

export const DEMO_TYPES: DemoType[] = ["diagnostic", "inbound_lead"]
export const BUSINESS_TYPES: BusinessType[] = ["hvac", "plumbing", "electrical", "roofing", "general"]

// ── Base state (all demos extend this) ───────────────────────────────────

export interface BaseDemoState {
  demo_type: DemoType
  business_type: BusinessType
  step: number
  created_at: number
  completed: boolean
}

// ── UI actions (union across all demos) ──────────────────────────────────

export interface ShowChoices {
  type: "show_choices"
  question: string
  choices: string[]
}

export interface ShowRoiCard {
  type: "show_roi_card"
  business_type: string
  monthly_leads: string
  low: number
  high: number
  benchmark_comparison?: string
  credibility_stat?: string
  missed_leads?: [number, number]
  recoverable_jobs?: [number, number]
}

export interface ShowCalendly {
  type: "show_calendly"
}

export interface ConversationComplete {
  type: "conversation_complete"
  lead_data: Record<string, string>
}

export interface ShowBookingSlots {
  type: "show_booking_slots"
  slots: { label: string; time: string; urgency_match: boolean }[]
}

export interface ShowUrgencyBadge {
  type: "show_urgency_badge"
  level: UrgencyLevel
  reason: string
}

export interface ShowDemoSummary {
  type: "show_demo_summary"
  summary: DemoSummary
}

export interface ShowOfficeNotification {
  type: "show_office_notification"
  service_type: string
  urgency: string
  timing: string
  issue: string
}

export type UIAction =
  | ShowChoices
  | ShowRoiCard
  | ShowCalendly
  | ConversationComplete
  | ShowBookingSlots
  | ShowUrgencyBadge
  | ShowDemoSummary
  | ShowOfficeNotification

// ── Demo summary (shown at end of every demo) ───────────────────────────

export interface DemoSummary {
  demo_type: DemoType
  business_type: BusinessType
  headline: string
  fields: { label: string; value: string; highlight?: boolean }[]
  actions_taken: string[]
  internal_notes: string
  cta_text: string
  cta_subtitle?: string
  without_items?: string[]
  with_items?: string[]
  next_steps?: string[]
  roi_strip?: string
  next_demos?: { id: string; label: string; description: string }[]
  /** AI-generated follow-up email draft based on the conversation */
  email_draft?: { subject: string; body: string }
}

// ── Engine result (returned by every demo's advanceState) ────────────────

export interface EngineResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any  // Demo-specific state (extends BaseDemoState). Cast in route.ts.
  stepContext: string
  forceToolCall?: string
  /** UI actions emitted deterministically by the engine (bypass model entirely). */
  engineActions?: UIAction[]
  /** Text shown when the model emits only a tool call with no accompanying text. */
  fallbackText?: string
}

// ── Tool executor type ──────────────────────────────────────────────────

export type ToolExecutor = (
  args: Record<string, unknown>,
  state: BaseDemoState,
) => [Record<string, unknown>, UIAction] | Promise<[Record<string, unknown>, UIAction]>

// ── Demo config (plugin interface) ──────────────────────────────────────

export interface DemoConfig {
  id: DemoType
  label: string
  description: string
  icon: string
  engine: (state: BaseDemoState, message: string, businessType: BusinessType) => Promise<EngineResult>
  buildSystemPrompt: (stepContext: string, businessType: BusinessType) => string
  toolDeclarations: FunctionDeclaration[]
  toolExecutors: Record<string, ToolExecutor>
  allowedTools: Record<number, string[]>
  createInitialState: (businessType: BusinessType) => BaseDemoState
  stateSchema: z.ZodType<BaseDemoState>
  maxSteps: number
  displayOnlyTools: Set<string>
  /** Called after each tool executes to update state (analytics, step transitions). */
  onToolComplete?: (
    toolName: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    action: UIAction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => any
  summaryGenerator: (state: BaseDemoState) => DemoSummary
}
