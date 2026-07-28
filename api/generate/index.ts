import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../lib/savedOutputs'
import { getVoiceContext } from '../../lib/voiceGuide'
import { requireCapability } from '../../lib/entitlements'
import { checkFrameworkConfirmed, getValidatedBlueprint } from '../../lib/toolkitsShared'
import { stampSyncSnapshot } from '../../lib/syncDependencies'
import { GenerationParseError } from '../../lib/aiJson'
import {
  generateMicroTraining,
  regenerateAsset,
  regenerateScript,
  generateAnglePreviews,
  generateSingleSlide,
  SingleSlideKind,
  resolveAngle,
  scrubTopicHooks,
  scrubSlideCoverHook,
  scrubEmailSubjectHooks,
  stampEmailOriginals,
  stampSlideGenSnapshots,
  stampScriptGenSnapshots,
  matchHookShapes,
  DeliveryInput,
  GeneratorInputs,
  MtSlide,
  MtTopic,
  PersonalHook,
  CtaType,
  coerceSlides,
  coerceEmails,
  coerceWorkbook,
  coerceRecordingTips,
  coerceOutline,
  coerceTopics,
  coerceSalesScript,
  coerceObjections,
  coerceAnglePreviews,
} from '../../lib/microTrainingGenerator'
import { BEAT_TEACHING } from '../../lib/slideDeckCanonical'
import { emailBodyHasRawHtml } from '../../lib/email'
import { sanitizePhrasingDeep } from '../../lib/phrasing'
import { avatarUrlForSeed, personaSeedFromAudience } from '../../lib/avatars'

// POST /api/generate — the unified Micro-Training generator. From ONE validated
// blueprint plus a few optional recording details, it produces and persists the
// full Step 4 (Build) / Step 5 (Launch) asset set into the canonical
// mtm_generations row for (user_id, card_id). The Micro-Training is a single
// 15-20 minute recorded video. No content is entered by the caller — audience,
// transformation, confirmed framework, the chosen blueprint, and the voice guide
// are all loaded server-side. See lib/microTrainingGenerator.ts.
//
// The generation runs in two waves (the meta unit first to fix the title, then
// the remaining five asset units in parallel). maxDuration is 90 (Pro plan
// allows it) so the sequential first wave plus a truncation retry stays clear of
// the ceiling.
export const config = { maxDuration: 90 }

const REGEN_TARGETS = new Set([
  'slides',
  'warm_invite',
  'emails',
  'book_a_call',
  'workbook',
  'recording_tips',
  'script',
  'topics',
  'outline',
  'sales_script',
  'objections',
  'angle_previews',
])

// The wizard steps a coach can approve, driving the Build progress rail.
// Objections are not their own approvable step — they're approved as part of the
// script (they feed the beat-5 panel), so 'objections' is not listed here.
const VALID_BUILD_STEPS = new Set(['angle', 'slides', 'emails', 'script'])

// ── Angle-sync state ─────────────────────────────────────────────────────────
// The downstream assets whose angle-sync is shown (also the full-generate stamp
// set). asset_angles[key] holds the chosen_angle each was generated on.
const ANGLE_SYNC_ASSETS = [
  'slides',
  'workbook',
  'warm_invite',
  'emails',
  'book_a_call',
  'sales_script',
  'objections',
  'outline',
] as const

// The row fields captured in pre_rebuild_snapshot (and restored from it): the
// rebuildable asset columns plus the angle-identity fields, for one level of undo.
const REBUILD_SNAPSHOT_COLUMNS = [
  'slides',
  'emails',
  'warm_invite_emails',
  'book_a_call_emails',
  'sales_script',
  'objections',
  'workbook',
  'outline',
  'asset_angles',
  'chosen_topic',
  'chosen_angle',
  'angle_source',
] as const

// Which asset_angles key a regenerate target stamps (topics / angle_previews
// stamp nothing; 'script' stamps the slides key).
const REGEN_ANGLE_KEY: Record<string, string> = {
  slides: 'slides',
  script: 'slides',
  warm_invite: 'warm_invite',
  emails: 'emails',
  book_a_call: 'book_a_call',
  workbook: 'workbook',
  recording_tips: 'recording_tips',
  sales_script: 'sales_script',
  objections: 'objections',
  outline: 'outline',
}

// The three email arrays, by their stored column name, for the hook-flag scan.
const EMAIL_LISTS = ['emails', 'warm_invite_emails', 'book_a_call_emails'] as const

// A slide counts as coach-customized when its content differs from the
// generator-owned gen_snapshot, or when it was hand-added (no snapshot).
function isSlideCustomized(s: unknown): boolean {
  const slide = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
  const gen = (slide.gen_snapshot && typeof slide.gen_snapshot === 'object' ? slide.gen_snapshot : null) as Record<string, unknown> | null
  if (!gen) return true // hand-added slide (no generator snapshot) — lost on a rebuild
  return (
    slide.slideTitle !== gen.slideTitle ||
    slide.sectionName !== gen.sectionName ||
    // current content: talking points (array, order matters) + delivery move
    canonicalJson(slide.talkingPoints ?? []) !== canonicalJson(gen.talkingPoints ?? []) ||
    canonicalJson(slide.deliveryMove ?? null) !== canonicalJson(gen.deliveryMove ?? null) ||
    // legacy on-screen narration, still compared so an edit to an old deck counts
    slide.script !== gen.script ||
    slide.speakerNote !== gen.speakerNote
  )
}

// An email counts as coach-customized when its subject or body differs from the
// as-generated `original`. An email with no original (legacy) never counts.
function isEmailCustomized(e: unknown): boolean {
  const email = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const orig = (email.original && typeof email.original === 'object' ? email.original : null) as Record<string, unknown> | null
  if (!orig) return false
  return email.subject !== orig.subject || email.body !== orig.body
}

// Whether any email in a stored array is coach-customized.
function emailSetCustomized(arr: unknown): boolean {
  return Array.isArray(arr) && arr.some(isEmailCustomized)
}

// Stable JSON with object keys sorted, so a jsonb column read back from Postgres
// (which does not preserve key order) compares equal to freshly-coerced content
// of the same value — a plain JSON.stringify compare would false-positive on order.
function canonicalJson(v: unknown): string {
  const seen = new WeakSet<object>()
  const norm = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x
    if (seen.has(x as object)) return null
    seen.add(x as object)
    if (Array.isArray(x)) return x.map(norm)
    const o = x as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = norm(o[k])
    return out
  }
  try { return JSON.stringify(norm(v)) } catch { return '' }
}

// A call-script beat counts as coach-customized when its content differs from the
// generator-owned gen_snapshot, or when it was hand-added (no snapshot).
// phrasing_options is an array, so compare it structurally.
function isBeatCustomized(b: unknown): boolean {
  const beat = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
  const gen = (beat.gen_snapshot && typeof beat.gen_snapshot === 'object' ? beat.gen_snapshot : null) as Record<string, unknown> | null
  if (!gen) return true // hand-added beat (no generator snapshot)
  return (
    beat.beat !== gen.beat ||
    beat.prospect_mindset !== gen.prospect_mindset ||
    beat.recommended !== gen.recommended ||
    JSON.stringify(beat.phrasing_options ?? []) !== JSON.stringify(gen.phrasing_options ?? [])
  )
}

// Computed, read-only fields for the GET response — never stored. Purely signals;
// nothing here rewrites content.
//  - angle_sync: per-asset (asset_angles[key] === chosen_angle); an UNSTAMPED
//    asset counts as in-sync so legacy rows don't false-alarm.
//  - customized_slides: slides whose content differs from their `original`
//    snapshot, or that were hand-added (no original).
//  - hook_flags: quiet "reads like generic ad copy" nudges the frontend can show.
//    chosen_angle is flagged only when the coach owns the hook (angle_source
//    'coach'); email subjects only when coach-edited (differ from their original).
//    A true value means a banned shape is present; the coach can accept or ignore.
function computeAngleFields(row: Record<string, unknown>): {
  angle_sync: { current_angle: string; assets: Record<string, boolean>; all_in_sync: boolean }
  customized_slides: number
  customized_emails: number
  customized_script: number
  can_restore: boolean
  hook_flags: {
    chosen_angle: boolean | null
    email_subjects: Array<{ list: string; index: number; banned_shape: boolean }>
  }
} {
  const chosenAngle = typeof row.chosen_angle === 'string' ? row.chosen_angle : ''
  const stamps = (row.asset_angles && typeof row.asset_angles === 'object' ? row.asset_angles : {}) as Record<string, unknown>
  const assets: Record<string, boolean> = {}
  let allInSync = true
  for (const key of ANGLE_SYNC_ASSETS) {
    const stamp = typeof stamps[key] === 'string' ? (stamps[key] as string) : undefined
    const inSync = stamp === undefined || stamp === chosenAngle
    assets[key] = inSync
    if (!inSync) allInSync = false
  }

  // customized_slides compares against the generator-owned gen_snapshot (NOT the
  // editor-owned `original`): a freshly generated slide carries a gen_snapshot
  // equal to its content, so an untouched deck reads 0. A slide the coach edited
  // differs from its snapshot, and a hand-added slide has no snapshot — both count.
  const slides = Array.isArray(row.slides) ? row.slides : []
  const customized = slides.filter(isSlideCustomized).length

  // customized_script: call-script beats edited from, or added without, their
  // gen_snapshot. A freshly generated script reads 0.
  const scriptBeats = Array.isArray(row.sales_script) ? row.sales_script : []
  const customizedScript = scriptBeats.filter(isBeatCustomized).length

  // Email edit-detection + hook_flags in one pass over the three email arrays.
  // customized_emails: subject OR body differs from the as-generated snapshot; an
  // email with no original (legacy rows) counts as not customized. hook_flags:
  // flag-only banned-shape signals for coach-owned hook text.
  const angleSource = typeof row.angle_source === 'string' ? row.angle_source : 'ai'
  const chosenAngleFlag = angleSource === 'coach' ? matchHookShapes(chosenAngle).length > 0 : null
  const emailSubjectFlags: Array<{ list: string; index: number; banned_shape: boolean }> = []
  let customizedEmails = 0
  for (const list of EMAIL_LISTS) {
    const arr = Array.isArray(row[list]) ? (row[list] as unknown[]) : []
    arr.forEach((e, index) => {
      if (isEmailCustomized(e)) customizedEmails++
      const email = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
      const orig = (email.original && typeof email.original === 'object' ? email.original : null) as Record<string, unknown> | null
      if (!orig) return // legacy email with no snapshot — never false-alarm
      const subject = typeof email.subject === 'string' ? email.subject : ''
      // Coach-edited subject: surface whether it trips a banned shape.
      if (subject !== orig.subject) {
        emailSubjectFlags.push({ list, index, banned_shape: matchHookShapes(subject).length > 0 })
      }
    })
  }

  return {
    angle_sync: { current_angle: chosenAngle, assets, all_in_sync: allInSync },
    customized_slides: customized,
    customized_emails: customizedEmails,
    customized_script: customizedScript,
    // A rebuild captures the pre-state; present until a restore clears it (one
    // level of undo). Lets the frontend enable the undo control.
    can_restore: row.pre_rebuild_snapshot != null,
    hook_flags: { chosen_angle: chosenAngleFlag, email_subjects: emailSubjectFlags },
  }
}

// Attach the computed angle-sync fields to a generation row for a GET response.
function withAngleFields<T extends Record<string, unknown>>(row: T): T & ReturnType<typeof computeAngleFields> {
  return { ...row, ...computeAngleFields(row) }
}

// Defensive read-sanitize: rows generated before the em-dash sanitizer (or by any
// path that missed it) still carry clause em-dashes in the AI-generated content
// (objections especially). Clean them on READ so every account renders clean
// without a data backfill — mirrors what bodyFramework does for the framework PDF.
// Phrasing-only, display-only (never written back). Coach-entered `delivery` and
// the raw undo `pre_rebuild_snapshot` are preserved verbatim.
function sanitizeGenRead<T extends Record<string, unknown>>(row: T): T {
  const clean = sanitizePhrasingDeep(row)
  return { ...clean, delivery: row.delivery, pre_rebuild_snapshot: row.pre_rebuild_snapshot }
}

// Persona for the Launch persona tile ("Who it's for"): the coach's user-level
// persona name (avatar_name) plus one curated illustrated portrait from
// public/avatars, chosen from that same identity (see personaSeedFromAudience) so
// the face matches the Audience step. Both are read-only, display-only — never
// persisted. avatar_name is '' when the coach has no named Audience persona yet.
function withAvatar<T extends Record<string, unknown>>(
  row: T,
  seed: string,
  name: string
): T & { avatar_url: string; avatar_name: string } {
  return { ...row, avatar_url: avatarUrlForSeed(seed), avatar_name: name }
}

function parsePersonalHook(raw: unknown): PersonalHook | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const h = raw as Record<string, unknown>
  const hook: PersonalHook = {}
  if (typeof h.opening_story === 'string' && h.opening_story.trim().length > 0) hook.opening_story = h.opening_story.trim()
  if (typeof h.signature_example === 'string' && h.signature_example.trim().length > 0) hook.signature_example = h.signature_example.trim()
  if (typeof h.proof === 'string' && h.proof.trim().length > 0) hook.proof = h.proof.trim()
  return hook.opening_story || hook.signature_example || hook.proof ? hook : undefined
}

function parseCtaType(raw: unknown): CtaType | undefined {
  return raw === 'book_call' || raw === 'sell_program' ? raw : undefined
}

// Recording + authorship inputs are all optional (no duration/format — the video
// is a fixed 15-20 minutes). Always returns an object; presenter_name defaults to
// the coach's account name later. Reads personal_hook/cta_type from ITS input's
// keys, so reading a stored delivery blob (which nests them) reconstructs them —
// the request carries them at the top level and folds them in (see the handler).
function parseDelivery(raw: unknown): DeliveryInput {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const delivery: DeliveryInput = {}
  if (typeof d.presenter_name === 'string' && d.presenter_name.trim().length > 0) delivery.presenter_name = d.presenter_name.trim()
  if (typeof d.soft_cta === 'string' && d.soft_cta.trim().length > 0) delivery.soft_cta = d.soft_cta.trim()
  if (typeof d.call_page_url === 'string' && d.call_page_url.trim().length > 0) delivery.call_page_url = d.call_page_url.trim()
  if (typeof d.sell_page_url === 'string' && d.sell_page_url.trim().length > 0) delivery.sell_page_url = d.sell_page_url.trim()
  const hook = parsePersonalHook(d.personal_hook)
  if (hook) delivery.personal_hook = hook
  const cta = parseCtaType(d.cta_type)
  if (cta) delivery.cta_type = cta
  return delivery
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const card_id = typeof body.card_id === 'string' ? body.card_id : ''
    if (!card_id) return res.status(400).json({ error: 'card_id required' })

    // Choose / swap title — set chosen_topic with NO regeneration (instant
    // relabel). Accepts any topics[].title or free text. Handled before any
    // grounding load since nothing is generated.
    if (typeof body.choose_title === 'string') {
      const title = body.choose_title.trim()
      if (!title) return res.status(400).json({ error: 'choose_title must be a non-empty string' })
      if (!(await requireCapability(userId, 'toolkits', res))) return
      try {
        // Resolve the picked title's angle hook from the stored topics and pin it
        // as chosen_angle, so every later regenerate stays on this angle.
        const { data: cur, error: readErr } = await supabase
          .from('mtm_generations')
          .select('topics')
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .maybeSingle()
        if (readErr) throw readErr
        if (!cur) return res.status(404).json({ error: 'No generation for this card yet' })
        // If the picked title matches a stored topic, pin that topic's hook too.
        // If it's a free-text reword (no match), set the title only and LEAVE the
        // existing chosen_angle untouched — never clear the hook with an empty ''.
        const resolvedAngle = resolveAngle(Array.isArray(cur.topics) ? (cur.topics as MtTopic[]) : [], title)
        const titleUpdate: Record<string, unknown> = { chosen_topic: title, updated_at: new Date().toISOString() }
        // Picking one of the AI-suggested titles pins that topic's AI angle;
        // typing a custom title (no match) is the coach owning the hook, so mark
        // it 'coach' and leave the existing chosen_angle untouched. Coach-owned
        // hooks are then excluded from the banned-shape auto-repair.
        if (resolvedAngle.trim().length > 0) {
          titleUpdate.chosen_angle = resolvedAngle
          titleUpdate.angle_source = 'ai'
        } else {
          titleUpdate.angle_source = 'coach'
        }
        const { data, error } = await supabase
          .from('mtm_generations')
          .update(titleUpdate)
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .maybeSingle()
        if (error) throw error
        if (!data) return res.status(404).json({ error: 'No generation for this card yet' })
        return res.status(200).json(data)
      } catch (err) {
        console.error('[generate] POST choose_title', err)
        return res.status(500).json({ error: 'Failed to set title' })
      }
    }

    // Approve a wizard step — flip its flag in the build_steps jsonb (read →
    // merge → write) so the Build progress rail advances. No regeneration. One of
    // angle | slides | emails | script | objections.
    if (typeof body.approve_step === 'string') {
      const step = body.approve_step.trim()
      if (!VALID_BUILD_STEPS.has(step)) {
        return res.status(400).json({ error: `approve_step must be one of: ${[...VALID_BUILD_STEPS].join(', ')}` })
      }
      if (!(await requireCapability(userId, 'toolkits', res))) return
      try {
        const { data: cur, error: readErr } = await supabase
          .from('mtm_generations')
          .select('build_steps')
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .maybeSingle()
        if (readErr) throw readErr
        if (!cur) return res.status(404).json({ error: 'No generation for this card yet' })
        const existingSteps = (cur.build_steps && typeof cur.build_steps === 'object' ? cur.build_steps : {}) as Record<string, unknown>
        const build_steps = { ...existingSteps, [step]: { approved: true, approved_at: new Date().toISOString() } }
        const { data, error } = await supabase
          .from('mtm_generations')
          .update({ build_steps, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .maybeSingle()
        if (error) throw error
        if (!data) return res.status(404).json({ error: 'No generation for this card yet' })
        return res.status(200).json(data)
      } catch (err) {
        console.error('[generate] POST approve_step', err)
        return res.status(500).json({ error: 'Failed to approve step' })
      }
    }

    // Inline-edit SAVE — persist the coach's manual edits to an EXISTING
    // generation. No LLM call. delivery is left untouched and sync_snapshot is NOT
    // re-stamped: a manual edit is the coach's own change, not a rebuild from
    // upstream, so staleness must not move. Only the recognized editable keys
    // present in body.save are written, each through its matching coercer.
    if (body.save && typeof body.save === 'object') {
      if (!(await requireCapability(userId, 'toolkits', res))) return
      const save = body.save as Record<string, unknown>
      const update: Record<string, unknown> = {}

      // Guard: email bodies are canonical text (plain text + link tokens +
      // lightweight markers). Reject any that arrive as RENDERED HTML — a past
      // frontend regression once flattened tokens to <a href="#"> and stored the
      // DOM verbatim, permanently corrupting the email. This can't recover an
      // already-flattened token, so its job is to stop a future regression from
      // silently corrupting stored emails again — fail loudly and log.
      for (const listName of ['emails', 'warm_invite_emails', 'book_a_call_emails'] as const) {
        if (!(listName in save)) continue
        const arr = Array.isArray(save[listName]) ? (save[listName] as unknown[]) : []
        for (let idx = 0; idx < arr.length; idx++) {
          const em = (arr[idx] && typeof arr[idx] === 'object' ? arr[idx] : {}) as Record<string, unknown>
          if (emailBodyHasRawHtml(em.body)) {
            console.error(`[generate] rejected rendered-HTML email body on save (list=${listName}, index=${idx}, user=${userId}, card=${card_id})`)
            return res.status(400).json({ error: 'Email body must be plain text with formatting markers, not HTML. Please retry from the editor.' })
          }
        }
      }

      if ('slides' in save) update.slides = coerceSlides(save.slides)
      if ('warm_invite_emails' in save) update.warm_invite_emails = coerceEmails(save.warm_invite_emails)
      if ('emails' in save) update.emails = coerceEmails(save.emails)
      if ('book_a_call_emails' in save) update.book_a_call_emails = coerceEmails(save.book_a_call_emails)
      if ('workbook' in save) update.workbook = coerceWorkbook(save.workbook)
      if ('recording_tips' in save) update.recording_tips = coerceRecordingTips(save.recording_tips)
      if ('outline' in save) update.outline = coerceOutline(save.outline)
      if ('topics' in save) update.topics = coerceTopics(save.topics)
      if ('sales_script' in save) update.sales_script = coerceSalesScript(save.sales_script)
      if ('objections' in save) update.objections = coerceObjections(save.objections)
      if ('angle_previews' in save) update.angle_previews = coerceAnglePreviews(save.angle_previews)
      if ('subtitle' in save) update.subtitle = typeof save.subtitle === 'string' ? save.subtitle.trim() : ''
      if ('chosen_topic' in save) {
        const t = typeof save.chosen_topic === 'string' ? save.chosen_topic.trim() : ''
        if (!t) return res.status(400).json({ error: 'chosen_topic cannot be empty' })
        update.chosen_topic = t
      }
      // Apply chosen_angle only when the request sends a non-empty string — never
      // clear a good hook with ''. An inline angle edit is the coach writing their
      // own hook, so mark it 'coach' — that hook is then never auto-rewritten.
      if (typeof save.chosen_angle === 'string' && save.chosen_angle.trim().length > 0) {
        update.chosen_angle = save.chosen_angle
        update.angle_source = 'coach'
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'save had no editable fields' })
      }
      update.updated_at = new Date().toISOString()

      try {
        // Airtight undo: a genuine content edit after a rebuild invalidates the one-step
        // undo (restoring would wipe the new edit). Clear the pre-rebuild snapshot when any
        // written field actually changes. angle_source and updated_at are not content, so a
        // no-op autosave (identical content) leaves undo intact.
        const contentKeys = Object.keys(update).filter((k) => k !== 'updated_at' && k !== 'angle_source')
        if (contentKeys.length > 0) {
          const { data: cur, error: readErr } = await supabase
            .from('mtm_generations')
            .select(['pre_rebuild_snapshot', ...contentKeys].join(','))
            .eq('user_id', userId)
            .eq('card_id', card_id)
            .maybeSingle()
          if (readErr) throw readErr
          const row = cur as unknown as Record<string, unknown> | null
          if (row && row.pre_rebuild_snapshot != null) {
            const changed = contentKeys.some((k) => canonicalJson(row[k]) !== canonicalJson(update[k]))
            if (changed) update.pre_rebuild_snapshot = null
          }
        }

        const { data, error } = await supabase
          .from('mtm_generations')
          .update(update)
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .maybeSingle()
        if (error) throw error
        if (!data) return res.status(404).json({ error: 'No generation to edit — generate first' })
        return res.status(200).json(data)
      } catch (err) {
        console.error('[generate] POST save', err)
        return res.status(500).json({ error: 'Failed to save edits' })
      }
    }

    // A regenerate request rebuilds ONE asset conditioned on the current
    // chosen_topic and reuses the stored delivery. A full generate takes optional
    // recording details in the body (no content).
    const regenerate = typeof body.regenerate === 'string' ? body.regenerate : null
    const keepTitle = body.keep_title === true

    let delivery: DeliveryInput | null = null
    if (regenerate) {
      if (!REGEN_TARGETS.has(regenerate)) {
        return res.status(400).json({
          error: `regenerate must be one of: ${[...REGEN_TARGETS].join(', ')}`,
        })
      }
    } else {
      // Optional recording details only — { presenter_name?, soft_cta?, call_page_url? }.
      delivery = parseDelivery(body.delivery)
    }

    // Capability gate — toolkits require beta/full (admin bypasses).
    if (!(await requireCapability(userId, 'toolkits', res))) return

    try {
      const blueprintGate = await getValidatedBlueprint(userId, card_id)
      if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

      const frameworkGate = await checkFrameworkConfirmed(userId)
      if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

      const [audienceRow, transformationRow, existingRow, userRow, voiceContext] = await Promise.all([
        getSavedOutput(userId, 'audience'),
        getSavedOutput(userId, 'transformation'),
        supabase
          .from('mtm_generations')
          // Full row: the rebuild/restore actions need every asset column plus
          // pre_rebuild_snapshot; the regenerate/full-generate paths read a subset.
          .select('*')
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .maybeSingle(),
        supabase.from('users').select('name').eq('id', userId).maybeSingle(),
        getVoiceContext(userId),
      ])
      const existing = existingRow.data
      // presenter_name defaults to the coach's account name when not supplied.
      const accountName = typeof userRow.data?.name === 'string' ? userRow.data.name.trim() : ''
      const withPresenter = (dv: DeliveryInput): DeliveryInput =>
        dv.presenter_name || !accountName ? dv : { ...dv, presenter_name: accountName }

      const baseInputs: Omit<GeneratorInputs, 'delivery'> = {
        audience: audienceRow ? stripSessionHistory(audienceRow.content) : null,
        transformation: transformationRow ? stripSessionHistory(transformationRow.content) : null,
        framework: {
          frameworkName: frameworkGate.framework.frameworkName,
          frameworkTagline: frameworkGate.framework.frameworkTagline,
          phases: frameworkGate.framework.phases,
        },
        card: {
          id: blueprintGate.card.id,
          card_name: blueprintGate.card.card_name,
          problem_text: blueprintGate.card.problem_text,
          reasoning: blueprintGate.card.reasoning,
          suggested_offer: blueprintGate.card.suggested_offer,
        },
        voiceContext,
      }

      // ── Add one slide ── generate ONE polished slide from a coach personalize
      // input and return it; never touches the stored deck (the editor inserts +
      // saves it). Uses the same grounding the slides unit does.
      if (body.add_slide && typeof body.add_slide === 'object') {
        const add = body.add_slide as Record<string, unknown>
        const kind = add.kind
        const text = typeof add.text === 'string' ? add.text.trim() : ''
        if (kind !== 'proof' && kind !== 'opening_story' && kind !== 'signature_example') {
          return res.status(400).json({ error: 'add_slide.kind must be one of: proof, opening_story, signature_example' })
        }
        if (!text) return res.status(400).json({ error: 'add_slide.text required' })
        const inputs: GeneratorInputs = { ...baseInputs, delivery: withPresenter(parseDelivery(existing?.delivery)) }
        const slide = await generateSingleSlide(userId, kind as SingleSlideKind, text, inputs)
        return res.status(200).json({ ok: true, slide })
      }

      // ── Regenerate one asset ── conditioned on the stored chosen_topic +
      // delivery, writing back only that asset's column(s).
      if (regenerate) {
        if (!existing) return res.status(404).json({ error: 'No generation to regenerate — run a full generate first' })
        const chosenTopic = typeof existing.chosen_topic === 'string' ? existing.chosen_topic : ''
        // The angle every regenerated asset stays inside: the stored chosen_angle,
        // or (interim, for rows saved before it existed) resolved from the topics.
        const storedAngle = typeof existing.chosen_angle === 'string' ? existing.chosen_angle : ''
        const chosenAngle = storedAngle.trim().length > 0
          ? storedAngle
          : resolveAngle(Array.isArray(existing.topics) ? (existing.topics as MtTopic[]) : [], chosenTopic)

        // Mirror the full-generate path: personalize inputs (opening_story /
        // signature_example / proof) may arrive at the top level of the request
        // (the Slides editor's "Apply & rebuild"). When present, fold them over
        // the stored delivery so the regenerated asset reflects them; otherwise
        // use the stored delivery exactly as before.
        const storedDelivery = parseDelivery(existing.delivery)
        const reqHook = parsePersonalHook(body.personal_hook)
        const resolvedDelivery = withPresenter({
          ...storedDelivery,
          personal_hook: reqHook ?? storedDelivery.personal_hook,
        })
        const inputs: GeneratorInputs = { ...baseInputs, delivery: resolvedDelivery }

        const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
        // Persist the new personalize inputs only when the request actually
        // provided them, so a plain regenerate never rewrites stored delivery.
        if (reqHook) update.delivery = resolvedDelivery
        switch (regenerate) {
          case 'slides':
            update.slides = stampSlideGenSnapshots(await scrubSlideCoverHook(userId, (await regenerateAsset(userId, 'slides', inputs, chosenTopic, chosenAngle)).slides ?? [], chosenTopic, baseInputs.audience))
            break
          case 'warm_invite':
            update.warm_invite_emails = stampEmailOriginals(await scrubEmailSubjectHooks(userId, (await regenerateAsset(userId, 'warm_invite', inputs, chosenTopic, chosenAngle)).warm_invite_emails ?? [], chosenTopic, baseInputs.audience))
            break
          case 'emails':
            update.emails = stampEmailOriginals(await scrubEmailSubjectHooks(userId, (await regenerateAsset(userId, 'emails', inputs, chosenTopic, chosenAngle)).emails ?? [], chosenTopic, baseInputs.audience))
            break
          case 'book_a_call':
            update.book_a_call_emails = stampEmailOriginals(await scrubEmailSubjectHooks(userId, (await regenerateAsset(userId, 'book_a_call', inputs, chosenTopic, chosenAngle)).book_a_call_emails ?? [], chosenTopic, baseInputs.audience))
            break
          case 'workbook':
            update.workbook = (await regenerateAsset(userId, 'workbook', inputs, chosenTopic, chosenAngle)).workbook
            break
          case 'recording_tips':
            update.recording_tips = (await regenerateAsset(userId, 'recording_tips', inputs, chosenTopic, chosenAngle)).recording_tips
            break
          case 'topics':
            update.topics = await scrubTopicHooks(userId, (await regenerateAsset(userId, 'meta', inputs, chosenTopic, chosenAngle)).topics ?? [], chosenTopic, baseInputs.audience)
            break
          case 'outline':
            update.outline = (await regenerateAsset(userId, 'meta', inputs, chosenTopic, chosenAngle)).outline
            break
          case 'script': {
            const cur = Array.isArray(existing.slides) ? (existing.slides as MtSlide[]) : []
            update.slides = stampSlideGenSnapshots(await regenerateScript(userId, inputs, cur, chosenTopic, chosenAngle))
            break
          }
          case 'sales_script':
            update.sales_script = stampScriptGenSnapshots((await regenerateAsset(userId, 'sales_script', inputs, chosenTopic, chosenAngle)).sales_script ?? [])
            break
          case 'objections':
            update.objections = (await regenerateAsset(userId, 'objections', inputs, chosenTopic, chosenAngle)).objections
            break
          case 'angle_previews': {
            const topics = Array.isArray(existing.topics) ? (existing.topics as MtTopic[]) : []
            update.angle_previews = await generateAnglePreviews(userId, inputs, chosenTopic, topics)
            break
          }
        }
        // Rebuilding the slides re-stamps the 'slides' staleness snapshot.
        if (regenerate === 'slides' || regenerate === 'script') {
          update.sync_snapshot = await stampSyncSnapshot(userId, 'slides', card_id)
        }
        // Stamp this asset with the angle it was just regenerated on — merge into
        // the stored map so the other assets' stamps are untouched.
        const regenKey = REGEN_ANGLE_KEY[regenerate]
        if (regenKey) {
          const stored = (existing.asset_angles && typeof existing.asset_angles === 'object' ? existing.asset_angles : {}) as Record<string, unknown>
          update.asset_angles = { ...stored, [regenKey]: chosenAngle }
        }

        const { data, error } = await supabase
          .from('mtm_generations')
          .update(update)
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .single()
        if (error) throw error
        return res.status(200).json(withAngleFields(data))
      }

      // ── Restore ── one level of undo: put the assets (and angle identity) back
      // to the pre-rebuild snapshot and clear it. 400 when there is nothing stored.
      if (body.restore_snapshot === true) {
        if (!existing) return res.status(404).json({ error: 'No generation to restore' })
        const snap = existing.pre_rebuild_snapshot
        if (snap == null || typeof snap !== 'object') {
          return res.status(400).json({ error: 'nothing to restore' })
        }
        const s = snap as Record<string, unknown>
        const update: Record<string, unknown> = { pre_rebuild_snapshot: null, updated_at: new Date().toISOString() }
        for (const col of REBUILD_SNAPSHOT_COLUMNS) {
          if (!(col in s)) continue
          // asset_angles / angle_source are NOT NULL — coalesce to their defaults.
          if (col === 'asset_angles') update[col] = s[col] && typeof s[col] === 'object' ? s[col] : {}
          else if (col === 'angle_source') update[col] = typeof s[col] === 'string' ? s[col] : 'ai'
          else update[col] = s[col]
        }
        const { data, error } = await supabase
          .from('mtm_generations')
          .update(update)
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .single()
        if (error) throw error
        return res.status(200).json(withAngleFields(data))
      }

      // ── Scoped rebuild ── re-sync assets to the CURRENT chosen_angle.
      // rebuild: { scope: 'all' | 'keep_edited' }. Each target asset is
      // regenerated on the pinned current topic + angle via the same per-unit
      // helpers the single regenerate uses, so chosen_angle is an INPUT and is
      // never rewritten (coach-hook protection holds automatically). The pre-state
      // is captured for one level of undo. If any unit throws, nothing is written.
      if (body.rebuild && typeof body.rebuild === 'object') {
        if (!existing) return res.status(404).json({ error: 'No generation to rebuild — run a full generate first' })
        const scope = (body.rebuild as Record<string, unknown>).scope
        if (scope !== 'all' && scope !== 'keep_edited') {
          return res.status(400).json({ error: "rebuild.scope must be 'all' or 'keep_edited'" })
        }

        const chosenTopic = typeof existing.chosen_topic === 'string' ? existing.chosen_topic : ''
        const storedAngle = typeof existing.chosen_angle === 'string' ? existing.chosen_angle : ''
        const chosenAngle = storedAngle.trim().length > 0
          ? storedAngle
          : resolveAngle(Array.isArray(existing.topics) ? (existing.topics as MtTopic[]) : [], chosenTopic)
        const inputs: GeneratorInputs = { ...baseInputs, delivery: withPresenter(parseDelivery(existing.delivery)) }

        // Each rebuildable asset, keyed by its asset_angles key, with its column
        // and how to regenerate it on the pinned angle (the single-regenerate calls).
        const rebuildTasks: Record<string, { column: string; run: () => Promise<unknown> }> = {
          slides: { column: 'slides', run: async () => stampSlideGenSnapshots(await scrubSlideCoverHook(userId, (await regenerateAsset(userId, 'slides', inputs, chosenTopic, chosenAngle)).slides ?? [], chosenTopic, baseInputs.audience)) },
          warm_invite: { column: 'warm_invite_emails', run: async () => stampEmailOriginals(await scrubEmailSubjectHooks(userId, (await regenerateAsset(userId, 'warm_invite', inputs, chosenTopic, chosenAngle)).warm_invite_emails ?? [], chosenTopic, baseInputs.audience)) },
          emails: { column: 'emails', run: async () => stampEmailOriginals(await scrubEmailSubjectHooks(userId, (await regenerateAsset(userId, 'emails', inputs, chosenTopic, chosenAngle)).emails ?? [], chosenTopic, baseInputs.audience)) },
          book_a_call: { column: 'book_a_call_emails', run: async () => stampEmailOriginals(await scrubEmailSubjectHooks(userId, (await regenerateAsset(userId, 'book_a_call', inputs, chosenTopic, chosenAngle)).book_a_call_emails ?? [], chosenTopic, baseInputs.audience)) },
          sales_script: { column: 'sales_script', run: async () => stampScriptGenSnapshots((await regenerateAsset(userId, 'sales_script', inputs, chosenTopic, chosenAngle)).sales_script ?? []) },
          objections: { column: 'objections', run: async () => (await regenerateAsset(userId, 'objections', inputs, chosenTopic, chosenAngle)).objections },
          workbook: { column: 'workbook', run: async () => (await regenerateAsset(userId, 'workbook', inputs, chosenTopic, chosenAngle)).workbook },
          outline: { column: 'outline', run: async () => (await regenerateAsset(userId, 'meta', inputs, chosenTopic, chosenAngle)).outline },
        }

        // keep_edited drops the editable assets the coach customized (they stay,
        // still out-of-sync — the coach chose to keep them). The remaining
        // non-editable assets (guide, objections, outline) are always rebuilt.
        const isKept = (key: string): boolean => {
          if (scope !== 'keep_edited') return false
          if (key === 'slides') return Array.isArray(existing.slides) && (existing.slides as unknown[]).some(isSlideCustomized)
          if (key === 'warm_invite') return emailSetCustomized(existing.warm_invite_emails)
          if (key === 'emails') return emailSetCustomized(existing.emails)
          if (key === 'book_a_call') return emailSetCustomized(existing.book_a_call_emails)
          if (key === 'sales_script') return Array.isArray(existing.sales_script) && (existing.sales_script as unknown[]).some(isBeatCustomized)
          return false
        }
        const targets = (ANGLE_SYNC_ASSETS as readonly string[]).filter((k) => !isKept(k))

        // Regenerate every target concurrently. If any throws, the whole rebuild
        // aborts (outer catch) and NOTHING is written — coach data untouched.
        const rebuilt = await Promise.all(
          targets.map(async (key) => ({ key, column: rebuildTasks[key].column, value: await rebuildTasks[key].run() }))
        )

        // Capture the pre-rebuild state for one level of undo.
        const pre_rebuild_snapshot: Record<string, unknown> = {}
        for (const col of REBUILD_SNAPSHOT_COLUMNS) {
          pre_rebuild_snapshot[col] = (existing as Record<string, unknown>)[col] ?? null
        }

        const update: Record<string, unknown> = { updated_at: new Date().toISOString(), pre_rebuild_snapshot }
        const storedStamps = (existing.asset_angles && typeof existing.asset_angles === 'object' ? existing.asset_angles : {}) as Record<string, unknown>
        const newStamps: Record<string, unknown> = { ...storedStamps }
        for (const r of rebuilt) {
          update[r.column] = r.value
          newStamps[r.key] = chosenAngle // rebuilt asset now sits on the current angle
        }
        update.asset_angles = newStamps
        // Rebuilding the deck re-stamps the slides staleness snapshot too.
        if (targets.includes('slides')) update.sync_snapshot = await stampSyncSnapshot(userId, 'slides', card_id)

        const { data, error } = await supabase
          .from('mtm_generations')
          .update(update)
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .single()
        if (error) throw error
        return res.status(200).json(withAngleFields(data))
      }

      // ── Full generate ──
      // Authorship inputs (personal_hook, cta_type) arrive at the top level of
      // the request. Fold them into the delivery blob so they persist and the
      // studio reloads them; when omitted, fall back to the stored values.
      const stored = parseDelivery(existing?.delivery)
      const reqHook = parsePersonalHook(body.personal_hook)
      const reqCta = parseCtaType(body.cta_type)
      const resolvedDelivery = withPresenter({
        ...delivery!,
        personal_hook: reqHook ?? stored.personal_hook,
        cta_type: reqCta ?? stored.cta_type ?? 'book_call',
      })
      const inputs: GeneratorInputs = { ...baseInputs, delivery: resolvedDelivery }

      // keep_title pins the coach's chosen title AND its angle hook, so the whole
      // training is generated on that angle rather than the meta unit's fresh pick.
      // The stored chosen_angle wins; interim fallback resolves it from the topics.
      const existingChosen = (existing?.chosen_topic ?? '') as string
      const pinned =
        keepTitle && existingChosen.trim().length > 0
          ? {
              chosen_topic: existingChosen,
              chosen_angle:
                typeof existing?.chosen_angle === 'string' && existing.chosen_angle.trim().length > 0
                  ? existing.chosen_angle
                  : resolveAngle(Array.isArray(existing?.topics) ? (existing!.topics as MtTopic[]) : [], existingChosen),
            }
          : undefined
      // When keep_title pins a coach-authored angle, carry that authorship into
      // the rebuild: the coach's hook is preserved (excluded from the banned-shape
      // auto-repair) and the row stays flagged 'coach'. A fresh generate, or a
      // pinned AI angle, is 'ai'.
      const angleSource: 'ai' | 'coach' =
        keepTitle &&
        existing?.angle_source === 'coach' &&
        typeof existing?.chosen_angle === 'string' &&
        existing.chosen_angle.trim().length > 0
          ? 'coach'
          : 'ai'
      const generated = await generateMicroTraining(userId, inputs, pinned, angleSource)
      // generateMicroTraining returns the effective (pinned-aware) title + angle.
      const chosen_topic = generated.chosen_topic
      // Never overwrite a good stored angle with an empty one — keep the previous
      // value if the fresh generation somehow came back without a hook.
      const storedAngle = typeof existing?.chosen_angle === 'string' ? existing.chosen_angle : ''
      const chosen_angle = generated.chosen_angle.trim().length > 0 ? generated.chosen_angle : storedAngle

      // A full generate builds the slides, so it stamps the 'slides' staleness snapshot.
      const sync_snapshot = await stampSyncSnapshot(userId, 'slides', card_id)

      // A full generate builds every downstream asset on the effective angle, so
      // stamp them all with it. This makes the whole training read as in-sync
      // until the coach picks a different angle or regenerates a single asset.
      const asset_angles = Object.fromEntries(ANGLE_SYNC_ASSETS.map((k) => [k, chosen_angle]))

      const { data, error } = await supabase
        .from('mtm_generations')
        .upsert(
          {
            user_id: userId,
            card_id,
            topics: generated.topics,
            chosen_topic,
            chosen_angle,
            subtitle: generated.subtitle,
            total_duration: generated.total_duration,
            outline: generated.outline,
            slides: generated.slides,
            workbook: generated.workbook,
            warm_invite_emails: generated.warm_invite_emails,
            emails: generated.emails,
            book_a_call_emails: generated.book_a_call_emails,
            recording_tips: generated.recording_tips,
            sales_script: generated.sales_script,
            objections: generated.objections,
            angle_previews: generated.angle_previews,
            delivery: resolvedDelivery,
            sync_snapshot,
            asset_angles,
            angle_source: angleSource,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,card_id' }
        )
        .select()
        .single()

      if (error) throw error
      return res.status(200).json(withAngleFields(data))
    } catch (err) {
      if (err instanceof GenerationParseError) {
        console.error('[generate] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
        return res.status(502).json({ error: 'generation_truncated' })
      }
      console.error('[generate] POST', err)
      return res.status(500).json({ error: 'Generation failed' })
    }
  }

  if (req.method === 'GET') {
    const rawId = req.query && req.query.id
    const id = Array.isArray(rawId) ? rawId[0] : rawId

    // Persona is user-level (one Audience persona per coach), so resolve it once
    // from the coach's saved Audience — the same name + face the Audience step
    // shows. Best-effort: a missing/failed audience read falls back to userId for
    // the seed and an empty persona name.
    let personaSeed = userId
    let personaName = ''
    try {
      const audienceRow = await getSavedOutput(userId, 'audience')
      personaSeed = personaSeedFromAudience(audienceRow?.content, userId)
      const content = audienceRow?.content as Record<string, unknown> | null | undefined
      personaName =
        content && typeof content.avatar_name === 'string' ? content.avatar_name.trim() : ''
    } catch {
      /* keep userId seed + empty name fallback */
    }

    // GET with id — return a single generation (must belong to the user)
    if (id && typeof id === 'string') {
      try {
        const { data, error } = await supabase
          .from('mtm_generations')
          .select('*')
          .eq('id', id)
          .eq('user_id', userId)
          .maybeSingle()

        if (error) throw error
        if (!data) return res.status(404).json({ error: 'Generation not found' })
        // beat_teaching is the static, universal per-beat coaching copy; the
        // frontend renders each slide's note from beat_teaching[slide.sectionName].
        return res.status(200).json({ ...withAvatar(withAngleFields(sanitizeGenRead(data)), personaSeed, personaName), beat_teaching: BEAT_TEACHING })
      } catch (err) {
        console.error('[generate] GET one', err)
        return res.status(500).json({ error: 'Failed to load generation' })
      }
    }

    // GET with card_id — return the canonical generation row for that card.
    const rawCardId = req.query && req.query.card_id
    const cardId = Array.isArray(rawCardId) ? rawCardId[0] : rawCardId
    if (cardId && typeof cardId === 'string') {
      try {
        const { data, error } = await supabase
          .from('mtm_generations')
          .select('*')
          .eq('card_id', cardId)
          .eq('user_id', userId)
          .maybeSingle()

        if (error) throw error
        // beat_teaching is the static, universal per-beat coaching copy; the
        // frontend renders each slide's note from beat_teaching[slide.sectionName].
        return res.status(200).json(data ? { ...withAvatar(withAngleFields(sanitizeGenRead(data)), personaSeed, personaName), beat_teaching: BEAT_TEACHING } : null)
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
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (error) throw error

      const rows = (data || []).map((r: any) => {
        const { problem_solution_cards, ...rest } = r
        return withAngleFields({ ...rest, card_name: problem_solution_cards?.card_name ?? null })
      })

      return res.status(200).json(rows)
    } catch (err) {
      console.error('[generate] GET list', err)
      return res.status(500).json({ error: 'Failed to load generations' })
    }
  }

  return res.status(405).end()
}
