import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export async function callClaude(systemPrompt: string, userMessage: string): Promise<unknown> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
  return JSON.parse(cleaned)
}

// ─── AUDIENCE ANALYZER ───────────────────────────────────────────────────────

export const AUDIENCE_PROMPT = `You are an expert marketing strategist helping coaches and consultants define their ideal client avatar with precision.

Analyze the inputs and return a JSON object with this exact structure:
{
  "avatar_name": "A vivid name for this ideal client persona (e.g. 'Burnt-Out Business Coach Beth')",
  "description": "2-3 sentence description of who this person is",
  "pain_points": ["pain point 1", "pain point 2", "pain point 3", "pain point 4"],
  "desires": ["desire 1", "desire 2", "desire 3", "desire 4"],
  "messaging_angles": ["angle 1", "angle 2", "angle 3"],
  "where_they_hang_out": ["platform/place 1", "platform/place 2", "platform/place 3"],
  "buying_trigger": "The specific moment or event that makes them ready to invest",
  "biggest_objection": "The #1 reason they hesitate to buy",
  "ideal_outcome": "In one sentence, the life they want after working with you"
}

Return ONLY valid JSON. No preamble, no explanation, no markdown.`

// ─── TRANSFORMATION BUILDER ──────────────────────────────────────────────────

export const TRANSFORMATION_PROMPT = `You are an expert at defining coach/consultant transformations that justify premium pricing.

Analyze the inputs and return a JSON object with this exact structure:
{
  "before_state": {
    "headline": "Where they are now (the pain, in their words)",
    "details": ["detail 1", "detail 2", "detail 3", "detail 4"]
  },
  "after_state": {
    "headline": "Where they will be after working with you (the result)",
    "details": ["detail 1", "detail 2", "detail 3", "detail 4"]
  },
  "transformation_statement": "One powerful sentence: 'I help [avatar] go from [before] to [after] in [timeframe]'",
  "proof_of_concept": "Why YOU are the right person to deliver this transformation",
  "pricing_anchor": "The recommended price range for this transformation and why it's justified",
  "timeframe": "Realistic timeframe to achieve the core result",
  "signature_method_name": "A memorable name for your process (e.g. 'The ATM Method', 'The 90-Day Clarity System')"
}

Return ONLY valid JSON. No preamble, no explanation, no markdown.`

// ─── MONETIZATION CREATOR ────────────────────────────────────────────────────

export const MONETIZATION_PROMPT = `You are an expert at building offer suites for coaches and consultants that maximize revenue and client results.

Analyze the inputs and return a JSON object with this exact structure:
{
  "offer_suite": {
    "low_ticket": {
      "name": "Product/offer name",
      "price": 97,
      "format": "Self-paced course / template / guide / etc.",
      "description": "What it is and what it does",
      "best_for": "Who buys this",
      "included": ["item 1", "item 2", "item 3"]
    },
    "mid_ticket": {
      "name": "Product/offer name",
      "price": 997,
      "format": "Group program / workshop / bootcamp / etc.",
      "description": "What it is and what it does",
      "best_for": "Who buys this",
      "included": ["item 1", "item 2", "item 3", "item 4"]
    },
    "high_ticket": {
      "name": "Product/offer name",
      "price": 5000,
      "format": "1:1 coaching / done-with-you / VIP / etc.",
      "description": "What it is and what it does",
      "best_for": "Who buys this",
      "included": ["item 1", "item 2", "item 3", "item 4", "item 5"]
    }
  },
  "revenue_model": "How these three offers work together as a funnel",
  "recommended_starting_offer": "Which offer to launch first and why",
  "monthly_revenue_target": {
    "conservative": 5000,
    "realistic": 10000,
    "ambitious": 25000
  }
}

Return ONLY valid JSON. No preamble, no explanation, no markdown.`

// ─── QUIZ ANALYZER ───────────────────────────────────────────────────────────

export const QUIZ_PROMPT = `You are analyzing quiz responses from a coach or consultant to identify their biggest growth gaps.

Analyze the answers and return a JSON object with this exact structure:
{
  "overall_score": 65,
  "scores": {
    "attract": 60,
    "transform": 70,
    "monetize": 65
  },
  "moniker": "A short, memorable label for their current stage (e.g. 'The Hidden Gem', 'The Undercharger', 'The Busy Broke Coach')",
  "biggest_gap": "The #1 area holding them back, explained plainly",
  "quick_win": "The single most impactful action they can take this week",
  "what_hurts_most": "The pain point that resonates most deeply based on their answers",
  "has_pricing_issue": true,
  "recommended_tool": "audience | transformation | monetization"
}

Scores should be 0-100 integers. Return ONLY valid JSON.`
