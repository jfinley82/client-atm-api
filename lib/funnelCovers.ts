import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'
import { supabase } from './supabase'
import { loadBranding, loadKeyTakeaways, landingPage, trainingPage, bookPage } from '../api/funnels/render'

// Page cover thumbnails for the Pages tab — generated on funnel publish (and
// refreshed on every re-publish) via a real headless-Chromium screenshot of
// the EXACT HTML the public render would serve (same landingPage/trainingPage/
// bookPage builders + loadBranding render.ts itself uses), not a hand-rolled
// stand-in. Chosen over a lighter styled-render approximation because the
// chromium/puppeteer-core pair this needs is already a proven dependency here
// (api/pdf/render.ts) — no new infra to add.
//
// JavaScript is disabled and every non-data: network request is aborted
// (mirroring api/pdf/render.ts's lockdown), so the shot is deterministic and
// makes no real calls to Google/Facebook's script tags in <head> — a cover
// thumbnail needs the static look, not live pixels or the booking page's
// dynamic slot list (which renders its static "Loading available times…"
// placeholder, same as a fresh page load before JS finishes fetching).
//
// Storage: bucket `funnel-covers` (public read, migration 068), one object per
// (funnel, page) at a FIXED path so a re-publish overwrites in place rather
// than accumulating history. The resulting public URL is upserted into
// `funnel_assets` — one row per (funnel_id, slot_key), slot_key being
// 'cover_landing' | 'cover_training' | 'cover_booking' — keyed by the same
// (funnel_id, slot_key) unique index a caller can read straight back.
const COVER_BUCKET = 'funnel-covers'
const COVER_WIDTH = 1200
const COVER_HEIGHT = 630

export const COVER_SLOT_KEYS = {
  landing: 'cover_landing',
  training: 'cover_training',
  booking: 'cover_booking',
} as const

type PageKey = keyof typeof COVER_SLOT_KEYS

const FUNNEL_SELECT =
  'id, user_id, subdomain, status, generation_id, video_url, collect_name, collect_phone, landing_page, training_page, booking_page, application_questions_enabled, booking_questions, disqualify_rules, disqualify_action, disqualify_message, disqualify_redirect_url, cookie_notice_enabled, cta_mode, offer_url, offer_button_text, offer_price_display'

async function screenshotHtml(browser: Awaited<ReturnType<typeof puppeteer.launch>>, html: string): Promise<Buffer> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: COVER_WIDTH, height: COVER_HEIGHT })
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      if (request.url().startsWith('data:')) request.continue()
      else request.abort()
    })
    await page.setContent(html, { waitUntil: 'load' })
    const shot = await page.screenshot({ type: 'jpeg', quality: 72 })
    return Buffer.from(shot)
  } finally {
    await page.close().catch(() => {})
  }
}

// Generates and stores fresh covers for all three of a funnel's pages. Called
// from POST /api/funnels/[id]/publish, best-effort — a screenshot failure must
// never fail the publish itself (the funnel still goes live; its cover(s)
// just stay whatever they were, same as a draft's null, and the next
// re-publish retries).
export async function generateFunnelCovers(funnelId: string): Promise<void> {
  const { data: funnel, error } = await supabase.from('funnels').select(FUNNEL_SELECT).eq('id', funnelId).maybeSingle()
  if (error) throw error
  if (!funnel) return

  const branding = await loadBranding(funnel)
  const takeaways = await loadKeyTakeaways(funnel.generation_id as string | null)

  const pages: { key: PageKey; html: string }[] = [
    { key: 'landing', html: landingPage(funnel, branding) },
    { key: 'training', html: trainingPage(funnel, branding, takeaways) },
    { key: 'booking', html: bookPage(funnel, branding) },
  ]

  chromium.setGraphicsMode = false
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  })

  try {
    for (const p of pages) {
      const bytes = await screenshotHtml(browser, p.html)
      const slotKey = COVER_SLOT_KEYS[p.key]
      const path = `${funnelId}/${slotKey}.jpg`

      const { error: uploadError } = await supabase.storage
        .from(COVER_BUCKET)
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: true })
      if (uploadError) throw uploadError

      const { data: publicUrlData } = supabase.storage.from(COVER_BUCKET).getPublicUrl(path)
      const url = `${publicUrlData.publicUrl}?v=${Date.now()}`

      const { error: upsertError } = await supabase
        .from('funnel_assets')
        .upsert(
          { funnel_id: funnelId, user_id: funnel.user_id, slot_key: slotKey, url, file_size_bytes: bytes.length },
          { onConflict: 'funnel_id,slot_key' }
        )
      if (upsertError) throw upsertError
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

// Read path for GET /api/funnels/[id]/analytics's `page_covers` block. A
// funnel that has never published (or whose cover generation hasn't run yet)
// simply has no rows — every key comes back null, which is exactly the
// "draft has no cover, frontend shows a placeholder" contract.
export async function loadPageCovers(funnelId: string): Promise<{ landing: string | null; training: string | null; booking: string | null }> {
  const { data, error } = await supabase.from('funnel_assets').select('slot_key, url').eq('funnel_id', funnelId)
  if (error) throw error
  const bySlot = new Map((data || []).map((r) => [r.slot_key as string, r.url as string]))
  return {
    landing: bySlot.get(COVER_SLOT_KEYS.landing) ?? null,
    training: bySlot.get(COVER_SLOT_KEYS.training) ?? null,
    booking: bySlot.get(COVER_SLOT_KEYS.booking) ?? null,
  }
}
