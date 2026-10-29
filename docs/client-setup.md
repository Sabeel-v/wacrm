# Setting up wacrm for a new client (Vercel + Supabase + QStash)

A checklist for standing up one single-tenant install per client on
the free tiers: Vercel Hobby, Supabase Free and Upstash QStash Free.
Broadcasts are delivered in the background through QStash (migration
046), so the client can close the browser tab while a campaign sends.

## Time

| Step | First time | Once practiced | Waiting on others |
| --- | --- | --- | --- |
| 1. Meta Business + WhatsApp number | 1–2 h | 30 min | Business verification: 1–3 days |
| 2. Supabase project + migrations | 45 min | 10 min | — |
| 3. Upstash QStash | 10 min | 5 min | — |
| 4. GitHub + Vercel deploy | 45 min | 15 min | — |
| 5. Connect WhatsApp in the app + webhook | 45 min | 15 min | — |
| 6. Template + test broadcast | 30 min | 15 min | Template approval: minutes to 24 h |

About 1–2 hours of your own work once practiced (4–6 hours the first
time), plus 1–3 days of Meta approvals. Start step 1 first.

## What to collect from the client

- Business legal name, address and website (for Meta verification)
- A phone number for WhatsApp that is **not** in use on the WhatsApp
  phone app, and that can receive an SMS or call for the code
- Admin access to their Meta Business account (or have them add you)
- The domain or subdomain the CRM should live on, e.g.
  `crm.clientname.com`, and access to its DNS

## 1. Meta (start here, it is the slow part)

1. The client creates a Meta Business account at
   [business.facebook.com](https://business.facebook.com) and submits
   **business verification** (Business Settings → Security Center).
2. At [developers.facebook.com](https://developers.facebook.com),
   create an app of type **Business** and add the **WhatsApp** product.
3. Under **WhatsApp → API Setup**, add the client's phone number and
   verify it.
4. In Business Settings → Users → **System Users**, create a system
   user (Admin), assign it the app and the WhatsApp Business Account,
   and **generate a token** with:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`

   Choose "never expires". The temporary token on the API Setup page
   expires in 24 hours — do not use it.
5. Note down:
   - **Phone Number ID** and **WhatsApp Business Account ID** (API Setup page)
   - the **system user token**
   - the **App Secret** and **App ID** (App Settings → Basic)

## 2. Supabase

1. Create a new project at [supabase.com](https://supabase.com). Pick
   the region closest to the client's customers (e.g. Mumbai for India).
   Save the database password.
2. Run every migration in `supabase/migrations/` **in order**
   (001 → 046). Either paste each file into the SQL Editor, or use the
   CLI from the repo root:

   ```bash
   npx supabase link --project-ref <project-ref>
   ```

   ```bash
   npx supabase db push
   ```

3. From **Project Settings → API**, copy the project URL, the `anon`
   key and the `service_role` key.
4. Under **Authentication → URL Configuration**, set the Site URL to the
   client's domain.

## 3. Upstash QStash

1. Sign up at [console.upstash.com](https://console.upstash.com) and
   open **QStash**.
2. Copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
   `QSTASH_NEXT_SIGNING_KEY`, and `QSTASH_URL` if the console shows a
   regional URL.

## 4. Vercel

1. Push the repo to GitHub and import it in [vercel.com](https://vercel.com).
2. Add the environment variables (Project → Settings → Environment
   Variables, **Production**):

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase `anon` key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` key |
   | `ENCRYPTION_KEY` | a **new** value per client: `openssl rand -hex 32` |
   | `META_APP_SECRET` | Meta App Secret |
   | `META_APP_ID` | Meta App ID (needed for image-header templates) |
   | `NEXT_PUBLIC_SITE_URL` | the client's real domain, e.g. `https://crm.clientname.com` |
   | `QSTASH_TOKEN` | from step 3 |
   | `QSTASH_CURRENT_SIGNING_KEY` | from step 3 |
   | `QSTASH_NEXT_SIGNING_KEY` | from step 3 |
   | `QSTASH_URL` | from step 3, only if shown |

3. Deploy, then add the domain under **Settings → Domains** and create
   the DNS record Vercel shows.
4. Redeploy after changing any `NEXT_PUBLIC_*` variable — they are
   inlined at build time.

## 5. Connect WhatsApp in the app

1. Open the deployed app and sign up. The first user becomes the
   account owner.
2. In **Settings → WhatsApp**, enter the Phone Number ID, WABA ID and
   system user token, and choose a verify token (any random string).
3. In the Meta app, **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<domain>/api/whatsapp/webhook`
   - Verify token: the one you chose above
   - Subscribe to the **messages** field
4. Invite the client's team from **Settings → Team members**.

## 6. Test

1. Sync templates from Meta, or create one and submit it for approval.
2. Send a broadcast to 10–20 of your own numbers, **close the tab**,
   and confirm the broadcast page reaches "sent" on its own.
3. Reply from one of those phones and check it lands in the inbox.

## Mistakes to avoid

- **Never reuse keys across clients.** Each client gets their own
  Supabase project, `ENCRYPTION_KEY` and Meta token.
- **QStash cannot reach Vercel preview URLs** (Deployment Protection).
  Test broadcasts on the production domain.
- **New numbers start at 250 recipients a day.** Meta raises the daily
  cap (2k → 10k → 100k) as quality and volume build up — tell the
  client to grow gradually.
- **Vercel Hobby is for non-commercial use.** For a paying client,
  budget Vercel Pro ($20/month).

## Free-tier capacity and upkeep

Roughly 60k messages a month and 3k–5k a day fit, with Vercel's 4 h of
monthly CPU time and Supabase's 500 MB database as the limits to watch.

- Check Vercel → Usage weekly; move to Pro above ~3 h CPU a month.
- Delete message detail older than ~60 days each month, or the
  database fills in about three months at 60k messages a month.
- Supabase Free has no automatic backups — export the database
  regularly.
- Supabase Free pauses a project after 7 days without activity.
