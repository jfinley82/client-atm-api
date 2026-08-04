import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { MAX_SELECTED_EXERCISES_PER_SECTION } from '../../lib/microTrainingGenerator'

// PATCH /api/generate/exercises?card_id=... — persist the coach's guide exercise
// selection.
//
// Body: { sections: [ { index: number, selected: number[] } ] }
//   index    — position of the section in workbook.sections
//   selected — indexes of the chosen exercises WITHIN that section's pool
//
// Writes a `selected` boolean onto each exercise inside the existing workbook
// JSONB. No new column: the workbook already holds the exercise pool, and a
// separate table would split one document across two places.
//
// `recommended` is left exactly as the generator wrote it. That is the point of
// a separate flag — recommended is the AI's own output, and overwriting it
// destroys the ability to tell an AI default from a coach edit, which is the
// same reason script beats carry gen_snapshot.
//
// The max of 2 per section is enforced HERE rather than trusted from the client,
// so a UI that forgets its own counter cannot widen the guide.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const rawCardId = req.query?.card_id
  const cardId = Array.isArray(rawCardId) ? rawCardId[0] : rawCardId
  if (!cardId || typeof cardId !== 'string') return res.status(400).json({ error: 'card_id required' })

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const rawSections = body.sections
  if (!Array.isArray(rawSections)) {
    return res.status(400).json({ error: 'invalid_field', field: 'sections', message: 'sections must be an array' })
  }

  // Validate the whole payload before touching the row: a partially-applied
  // selection would leave the guide in a state the coach never chose.
  const wanted = new Map<number, number[]>()
  for (const entry of rawSections) {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    if (!Number.isInteger(e.index) || (e.index as number) < 0) {
      return res.status(400).json({ error: 'invalid_field', field: 'sections[].index', message: 'must be a non-negative integer' })
    }
    if (!Array.isArray(e.selected) || !e.selected.every((n) => Number.isInteger(n) && (n as number) >= 0)) {
      return res.status(400).json({ error: 'invalid_field', field: 'sections[].selected', message: 'must be an array of non-negative integers' })
    }
    const unique = [...new Set(e.selected as number[])]
    if (unique.length > MAX_SELECTED_EXERCISES_PER_SECTION) {
      return res.status(400).json({
        error: 'too_many_selected',
        field: 'sections[].selected',
        section_index: e.index,
        max: MAX_SELECTED_EXERCISES_PER_SECTION,
        message: `at most ${MAX_SELECTED_EXERCISES_PER_SECTION} exercises per section`,
      })
    }
    wanted.set(e.index as number, unique)
  }

  try {
    const { data: row, error: readErr } = await supabase
      .from('mtm_generations')
      .select('id, workbook')
      .eq('card_id', cardId)
      .eq('user_id', userId)
      .maybeSingle()
    if (readErr) throw readErr
    if (!row) return res.status(404).json({ error: 'Generation not found' })

    const workbook = ((row as any).workbook && typeof (row as any).workbook === 'object' ? (row as any).workbook : {}) as Record<string, unknown>
    const sections = Array.isArray(workbook.sections) ? (workbook.sections as any[]) : []
    if (!sections.length) return res.status(400).json({ error: 'no_workbook_sections' })

    // Every index must exist, and every chosen exercise must exist in that
    // section's pool — an out-of-range index would silently select nothing.
    for (const [sectionIndex, chosen] of wanted) {
      const section = sections[sectionIndex]
      if (!section || typeof section !== 'object') {
        return res.status(400).json({ error: 'unknown_section', section_index: sectionIndex })
      }
      const pool = Array.isArray(section.exercises) ? section.exercises : []
      for (const i of chosen) {
        if (!pool[i]) {
          return res.status(400).json({ error: 'unknown_exercise', section_index: sectionIndex, exercise_index: i, pool_size: pool.length })
        }
      }
    }

    const nextSections = sections.map((section, sectionIndex) => {
      if (!wanted.has(sectionIndex)) return section
      const chosen = new Set(wanted.get(sectionIndex)!)
      const pool = Array.isArray(section?.exercises) ? section.exercises : []
      return {
        ...section,
        // Every exercise in a touched section gets an explicit boolean, so the
        // section reads as "the coach has chosen here" and stops falling back to
        // recommended — including when they deliberately select none.
        exercises: pool.map((ex: any, i: number) => ({ ...(ex && typeof ex === 'object' ? ex : {}), selected: chosen.has(i) })),
      }
    })

    const { error: writeErr } = await supabase
      .from('mtm_generations')
      .update({ workbook: { ...workbook, sections: nextSections } })
      .eq('id', (row as any).id)
      .eq('user_id', userId)
    if (writeErr) throw writeErr

    return res.status(200).json({
      ok: true,
      sections: nextSections.map((s: any, i: number) => ({
        index: i,
        selected: (Array.isArray(s?.exercises) ? s.exercises : [])
          .map((ex: any, j: number) => (ex?.selected === true ? j : -1))
          .filter((j: number) => j >= 0),
      })),
    })
  } catch (err) {
    console.error('[generate/exercises] PATCH', err)
    return res.status(500).json({ error: 'Failed to save exercise selection' })
  }
}
