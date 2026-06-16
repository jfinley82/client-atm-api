import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

const GENERATION_PROMPT = `You are an expert content strategist and coach trainer. You have been given a coach's complete audience intelligence, transformation data, and validated problem/solution pair. Your job is to generate a complete micro-training system they can record and share immediately.
Generate ALL of the following in one response. Output ONLY valid JSON — no preamble, no explanation, no markdown. Double quotes only.
{ "topics": [ { "title": "training title option 1", "angle": "the specific hook or framing for this title", "why": "why this angle would resonate with the audience" }, { "title": "training title option 2", "angle": "the specific hook or framing for this title", "why": "why this angle would resonate with the audience" }, { "title": "training title option 3", "angle": "the specific hook or framing for this title", "why": "why this angle would resonate with the audience" }, { "title": "training title option 4", "angle": "the specific hook or framing for this title", "why": "why this angle would resonate with the audience" }, { "title": "training title option 5", "angle": "the specific hook or framing for this title", "why": "why this angle would resonate with the audience" } ], "script": { "hook": "Opening 60 seconds — speak directly to the audience's pain using their own language. Make them feel seen before you say anything else.", "problem_deep_dive": "Minutes 1-5 — describe the problem in vivid detail using the audience's internal dialogue and language. Name the real cause not the perceived cause.", "credibility_bridge": "Minutes 5-8 — brief story or proof point that shows you understand this from the inside. Not a bio — a moment of recognition.", "the_teaching": "Minutes 8-22 — the actual content. Solve the surface problem in a way that reveals the deeper issue only coaching can address. Use numbered steps or a simple framework.", "the_revelation": "Minutes 22-26 — the one insight they did not expect. The thing that makes them think differently about their situation.", "the_invitation": "Minutes 26-30 — soft close to a discovery call. Not a pitch. A natural next step for someone who now understands their problem more clearly." }, "slides": [ { "slide_number": 1, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "hook" }, { "slide_number": 2, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "problem_deep_dive" }, { "slide_number": 3, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "problem_deep_dive" }, { "slide_number": 4, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "credibility_bridge" }, { "slide_number": 5, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "the_teaching" }, { "slide_number": 6, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "the_teaching" }, { "slide_number": 7, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "the_teaching" }, { "slide_number": 8, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "the_teaching" }, { "slide_number": 9, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "the_revelation" }, { "slide_number": 10, "title": "slide title", "talking_points": ["point 1", "point 2"], "section": "the_invitation" } ], "emails": [ { "email_number": 1, "send_timing": "immediately after registration", "subject": "email subject line", "body": "full email body — conversational, warm, direct. Confirm their registration, remind them what they are about to learn and why it matters. End with the training link." }, { "email_number": 2, "send_timing": "24 hours after registration if they have not watched", "subject": "email subject line", "body": "full email body — reference the specific problem the training solves. Create mild urgency without fake scarcity. End with the training link." }, { "email_number": 3, "send_timing": "48 hours after registration", "subject": "email subject line", "body": "full email body — this is the call to action email. For those who watched, invite them to book a discovery call. For those who have not, give them one more reason to watch. Include both the training link and the discovery call link as [DISCOVERY_CALL_LINK]." } ] }`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  // POST — one-click generation of a complete micro-training system
  if (req.method === 'POST') {
    const { card_id } = req.body || {}
    if (!card_id || typeof card_id !== 'string') {
      return res.status(400).json({ error: 'card_id required' })
    }

    // Tier gate — generation requires a paid membership tier
    const { data: gateUser } = await supabase
      .from('users')
      .select('membership_tier')
      .eq('id', payload.userId)
      .single()
    if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
      return res.status(403).json({ error: 'upgrade_required' })
    }

    try {
      // Fetch the card and verify ownership
      const { data: card } = await supabase
        .from('problem_solution_cards')
        .select('*')
        .eq('id', card_id)
        .single()

      if (!card || card.user_id !== payload.userId) {
        return res.status(404).json({ error: 'Card not found' })
      }

      // Fetch the user's audience + transformation outputs
      const { data: outputs } = await supabase
        .from('saved_outputs')
        .select('tool_type, content')
        .eq('user_id', payload.userId)
        .in('tool_type', ['audience', 'transformation'])

      const byType: Record<string, unknown> = {}
      for (const row of outputs || []) byType[row.tool_type] = row.content

      const userMessage = `AUDIENCE INTELLIGENCE: ${JSON.stringify(byType['audience'] ?? {})}
TRANSFORMATION DATA: ${JSON.stringify(byType['transformation'] ?? {})}
PROBLEM/SOLUTION CARD: ${JSON.stringify(card)}
Generate the complete micro-training system now.`

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: GENERATION_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      })

      const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
      const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()

      let parsed: any
      try {
        parsed = JSON.parse(cleaned)
      } catch {
        console.error('[generate] failed to parse model output')
        return res.status(502).json({ error: 'Generation returned invalid JSON' })
      }

      const { data: generation, error } = await supabase
        .from('mtm_generations')
        .insert({
          user_id: payload.userId,
          card_id,
          topics: parsed.topics ?? [],
          chosen_topic: null,
          script: parsed.script ? JSON.stringify(parsed.script) : null,
          slides: parsed.slides ?? [],
          emails: parsed.emails ?? [],
        })
        .select()
        .single()

      if (error) throw error
      return res.status(200).json(generation)
    } catch (err) {
      console.error('[generate] POST', err)
      return res.status(500).json({ error: 'Generation failed' })
    }
  }

  if (req.method === 'GET') {
    const rawId = req.query && req.query.id
    const id = Array.isArray(rawId) ? rawId[0] : rawId

    // GET with id — return a single generation (must belong to the user)
    if (id && typeof id === 'string') {
      try {
        const { data, error } = await supabase
          .from('mtm_generations')
          .select('*')
          .eq('id', id)
          .eq('user_id', payload.userId)
          .maybeSingle()

        if (error) throw error
        if (!data) return res.status(404).json({ error: 'Generation not found' })
        return res.status(200).json(data)
      } catch (err) {
        console.error('[generate] GET one', err)
        return res.status(500).json({ error: 'Failed to load generation' })
      }
    }

    // GET with card_id — return the most recent generation for that card (user-owned)
    const rawCardId = req.query && req.query.card_id
    const cardId = Array.isArray(rawCardId) ? rawCardId[0] : rawCardId
    if (cardId && typeof cardId === 'string') {
      try {
        const { data, error } = await supabase
          .from('mtm_generations')
          .select('*')
          .eq('card_id', cardId)
          .eq('user_id', payload.userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (error) throw error
        return res.status(200).json(data ?? null)
      } catch (err) {
        console.error('[generate] GET by card_id', err)
        return res.status(500).json({ error: 'Failed to load generation' })
      }
    }

    // GET — list all generations for the user, with the card name joined in
    try {
      const { data, error } = await supabase
        .from('mtm_generations')
        .select('*, problem_solution_cards(card_name)')
        .eq('user_id', payload.userId)
        .order('created_at', { ascending: false })

      if (error) throw error

      const rows = (data || []).map((r: any) => {
        const { problem_solution_cards, ...rest } = r
        return { ...rest, card_name: problem_solution_cards?.card_name ?? null }
      })

      return res.status(200).json(rows)
    } catch (err) {
      console.error('[generate] GET list', err)
      return res.status(500).json({ error: 'Failed to load generations' })
    }
  }

  return res.status(405).end()
}
