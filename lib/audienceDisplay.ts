import { genderFromName, AvatarGender, avatarUrlForSeed, personaSeedFromAudience } from './avatars'

// The audience profile's DISPLAY subset, and the read-time application of it.
//
// WHY THIS LIVES IN lib/ RATHER THAN api/tools/chat.ts, where it used to. Every
// reader that hands a profile to a UI needs it, and chat.ts constructs an
// Anthropic client at module scope — so importing it from a light read endpoint
// would drag the SDK in for the sake of a pure function. Moved here so
// api/tools/saved.ts and anything after it can derive without that cost.
// chat.ts re-exports deriveAudienceDisplayFields, so its own callers are
// unaffected.

// The audience <data> block carries the full raw fields the model naturally
// produces (who_they_are, perceived_problem, tried_before, ...) — that raw
// object is the canonical saved record, consumed directly by the Funnel
// Builder's MTM Adapter. The report panel only knows how to render a
// narrower shape (painPoints/fearsAndDoubts/objections/dreamOutcome), so we
// derive that display subset deterministically here rather than asking the
// model to emit two parallel schemas, and merge it into the same object —
// nothing about the raw fields is dropped.
// Exported so api/tools/results.ts derives the same display subset
// (painPoints/fearsAndDoubts/objections/... camelCase aliases) on the finalized
// audience profile that the incremental chat derives on each turn — one source
// of truth for the report panel's shape. Additive export only.
export function deriveAudienceDisplayFields(
  raw: Record<string, unknown>,
  userId?: string
): Record<string, unknown> {
  const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null)
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []

  // painPoints/fearsAndDoubts now come from the model's own inferred
  // pain_points/fears_and_doubts arrays — EXACTLY 5 rich entries each, where
  // every entry fuses the pain/fear itself with WHY it exists for this specific
  // person (same one-rich-string pattern as sales_objections). We fall back to
  // the older scalar-derived pair (perceived_problem/real_problem and
  // emotional_state/internal_dialogue) for early turns, before the analysis
  // fields have been inferred, so the cards still populate progressively.
  const painPointsRich = asStringArray(raw.pain_points)
  const painPoints =
    painPointsRich.length > 0
      ? painPointsRich
      : [asString(raw.perceived_problem), asString(raw.real_problem)].filter((v): v is string => v !== null)
  const fearsRich = asStringArray(raw.fears_and_doubts)
  const fearsAndDoubts =
    fearsRich.length > 0
      ? fearsRich
      : [asString(raw.emotional_state), asString(raw.internal_dialogue)].filter((v): v is string => v !== null)
  const dreamOutcome = asString(raw.dream_outcome)
  const avatarName = asString(raw.avatar_name)
  // Implied gender of the persona, used to pick a gender-matched avatar. Prefer the
  // model's own avatar_gender when it emits a valid value; otherwise backfill from
  // the persona's first name. Unisex/made-up/non-names resolve to 'neutral' — never
  // guess. Persisted on the profile so reads don't have to re-derive.
  const rawGender = asString(raw.avatar_gender)?.toLowerCase()
  const avatarGender: AvatarGender =
    rawGender === 'feminine' || rawGender === 'masculine' || rawGender === 'neutral'
      ? rawGender
      : genderFromName(avatarName || '')
  const problemStatement = asString(raw.problem_statement)

  // The avatar hero's six. These had no camelCase alias, so the panel's choices
  // were to thin the hero or to read raw snake_case keys directly — and reading
  // raw keys is how a second renderer starts, drifting from the one
  // api/tools/results.ts uses. One renderer, so they are derived here.
  //
  // ALL SIX ARE STRAIGHT CAMELISATIONS, deliberately. Four of the existing
  // nineteen are not — buyingDecisions, pastAttempts, motivatingStatements,
  // turnAwayStatements — and that is exactly what nearly cost four blank cards,
  // because a reasonable person camelises the raw key and gets undefined. There
  // was no reason to rename any of these, so none is renamed: whoTheyAre,
  // theirWorld, emotionalState, internalDialogue, triggeringMoment, whyItFailed.
  //
  // emotionalState and internalDialogue also feed the fearsAndDoubts fallback
  // above. That is not duplication to collapse — the fallback is a degraded
  // early-turn shape for a different card, and these are the hero's own fields.
  const whoTheyAre = asString(raw.who_they_are)
  const theirWorld = asString(raw.their_world)
  const emotionalState = asString(raw.emotional_state)
  const internalDialogue = asString(raw.internal_dialogue)
  const triggeringMoment = asString(raw.triggering_moment)
  const whyItFailed = asString(raw.why_it_failed)
  // camelCase aliases for The Gap card. The model emits these as snake_case
  // (perceived_problem/real_problem) and they always have — but the Gap-card UI
  // reads output.perceivedProblem / output.realProblem, so the raw snake_case
  // keys never matched and the card rendered blank. The snake_case keys stay in
  // the record (via ...parsed) for the Funnel Builder's MTM Adapter; these are
  // additive camelCase copies the frontend can actually read.
  const perceivedProblem = asString(raw.perceived_problem)
  const realProblem = asString(raw.real_problem)
  // Short synthesis that frames the Pain Points / Fears cards — sums up what
  // this person is going through emotionally/practically and how to connect
  // with them. Inferred like dream_outcome, never asked directly.
  const connectionSummary = asString(raw.connection_summary)

  // New inferred insight layer — all synthesized from the conversation the same
  // way dream_outcome/avatar_name are, never asked as direct questions.
  // gapInsight is the tool's signature moment: it names WHY the gap between
  // perceived_problem and real_problem keeps this person stuck, so the coach
  // reading it about their own client feels the same "someone described my
  // problem better than I could" jolt the client feels in the conversation.
  const gapInsight = asString(raw.gap_insight)
  // Targeted subsets of the audience's own language — distinct from the
  // untouched language_they_use. languageProblem is their words for THE PROBLEM;
  // languageSolution is their words for what THEY THINK would fix it (their
  // imagined fix, which often won't match real_problem — that mismatch is itself
  // the insight).
  const languageProblem = asStringArray(raw.language_problem)
  const languageSolution = asStringArray(raw.language_solution)
  // 2-3 lightweight alternate framings of the core problem. Each is an object:
  // reframe (an alternate diagnostic angle, a genuine "you might think it's X,
  // but it could also be Y") plus a single-sentence monetization_hint teasing
  // that the angle could anchor its own Micro-Training. Kept deliberately shallow
  // — no urgency scoring, offer suggestions, or deep reasoning — so the Monetize
  // tool's later deep pass over the same territory doesn't feel redundant.
  //
  // Salvage, not all-or-nothing: the previous version required BOTH reframe and
  // monetization_hint on every entry and dropped the ENTIRE field if a single
  // entry (or a key-name/shape drift) failed, so one near-miss silently erased
  // the whole "Other Angles" card. Now each entry is salvaged independently:
  // accept common key-name drifts, accept a bare string as a reframe, keep an
  // entry as long as it carries the core content (the reframe) even if the hint
  // is missing, and only drop entries that have no usable reframe at all.
  // Output shape carries BOTH key spellings for the hint: the Gap-card UI reads
  // angle.monetizationHint (camelCase), while monetization_hint (snake_case) is
  // kept for the raw record / any snake_case consumer. reframe already matched
  // the UI, so it needs no alias.
  type Angle = { reframe: string; monetization_hint: string; monetizationHint: string }
  const asAngle = (a: unknown): Angle | null => {
    // A bare string entry (model flattened the array) → treat as the reframe.
    if (typeof a === 'string') {
      const r = a.trim()
      return r.length > 0 ? { reframe: r, monetization_hint: '', monetizationHint: '' } : null
    }
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return null
    const obj = a as Record<string, unknown>
    // Accept the documented key plus plausible near-miss aliases the model drifts to.
    const reframe = asString(obj.reframe) ?? asString(obj.angle) ?? asString(obj.reframing)
    const hint =
      asString(obj.monetization_hint) ??
      asString(obj.monetizationHint) ??
      asString(obj.monetization) ??
      asString(obj.hint) ??
      ''
    // Keep the entry if it has the core content; a hint with no reframe has
    // nothing to render, so it is dropped.
    return reframe !== null ? { reframe, monetization_hint: hint, monetizationHint: hint } : null
  }
  // Accept an array (normal) or a single object the model forgot to wrap.
  const rawAngles = Array.isArray(raw.other_angles)
    ? raw.other_angles
    : raw.other_angles && typeof raw.other_angles === 'object'
      ? [raw.other_angles]
      : []
  const otherAngles = rawAngles.map(asAngle).filter((a): a is Angle => a !== null)
  // One closing insight previewing the kind of Micro-Training this audience is
  // primed for — closes the Audience report and hands off toward Monetize.
  const monetizeBridge = asString(raw.monetize_bridge)

  // objections comes from the model's own inferred sales_objections field —
  // NOT from templating why_it_failed onto every tried_before entry, which
  // guaranteed near-duplicate output (one why_it_failed string repeated
  // across every past-attempt item). See ANALYSIS FIELDS in the audience
  // prompt for the generation rules.
  const objections = asStringArray(raw.sales_objections)

  // Straight renames — the model already produces these as arrays; no
  // combining logic needed, just pass through under the report panel's names.
  const pastAttempts = asStringArray(raw.tried_before)
  const buyingDecisions = asStringArray(raw.buying_triggers)
  const motivatingStatements = asStringArray(raw.motivating_phrases)
  const turnAwayStatements = asStringArray(raw.repelling_phrases)
  const whereToFind = asStringArray(raw.where_to_find_them)

  const derived: Record<string, unknown> = {}
  if (painPoints.length > 0) derived.painPoints = painPoints
  if (fearsAndDoubts.length > 0) derived.fearsAndDoubts = fearsAndDoubts
  if (objections.length > 0) derived.objections = objections
  if (dreamOutcome !== null) derived.dreamOutcome = dreamOutcome
  if (pastAttempts.length > 0) derived.pastAttempts = pastAttempts
  if (buyingDecisions.length > 0) derived.buyingDecisions = buyingDecisions
  if (motivatingStatements.length > 0) derived.motivatingStatements = motivatingStatements
  if (turnAwayStatements.length > 0) derived.turnAwayStatements = turnAwayStatements
  if (whereToFind.length > 0) derived.whereToFind = whereToFind
  if (avatarName !== null) derived.avatarName = avatarName
  // Always set — genderFromName defaults to a safe 'neutral', so the profile always
  // carries a valid avatar_gender for gender-matched avatar selection on read.
  derived.avatar_gender = avatarGender
  if (problemStatement !== null) derived.problemStatement = problemStatement
  if (whoTheyAre !== null) derived.whoTheyAre = whoTheyAre
  if (theirWorld !== null) derived.theirWorld = theirWorld
  if (emotionalState !== null) derived.emotionalState = emotionalState
  if (internalDialogue !== null) derived.internalDialogue = internalDialogue
  if (triggeringMoment !== null) derived.triggeringMoment = triggeringMoment
  if (whyItFailed !== null) derived.whyItFailed = whyItFailed
  if (perceivedProblem !== null) derived.perceivedProblem = perceivedProblem
  if (realProblem !== null) derived.realProblem = realProblem
  if (connectionSummary !== null) derived.connectionSummary = connectionSummary
  if (gapInsight !== null) derived.gapInsight = gapInsight
  if (languageProblem.length > 0) derived.languageProblem = languageProblem
  if (languageSolution.length > 0) derived.languageSolution = languageSolution
  if (otherAngles.length > 0) derived.otherAngles = otherAngles
  if (monetizeBridge !== null) derived.monetizeBridge = monetizeBridge

  // THE PERSONA'S FACE, resolved server-side.
  //
  // NAMED personaAvatarUrl, NOT avatarUrl. `users.avatar_url` is the COACH's own
  // account photo — the private field this repo spent a day keeping off public
  // surfaces — and a key called `avatarUrl` sitting on a profile payload is one
  // careless read away from somebody wiring the wrong one. This is the invented
  // PERSONA's face, and the name says so. It also matches the helper it comes
  // from, personaSeedFromAudience.
  //
  // Derived here rather than chosen client-side because the seed IS the identity:
  // the same persona must resolve to the same face on the Audience band, the
  // Launch persona tile and every Launch library card. A client-side pick would
  // give one coach's single persona a different face per surface, which is the
  // exact thing the seed exists to prevent.
  //
  // Seeded from avatar_name when there is one, falling back to the coach's id so
  // the face is stable even before a persona has been named — personaSeedFromAudience
  // owns that rule, and it is not restated here.
  const personaSeed = personaSeedFromAudience(raw, userId ?? '')
  if (personaSeed) derived.personaAvatarUrl = avatarUrlForSeed(personaSeed, avatarGender)

  return derived
}


/**
 * A saved audience profile as a panel should read it.
 *
 * DERIVED AT READ TIME, NOT BACKFILLED. The display subset used to be computed
 * only on write and merged into the stored row, so a row carried whichever
 * aliases existed on the day it was written. When the avatar hero's six were
 * added on 2026-08-06, every profile already in the database kept its seventeen
 * and the hero rendered blank — verified on the live payload: who_they_are 245
 * characters present in the row, whoTheyAre undefined in the response.
 *
 * A backfill would have fixed those rows and left the identical trap for the
 * next field added. Deriving here makes the display subset a FUNCTION of the raw
 * fields, evaluated per request, so it cannot go stale again — the property is
 * that any saved profile resolves every published key regardless of when it was
 * written, and that is what tests/audienceReadPath.test.ts asserts against a row
 * seeded with raw snake_case and no camelCase at all.
 *
 * The derived keys are spread LAST so they win over anything stored. They are a
 * pure function of the raw fields, so recomputing agrees with a fresh row and
 * repairs an old one; letting the stored copy win would preserve exactly the
 * staleness this exists to remove.
 *
 * Non-objects pass through untouched — a null row stays null rather than
 * becoming an empty profile, which is how callers tell "no conversation yet"
 * from "a conversation with nothing in it".
 */
export function audienceForDisplay<T>(content: T, userId?: string): T {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content
  const raw = content as Record<string, unknown>
  return { ...raw, ...deriveAudienceDisplayFields(raw, userId) } as T
}
