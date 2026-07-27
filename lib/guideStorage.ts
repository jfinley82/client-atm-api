import { supabase } from './supabase'

// Store a coach's Guide PDF for a (user_id, card_id) generation on the public
// `guides` bucket and stamp its cache-busted URL onto mtm_generations.guide_url.
// Shared by the client-upload path (POST /api/guide/publish) and the server-side
// render+refresh path (POST /api/guide/refresh) so both write the guide the same
// way. Returns the new public guide_url.
export async function storeGuidePdf(userId: string, cardId: string, buffer: Buffer): Promise<string> {
  // One object per (coach, card); a re-publish overwrites the SAME object rather
  // than orphaning the previous PDF. contentType is set explicitly so the object
  // is served as a PDF regardless of path.
  const path = `${userId}/${cardId}.pdf`
  const { error: uploadError } = await supabase.storage
    .from('guides')
    .upload(path, buffer, { contentType: 'application/pdf', upsert: true })
  if (uploadError) throw uploadError

  const { data: publicUrlData } = supabase.storage.from('guides').getPublicUrl(path)
  // Cache-bust: the object path never changes across re-publishes, so without a
  // fresh ?v= a browser/CDN could keep serving the previous PDF after a refresh.
  const guide_url = `${publicUrlData.publicUrl}?v=${Date.now()}`

  const { error: updateError } = await supabase
    .from('mtm_generations')
    .update({ guide_url, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('card_id', cardId)
  if (updateError) throw updateError

  return guide_url
}
