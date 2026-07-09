import { supabase } from './supabase'

// Persistent MTM Coach conversation history, one row per turn. Backs three
// endpoints: chat.ts (reads active history for context, writes both sides
// of each exchange), history.ts (reads active history for the widget on
// load), restart.ts (archives the active thread).
//
// Soft-delete only: "restart" sets archived_at rather than deleting rows,
// so a restart never permanently destroys a member's conversation.

export type HistoryRole = 'user' | 'assistant'
export type HistoryMessage = { role: HistoryRole; content: string }

const MAX_CONTENT = 4000 // per-message character cap, defensive, matches chat.ts
const MAX_HISTORY_TURNS = 20 // trailing turns loaded for model context and widget hydration

function clip(content: string): string {
  return content.trim().slice(0, MAX_CONTENT)
}

// Active (non-archived) messages, oldest first, capped to the trailing
// MAX_HISTORY_TURNS. Used both to hydrate the widget on open and to build
// the model's context window.
export async function getActiveHistory(userId: string): Promise<HistoryMessage[]> {
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('role, content, created_at')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_TURNS * 2) // *2: a "turn" is one user + one assistant row

  if (error) throw error

  return ((data || []) as Array<{ role: HistoryRole; content: string }>).reverse()
}

// Appends one exchange (the member's message and, once generated, the
// coach's reply) to the active thread.
export async function appendMessages(userId: string, messages: HistoryMessage[]): Promise<void> {
  if (messages.length === 0) return
  const rows = messages.map((m) => ({ user_id: userId, role: m.role, content: clip(m.content) }))
  const { error } = await supabase.from('assistant_messages').insert(rows)
  if (error) throw error
}

// Archives every currently-active row for the member, starting a fresh
// thread. Soft-delete: rows stay in the table with archived_at set, nothing
// is dropped.
export async function archiveActiveHistory(userId: string): Promise<void> {
  const { error } = await supabase
    .from('assistant_messages')
    .update({ archived_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('archived_at', null)
  if (error) throw error
}
