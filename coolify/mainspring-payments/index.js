// Mainspring Dubai — consolidated payments service (for Coolify)
//
// One small Express app exposing everything the storefront needs so it can be
// deployed as a SINGLE Coolify application (one domain, one set of env vars):
//
//   POST /create-order    -> creates the order row server-side (secrets safe here)
//   POST /ziina-checkout   -> creates a Ziina payment intent, returns payment_url
//   POST /ziina-webhook    -> receives Ziina events, verifies, updates order status
//   GET  /health           -> healthcheck for Coolify
//
// Required environment variables (set these in Coolify -> app -> Environment):
//   MAINSPRING_ZIINA_API_KEY   Ziina secret API key (use a test key while testing)
//   SUPABASE_URL               e.g. https://sldb.swiftloop.tech
//   SUPABASE_SERVICE_ROLE_KEY  Supabase service_role key (server-side only)
//   SITE_URL                   storefront URL for post-payment redirects
//   ZIINA_TEST_MODE            "true" to create Ziina test payments (no real charge)
//   ZIINA_WEBHOOK_SECRET       (optional) secret used to verify webhook HMAC signature

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const ZIINA_API_KEY = process.env.MAINSPRING_ZIINA_API_KEY;
// Accept the common self-hosted / Coolify variable names too.
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.SUPABASE_PUBLIC_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://mainspringdxb.com';
const ZIINA_TEST_MODE = process.env.ZIINA_TEST_MODE === 'true';
const ZIINA_WEBHOOK_SECRET = process.env.ZIINA_WEBHOOK_SECRET;

if (!ZIINA_API_KEY) console.error('WARN: MAINSPRING_ZIINA_API_KEY not set');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.error('WARN: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');

const app = express();
app.use(cors());
// Capture the raw body so the webhook route can verify the HMAC signature over
// the exact bytes Ziina signed.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// --- Supabase REST helpers (service role) ---
const sbHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

function sbUrl(path) {
  return `${SUPABASE_URL}/rest/v1/${path}`;
}

// Decode the "role" claim from a Supabase JWT (payload only, no secret exposed).
// Used by /health to confirm the service is actually holding a service_role key.
function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.role || null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// POST /create-order
// ----------------------------------------------------------------------------
app.post('/create-order', async (req, res) => {
  try {
    const { customer_name, customer_email, customer_phone, customer_address, items, payment_method } = req.body || {};

    if (!customer_name || !customer_phone || !items?.length || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields: customer_name, customer_phone, items, payment_method' });
    }

    const validMethods = ['bank_transfer', 'ziina', 'tabby', 'tamara', 'cash'];
    if (!validMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const cleanPhone = String(customer_phone).replace(/[^\d+]/g, '');
    if (cleanPhone.length < 8) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // Server-side total calculation. Never trust client totals.
    const subtotal = items.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0);

    const surchargeRate = (payment_method === 'tabby' || payment_method === 'tamara') ? 8.5
      : (payment_method === 'ziina') ? 3
      : 0;
    const total = Math.round(subtotal * (1 + surchargeRate / 100));

    const orderRef = 'MS-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

    const insertResp = await fetch(sbUrl('mainspring_orders'), {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        order_ref: orderRef,
        customer_name: String(customer_name).substring(0, 200),
        customer_email: customer_email ? String(customer_email).substring(0, 200) : null,
        customer_phone: cleanPhone.substring(0, 20),
        customer_address: customer_address ? String(customer_address).substring(0, 500) : null,
        items: items.map((i) => ({
          id: i.id,
          brand: String(i.brand).substring(0, 100),
          name: String(i.name).substring(0, 200),
          price: Number(i.price),
          qty: Math.min(Math.max(1, Math.floor(Number(i.qty))), 10),
        })),
        subtotal_aed: subtotal,
        surcharge_pct: surchargeRate,
        total_aed: total,
        payment_method,
        payment_status: 'pending',
        order_status: 'pending',
        device_type: (req.headers['user-agent'] || '').includes('Mobile') ? 'mobile' : 'desktop',
        user_agent: (req.headers['user-agent'] || '').substring(0, 500),
      }),
    });

    if (!insertResp.ok) {
      const errText = await insertResp.text();
      console.error('Order insert error:', insertResp.status, errText);
      // Surface the DB error only in test mode to aid debugging.
      return res.status(500).json({
        error: 'Failed to create order',
        ...(ZIINA_TEST_MODE ? { status: insertResp.status, detail: errText } : {}),
      });
    }

    const inserted = await insertResp.json();
    const order = Array.isArray(inserted) ? inserted[0] : inserted;

    // Best-effort audit log; do not fail the order if this errors.
    try {
      await fetch(sbUrl('mainspring_order_status_history'), {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          order_id: order.id,
          old_status: null,
          new_status: 'pending',
          changed_by: 'system',
          note: `Order created via ${payment_method}`,
        }),
      });
    } catch (e) {
      console.error('status history insert failed (non-fatal):', e);
    }

    return res.status(201).json({
      success: true,
      order_ref: orderRef,
      total_aed: total,
      payment_method,
      surcharge_pct: surchargeRate,
    });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /ziina-checkout
// ----------------------------------------------------------------------------
app.post('/ziina-checkout', async (req, res) => {
  try {
    const { order_ref } = req.body || {};
    if (!order_ref) return res.status(400).json({ error: 'Missing order_ref' });

    if (!ZIINA_API_KEY) return res.status(503).json({ error: 'Payment gateway not configured' });

    const orderResp = await fetch(
      sbUrl(`mainspring_orders?order_ref=eq.${encodeURIComponent(order_ref)}&select=*`),
      { headers: sbHeaders }
    );
    if (!orderResp.ok) {
      console.error('Supabase fetch error', await orderResp.text());
      return res.status(404).json({ error: 'Order not found' });
    }
    const orders = await orderResp.json();
    const order = orders && orders[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order already paid' });

    // Ziina requires amounts in fils (smallest unit): 1 AED = 100 fils. Min 200 fils.
    const amountInFils = Math.round((order.total_aed || 0) * 100);
    if (amountInFils < 200) {
      return res.status(400).json({ error: 'Order total is below the minimum payment amount (2 AED)' });
    }

    const ziinaResp = await fetch('https://api-v2.ziina.com/api/payment_intent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ZIINA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountInFils,
        currency_code: 'AED',
        message: `Mainspring Dubai — Order ${order_ref}`,
        test: ZIINA_TEST_MODE,
        success_url: `${SITE_URL}?order=${order_ref}&status=ziina_success`,
        cancel_url: `${SITE_URL}?order=${order_ref}&status=ziina_cancel`,
        failure_url: `${SITE_URL}?order=${order_ref}&status=ziina_failed`,
      }),
    });

    const ziinaData = await ziinaResp.json();
    if (!ziinaResp.ok || !ziinaData.redirect_url) {
      console.error('Ziina API error:', ziinaData);
      return res.status(502).json({ error: 'Failed to create payment session' });
    }

    await fetch(sbUrl(`mainspring_orders?order_ref=eq.${encodeURIComponent(order_ref)}`), {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ payment_gateway_ref: ziinaData.id, payment_status: 'processing' }),
    });

    return res.json({ success: true, payment_url: ziinaData.redirect_url, payment_intent_id: ziinaData.id });
  } catch (err) {
    console.error('ziina-checkout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /ziina-webhook
// ----------------------------------------------------------------------------
app.post('/ziina-webhook', async (req, res) => {
  try {
    // Optional HMAC-SHA256 verification over the raw request body.
    if (ZIINA_WEBHOOK_SECRET) {
      const signature = req.headers['x-hmac-signature'] || '';
      const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const expected = crypto.createHmac('sha256', ZIINA_WEBHOOK_SECRET).update(raw).digest('hex');
      const ok = signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      if (!ok) {
        console.error('Ziina webhook: invalid HMAC signature');
        return res.status(401).send('Invalid signature');
      }
    }

    const payload = req.body || {};
    // Ziina delivers an event envelope: { event: "...", data: { id, status, ... } }
    const paymentIntentId = payload?.data?.id || payload.id || payload.payment_intent_id;
    if (!paymentIntentId) return res.status(400).send('Missing payment_intent_id');
    if (!ZIINA_API_KEY) return res.status(500).send('Server config error');

    // Never trust the webhook status alone; re-fetch the intent from Ziina.
    const verifyResp = await fetch(`https://api-v2.ziina.com/api/payment_intent/${encodeURIComponent(paymentIntentId)}`, {
      headers: { Authorization: `Bearer ${ZIINA_API_KEY}` },
    });
    if (!verifyResp.ok) {
      console.error('Failed to verify Ziina payment intent', await verifyResp.text());
      return res.status(502).send('Verification failed');
    }
    const intent = await verifyResp.json();

    let paymentStatus;
    switch (intent.status) {
      case 'completed': paymentStatus = 'paid'; break;
      case 'failed': paymentStatus = 'failed'; break;
      case 'canceled': paymentStatus = 'cancelled'; break;
      case 'pending':
      case 'requires_user_action': paymentStatus = 'processing'; break;
      default: paymentStatus = 'pending';
    }

    const orderResp = await fetch(
      sbUrl(`mainspring_orders?payment_gateway_ref=eq.${encodeURIComponent(paymentIntentId)}&select=order_ref`),
      { headers: sbHeaders }
    );
    if (!orderResp.ok) {
      console.error('Supabase fetch error', await orderResp.text());
      return res.status(404).send('Order not found');
    }
    const orders = await orderResp.json();
    const order = orders && orders[0];
    if (!order) return res.status(404).send('Order not found');

    const updateResp = await fetch(
      sbUrl(`mainspring_orders?payment_gateway_ref=eq.${encodeURIComponent(paymentIntentId)}`),
      { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ payment_status: paymentStatus }) }
    );
    if (!updateResp.ok) {
      console.error('Failed to update order', await updateResp.text());
      return res.status(500).send('DB update failed');
    }

    console.log(`Ziina webhook: order ${order.order_ref} -> ${paymentStatus} (intent ${paymentIntentId})`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('ziina-webhook error:', err);
    return res.status(500).send('Internal server error');
  }
});

// ----------------------------------------------------------------------------
// GET /order/:order_ref — used to render the printable receipt after checkout
// ----------------------------------------------------------------------------
app.get('/order/:order_ref', async (req, res) => {
  try {
    const orderRef = req.params.order_ref;
    if (!orderRef) return res.status(400).json({ error: 'Missing order_ref' });

    const fields = 'order_ref,customer_name,customer_email,customer_phone,customer_address,items,subtotal_aed,surcharge_pct,total_aed,payment_method,payment_status,order_status,created_at';
    const orderResp = await fetch(
      sbUrl(`mainspring_orders?order_ref=eq.${encodeURIComponent(orderRef)}&select=${fields}`),
      { headers: sbHeaders }
    );
    if (!orderResp.ok) {
      console.error('Supabase fetch error', await orderResp.text());
      return res.status(502).json({ error: 'Failed to look up order' });
    }
    const orders = await orderResp.json();
    const order = orders && orders[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    return res.json({ success: true, order });
  } catch (err) {
    console.error('order lookup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  test_mode: ZIINA_TEST_MODE,
  supabase_url_set: !!SUPABASE_URL,
  service_key_present: !!SUPABASE_SERVICE_ROLE_KEY,
  service_key_role: SUPABASE_SERVICE_ROLE_KEY ? jwtRole(SUPABASE_SERVICE_ROLE_KEY) : null,
  ziina_key_present: !!ZIINA_API_KEY,
  webhook_secret_set: !!ZIINA_WEBHOOK_SECRET,
}));
app.get('/', (_req, res) => res.send('Mainspring payments service'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`mainspring-payments running on ${port} (ziina test_mode=${ZIINA_TEST_MODE})`));
