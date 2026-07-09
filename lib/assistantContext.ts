import { supabase } from './supabase'
import { getSavedOutput } from './savedOutputs'
import { getMtmSessionProgress } from './progress'

// Shared read-only snapshot of a member's real situation, used by both the MTM
// Coach chat endpoint (as grounding context) and the checklist endpoint (as the
// ordered follow-along list). It reads the same sources the dashboard reads
// (users.video_watched, lib/progress, saved_outputs) so the assistant and the
// checklist always match what the member actually sees. No writes.

export type ChecklistStatus = 'done' | 'current' | 'locked'
export type ChecklistItem = { key: string; label: string; status: ChecklistStatus }

export type MemberSnapshot = {
  name: string
  checklist: ChecklistItem[]
  percent: number
  // A plain-text summary of the member's progress and their own generated work,
  // injected into the coach's system prompt. Only real values appear; anything
  // absent is reported as not done so the model never invents member specifics.
  contextText: string
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}
// A toolkit has produced something once its saved row holds a non-empty
// by_card_id map (program/content/slides/qualifier all persist that shape).
function hasAsset(row: { content: unknown } | null): boolean {
  const c = obj(row?.content)
  const map = c ? obj(c.by_card_id) : null
  return !!map && Object.keys(map).length > 0
}

export async function getMemberSnapshot(userId: string): Promise<MemberSnapshot> {
  const [
    userRes,
    sessions,
    audienceRow,
    analysisRow,
    frameworkRow,
    offersRow,
    cardsRes,
    program,
    content,
    slides,
    qualifier,
  ] = await Promise.all([
    supabase.from('users').select('name, video_watched').eq('id', userId).single(),
    getMtmSessionProgress(userId),
    getSavedOutput(userId, 'audience'),
    getSavedOutput(userId, 'transformation_analysis'),
    getSavedOutput(userId, 'framework'),
    getSavedOutput(userId, 'core_offers'),
    supabase
      .from('problem_solution_cards')
      .select('card_name')
      .eq('user_id', userId)
      .eq('validated', true)
      .order('created_at', { ascending: true })
      .limit(3),
    getSavedOutput(userId, 'program'),
    getSavedOutput(userId, 'content'),
    getSavedOutput(userId, 'slides'),
    getSavedOutput(userId, 'qualifier'),
  ])

  const name = str(userRes.data?.name) || 'there'
  const watched = userRes.data?.video_watched === true

  const done = new Map(sessions.map((s) => [s.key, s.completed]))
  const attractDone = done.get('audience') === true
  const transformDone = done.get('transformation') === true
  const monetizeDone = done.get('matcher') === true
  const blueprintDone = done.get('blueprint') === true
  const assetsDone = hasAsset(program) || hasAsset(content) || hasAsset(slides) || hasAsset(qualifier)

  const raw = [
    { key: 'watch_training', label: 'Watch the full training', done: watched },
    { key: 'attract', label: 'Step 1: Attract — discover your audience', done: attractDone },
    { key: 'transform', label: 'Step 2: Transform — define your method', done: transformDone },
    { key: 'monetize', label: 'Step 3: Monetize — validate your Blueprints', done: monetizeDone },
    { key: 'blueprint', label: 'Generate your Micro-Training Blueprint', done: blueprintDone },
    { key: 'assets', label: 'Create your assets', done: assetsDone },
  ]

  // First not-done item is "current"; everything after it is "locked".
  let currentAssigned = false
  const checklist: ChecklistItem[] = raw.map((it) => {
    let status: ChecklistStatus
    if (it.done) status = 'done'
    else if (!currentAssigned) {
      status = 'current'
      currentAssigned = true
    } else status = 'locked'
    return { key: it.key, label: it.label, status }
  })
  const doneCount = raw.filter((it) => it.done).length
  const percent = Math.round((doneCount / raw.length) * 100)
  const current = checklist.find((c) => c.status === 'current') || null

  // Member-specific facts for the coach. Gated on BOTH the row's own
  // confirmed/completed flag AND the matching step's session-progress flag.
  // These two signals live in different tables and can drift out of sync
  // (e.g. a framework row confirmed in the tool while the Step 2
  // session-progress record wasn't marked complete). Requiring both means
  // the coach never states a step is "still open" in one line and then
  // cites that step's specific output as settled fact in another.
  const audience = obj(audienceRow?.content)
  const avatarName = attractDone && audience && audience.completed === true ? str(audience.avatarName) : null
  const problem = attractDone && audience && audience.completed === true ? str(audience.problemStatement) : null
  const analysis = obj(analysisRow?.content)
  const zone = transformDone && analysis && analysis.confirmed === true ? str(analysis.zoneOfImpact) : null
  const framework = obj(frameworkRow?.content)
  const frameworkName = transformDone && framework && framework.confirmed === true ? str(framework.frameworkName) : null
  const offers = obj(offersRow?.content)
  const offersConfirmed = monetizeDone && !!offers && offers.confirmed === true
  const cardNames = ((cardsRes.data || []) as Array<{ card_name: unknown }>)
    .map((c) => str(c.card_name))
    .filter((n): n is string => n !== null)

  const lines: string[] = []
  lines.push(`Member name: ${name}.`)
  lines.push(`Watched the full training: ${watched ? 'yes' : 'not yet'}.`)
  lines.push(`Step 1 Attract: ${attractDone ? 'complete' : 'not complete'}.`)
  lines.push(`Step 2 Transform: ${transformDone ? 'complete' : 'not complete'}.`)
  lines.push(`Step 3 Monetize: ${monetizeDone ? 'complete' : 'not complete'}.`)
  lines.push(`Blueprint generated: ${blueprintDone ? 'yes' : 'no'}.`)
  lines.push(`Assets created: ${assetsDone ? 'yes' : 'none yet'}.`)
  if (avatarName) lines.push(`Their avatar is named ${avatarName}.`)
  if (problem) lines.push(`Their problem statement: ${problem}`)
  if (zone) lines.push(`Their zone of impact: ${zone}`)
  if (frameworkName) lines.push(`Their named method: ${frameworkName}.`)
  if (cardNames.length) lines.push(`Validated Blueprint topics: ${cardNames.join('; ')}.`)
  lines.push(`Core offers set: ${offersConfirmed ? 'yes' : 'not yet'}.`)
  lines.push(
    `Their next step: ${current ? current.label : 'they have finished the core path, so help them use and deploy their assets'}.`
  )

  return { name, checklist, percent, contextText: lines.join('\n') }
}
