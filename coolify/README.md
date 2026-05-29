# Coolify services — Ziina checkout & webhook

This folder contains two small services prepared for deployment with Coolify:

- `ziina-checkout` — creates Ziina payment intents and returns `payment_url`.
- `ziina-webhook` — receives Ziina webhook events and updates the `mainspring_orders` table.

Environment variables (set these in Coolify before deploying):

- `MAINSPRING_ZIINA_API_KEY` — your Ziina secret API key (use sandbox/test key for testing).
- `SUPABASE_URL` — your Supabase REST URL (e.g. `https://xyz.supabase.co`).
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase `service_role` key (server-side only).
- `SITE_URL` — your site URL (used for success/cancel return links). Optional but recommended.

Deployment notes

1. Commit and push the `coolify/ziina-checkout` and `coolify/ziina-webhook` folders to the repo.
2. In Coolify create two applications (or one app with routes): set the Base Directory to the respective folder and Dockerfile location to `Dockerfile`.
3. Add the environment variables in the app settings as listed above.
4. Deploy each app and assign a domain (or use the generated preview domain). Enable TLS.

Frontend wiring

- The storefront uses `js/app.js` to perform checkout. It will call the Edge Function URL by default (Supabase functions):

  `EDGE_FN_URL = SUPABASE_URL + '/functions/v1'`

- To use the Coolify checkout service instead, expose a public URL for the `ziina-checkout` app (for example `https://ziina-pay.example.com`) and set the global JavaScript variable `ZIINA_CHECKOUT_URL` on your site pages before `js/app.js` runs. Example in `index.html` (or a header partial):

```html
<script>window.ZIINA_CHECKOUT_URL = 'https://ziina-pay.example.com';</script>
<script src="js/app.js"></script>
```

This makes the front-end call your Coolify checkout endpoint instead of the Supabase Edge Function.

Testing (without public domain)

- You can test the services from the VPS directly (no DNS required): use `docker run --rm --network container:<CONTAINER_ID> curlimages/curl` to POST to `http://localhost:3000/` (checkout) and `http://localhost:3001/` (webhook).
- Create a test order in `mainspring_orders` (SQL) with `order_ref` and then POST `{"order_ref":"TEST123"}` to checkout.
- For webhook testing, POST a payload with `{"id":"<payment_intent_id>", "status":"completed"}` after ensuring the order `payment_gateway_ref` matches the `id`.

Final steps once you have domain and Ziina access

1. Set your real domain in Coolify for both apps and enable TLS.
2. Put your production/sandbox `MAINSPRING_ZIINA_API_KEY` in the webhook and checkout app envs.
3. Remove or do not set any testing toggles; the webhook performs live verification against the Ziina API.
4. Update the frontend `ZIINA_CHECKOUT_URL` to point to your `ziina-checkout` domain and test end-to-end with a Ziina sandbox key.

If you want, I can also:
- Add a small healthcheck endpoint to each service.
- Add `package-lock.json` for reproducible builds.
- Patch frontend assets to set `ZIINA_CHECKOUT_URL` automatically when you give me the final domain.

---

Created by automation — keep this README with the `coolify/` folder for future reference.
