/** Conversation persistence — CRUD operations for the conversations table.
 *
 * All writes use the service client (bypasses RLS) since webhook handlers
 * don't have a user session. Reads for the dashboard go through the
 * server client (respects RLS).
 *
 * Includes ownership checks, known-contacts lookup, and client config
 * retrieval for the routing safety stack.
 */

import { createServiceClient } from "@/lib/supabase/server"
import type { Conversation, ClientConfig } from "@/lib/supabase/types"
import type {
  ConversationState,
  Platform,
  PlatformCredentials,
  StoredMessage,
  ThreadOwner,
  RoutingDecision,
} from "../platforms/types"

// ─── Thread CRUD ────────────────────────────────────────────

/** Get an existing conversation by thread_id, or create a new one.
 *
 * Uses upsert with onConflict: 'thread_id' to atomically handle the race
 * where two concurrent webhooks for the same new thread both miss the
 * SELECT and try to INSERT. The unique index on thread_id makes the
 * second insert a no-op; we then re-fetch to return the canonical row.
 */
export async function getOrCreateThread(
  threadId: string,
  senderId: string,
  platform: Platform,
  clientId?: string,
): Promise<Conversation> {
  const supabase = createServiceClient()

  // Try to fetch existing first (covers the common case without a write).
  const { data: existing } = await supabase
    .from("conversations")
    .select("*")
    .eq("thread_id", threadId)
    .maybeSingle()

  if (existing) {
    // SECURITY: thread_id is currently `${platform}:${senderId}` with NO
    // client_id, so two different clients with the same customer (same
    // email/phone/PSID) would otherwise share thread state — agent answers
    // as the wrong business, leaks prior conversation context across
    // clients. Defensive guard until thread_id format is migrated to
    // include client_id.
    if (clientId && existing.client_id && existing.client_id !== clientId) {
      throw new Error(
        `Cross-client thread collision: thread ${threadId} belongs to ` +
        `client ${existing.client_id}, refusing to serve client ${clientId}`,
      )
    }
    return existing
  }

  // Atomic upsert: unique constraint on thread_id makes a concurrent insert
  // safe. ignoreDuplicates: true means the conflict path returns no rows,
  // so we always re-fetch the canonical row afterwards.
  const { error: upsertError } = await supabase
    .from("conversations")
    .upsert(
      {
        thread_id: threadId,
        sender_id: senderId,
        platform,
        client_id: clientId ?? process.env.SUPABASE_DEFAULT_CLIENT_ID ?? null,
        state: "new",
        owned_by: "agent",
      },
      { onConflict: "thread_id", ignoreDuplicates: true },
    )

  if (upsertError) {
    throw new Error(`Failed to upsert conversation: ${upsertError.message}`)
  }

  const { data: created, error: fetchError } = await supabase
    .from("conversations")
    .select("*")
    .eq("thread_id", threadId)
    .maybeSingle()

  if (fetchError || !created) {
    throw new Error(`Failed to fetch conversation after upsert: ${fetchError?.message ?? "row missing"}`)
  }

  return created
}

/** Get a conversation by thread_id. Returns null if not found. */
export async function getThread(threadId: string): Promise<Conversation | null> {
  const supabase = createServiceClient()

  // maybeSingle: PGRST116 (zero rows) is a legitimate "thread doesn't exist
  // yet" signal, not an error.
  const { data } = await supabase
    .from("conversations")
    .select("*")
    .eq("thread_id", threadId)
    .maybeSingle()

  return data
}

/** Append a message to the conversation's messages JSONB array.
 *
 * Uses the `append_conversation_message` Postgres function for an ATOMIC
 * append. Previously this was read→push→update across three calls, which
 * caused two concurrent inbound messages on the same thread to silently
 * overwrite each other. The RPC compiles to a single
 * `UPDATE ... SET messages = messages || jsonb_build_array($1)` statement
 * so concurrent calls serialize on the row lock.
 */
export async function appendMessage(
  threadId: string,
  message: StoredMessage,
): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase.rpc("append_conversation_message", {
    p_thread_id: threadId,
    p_message: message as unknown as Record<string, unknown>,
  })

  if (error) {
    throw new Error(`Failed to append message: ${error.message}`)
  }
}

/** Update the conversation state and optionally merge context/contact info. */
export async function updateConversation(
  threadId: string,
  updates: {
    state?: ConversationState
    context?: Record<string, unknown>
    contact_info?: Record<string, unknown>
    owned_by?: ThreadOwner
    human_replied_at?: string
  },
): Promise<void> {
  const supabase = createServiceClient()

  // If context or contact_info provided, merge with existing.
  //
  // KNOWN ISSUE: this is read-modify-write and has the same lost-update
  // shape as the old appendMessage. Lower blast radius because the agent
  // handler typically processes one message per thread at a time, but two
  // concurrent calls (e.g. agent + cron followup) can clobber each other's
  // merge. Followup: lift to an atomic `update_conversation_jsonb_merge`
  // RPC using `context || $new` and `contact_info || $new` in SQL.
  if (updates.context || updates.contact_info) {
    const { data: conv } = await supabase
      .from("conversations")
      .select("context, contact_info")
      .eq("thread_id", threadId)
      .maybeSingle()

    if (conv) {
      if (updates.context) {
        updates.context = {
          ...(conv.context as Record<string, unknown> ?? {}),
          ...updates.context,
        }
      }
      if (updates.contact_info) {
        updates.contact_info = {
          ...(conv.contact_info as Record<string, unknown> ?? {}),
          ...updates.contact_info,
        }
      }
    }
  }

  const { error } = await supabase
    .from("conversations")
    .update(updates)
    .eq("thread_id", threadId)

  if (error) {
    throw new Error(`Failed to update conversation: ${error.message}`)
  }
}

/** Get the message history as StoredMessage array for prompt building. */
export async function getMessageHistory(threadId: string): Promise<StoredMessage[]> {
  const supabase = createServiceClient()

  // maybeSingle: zero rows is "thread doesn't exist yet" → empty history.
  const { data } = await supabase
    .from("conversations")
    .select("messages")
    .eq("thread_id", threadId)
    .maybeSingle()

  if (!data) return []
  return (data.messages as unknown as StoredMessage[]) ?? []
}

// ─── Ownership & Routing ────────────────────────────────────

/** Mark a thread as human-owned. Called when the business owner replies. */
export async function markHumanOwned(threadId: string): Promise<void> {
  await updateConversation(threadId, {
    owned_by: "human",
    human_replied_at: new Date().toISOString(),
  })
}

/** Mark a thread as unassigned (escalated, waiting for owner). */
export async function markUnassigned(threadId: string): Promise<void> {
  await updateConversation(threadId, { owned_by: "unassigned" })
}

// ─── Client Resolution & Credentials ────────────────────────

/** Resolve a client_id from a platform-specific identifier (page ID, phone, email). */
export async function resolveClientFromPlatformId(
  platform: Platform,
  platformIdentifier: string,
): Promise<string | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("client_platform_identifiers")
    .select("client_id")
    .eq("platform", platform)
    .eq("platform_identifier", platformIdentifier)
    .maybeSingle()

  return data?.client_id ?? null
}

/** Get per-client credentials for a platform. Returns null if none stored. */
export async function getClientCredentials(
  clientId: string,
  platform: Platform,
): Promise<PlatformCredentials | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("client_platform_credentials")
    .select("credentials")
    .eq("client_id", clientId)
    .eq("platform", platform)
    .maybeSingle()

  return (data?.credentials as PlatformCredentials) ?? null
}

/** List every (client_id, credentials) row for a given platform.
 *  Used by the Wave 5 Gmail cron poller to iterate all clients with
 *  an active email credential and poll each one's inbox per tick. */
export async function listClientsWithPlatform(
  platform: Platform,
): Promise<Array<{ client_id: string; credentials: PlatformCredentials }>> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("client_platform_credentials")
    .select("client_id, credentials")
    .eq("platform", platform)

  if (error) {
    console.error(`[listClientsWithPlatform] query failed for ${platform}:`, error)
    return []
  }

  return (data ?? []).map((row) => ({
    client_id: row.client_id as string,
    credentials: (row.credentials ?? {}) as PlatformCredentials,
  }))
}

/** Merge a patch into the credentials jsonb for a specific (client, platform)
 *  row. Read-modify-write — sufficient for the low-volume poll-cursor use case.
 *  Used by the Wave 5 Gmail cron poller to bump last_poll_ts after each tick. */
export async function updateClientCredentials(
  clientId: string,
  platform: Platform,
  patch: Record<string, unknown>,
): Promise<void> {
  const supabase = createServiceClient()

  const { data: existing, error: readErr } = await supabase
    .from("client_platform_credentials")
    .select("credentials")
    .eq("client_id", clientId)
    .eq("platform", platform)
    .single()

  if (readErr) {
    console.error(`[updateClientCredentials] read failed for ${clientId}/${platform}:`, readErr)
    return
  }

  const merged = {
    ...((existing?.credentials as Record<string, unknown>) ?? {}),
    ...patch,
  }

  const { error: writeErr } = await supabase
    .from("client_platform_credentials")
    .update({ credentials: merged })
    .eq("client_id", clientId)
    .eq("platform", platform)

  if (writeErr) {
    console.error(`[updateClientCredentials] write failed for ${clientId}/${platform}:`, writeErr)
  }
}

// ─── Gmail Message Dedupe (Wave 5.1) ────────────────────────

/** Atomically claim a Gmail message_id for processing.
 *
 *  Returns true if THIS caller now owns the message (insert succeeded)
 *  and should proceed to classify + route. Returns false if any other
 *  caller (concurrent cron run, retry, manual trigger) already claimed
 *  it (PK conflict on insert).
 *
 *  This MUST be the gate before any side-effecting work. The previous
 *  read-then-write pattern (isGmailMessageProcessed → routeInbound →
 *  markGmailMessageProcessed) had a TOCTOU race: two cron runs could
 *  both pass the read, both route, both fire a duplicate reply. The
 *  composite PK on processed_gmail_messages serializes the claim.
 *
 *  Behaviour on DB error:
 *    - Postgres unique-violation (23505) → return false (already claimed)
 *    - Any other error → log + return false (fail-closed). Skipping
 *      one inbound on Supabase outage is strictly better than firing
 *      a duplicate reply if the outage is transient and the dedupe
 *      table is actually consistent.
 */
export async function claimGmailMessage(
  clientId: string,
  gmailMessageId: string,
): Promise<boolean> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("processed_gmail_messages")
    .insert({ client_id: clientId, gmail_message_id: gmailMessageId })

  if (!error) return true

  if (/(duplicate key|23505)/i.test(error.message)) {
    // Already claimed by another tick. Expected under retry / overlap.
    return false
  }

  // Unexpected DB error. Log and fail closed.
  console.error(`[claimGmailMessage] ${clientId}/${gmailMessageId}:`, error)
  return false
}

// ─── Known Contacts ─────────────────────────────────────────

/** Check if a sender is a known contact for a given client. */
export async function isKnownContact(
  clientId: string,
  platform: Platform,
  senderId: string,
): Promise<{ known: boolean; displayName?: string }> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("known_contacts")
    .select("display_name")
    .eq("client_id", clientId)
    .eq("platform", platform)
    .eq("platform_id", senderId)
    .maybeSingle()

  if (data) {
    return { known: true, displayName: data.display_name ?? undefined }
  }
  return { known: false }
}

// ─── Client Config ──────────────────────────────────────────

/** Get the routing config for a client. Returns defaults if none set. */
export async function getClientConfig(clientId: string): Promise<ClientConfig | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("client_config")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle()

  return data
}

/** Per-client agent personalization (jsonb bag on clients.client_profile). */
export type ClientProfile = Record<string, unknown>

/** Load the client_profile jsonb for a client. Returns empty object if missing. */
export async function getClientProfile(clientId: string): Promise<ClientProfile | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("clients")
    .select("client_profile, business_name")
    .eq("id", clientId)
    .maybeSingle()

  if (!data) return null
  const profile = (data.client_profile as ClientProfile | null) ?? {}
  // Stash the business name into the profile so prompts.ts can reference it
  return { ...profile, business_name: data.business_name }
}

/** Load core client fields (id, business_name, owner_email, business_type). */
export async function getClientById(
  clientId: string,
): Promise<{ id: string; business_name: string; owner_email: string; business_type: string } | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("clients")
    .select("id, business_name, owner_email, business_type")
    .eq("id", clientId)
    .maybeSingle()

  return data
}

// ─── Routing Safety Stack ───────────────────────────────────

/** Default config used when no client_config row exists. */
const DEFAULT_CONFIG = {
  auto_respond: ["new_lead", "qualifying", "booking", "faq", "followup"],
  escalate_always: ["complaint", "custom_quote", "existing_customer", "legal"],
  owner_display_name: "the team",
}

/**
 * Run the full routing safety check before the agent processes a message.
 *
 * Order:
 * 1. Known contact? -> Skip agent, notify owner.
 * 2. Thread owned by human? -> Skip entirely.
 * 3. Thread escalated/unassigned? -> Skip, waiting on owner.
 * 4. Existing conversation with prior messages from non-agent? -> Skip.
 * 5. Otherwise -> Agent responds.
 */
export async function checkRouting(
  conversation: Conversation,
  senderId: string,
  platform: Platform,
): Promise<RoutingDecision> {
  const clientId = conversation.client_id ?? process.env.SUPABASE_DEFAULT_CLIENT_ID

  // 1. Known contact check
  if (clientId) {
    const { known, displayName } = await isKnownContact(clientId, platform, senderId)
    if (known) {
      return {
        allowed: false,
        reason: `Known contact: ${displayName ?? senderId}. Skipping agent, notifying owner.`,
        action: "notify_owner",
      }
    }
  }

  // 2. Human-owned thread
  if (conversation.owned_by === "human") {
    return {
      allowed: false,
      reason: "Thread owned by human. Agent will not respond.",
      action: "skip",
    }
  }

  // 3. Escalated or unassigned -- waiting on owner. The customer should still
  //    get a one-time handoff ack ("Got it — Gian is on this") instead of
  //    silence; the handler reads the action and sends the ack once per thread.
  if (conversation.owned_by === "unassigned" || conversation.state === "escalated") {
    return {
      allowed: false,
      reason: "Thread escalated or unassigned. Waiting for human.",
      action: "handoff_ack",
    }
  }

  // 4. Closed conversation -- treat as new if they message again
  //    (state resets in handler when routing allows)

  // 5. All clear -- agent responds
  return { allowed: true, reason: "New or agent-owned thread. Agent responding." }
}

/** Get the owner display name from client config. */
export async function getOwnerDisplayName(clientId: string | null): Promise<string> {
  if (!clientId) return DEFAULT_CONFIG.owner_display_name
  const config = await getClientConfig(clientId)
  return config?.owner_display_name ?? DEFAULT_CONFIG.owner_display_name
}

/** Get the escalate-always intents from client config. */
export async function getEscalateAlwaysIntents(clientId: string | null): Promise<string[]> {
  if (!clientId) return DEFAULT_CONFIG.escalate_always
  const config = await getClientConfig(clientId)
  return config?.escalate_always ?? DEFAULT_CONFIG.escalate_always
}
