import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (_client) return _client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    return (getClient() as any)[prop]
  }
})

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
