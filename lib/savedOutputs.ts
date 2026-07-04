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
