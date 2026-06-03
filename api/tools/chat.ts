import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

type ToolType = 'audience' | 'transformation' | 'monetization'

const MAX_STEPS: Record<ToolType, number> = {
  audience: 4,
  transformation: 6,
  monetization: 4,
}

function buildSystemPrompt(toolType: ToolType, currentStep: number): string {
  switch (toolType) {
    case 'audience':
      return `You are an expert business coach helping a coach or consultant discover their ideal client avatar through structured conversation. Ask ONE focused question at a time. Be warm, encouraging, and specific.
Steps: 1-Business Stage, 2-Your Story, 3-Client Discovery, 4-Deep Profile.
Current step: ${currentStep} of 4.
From step 3 onwards, if you have enough information, include a JSON object at the end of your response wrapped in <data> tags:
{
  'persona_name':'...','description':'...',
  'demographics':['...'],'core_problem':'...',
  'dream_outcome':'...','frustrations':['...'],
  'fears':['...'],'messaging_triggers':['...']
}`
    case 'transformation':
      return `You are an expert coach helping map a client transformation journey. Ask ONE focused question at a time. Be specific and insightful.
Steps: 1-Re-Orientation, 2-Root Cause, 3-Root Desire, 4-Language Mirror, 5-Top 10 Problems, 6-Focus Selector.
Current step: ${currentStep} of 6.
From step 4 onwards, include <data> tags with:
{
  'before_headline':'...','before_beliefs':'...',
  'before_internal_talk':'...','before_results':'...',
  'after_headline':'...','after_beliefs':'...',
  'after_internal_talk':'...','after_results':'...',
  'perceived_value':0,'transformed_value':0,
  'timeline':'...'
}`
    case 'monetization':
      return `You are a business strategist building a 3-tier offer suite for a coach or consultant. Ask ONE focused question at a time.
Steps: 1-Offer Structure, 2-Pricing Strategy, 3-Revenue Calculation, 4-Offer Refinement.
Current step: ${currentStep} of 4.
From step 3 onwards, include <data> tags with:
{
  'low_ticket':{'name':'...','price':0,
    'description':'...','deliverables':['...']},
  'mid_ticket':{'name':'...','price':0,
    'description':'...','deliverables':['...']},
  'high_ticket':{'name':'...','price':0,
    'description':'...','deliverables':['...']},
  'monthly_projection':0,'annual_projection':0
}`
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const { tool_type, messages, current_step } = req.body || {}

  if (tool_type !== 'audience' && tool_type !== 'transformation' && tool_type !== 'monetization') {
    return res.status(400).json({ error: 'Invalid tool_type' })
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' })
  }
  const currentStep = typeof current_step === 'number' ? current_step : 1

  try {
    const system = buildSystemPrompt(tool_type, currentStep)

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    })

    const responseText = message.content[0]?.type === 'text' ? message.content[0].text : ''

    // Extract <data>...</data> JSON if present, then strip the tags from the message
    let structuredData: unknown = null
    let cleanedMessage = responseText
    const dataMatch = responseText.match(/<data>([\s\S]*?)<\/data>/)
    if (dataMatch) {
      try {
        structuredData = JSON.parse(dataMatch[1].trim())
      } catch {
        structuredData = null
      }
      cleanedMessage = responseText.replace(/<data>[\s\S]*?<\/data>/, '').trim()
    }

    const maxSteps = MAX_STEPS[tool_type as ToolType]

    return res.status(200).json({
      message: cleanedMessage,
      structured_data: structuredData,
      step_complete: currentStep >= maxSteps,
    })
  } catch (err) {
    console.error('[tools/chat]', err)
    return res.status(500).json({ error: 'Chat failed' })
  }
}
