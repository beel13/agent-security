/**
 * NOTE: this file mixes generated and HAND-EXTENDED entries.
 *
 * Hand-extended (Wave 5.1):
 *   - public.Tables.processed_gmail_messages
 *   - public.Tables.onboarding_submissions (Wave 6)
 *
 * If you ever regenerate this file via `mcp__supabase__generate_typescript_types`
 * or the Supabase CLI, the regenerator will WIPE the hand-extended entries
 * and the gmail-dedupe code path will silently break (TS error on the
 * insert call in app/api/agent/db/conversations.ts → claimGmailMessage).
 * After any regen, re-add the missing tables from `git log -p` of this file.
 */
export type Database = {
  public: {
    Tables: {
      clients: {
        Row: {
          id: string
          business_name: string
          owner_name: string | null
          owner_email: string
          business_type: string
          phone: string | null
          timezone: string
          onboarded_at: string
          is_demo: boolean
          client_profile: Record<string, unknown> | null
        }
        Insert: {
          id?: string
          business_name: string
          owner_name?: string | null
          owner_email: string
          business_type?: string
          phone?: string | null
          timezone?: string
          onboarded_at?: string
          is_demo?: boolean
          client_profile?: Record<string, unknown> | null
        }
        Update: {
          id?: string
          business_name?: string
          owner_name?: string | null
          owner_email?: string
          business_type?: string
          phone?: string | null
          timezone?: string
          onboarded_at?: string
          is_demo?: boolean
          client_profile?: Record<string, unknown> | null
        }
        Relationships: []
      }
      leads: {
        Row: {
          id: string
          client_id: string
          name: string | null
          contact: string | null
          source: string | null
          demo_type: string | null
          business_type: string | null
          service_type: string | null
          lead_quality: string | null
          lead_score: number | null
          urgency_level: string | null
          tags: string[] | null
          sentiment_arc: string | null
          turn_count: number | null
          booking_slot: string | null
          objection_type: string | null
          strategy_used: string | null
          complaint_type: string | null
          resolution_offered: string | null
          response_time_ms: number | null
          status: string
          // Wave 7: booking safety
          appointment_at: string | null
          address: string | null
          verification_status: string
          verification_method: string | null
          verified_phone: string | null
          no_show_count: number
          last_no_show_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          name?: string | null
          contact?: string | null
          source?: string | null
          demo_type?: string | null
          business_type?: string | null
          service_type?: string | null
          lead_quality?: string | null
          lead_score?: number | null
          urgency_level?: string | null
          tags?: string[] | null
          sentiment_arc?: string | null
          turn_count?: number | null
          booking_slot?: string | null
          objection_type?: string | null
          strategy_used?: string | null
          complaint_type?: string | null
          resolution_offered?: string | null
          response_time_ms?: number | null
          status?: string
          appointment_at?: string | null
          address?: string | null
          verification_status?: string
          verification_method?: string | null
          verified_phone?: string | null
          no_show_count?: number
          last_no_show_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          name?: string | null
          contact?: string | null
          source?: string | null
          demo_type?: string | null
          business_type?: string | null
          service_type?: string | null
          lead_quality?: string | null
          lead_score?: number | null
          urgency_level?: string | null
          tags?: string[] | null
          sentiment_arc?: string | null
          turn_count?: number | null
          booking_slot?: string | null
          objection_type?: string | null
          strategy_used?: string | null
          complaint_type?: string | null
          resolution_offered?: string | null
          response_time_ms?: number | null
          status?: string
          appointment_at?: string | null
          address?: string | null
          verification_status?: string
          verification_method?: string | null
          verified_phone?: string | null
          no_show_count?: number
          last_no_show_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      demo_transcripts: {
        Row: {
          id: string
          lead_id: string
          transcript: string | null
          score_breakdown: Record<string, unknown> | null
          answers: Record<string, unknown> | null
          input_tokens: number | null
          output_tokens: number | null
          total_tokens: number | null
          estimated_cost: number | null
          issue_summary: string | null
          created_at: string
        }
        Insert: {
          id?: string
          lead_id: string
          transcript?: string | null
          score_breakdown?: Record<string, unknown> | null
          answers?: Record<string, unknown> | null
          input_tokens?: number | null
          output_tokens?: number | null
          total_tokens?: number | null
          estimated_cost?: number | null
          issue_summary?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          lead_id?: string
          transcript?: string | null
          score_breakdown?: Record<string, unknown> | null
          answers?: Record<string, unknown> | null
          input_tokens?: number | null
          output_tokens?: number | null
          total_tokens?: number | null
          estimated_cost?: number | null
          issue_summary?: string | null
          created_at?: string
        }
        Relationships: []
      }
      form_submissions: {
        Row: {
          id: string
          lead_id: string | null
          service: string
          sms_consent: boolean
          consent_timestamp: string | null
          consent_ip: string | null
          submitted_at: string
        }
        Insert: {
          id?: string
          lead_id?: string | null
          service: string
          sms_consent?: boolean
          consent_timestamp?: string | null
          consent_ip?: string | null
          submitted_at?: string
        }
        Update: {
          id?: string
          lead_id?: string | null
          service?: string
          sms_consent?: boolean
          consent_timestamp?: string | null
          consent_ip?: string | null
          submitted_at?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          id: string
          thread_id: string
          client_id: string | null
          sender_id: string
          platform: string
          contact_info: Record<string, unknown>
          messages: Record<string, unknown>[]
          state: string
          context: Record<string, unknown>
          owned_by: string
          human_replied_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          thread_id: string
          client_id?: string | null
          sender_id: string
          platform: string
          contact_info?: Record<string, unknown>
          messages?: Record<string, unknown>[]
          state?: string
          context?: Record<string, unknown>
          owned_by?: string
          human_replied_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          thread_id?: string
          client_id?: string | null
          sender_id?: string
          platform?: string
          contact_info?: Record<string, unknown>
          messages?: Record<string, unknown>[]
          state?: string
          context?: Record<string, unknown>
          owned_by?: string
          human_replied_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      known_contacts: {
        Row: {
          id: string
          client_id: string
          platform: string
          platform_id: string
          display_name: string | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          platform: string
          platform_id: string
          display_name?: string | null
          notes?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          platform?: string
          platform_id?: string
          display_name?: string | null
          notes?: string | null
          created_at?: string
        }
        Relationships: []
      }
      processed_gmail_messages: {
        Row: {
          client_id: string
          gmail_message_id: string
          processed_at: string
        }
        Insert: {
          client_id: string
          gmail_message_id: string
          processed_at?: string
        }
        Update: {
          client_id?: string
          gmail_message_id?: string
          processed_at?: string
        }
        Relationships: []
      }
      onboarding_submissions: {
        Row: {
          id: string
          token_hash: string
          form_data: Record<string, unknown>
          website_content: string | null
          synth_profile: Record<string, unknown> | null
          synth_status: string
          approved_at: string | null
          approved_by: string | null
          client_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          token_hash: string
          form_data: Record<string, unknown>
          website_content?: string | null
          synth_profile?: Record<string, unknown> | null
          synth_status?: string
          approved_at?: string | null
          approved_by?: string | null
          client_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          token_hash?: string
          form_data?: Record<string, unknown>
          website_content?: string | null
          synth_profile?: Record<string, unknown> | null
          synth_status?: string
          approved_at?: string | null
          approved_by?: string | null
          client_id?: string | null
          created_at?: string
        }
        Relationships: []
      }
      client_config: {
        Row: {
          id: string
          client_id: string
          auto_respond: string[]
          escalate_always: string[]
          confidence_threshold: number
          notification_channel: string
          notification_target: string | null
          owner_display_name: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          auto_respond?: string[]
          escalate_always?: string[]
          confidence_threshold?: number
          notification_channel?: string
          notification_target?: string | null
          owner_display_name?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          auto_respond?: string[]
          escalate_always?: string[]
          confidence_threshold?: number
          notification_channel?: string
          notification_target?: string | null
          owner_display_name?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      client_platform_identifiers: {
        Row: {
          id: string
          client_id: string
          platform: string
          platform_identifier: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          platform: string
          platform_identifier: string
          created_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          platform?: string
          platform_identifier?: string
          created_at?: string
        }
        Relationships: []
      }
      client_platform_credentials: {
        Row: {
          id: string
          client_id: string
          platform: string
          credentials: Record<string, unknown>
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          platform: string
          credentials?: Record<string, unknown>
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          platform?: string
          credentials?: Record<string, unknown>
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      scheduled_followups: {
        Row: {
          id: string
          thread_id: string
          client_id: string | null
          message: string
          fire_at: string
          status: string
          attempts: number
          last_error: string | null
          // Wave 7: booking reminders
          kind: string
          lead_id: string | null
          created_at: string
          updated_at: string
          sent_at: string | null
        }
        Insert: {
          id?: string
          thread_id: string
          client_id?: string | null
          message: string
          fire_at: string
          status?: string
          attempts?: number
          last_error?: string | null
          kind?: string
          lead_id?: string | null
          created_at?: string
          updated_at?: string
          sent_at?: string | null
        }
        Update: {
          id?: string
          thread_id?: string
          client_id?: string | null
          message?: string
          fire_at?: string
          status?: string
          attempts?: number
          last_error?: string | null
          kind?: string
          lead_id?: string | null
          created_at?: string
          updated_at?: string
          sent_at?: string | null
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      append_conversation_message: {
        Args: { p_thread_id: string; p_message: Record<string, unknown> }
        Returns: void
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

export type Client = Database["public"]["Tables"]["clients"]["Row"]
export type Lead = Database["public"]["Tables"]["leads"]["Row"]
export type DemoTranscript = Database["public"]["Tables"]["demo_transcripts"]["Row"]
export type FormSubmission = Database["public"]["Tables"]["form_submissions"]["Row"]
export type Conversation = Database["public"]["Tables"]["conversations"]["Row"]
export type KnownContact = Database["public"]["Tables"]["known_contacts"]["Row"]
export type ClientConfig = Database["public"]["Tables"]["client_config"]["Row"]
export type ClientPlatformIdentifier = Database["public"]["Tables"]["client_platform_identifiers"]["Row"]
export type ClientPlatformCredentials = Database["public"]["Tables"]["client_platform_credentials"]["Row"]
export type ProcessedGmailMessage = Database["public"]["Tables"]["processed_gmail_messages"]["Row"]
export type OnboardingSubmission = Database["public"]["Tables"]["onboarding_submissions"]["Row"]
export type ScheduledFollowup = Database["public"]["Tables"]["scheduled_followups"]["Row"]
