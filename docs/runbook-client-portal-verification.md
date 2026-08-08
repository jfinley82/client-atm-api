# Runbook — verifying the client portal on a preview deployment

**NOT RUN.** Nothing in this file has been executed. No programme has been
created and no mail has been sent. It is written for Jamaul to run or authorise.

---

## Why this exists

`npm run gate` is green at 3225 assertions and proves none of what is below. The
gate runs against local `node_modules` and a stub database; the five
`api/client/**` routes and the six programme emails have never executed against
real Supabase, real Resend, or a real signed token.

`GET /api/client/program?t=nonsense` returns `401 invalid_token` on the
deployment. **That proves the module loads and nothing else.** The second
incident recorded in `CLAUDE.md` returned a healthy-looking `405` from an
endpoint whose handler was broken inside, and it lost a real member's reply.

## Before you start

- **Use the PREVIEW deployment, not production.** A failure must not take prod
  down. Preview URL: the `client-atm-api-git-<branch>` alias on Vercel.
- **Preview and production share one Supabase database.** Everything below
  writes real rows. Step 9 removes them.
- **Use an address you control** for the client. Real mail is sent to it.
- Have `mcp__Vercel__get_runtime_logs` (or the Vercel dashboard's Logs tab) open
  on the preview deployment throughout. Several failure modes are silent in the
  response and loud in the logs.

**Fifteen minutes, plus waiting on two emails.**

---

## What a failure looks like, as distinct from a slow send

Read this before step 3 — most of the ambiguity in this runbook is here.

| symptom | this is | not this |
|---|---|---|
| No email after **5 minutes**, no `[clientProgramEmail]` line in the logs | the send never happened — a thrown error swallowed by the best-effort try/catch | a slow send |
| No email, but a `[clientProgramEmail] program_welcome …` **error** line | the send was attempted and Resend refused it | a slow send |
| Email arrives after 1–3 minutes | normal. Resend queues immediately-sent mail | a fault |
| `500` from any endpoint | a real fault; the log line names the route | anything transient |
| `401 invalid_token` when you pasted a real link | the link was truncated by the mail client — copy it from "show original" | a revoked token |
| `404 not_found` from the portal after step 3 | the programme is not `active`, or the token version moved | a bad link |
| A reminder does **not** arrive | expected — see step 8. Reminders fire 09:00 the day before a due date | a fault |

All programme mail is **best-effort by contract**: it is wrapped in try/catch and
never throws, so *a failed send does not fail the request*. That is deliberate,
and it is exactly why the logs are load-bearing here. **A 200 does not mean the
email went.**

---

## The steps

### 1. Create the programme (coach side)

`POST /api/client-programs` on the preview, authenticated as the coach, body:

```json
{ "client_name": "<your name>", "client_email": "<an address you control>", "start_date": "<a Monday within the next 7 days>" }
```

Deliberately **no `lead_id`** — a lead-less programme, so no real lead is
consumed by `uq_client_programs_lead` and step 9's cleanup is a single delete.

- **Expect** `201` with `{ program: { … , "status": "draft" } }`.
- **Note the `id`.** Every later step needs it.
- **`400 program_not_confirmed` / `program_empty`** means the coach account has
  no confirmed `program` saved output. That is a setup gap, not a bug — confirm
  the programme in the builder first.
- **Check now:** no email has arrived and none should. A draft sends nothing.

### 2. Confirm the draft really is silent

`GET /api/client-programs/<id>` and read `program.portal_url`. Open it — or rather,
call `GET /api/client/program?t=<the token from that URL>`.

- **Expect `404`.** A draft has no portal. If this returns `200`, stop: the
  active-only gate is broken and the client can see a programme their coach is
  still editing.
- **Expect no mail.** Still nothing in the inbox.

### 3. Send it

`POST /api/client-programs/<id>/send`.

- **Expect** `200` with `status: "active"` and `activated_at` set.
- **Expect `program_welcome`** in the inbox within ~3 minutes, wearing the
  **coach's** brand — their business name in the header, their accent colour on
  the button — sent from `noreply@mail.microtrainingmethod.com`, with the coach's
  address as reply-to.
- **In the logs:** no `[clientProgramEmail]` error lines.
- If the email does not arrive, use the table above before retrying anything.

**This is the step that most needs a human.** It is the first time the coach
brand, the token, the portal URL and Resend all run together.

### 4. Open the link from the EMAIL, not from the API

Copy the button's URL out of the received email — not the `portal_url` you read
in step 2. The point is to exercise the link as delivered, including anything a
mail client does to it.

`GET /api/client/program?t=<token>` **with no session cookie and no
Authorization header.**

- **Expect `200`** and a payload with `program`, `brand`, `this_week`,
  `upcoming`, `phases`, `notes`, `open_request`.
- **Check by value, not by shape:**
  - `program.client_name` is yours.
  - `program.current_week` is `1`.
  - `brand.bg` is the coach's `brand_primary_color`.
  - The payload contains **no** `user_id`, `lead_id`, `program_snapshot`,
    `portal_token_version`, `client_email`.
  - The payload contains **no** `avatars/avatars/<coach uid>` — the coach's
    account photo. If the coach has a Brand Identity logo, that URL *should* be
    present; the two live in the same bucket and only the object path separates
    them.
- **Then check the coach side:** `GET /api/client-programs/<id>` and confirm
  `portal_last_opened_at` is now set. It is written fire-and-forget, so give it a
  few seconds.

### 5. Tick an item (client write path)

Pick an item id out of `this_week.items`.

`POST /api/client/program/item?t=<token>` with `{ "item_id": "<id>", "status": "completed" }`.

- **Expect `200`** and the returned item with `completed_by: "client"` — not
  `"coach"`. That distinction is the only record of who did the work.
- **Re-read the portal:** `progress_pct` has moved.
- **Then try a foreign id:** repeat with any other programme's item id, or a
  made-up uuid. **Expect `404`**, and expect that item to be unchanged if it was
  real.

### 6. Request a session (client write path + coach notification)

`POST /api/client/program/session-request?t=<token>` with
`{ "item_id": "<a milestone id from this_week.items>", "preferred_1": "Tuesday morning", "preferred_2": "Thursday afternoon" }`.

- **Expect `201`**.
- **Expect an email to the COACH's own address**, MTM-branded — this is the one
  letter that is not the coach's brand, because it is our product telling a
  member something happened in it.
- If it does not arrive, check `funnel_business_settings.notification_prefs.new_booking`
  for that coach. `false` means no mail, deliberately, and is not a fault.
- **Then file a second one.** **Expect `409 request_already_open`** — that comes
  from the partial unique index, not from a pre-check.
- **Then withdraw it:** `POST /api/client/program/session-request/withdraw?t=<token>`.
  Expect `200`. File a third — expect `201`, proving the index was freed. Leave
  this one open for step 7.

### 7. Confirm it (coach side) — the discovery-call check

`POST /api/client-programs/<id>/requests/<requestId>` with

```json
{ "action": "confirm", "start_time": "<ISO, a few days out>", "end_time": "<ISO, +30 min>" }
```

- **Expect `200`** with a `booking` carrying `program_id` set. This is the only
  place in the codebase that sets that column.
- **Expect `program_session_confirmed`** in the client's inbox, with the time
  rendered in the client's timezone (named, e.g. `America/New_York`), not UTC.
- **Re-read the portal.** `sessions_used` is `1`, `sessions_remaining` is
  `sessions_allowed - 1`, and `upcoming` shows the milestone **once**, typed
  `session`, with the booking's clock time — not twice, and not with a
  fabricated midnight.
- **THE POINT OF THE WHOLE FEATURE:** if this coach has any prior bookings for
  the same email address, `GET /api/calendar` must still list them, and
  `sessions_used` must still be `1`. A discovery call is not excluded from the
  count — it was never in it, because it carries a null `program_id`.

### 8. Link recovery, and revocation

`POST /api/client/program/resend` with `{ "email": "<the client address>" }` —
**no token, no auth**.

- **Expect `200 {"ok":true}`** and a `program_link_resend` email.
- Repeat with an address that is nobody's: **expect a byte-identical `200
  {"ok":true}`** and **no** email. The response must not vary; that uniformity is
  what stops this being an "is this person a client" oracle.
- Repeat with `{ "email": "%" }`: **expect the same `200` and no email.** If any
  email arrives, the `ilike` escaping has regressed and a stranger can post an
  arbitrary client their own link.
- **Then revoke:** `PATCH /api/client-programs/<id>` with
  `{ "revoke_portal_link": true }`. Re-open the link **captured from the step-3
  email** — expect `404`. Read the new `portal_url` from the coach detail
  endpoint — expect `200`.

### 9. Clean up

`PATCH /api/client-programs/<id>` with `{ "status": "canceled" }`, then delete
the booking created in step 7 if you do not want it on the calendar.

An `active` programme cannot be deleted by design — only a `draft` can. Cancelling
is the intended end state and it also silences any queued reminders.

---

## What this pass does NOT cover

Stated here so the gap is known rather than discovered later.

**Three of the six mail kinds are not exercised:**

| kind | why not | how it would be covered |
|---|---|---|
| `program_item_due` | fires **09:00 client-local, the day before a due date**. Nothing in this pass can make that instant arrive, and the code refuses to schedule anything less than 60s out | set an item's `due_date` to tomorrow via `PATCH .../items/<itemId>`, confirm a `program_item_due` row appears in `funnel_email_sends` with `status: 'queued'` and a `scheduled_at` that reads 09:00 in the client's zone — then wait a day, or accept the queued row as the evidence |
| `program_session_declined` | step 7 confirms rather than declines, and a request can only be resolved once | file a fourth request and `POST …/requests/<id>` with `{"action":"decline","decline_reason":"…"}`. Worth doing if there is time; it is one extra call |
| `program_welcome` **re-send** | only sendable once per programme, by design | not coverable without a second programme |

**Also not covered:**

- **DST correctness of a reminder.** The unit test asserts it across a summer and
  a winter date; nothing here can. The queued `scheduled_at` above is the closest
  real-world check available.
- **A programme created from a `lead_id`.** This runbook deliberately uses a
  lead-less programme so cleanup is trivial. The lead path resolves ownership
  through the lead's funnel and seeds `client_timezone` from prior bookings —
  neither is exercised.
- **`sessions_remaining = 0`.** Driving the race needs two requests confirmed
  back-to-back against an allowance of 1.
- **The `paused` reminder-silencing path.**
- **Anything in `client-atm-frontend`.** There is no portal UI yet; step 10 of the
  build order is that work.
