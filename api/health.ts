export default function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(200).json({
    ok: true,
    env: {
      supabase_url: !!process.env.SUPABASE_URL,
      supabase_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      jwt_secret: !!process.env.JWT_SECRET,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      stripe: !!process.env.STRIPE_SECRET_KEY,
      resend: !!process.env.RESEND_API_KEY,
      app_url: !!process.env.APP_URL,
    }
  })
}
