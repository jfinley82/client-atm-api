import QRCode from 'qrcode'

// Generate a QR PNG data URI for the coach's own booking link, styled accent-ink
// on white per the guide CTA block. Returned inline (data:) so the locked-down
// render engine — which aborts every non-data: request — can draw it. Best-effort:
// a generation failure returns null and the CTA simply omits the QR.
export async function bookingQrDataUri(url: string, darkHex: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    return await QRCode.toDataURL(url, {
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'M',
      color: { dark: /^#[0-9a-f]{6}$/i.test(darkHex) ? darkHex : '#0b544e', light: '#ffffff' },
    })
  } catch (err) {
    console.error('[pdf/qr] QR generation failed', err)
    return null
  }
}
