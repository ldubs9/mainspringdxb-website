# Mainspring Dubai — Payment System Setup Guide

## Architecture

```
Browser (index.html)
  |
  | 1. POST customer details + cart items
  v
Supabase Edge Functions (server-side, secrets are SAFE here)
  |
  | 2. Creates order in DB, calls payment gateway API
  v
Payment Gateway (Tap / Tabby / Tamara)
  |
  | 3. Customer pays on gateway's hosted page
  | 4. Gateway sends webhook to Edge Function
  v
Edge Function updates order status in DB
```

**No API keys are ever exposed to the browser.** All gateway communication happens server-side in Edge Functions using `SUPABASE_SERVICE_ROLE_KEY`.

---

## Step 1: Run the Orders SQL

1. Go to your Supabase Dashboard → SQL Editor
2. Copy and paste the contents of `orders-tables.sql`
3. Click "Run"

This creates:
- `orders` table with RLS policies
- `order_status_history` table for audit trail
- Automatic triggers for `updated_at` and status change logging

---

## Step 2: Deploy Edge Functions

Install the Supabase CLI if you haven't:
```bash
npm install -g supabase
supabase login
supabase link --project-ref heblmjkgsuhwjffjrhrr
```

Deploy all functions:
```bash
supabase functions deploy create-order
supabase functions deploy ziina-checkout
supabase functions deploy ziina-webhook
supabase functions deploy tabby-checkout
supabase functions deploy tamara-checkout
supabase functions deploy order-status
```

---

## Step 3: Set Secrets

### Required for all payments:
```bash
# Already set automatically by Supabase:
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

# Your site URL (for redirects after payment)
supabase secrets set SITE_URL=https://mainspringdxb.com
```

### For Ziina (Card Payments):
1. Log in to your Ziina Business account at https://business.ziina.com
2. Copy your API key from the dashboard
```bash
supabase secrets set MAINSPRING_ZIINA_API_KEY=<your_ziina_api_key>
```
> To register the webhook so Ziina can notify you of payment events:
> Go to your Ziina dashboard → Webhooks → add the URL:
> `https://<your-project-ref>.supabase.co/functions/v1/ziina-webhook`

### For Tabby (BNPL):
1. Apply at https://tabby.ai/business
2. Get your **Secret Key** and **Merchant Code**
```bash
supabase secrets set TABBY_SECRET_KEY=sk_xxxxxxxxxxxxxxxx
supabase secrets set TABBY_MERCHANT_CODE=your_merchant_code
```

### For Tamara (BNPL):
1. Apply at https://tamara.co/business
2. Get your **API Token**
```bash
# For testing (sandbox):
supabase secrets set TAMARA_API_TOKEN=your_sandbox_token
supabase secrets set TAMARA_API_URL=https://api-sandbox.tamara.co

# For production:
supabase secrets set TAMARA_API_TOKEN=your_production_token
supabase secrets set TAMARA_API_URL=https://api.tamara.co
```

---

## Step 4: Update Bank Details

In `index.html`, search for "Emirates NBD" and "AE00 0000" and replace with your actual:
- Bank name
- Account name
- IBAN

---

## How It Works

### Bank Transfer / Cash:
1. Customer fills details → selects payment → order created in DB
2. Customer sees bank details (or COD confirmation)
3. Customer confirms via WhatsApp
4. You manually update order status in Supabase Dashboard

### Ziina (Card):
1. Customer fills details → selects Card → order created in DB
2. Edge Function calls Ziina `POST /payment_intent` → returns hosted payment URL
3. Customer is redirected to Ziina's secure hosted page → enters card
4. Ziina processes payment → sends webhook to `ziina-webhook` Edge Function
5. Webhook re-fetches the Payment Intent from Ziina API to verify status
6. Order updated to "paid" → customer redirected back with `?status=ziina_success`

**Testing:** Pass `test: true` when creating a Payment Intent to use Ziina's test mode — any card number, expiry, and CVV will work and no money is charged.

### Tabby / Tamara:
1. Customer fills details → selects Tabby/Tamara → order created in DB
2. Edge Function creates checkout session → returns payment URL
3. Customer is redirected to Tabby/Tamara → completes BNPL setup
4. Gateway redirects customer back with success/failure status
5. Webhook (if configured) updates order status

---

## Security Measures

- **No secret keys in browser code** — all gateway API calls happen in Edge Functions
- **RLS (Row Level Security)** — customers can only insert orders, not read/update/delete
- **Server-side total calculation** — prices are validated server-side, never trusted from client
- **Input sanitization** — all inputs are truncated and cleaned
- **Order lookup requires phone + ref** — prevents order enumeration
- **Webhook verification** — Ziina webhooks are verified by re-fetching the Payment Intent from Ziina API
- **Service role isolation** — only Edge Functions use the service_role key

---

## Testing

### Without payment gateway accounts:
The checkout flow works immediately for **Bank Transfer** and **Cash** payments. These don't require any external accounts.

For **Ziina/Tabby/Tamara**, the system gracefully falls back to a WhatsApp confirmation flow until you set up the API keys.

### With sandbox accounts:
- Ziina: Add `"test": true` to the Payment Intent body in `ziina-checkout/index.ts` — any card details work, no charge made
- Tabby: Use sandbox credentials from Tabby dashboard
- Tamara: Set `TAMARA_API_URL` to sandbox URL

---

## Managing Orders

View and manage orders in the Supabase Dashboard:
- **Table Editor** → `orders` table
- Update `order_status` (pending → confirmed → shipped → delivered)
- Update `payment_status` when bank transfers are received
- Add `tracking_number` when shipped
