# Mainspring transactional email setup

The website sends three transactional emails:

1. Every successfully submitted order sends the customer and order details to `info@mainspringdubai.com`.
2. The first verified change of an order to `paid` sends a payment confirmation to `info@mainspringdubai.com`.
3. The same verified payment sends a confirmation to the customer email entered at checkout.

The database payment status drives the confirmation. A browser return page cannot trigger a paid email. Card payments send only after the Ziina webhook verifies payment. Bank-transfer and in-store orders send when their payment status is changed to `paid`.

## Email services

- Shopify continues forwarding incoming email for `info@mainspringdubai.com`.
- Resend sends automatic messages from `Mainspring Dubai <orders@updates.mainspringdubai.com>`.
- Replies to automatic messages go to `info@mainspringdubai.com`.

Do not replace the root-domain MX records or remove the Shopify forwarding rule.

## Coolify environment variables

```text
RESEND_API_KEY=re_...
TRANSACTIONAL_EMAIL_FROM=Mainspring Dubai <orders@updates.mainspringdubai.com>
BUSINESS_EMAIL=info@mainspringdubai.com
EMAIL_POLL_INTERVAL_MS=15000
```

The API key must remain in Coolify. Never put it in browser JavaScript or the repository.

## Deployment order

1. Apply `supabase/migrations/20260731_order_email_outbox.sql`.
2. Deploy the `coolify/mainspring-payments` application.
3. Confirm its `/health` response reports `email_configured: true`.
4. Deploy the website to Vercel.
5. Submit a controlled test order with an email address you own.
6. Confirm the new-order email reaches `info@mainspringdubai.com`.
7. Change only the controlled test order to `paid`.
8. Confirm the payment email reaches Mainspring and the test customer.
9. Confirm the three corresponding rows in `mainspring_order_email_events` have status `sent` and provider message IDs.

## Reliability and security

- Database triggers queue email events in the same transaction as order and payment changes.
- Each order and email event type is unique, preventing duplicate queue entries.
- Provider requests use stable idempotency keys.
- Failed sends retry with increasing delays, up to eight attempts.
- Customer content is escaped in HTML email templates.
- Order submissions are rate-limited server-side.
- Browser users cannot read or modify the email outbox or rate-limit data.

This release is independent of the future discount-code feature.
