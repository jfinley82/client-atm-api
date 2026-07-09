import { supabase } from './supabase'

export type HistoryRole = 'user' | 'assistant'
export type HistoryMessage = { role: HistoryRole; content: string }
export type ThreadSummary = { id: string; startedAt: string; endedAt: string | null; preview: string | null }

const MAX_CONTENT = 4000 // per-message character cap, defensive, matches chat.ts
const MAX_HISTORY_TURNS = 20 // trailing turns loaded for model context and widget hydration

function clip(content: string): string {
  return content.trim().slice(0, MAX_CONTENT)
}

// Returns the member's currently open thread id, creating one if they've
// never chatted before, or if their previous thread was ended by a restart.
async function getOrCreateActiveThreadId(userId: string): Promise<string> {
  const { data: existing, error: findErr } = await supabase
    .from('assistant_threads')
    .select('id')
    .eq('user_id', userId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (findErr) throw findErr
  if (existing) return existing.id

  const { data: created, error: createErr } = await supabase
    .from('assistant_threads')
    .insert({ user_id: userId })
    .select('id')
    .single()
  if (createErr) throw createErr
  return created.id
}

// Active thread's messages, oldest first, capped to the trailing
// MAX_HISTORY_TURNS. Used both to hydrate the widget on open and to build
// the model's context window.
export async function getActiveHistory(userId: string): Promise<HistoryMessage[]> {
  const threadId = await getOrCreateActiveThreadId(userId)
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('role, content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_TURNS * 2) // *2: a "turn" is one user + one assistant row

  if (error) throw error

  return ((data || []) as Array<{ role: HistoryRole; content: string }>).reverse()
}

// Appends one exchange to the member's active thread, creating a thread on
// their very first-ever message.
export async function appendMessages(userId: string, messages: HistoryMessage[]): Promise<void> {
  if (messages.length === 0) return
  const threadId = await getOrCreateActiveThreadId(userId)
  const rows = messages.map((m) => ({
    user_id: userId,
    thread_id: threadId,
    role: m.role,
    content: clip(m.content),
  }))
  const { error } = await supabase.from('assistant_messages').insert(rows)
  if (error) throw error
}

// Ends the member's active thread. Their next message starts a brand new
// one. Nothing is deleted — the ended thread becomes browsable via
// getThreadList/getThreadMessages below.
export async function archiveActiveHistory(userId: string): Promise<void> {
  const { error } = await supabase
    .from('assistant_threads')
    .update({ ended_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('ended_at', null)
  if (error) throw error
}

// Past (ended) threads for the member, most recent first, each with a short
// preview drawn from its first member message — this is what "Past chats"
// renders as a list.
export async function getThreadList(userId: string): Promise<ThreadSummary[]> {
  const { data: threads, error } = await supabase
    .from('assistant_threads')
    .select('id, started_at, ended_at')
    .eq('user_id', userId)
    .not('ended_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(50)
  if (error) throw error

  const list = (threads || []) as Array<{ id: string; started_at: string; ended_at: string }>
  if (list.length === 0) return []

  const { data: firstMessages, error: msgErr } = await supabase
    .from('assistant_messages')
    .select('thread_id, content, created_at')
    .in('thread_id', list.map((t) => t.id))
    .eq('role', 'user')
    .order('created_at', { ascending: true })
  if (msgErr) throw msgErr

  const previewByThread = new Map<string, string>()
  for (const m of (firstMessages || []) as Array<{ thread_id: string; content: string }>) {
    if (!previewByThread.has(m.thread_id)) previewByThread.set(m.thread_id, m.content.slice(0, 80))
  }

  return list.map((t) => ({
    id: t.id,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    preview: previewByThread.get(t.id) ?? null,
  }))
}

// Full transcript of one past (ended) thread, oldest first. Scoped to the
// requesting member by construction — a threadId belonging to someone else
// returns an empty array, never another member's messages.
export async function getThreadMessages(userId: string, threadId: string): Promise<HistoryMessage[]> {
  const { data: thread, error: threadErr } = await supabase
    .from('assistant_threads')
    .select('id')
    .eq('id', threadId)
    .eq('user_id', userId)
    .maybeSingle()
  if (threadErr) throw threadErr
  if (!thread) return []

  const { data, error } = await supabase
    .from('assistant_messages')
    .select('role, content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []) as HistoryMessage[]
}
