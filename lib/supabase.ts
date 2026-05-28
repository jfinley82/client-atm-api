import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
})

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface User {
  id: string
  email: string
  name: string | null
  has_paid: boolean
  stripe_customer_id: string | null
  quiz_score: number | null
  quiz_completed: boolean
  created_at: string
}

export interface Lead {
  id: string
  email: string
  first_name: string | null
  source: string
  created_at: string
}

export interface MagicLinkToken {
  id: string
  user_id: string
  token: string
  expires_at: string
  used_at: string | null
}

export interface QuizResponse {
  id: string
  user_id: string
  answers: Record<string, string>
  score: number
  analysis: Record<string, unknown>
  created_at: string
}

export interface SavedOutput {
  id: string
  user_id: string
  tool_type: 'audience' | 'transformation' | 'monetization'
  content: Record<string, unknown>
  created_at: string
}
