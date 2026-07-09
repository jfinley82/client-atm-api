import { supabase } from './supabase'

// Persistent MTM Coach conversation history, grouped into threads. Backs
// four endpoints: chat.ts (reads active-thread history for context, writes
// both sides of each exchange), history.ts (reads active-thread history for
// the widget), restart.ts (ends the active thread), threads.ts (lists and
// reads past, ended threads).
//
// A member always has at most one open thread (ended_at is null). Nothing
// is ever deleted — restart ends the current thread rather than removing
// rows, so an ended thread becomes browsable via getThreadList/
// getThreadMessages instead of disappearing.

export type HistoryRole = 'user' | 'assistant'
export type HistoryMessage = { role: HistoryRole; content: string }
export type ThreadSummary = { id: string; startedAt: string; endedAt: string | null; preview: string | null }

const MAX_CONTENT = 4000 // per-message character cap, defensive, matches chat.ts
const MAX_HISTORY_TURNS = 20 // trailing turns loaded for model context and widget hydration

function clip(content: string): string {
  return content.trim().slice(0, MAX_CONTENT)
}

// The member's currently open thread id, if one exists. Does NOT create one
// — opening the widget or checking history shouldn't leave behind an empty
// thread row with no messages in it (that would show up as a blank entry
// in "Past chats" the moment it's ended). Only appendMessages creates a
// thread, and only once there's an actual message to put in it.
async function getOpenThreadId(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('assistant_threads')
    .select('id')
    .eq('user_id', userId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

// Same as getOpenThreadId, but creates a thread if the member doesn't have
// one open. Used only when a message is actually about to be written.
async function getOrCreateActiveThreadId(userId: string): Promise<string> {
  const existing = await getOpenThreadId(userId)
  if (existing) return existing

  const { data: created, error: createErr } = await supabase
    .from('assistant_threads')
    .insert({ user_id: userId })
    .select('id')
    .single()
  if (createErr) throw createErr
  return created.id
}

// Active thread's messages, oldest first, capped to the trailing
// MAX_HISTORY_TURNS. Used both to hydrate the widget and to build the
// model's context window. Returns [] if the member has no open thread —
// does not create one just to answer this question.
export async function getActiveHistory(userId: string): Promise<HistoryMessage[]> {
  const threadId = await getOpenThreadId(userId)
  if (!threadId) return []

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
// their very first-ever message (or their first message after a restart).
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

// Ends the member's active thread, if they have one. Their next message
// starts a brand new one. No-op (not an error) if nothing is currently
// open — safe to call unconditionally, e.g. every time the widget opens.
export async function archiveActiveHistory(userId: string): Promise<void> {
  const { error } = await supabase
    .from('assistant_threads')
    .update({ ended_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('ended_at', null)
  if (error) throw error
}

// Past (ended) threads for the member, most recent first, each with a short
// preview drawn from its first member message. Threads with zero messages
// (e.g. an old empty thread from before this got fixed) are excluded so
// "Past chats" never shows a blank entry.
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

  return list
    .filter((t) => previewByThread.has(t.id))
    .map((t) => ({
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
