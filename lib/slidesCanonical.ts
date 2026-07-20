import { MtSlide } from './microTrainingGenerator'
import { SlidesDeck, SlideEntry } from './slidesAnalysis'

// Mapping layer for the slides consolidation (Task 5). Slides now live only on
// the canonical mtm_generations row; the slides toolkit keeps its SlidesDeck API
// shape by mapping to/from canonical here. key_points is retired (no canonical
// home; unused by the ZoomSlideViewer + PPTX export, and the unified generator
// never emitted it), and the draft/confirmed flag is gone (Build is
// presence-based). Old by_card_id data is left in place, never hard-deleted.

// Framework phase names in order — the source for a slide's sectionName.
export function frameworkPhaseNames(framework: unknown): string[] {
  const phases = (framework as { phases?: unknown })?.phases
  if (!Array.isArray(phases)) return []
  return phases
    .map((p) => (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string' ? ((p as { name: string }).name) : ''))
    .filter((n) => n.length > 0)
}

// Old toolkit SlideEntry[] -> canonical MtSlide[]. speaker_notes seeds BOTH the
// spoken script and the speaker note (no separate enrichment pass, per spec);
// sectionName distributes the slides across the framework phases in order;
// timing has no legacy source, so it's left blank (the unified generator emits
// real timing).
export function deckSlidesToCanonical(slides: SlideEntry[], phaseNames: string[]): MtSlide[] {
  const n = slides.length
  return slides.map((s, i) => {
    const notes = typeof s.speaker_notes === 'string' ? s.speaker_notes : ''
    const sectionName =
      phaseNames.length > 0 && n > 0
        ? phaseNames[Math.min(phaseNames.length - 1, Math.floor((i * phaseNames.length) / n))]
        : ''
    return {
      slideNumber: typeof s.slide_number === 'number' ? s.slide_number : i + 1,
      slideTitle: typeof s.title === 'string' ? s.title : '',
      script: notes,
      speakerNote: notes,
      timing: '',
      sectionName,
    }
  })
}

// Canonical mtm_generations row -> the toolkit's SlidesDeck API shape. training_
// title/duration_estimate come from chosen_topic/total_duration; speaker_notes
// reads the spoken script (falling back to speakerNote); key_points is []; and
// confirmed is presence-based (true when slides exist).
export type CanonicalSlideRow = { slides?: unknown; chosen_topic?: unknown; total_duration?: unknown }

export function canonicalRowToDeck(row: CanonicalSlideRow): SlidesDeck {
  const rawSlides = Array.isArray(row.slides) ? row.slides : []
  const slides: SlideEntry[] = rawSlides.map((r, i) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const script = typeof o.script === 'string' ? o.script : ''
    const speakerNote = typeof o.speakerNote === 'string' ? o.speakerNote : ''
    return {
      slide_number: typeof o.slideNumber === 'number' ? o.slideNumber : i + 1,
      title: typeof o.slideTitle === 'string' ? o.slideTitle : '',
      speaker_notes: script || speakerNote,
      key_points: [],
    }
  })
  return {
    training_title: typeof row.chosen_topic === 'string' ? row.chosen_topic : '',
    duration_estimate: typeof row.total_duration === 'string' ? row.total_duration : '',
    slides,
    confirmed: slides.length > 0,
  }
}

// The canonical MtSlide[] for a toolkit deck, ready to write to
// mtm_generations.slides.
export function deckToCanonicalSlides(deck: { slides: SlideEntry[] }, phaseNames: string[]): MtSlide[] {
  return deckSlidesToCanonical(deck.slides, phaseNames)
}
