import { supabase } from './supabase'

export type SavedOutputRow = { tool_type: string; content: unknown; created_at: string }

export async function getSavedOutput(userId: string, toolType: string): Promise<SavedOutputRow | null> {
  const { data, error } = await supabase
    .from('saved_outputs')
    .select('tool_type, content, created_at')
    .eq('user_id', userId)
    .eq('tool_type', toolType)
    .maybeSingle()

  if (error) throw error
  return data ?? null
}

export async function saveOutput(userId: string, toolType: string, content: unknown): Promise<void> {
  const { error } = await supabase
    .from('saved_outputs')
    .upsert(
      { user_id: userId, tool_type: toolType, content, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,tool_type' }
    )
  if (error) throw error
}

// Content is stored FLAT: the profile fields, plus a `completed` flag and the
// raw `session_history` transcript, all as siblings in the same object. These
// helpers let the transcript ride along for mid-conversation rehydration
// without leaking into the places that read content AS the profile.

function isObjContent(content: unknown): content is Record<string, unknown> {
  return !!content && typeof content === 'object' && !Array.isArray(content)
}

// The saved transcript (empty array if the row predates this feature).
export function extractSessionHistory(content: unknown): unknown[] {
  if (isObjContent(content) && Array.isArray(content.session_history)) return content.session_history
  return []
}

// The profile view with the transcript removed — for consumers that feed
// content to an LLM or cast it to a profile type, so the (potentially large)
// transcript never bloats a prompt or shows up as a stray field. `completed`
// is intentionally left in place: it already rode along on main before this
// change, and existing readers tolerate it.
export function stripSessionHistory(content: unknown): unknown {
  if (isObjContent(content) && 'session_history' in content) {
    const { session_history: _omit, ...rest } = content
    return rest
  }
  return content
}

// A session is finished only when its explicit flag is set. Persisting every
// turn means a row exists from the first message, so existence never implies
// completion — callers that need a finished session must check this.
export function isContentComplete(content: unknown): boolean {
  return isObjContent(content) && content.completed === true
}
