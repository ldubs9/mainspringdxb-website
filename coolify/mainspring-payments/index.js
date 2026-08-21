// Mainspring Dubai — consolidated payments service (for Coolify)
//
// One small Express app exposing everything the storefront needs so it can be
// deployed as a SINGLE Coolify application (one domain, one set of env vars):
//
//   POST /create-order    -> creates the order row server-side (secrets safe here)
//   POST /ziina-checkout   -> creates a Ziina payment intent, returns payment_url
//   POST /ziina-webhook    -> receives Ziina events, verifies, updates order status
//   POST /ziina-reconcile  -> verifies a returned payment when a webhook is delayed
//   GET  /health           -> healthcheck for Coolify
//
// Required environment variables (set these in Coolify -> app -> Environment):
//   MAINSPRING_ZIINA_API_KEY   Ziina secret API key (use a test key while testing)
//   SUPABASE_URL               e.g. https://sldb.swiftloop.tech
//   SUPABASE_SERVICE_ROLE_KEY  Supabase service_role key (server-side only)
//   SITE_URL                   storefront URL for post-payment redirects
//   ZIINA_TEST_MODE            "true" to create Ziina test payments (no real charge)
//   ZIINA_WEBHOOK_SECRET       (optional) secret used to verify webhook HMAC signature
//   RESEND_API_KEY             transactional email API key
//   TRANSACTIONAL_EMAIL_FROM   verified sender, e.g. Mainspring Dubai <orders@updates.mainspringdubai.com>
//   BUSINESS_EMAIL             order recipient and reply-to address
//   PAYMENT_RECONCILE_INTERVAL_MS optional stuck-payment polling interval (default 60000)

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const {
  buildBusinessOrderEmail,
  buildBusinessPaymentEmail,
  buildBusinessPaymentReviewEmail,
  buildCustomerPaymentEmail,
  normalizeEmail,
  normalizeSender,
  sendResendEmail,
} = require('./email-utils');
const { normalizeCartItems, normalizeDiscountCode } = require('./discount-utils');

const ZIINA_API_KEY = process.env.MAINSPRING_ZIINA_API_KEY;
// Accept the common self-hosted / Coolify variable names too.
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.SUPABASE_PUBLIC_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://mainspringdxb.com';
const ZIINA_TEST_MODE = process.env.ZIINA_TEST_MODE === 'true';
const ZIINA_WEBHOOK_SECRET = process.env.ZIINA_WEBHOOK_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TRANSACTIONAL_EMAIL_FROM = normalizeSender(process.env.TRANSACTIONAL_EMAIL_FROM);
const BUSINESS_EMAIL = normalizeEmail(process.env.BUSINESS_EMAIL || 'info@mainspringdubai.com');
const EMAIL_POLL_INTERVAL_MS = Math.min(
  300000,
  Math.max(5000, Number(process.env.EMAIL_POLL_INTERVAL_MS) || 15000)
);
const PAYMENT_RECONCILE_INTERVAL_MS = Math.min(
  600000,
  Math.max(30000, Number(process.env.PAYMENT_RECONCILE_INTERVAL_MS) || 60000)
);
const EMAIL_CONFIGURED = !!(RESEND_API_KEY && TRANSACTIONAL_EMAIL_FROM && BUSINESS_EMAIL);

if (!ZIINA_API_KEY) console.error('WARN: MAINSPRING_ZIINA_API_KEY not set');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.error('WARN: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
if (!EMAIL_CONFIGURED) console.error('WARN: transactional email is disabled until RESEND_API_KEY, TRANSACTIONAL_EMAIL_FROM, and BUSINESS_EMAIL are valid');

const app = express();
app.set('trust proxy', 1);
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

function emailEventMessage(event) {
  const order = event && event.order_data;
  if (!order || !order.order_ref) throw new Error('Email event has no order snapshot');

  switch (event.event_type) {
    case 'order_created_business':
      return {
        recipient: BUSINESS_EMAIL,
        idempotencyKey: 'mainspring/order-created-business/' + order.order_ref,
        ...buildBusinessOrderEmail(order),
      };
    case 'payment_confirmed_business':
      return {
        recipient: BUSINESS_EMAIL,
        idempotencyKey: 'mainspring/payment-confirmed-business/' + order.order_ref,
        ...buildBusinessPaymentEmail(order),
      };
    case 'payment_confirmed_customer': {
      const customerEmail = normalizeEmail(order.customer_email);
      if (!customerEmail) throw new Error('Paid order has no valid customer email');
      return {
        recipient: customerEmail,
        idempotencyKey: 'mainspring/payment-confirmed-customer/' + order.order_ref,
        ...buildCustomerPaymentEmail(order),
      };
    }
    default:
      throw new Error('Unsupported email event type: ' + ((event && event.event_type) || 'missing'));
  }
}

async function updateEmailEvent(eventId, values) {
  const response = await fetch(
    sbUrl('mainspring_order_email_events?id=eq.' + encodeURIComponent(eventId)),
    {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
    }
  );
  if (!response.ok) {
    const detail = String(await response.text()).substring(0, 300);
    throw new Error('Unable to update email event (' + response.status + '): ' + detail);
  }
}

async function sendZiinaFinalizationAlert(order, paymentIntentId) {
  if (!EMAIL_CONFIGURED) {
    console.error('CRITICAL: completed Ziina payment could not be finalized and owner email is not configured:', order.order_ref);
    return;
  }

  const message = buildBusinessPaymentReviewEmail(order);
  await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: TRANSACTIONAL_EMAIL_FROM,
    to: BUSINESS_EMAIL,
    replyTo: BUSINESS_EMAIL,
    subject: message.subject,
    html: message.html,
    text: message.text,
    idempotencyKey: 'mainspring/ziina-finalization-review/' + order.order_ref + '/' + paymentIntentId,
  });
}

async function processEmailOutbox() {
  if (!EMAIL_CONFIGURED || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 0;

  const claimResponse = await fetch(sbUrl('rpc/claim_mainspring_order_email_events'), {
    method: 'POST',
    headers: sbHeaders,
    body: JSON.stringify({ p_limit: 10 }),
  });
  if (!claimResponse.ok) {
    const detail = String(await claimResponse.text()).substring(0, 300);
    throw new Error('Unable to claim email events (' + claimResponse.status + '): ' + detail);
  }

  const events = await claimResponse.json();
  for (const event of Array.isArray(events) ? events : []) {
    try {
      const message = emailEventMessage(event);
      const result = await sendResendEmail({
        apiKey: RESEND_API_KEY,
        from: TRANSACTIONAL_EMAIL_FROM,
        to: message.recipient,
        replyTo: BUSINESS_EMAIL,
        subject: message.subject,
        html: message.html,
        text: message.text,
        idempotencyKey: message.idempotencyKey,
      });
      await updateEmailEvent(event.event_id, {
        status: 'sent',
        provider_message_id: result.id,
        last_error: null,
        locked_at: null,
        sent_at: new Date().toISOString(),
      });
      console.log('Transactional email sent: ' + event.event_type + ' for ' + event.order_data.order_ref);
    } catch (error) {
      const attempts = Number(event.attempts) || 1;
      const retryDelaySeconds = Math.min(3600, 30 * (2 ** Math.min(attempts - 1, 7)));
      const nextAttemptAt = new Date(Date.now() + retryDelaySeconds * 1000).toISOString();
      const failure = String((error && error.message) || error).substring(0, 500);
      try {
        await updateEmailEvent(event.event_id, {
          status: 'failed',
          last_error: failure,
          next_attempt_at: nextAttemptAt,
          locked_at: null,
        });
      } catch (updateError) {
        console.error('Failed to persist transactional email error:', updateError);
      }
      console.error(
        'Transactional email failed: ' + event.event_type + ' for '
          + ((event.order_data && event.order_data.order_ref) || 'unknown order') + ':',
        failure
      );
    }
  }
  return Array.isArray(events) ? events.length : 0;
}

let emailWorkerRunning = false;
async function runEmailWorker() {
  if (emailWorkerRunning) return;
  emailWorkerRunning = true;
  try {
    await processEmailOutbox();
  } catch (error) {
    console.error('Transactional email worker error:', error);
  } finally {
    emailWorkerRunning = false;
  }
}

function paymentStatusFromZiina(status) {
  switch (status) {
    case 'completed': return 'paid';
    case 'failed': return 'failed';
    case 'canceled': return 'cancelled';
    case 'requires_payment_instrument':
    case 'requires_user_action':
    case 'pending':
    default:
      return 'processing';
  }
}

function paymentIntentIdFromWebhook(payload) {
  const data = payload && payload.data;
  if (typeof data === 'string') return data;
  return (data && (data.id || data.payment_intent_id || (data.payment_intent && data.payment_intent.id)))
    || (payload && (payload.id || payload.payment_intent_id))
    || null;
}

async function findZiinaOrder(paymentIntentId, expectedOrderRef) {
  let filters = 'payment_gateway_ref=eq.' + encodeURIComponent(paymentIntentId);
  if (expectedOrderRef) filters += '&order_ref=eq.' + encodeURIComponent(expectedOrderRef);
  const response = await fetch(
    sbUrl('mainspring_orders?' + filters
      + '&select=order_ref,payment_method,payment_status,customer_name,customer_email,customer_phone,customer_address,items,subtotal_aed,discount_code,discount_type,discount_value,discount_aed,discounted_subtotal_aed,surcharge_pct,vat_pct,total_aed'),
    { headers: sbHeaders }
  );
  if (!response.ok) {
    throw new Error('Unable to find Ziina order (' + response.status + '): ' + String(await response.text()).substring(0, 300));
  }
  const orders = await response.json();
  return (orders && orders[0]) || null;
}

async function reconcileZiinaPaymentIntent(paymentIntentId, expectedOrderRef) {
  if (!ZIINA_API_KEY) throw new Error('Ziina is not configured');

  const order = await findZiinaOrder(paymentIntentId, expectedOrderRef);
  if (!order || order.payment_method !== 'ziina') return { found: false };
  if (order.payment_status === 'paid') {
    return { found: true, orderRef: order.order_ref, paymentStatus: 'paid', intentStatus: 'completed', changed: false };
  }

  const verifyResponse = await fetch(
    'https://api-v2.ziina.com/api/payment_intent/' + encodeURIComponent(paymentIntentId),
    { headers: { Authorization: 'Bearer ' + ZIINA_API_KEY, Accept: 'application/json' } }
  );
  if (!verifyResponse.ok) {
    throw new Error('Unable to verify Ziina payment (' + verifyResponse.status + '): ' + String(await verifyResponse.text()).substring(0, 300));
  }

  const intent = await verifyResponse.json();
  const paymentStatus = paymentStatusFromZiina(intent.status);
  const changed = paymentStatus !== order.payment_status;

  if (changed) {
    const updateResponse = await fetch(
      sbUrl(
        'mainspring_orders?payment_gateway_ref=eq.' + encodeURIComponent(paymentIntentId)
          + '&order_ref=eq.' + encodeURIComponent(order.order_ref)
      ),
      {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ payment_status: paymentStatus }),
      }
    );
    if (!updateResponse.ok) {
      const detail = String(await updateResponse.text()).substring(0, 300);
      if (paymentStatus === 'paid') {
        try {
          await sendZiinaFinalizationAlert(order, paymentIntentId);
        } catch (alertError) {
          console.error('CRITICAL: unable to send Ziina payment finalization alert:', alertError);
        }
      }
      throw new Error('Unable to update reconciled payment (' + updateResponse.status + '): ' + detail);
    }
  }

  return {
    found: true,
    orderRef: order.order_ref,
    paymentStatus,
    intentStatus: intent.status,
    changed,
  };
}

let paymentReconcilerRunning = false;
async function runPaymentReconciler() {
  if (paymentReconcilerRunning || !ZIINA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  paymentReconcilerRunning = true;
  try {
    const response = await fetch(
      sbUrl(
        'mainspring_orders?payment_method=eq.ziina'
          + '&payment_status=in.(processing,pending)'
          + '&payment_gateway_ref=not.is.null'
          + '&select=order_ref,payment_gateway_ref'
          + '&order=created_at.asc&limit=20'
      ),
      { headers: sbHeaders }
    );
    if (!response.ok) {
      throw new Error('Unable to load processing Ziina orders (' + response.status + '): ' + String(await response.text()).substring(0, 300));
    }

    const orders = await response.json();
    for (const order of Array.isArray(orders) ? orders : []) {
      try {
        const result = await reconcileZiinaPaymentIntent(order.payment_gateway_ref, order.order_ref);
        if (result.changed) {
          console.log(
            'Ziina reconciliation: order ' + result.orderRef + ' -> ' + result.paymentStatus
              + ' (intent ' + order.payment_gateway_ref + ')'
          );
        }
      } catch (error) {
        console.error('Ziina reconciliation failed for order ' + order.order_ref + ':', error);
      }
    }
  } catch (error) {
    console.error('Ziina reconciliation worker error:', error);
  } finally {
    paymentReconcilerRunning = false;
  }
}

// ----------------------------------------------------------------------------
// POST /discounts/validate
// Preview only. Order creation independently revalidates and claims usage in
// the same database transaction as order creation.
// ----------------------------------------------------------------------------
app.post('/discounts/validate', async (req, res) => {
  try {
    const { discount_code, items, customer_phone } = req.body || {};
    const cleanCode = normalizeDiscountCode(discount_code);
    const cleanItems = normalizeCartItems(items);
    if (!cleanCode) {
      return res.status(400).json({ valid: false, message: 'Enter a valid discount code.' });
    }
    if (!cleanItems) {
      return res.status(400).json({ valid: false, message: 'Your cart contains an invalid item.' });
    }

    const limiterKey = 'discount-validation:' + crypto
      .createHash('sha256')
      .update(String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'))
      .digest('hex');
    const limitResponse = await fetch(sbUrl('rpc/consume_mainspring_order_submission_limit'), {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        p_limiter_key: limiterKey,
        p_limit: 20,
        p_window_seconds: 900,
      }),
    });
    if (!limitResponse.ok) {
      console.error('Discount validation limiter failed:', limitResponse.status, await limitResponse.text());
      return res.status(502).json({ valid: false, message: 'Unable to validate discounts right now.' });
    }
    if ((await limitResponse.json()) !== true) {
      return res.status(429).json({ valid: false, message: 'Too many discount attempts. Please try again later.' });
    }

    const validationResponse = await fetch(sbUrl('rpc/validate_mainspring_discount'), {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        p_code: cleanCode,
        p_items: cleanItems,
        p_customer_phone: String(customer_phone || '').substring(0, 20),
      }),
    });
    if (!validationResponse.ok) {
      console.error('Discount validation failed:', validationResponse.status, await validationResponse.text());
      return res.status(502).json({ valid: false, message: 'Unable to validate discounts right now.' });
    }

    const rows = await validationResponse.json();
    const result = Array.isArray(rows) ? rows[0] : rows;
    if (!result) {
      return res.status(502).json({ valid: false, message: 'Unable to validate discounts right now.' });
    }
    return res.json({
      valid: result.valid === true,
      message: String(result.message || ''),
      discount_code: result.discount_code || cleanCode,
      discount_type: result.discount_type || null,
      discount_value: result.discount_value == null ? null : Number(result.discount_value),
      subtotal_aed: result.subtotal_aed == null ? null : Number(result.subtotal_aed),
      eligible_subtotal_aed: result.eligible_subtotal_aed == null ? null : Number(result.eligible_subtotal_aed),
      discount_aed: result.discount_aed == null ? null : Number(result.discount_aed),
      discounted_subtotal_aed: result.discounted_subtotal_aed == null ? null : Number(result.discounted_subtotal_aed),
    });
  } catch (error) {
    console.error('discount validation error:', error);
    return res.status(500).json({ valid: false, message: 'Unable to validate discounts right now.' });
  }
});

// ----------------------------------------------------------------------------
// POST /create-order
// ----------------------------------------------------------------------------
app.post('/create-order', async (req, res) => {
  try {
    const {
      customer_name,
      customer_email,
      customer_phone,
      customer_address,
      items,
      payment_method,
      discount_code,
    } = req.body || {};

    if (!customer_name || !customer_email || !customer_phone || !String(customer_address || '').trim() || !items?.length || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields: customer_name, customer_email, customer_phone, customer_address, items, payment_method' });
    }

    const validMethods = ['bank_transfer', 'ziina', 'cash_in_store'];
    if (!validMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const cleanPhone = String(customer_phone).replace(/[^\d+]/g, '');
    if (cleanPhone.length < 8) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const cleanEmail = normalizeEmail(customer_email);
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Invalid customer email' });
    }

    const cleanItems = normalizeCartItems(items);
    if (!cleanItems) {
      return res.status(400).json({ error: 'Each cart item must identify one valid inventory record' });
    }
    const hasDiscountCode = payment_method !== 'cash_in_store'
      && String(discount_code || '').trim().length > 0;
    const cleanDiscountCode = hasDiscountCode ? normalizeDiscountCode(discount_code) : null;
    if (hasDiscountCode && !cleanDiscountCode) {
      return res.status(400).json({ error: 'Enter a valid discount code.' });
    }

    const orderLimiterKey = 'order:' + crypto
      .createHash('sha256')
      .update(String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'))
      .digest('hex');
    const orderLimitResponse = await fetch(sbUrl('rpc/consume_mainspring_order_submission_limit'), {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        p_limiter_key: orderLimiterKey,
        p_limit: 10,
        p_window_seconds: 3600,
      }),
    });
    if (!orderLimitResponse.ok) {
      console.error('Order submission limiter failed:', orderLimitResponse.status, await orderLimitResponse.text());
      return res.status(502).json({ error: 'Unable to create this order right now.' });
    }
    if ((await orderLimitResponse.json()) !== true) {
      return res.status(429).json({ error: 'Too many order attempts. Please try again later.' });
    }

    const orderRef = 'MS-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const orderRpcPath = payment_method === 'cash_in_store'
      ? 'rpc/create_mainspring_cash_order'
      : 'rpc/create_mainspring_order';
    const rpcResp = await fetch(sbUrl(orderRpcPath), {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        p_order_ref: orderRef,
        p_customer_name: String(customer_name).substring(0, 200),
        p_customer_email: cleanEmail,
        p_customer_phone: cleanPhone.substring(0, 20),
        p_customer_address: String(customer_address).trim().substring(0, 500),
        p_items: cleanItems,
        p_payment_method: payment_method,
        p_device_type: (req.headers['user-agent'] || '').includes('Mobile') ? 'mobile' : 'desktop',
        p_user_agent: (req.headers['user-agent'] || '').substring(0, 500),
        p_discount_code: cleanDiscountCode,
      }),
    });

    if (!rpcResp.ok) {
      const detail = await rpcResp.text();
      const unavailable = /sold|no longer available|inventory/i.test(detail);
      const discountRejected = /discount|usage limit|minimum subtotal|does not apply/i.test(detail);
      console.error('Atomic order creation failed:', rpcResp.status, detail);
      return res.status(unavailable ? 409 : 400).json({
        error: unavailable
          ? 'One or more items are no longer available. Please refresh your cart.'
          : discountRejected
            ? 'This discount code can no longer be applied. Please review it or remove it.'
            : 'Unable to create this order. Please check your details and try again.',
      });
    }

    const rows = await rpcResp.json();
    const order = Array.isArray(rows) ? rows[0] : rows;
    if (!order?.order_ref) {
      console.error('Atomic order creation returned no order:', rows);
      return res.status(500).json({ error: 'Failed to create order' });
    }

    return res.status(201).json({
      success: true,
      order_ref: order.order_ref,
      subtotal_aed: Number(order.subtotal_aed),
      discount_code: order.discount_code || null,
      discount_aed: Number(order.discount_aed || 0),
      discounted_subtotal_aed: Number(order.discounted_subtotal_aed),
      total_aed: Number(order.total_aed),
      payment_method: order.payment_method,
      surcharge_pct: Number(order.surcharge_pct),
      vat_pct: Number(order.vat_pct),
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
        success_url: `${SITE_URL}?order=${encodeURIComponent(order_ref)}&status=ziina_success&payment_intent={PAYMENT_INTENT_ID}`,
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
// POST /ziina-reconcile
// ----------------------------------------------------------------------------
app.post('/ziina-reconcile', async (req, res) => {
  try {
    const orderRef = String((req.body && req.body.order_ref) || '').trim();
    const paymentIntentId = String((req.body && req.body.payment_intent_id) || '').trim();
    if (!orderRef || orderRef.length > 100 || !paymentIntentId || paymentIntentId.length > 100) {
      return res.status(400).json({ error: 'Missing or invalid payment reference' });
    }

    const limiterKey = 'ziina-reconcile:' + crypto
      .createHash('sha256')
      .update(String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'))
      .digest('hex');
    const limitResponse = await fetch(sbUrl('rpc/consume_mainspring_order_submission_limit'), {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        p_limiter_key: limiterKey,
        p_limit: 30,
        p_window_seconds: 900,
      }),
    });
    if (!limitResponse.ok) {
      console.error('Ziina reconciliation limiter failed:', limitResponse.status, await limitResponse.text());
      return res.status(502).json({ error: 'Unable to verify payment right now' });
    }
    if ((await limitResponse.json()) !== true) {
      return res.status(429).json({ error: 'Too many verification attempts. Please try again later.' });
    }

    const result = await reconcileZiinaPaymentIntent(paymentIntentId, orderRef);
    if (!result.found) return res.status(404).json({ error: 'Payment order not found' });

    console.log(
      'Ziina return reconciliation: order ' + result.orderRef + ' -> ' + result.paymentStatus
        + ' (intent ' + paymentIntentId + ')'
    );
    return res.json({
      success: true,
      order_ref: result.orderRef,
      payment_status: result.paymentStatus,
    });
  } catch (error) {
    console.error('ziina-reconcile error:', error);
    return res.status(502).json({ error: 'Unable to verify payment right now' });
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
    const paymentIntentId = paymentIntentIdFromWebhook(payload);
    if (!paymentIntentId) return res.status(400).send('Missing payment_intent_id');

    // Never trust the webhook status alone. The shared reconciler re-fetches
    // the Payment Intent from Ziina before changing the order.
    const result = await reconcileZiinaPaymentIntent(paymentIntentId);
    if (!result.found) return res.status(404).send('Order not found');

    console.log(
      'Ziina webhook: order ' + result.orderRef + ' -> ' + result.paymentStatus
        + ' (intent ' + paymentIntentId + ')'
    );
    return res.status(200).send('OK');
  } catch (err) {
    console.error('ziina-webhook error:', err);
    return res.status(500).send('Internal server error');
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
  email_configured: EMAIL_CONFIGURED,
  payment_reconciliation_enabled: !!(ZIINA_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
}));
app.get('/', (_req, res) => res.send('Mainspring payments service'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`mainspring-payments running on ${port} (ziina test_mode=${ZIINA_TEST_MODE})`));

if (EMAIL_CONFIGURED) {
  setTimeout(runEmailWorker, 1000);
  setInterval(runEmailWorker, EMAIL_POLL_INTERVAL_MS);
}

if (ZIINA_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  setTimeout(runPaymentReconciler, 2000);
  setInterval(runPaymentReconciler, PAYMENT_RECONCILE_INTERVAL_MS);
}
