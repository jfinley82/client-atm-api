process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'stub-anthropic-key'

import {
  EDITOR_OWNED_FIELDS,
  coerceSlides,
  coerceWorkbook,
  coerceEmails,
  coerceSalesScript,
  selectedExercises,
} from '../lib/microTrainingGenerator'

// Every coerce* is an allowlist, so an editor-owned field survives a save only
// if someone remembered to write a passthrough. Three have been lost that way.
// These assertions are the memory.

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

console.log('\n-- every field in EDITOR_OWNED_FIELDS survives its coerce --')
{
  const slideIn = {
    slideNumber: 1, slideTitle: 'A slide', talkingPoints: ['a beat'],
    deliveryMove: { kind: 'just_talk', note: 'n' }, timing: '2m', sectionName: 'Intro',
    script: 'legacy narration', speakerNote: 'a note',
    elements: [{ type: 'text', x: 1 }],
    original: { slideTitle: 'A slide', talkingPoints: ['a beat'] },
    gen_snapshot: { slideTitle: 'A slide', talkingPoints: ['a beat'] },
    bgColor: '#ff8800',
  }
  const [slide] = coerceSlides([slideIn]) as any[]
  for (const f of EDITOR_OWNED_FIELDS.slide) {
    ok(`slide.${f} survives`, slide?.[f] !== undefined, `got ${JSON.stringify(slide?.[f])}`)
  }
  ok('slide.bgColor keeps its exact value', slide?.bgColor === '#ff8800', JSON.stringify(slide?.bgColor))
  ok('slide.elements is not rebuilt', JSON.stringify(slide?.elements) === JSON.stringify(slideIn.elements))
}
{
  const wb = coerceWorkbook({
    title: 'G', intro: 'i', sections: [{
      sectionTitle: 'S', keyInsight: 'k', reflection: 'r',
      exercises: [
        { prompt: 'p1', lines: 4, recommended: true, collects: 'c', why_fits: 'w', selected: true },
        { prompt: 'p2', lines: 4, recommended: false, collects: 'c', why_fits: 'w', selected: false },
      ],
    }],
  }) as any
  const ex = wb.sections[0].exercises
  for (const f of EDITOR_OWNED_FIELDS.exercise) {
    ok(`exercise.${f} survives`, ex[0]?.[f] !== undefined, `got ${JSON.stringify(ex[0]?.[f])}`)
  }
  ok('selected: true is preserved', ex[0].selected === true)
  ok('selected: false is preserved, not dropped as falsy', ex[1].selected === false, JSON.stringify(ex[1]))
  ok('the generator fields still coerce', ex[0].prompt === 'p1' && ex[0].recommended === true)
}
{
  const [email] = coerceEmails([{ email_number: 1, send_timing: 't', subject: 's', body: 'b', original: { subject: 's', body: 'b' } }]) as any[]
  for (const f of EDITOR_OWNED_FIELDS.email) ok(`email.${f} survives`, email?.[f] !== undefined)
}
{
  const [beat] = coerceSalesScript([{
    beat: 'Open', prospect_mindset: 'm', phrasing_options: ['a'], recommended: 'a',
    gen_snapshot: { beat: 'Open', prospect_mindset: 'm', phrasing_options: ['a'], recommended: 'a' },
  }]) as any[]
  for (const f of EDITOR_OWNED_FIELDS.scriptBeat) ok(`scriptBeat.${f} survives`, beat?.[f] !== undefined)
}

console.log('\n-- the regression: a coach selection survives an adjacent save --')
// The reported failure. Selections were written straight to supabase by
// PATCH /api/generate/exercises, then the NEXT save round-tripped the workbook
// through coerceWorkbook and every `selected` key was gone.
{
  const saved = {
    title: 'G', intro: 'i', sections: [{
      sectionTitle: 'S', keyInsight: 'k', reflection: 'r',
      exercises: [
        { prompt: 'p1', lines: 4, recommended: false, collects: 'c', why_fits: 'w', selected: true },
        { prompt: 'p2', lines: 4, recommended: true, collects: 'c', why_fits: 'w', selected: false },
        { prompt: 'p3', lines: 4, recommended: false, collects: 'c', why_fits: 'w', selected: false },
      ],
    }],
  }
  // Round-trip it repeatedly — an approve step can save more than once.
  let wb: any = saved
  for (let i = 0; i < 3; i++) wb = coerceWorkbook(wb)
  const ex = wb.sections[0].exercises
  ok('selections survive three round-trips', ex[0].selected === true && ex[1].selected === false)
  const rendered = selectedExercises(ex)
  ok('the guide renders the coach choice, not the recommended default', rendered.length === 1 && rendered[0].prompt === 'p1',
    JSON.stringify(rendered.map((e: any) => e.prompt)))
}

console.log('\n-- absence still means "the coach has not chosen here" --')
// If coerce wrote `selected: false` unconditionally, every untouched section
// would read as "coach chose, and chose nothing" and the guide would render
// empty. Absence must stay absent.
{
  const wb = coerceWorkbook({
    title: 'G', intro: 'i', sections: [{
      sectionTitle: 'S', keyInsight: 'k', reflection: 'r',
      exercises: [
        { prompt: 'p1', lines: 4, recommended: true, collects: 'c', why_fits: 'w' },
        { prompt: 'p2', lines: 4, recommended: false, collects: 'c', why_fits: 'w' },
      ],
    }],
  }) as any
  const ex = wb.sections[0].exercises
  ok('no `selected` key is invented', !('selected' in ex[0]) && !('selected' in ex[1]), JSON.stringify(ex))
  const rendered = selectedExercises(ex)
  ok('an untouched section still falls back to recommended', rendered.length === 1 && rendered[0].prompt === 'p1',
    JSON.stringify(rendered.map((e: any) => e.prompt)))
}
{
  // A non-boolean must not be trusted into the "coach chose" branch.
  const wb = coerceWorkbook({
    title: 'G', intro: 'i', sections: [{
      sectionTitle: 'S', keyInsight: 'k', reflection: 'r',
      exercises: [{ prompt: 'p1', lines: 4, recommended: true, collects: 'c', why_fits: 'w', selected: 'yes' }],
    }],
  }) as any
  ok('a non-boolean `selected` is dropped, not coerced', !('selected' in wb.sections[0].exercises[0]),
    JSON.stringify(wb.sections[0].exercises[0]))
}

console.log('\n-- the registry matches the types it claims to cover --')
// A field named here with no passthrough would pass every test above only if
// the fixture forgot it, so the fixtures are checked against the registry
// itself rather than a hand-written list.
ok('slide registry is non-empty', EDITOR_OWNED_FIELDS.slide.length > 0)
ok('bgColor is registered', (EDITOR_OWNED_FIELDS.slide as readonly string[]).includes('bgColor'))
ok('selected is registered', (EDITOR_OWNED_FIELDS.exercise as readonly string[]).includes('selected'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
