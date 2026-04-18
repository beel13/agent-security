import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./types"

/** Supabase service client — STUB for the public snapshot.
 *
 * The real production file uses next/headers and environment-configured
 * project URLs. Tests mock this module at the boundary, so a throwing stub
 * is enough for every code path actually exercised here. Running the
 * agent live requires the private repo. The declared return type matches
 * the real one so downstream `.from("...")` call sites still type-check.
 */
export function createServiceClient(): SupabaseClient<Database> {
  throw new Error(
    "[snapshot] Supabase service client is not configured. " +
      "This snapshot is for code review and test verification only.",
  )
}

export type { Database }
