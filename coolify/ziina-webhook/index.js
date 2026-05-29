const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const ZIINA_API_KEY = process.env.MAINSPRING_ZIINA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

app.post('/', async (req, res) => {
  try {
    const payload = req.body;
    const paymentIntentId = payload.id || payload.payment_intent_id;
    if (!paymentIntentId) return res.status(400).send('Missing payment_intent_id');

    if (!ZIINA_API_KEY) {
      console.error('MAINSPRING_ZIINA_API_KEY not set');
      return res.status(500).send('Server config error');
    }

    // Verify by fetching the payment intent from Ziina
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
      case 'completed':
        paymentStatus = 'paid';
        break;
      case 'failed':
        paymentStatus = 'failed';
        break;
      case 'canceled':
        paymentStatus = 'cancelled';
        break;
      case 'pending':
      case 'requires_user_action':
        paymentStatus = 'processing';
        break;
      default:
        paymentStatus = 'pending';
    }

    // Find order by payment_gateway_ref
    const orderResp = await fetch(
      `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/mainspring_orders?payment_gateway_ref=eq.${encodeURIComponent(paymentIntentId)}&select=order_ref`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!orderResp.ok) {
      console.error('Supabase fetch error', await orderResp.text());
      return res.status(404).send('Order not found');
    }

    const orders = await orderResp.json();
    const order = orders && orders[0];
    if (!order) return res.status(404).send('Order not found');

    // Update order status (idempotent by nature of setting to same value)
    const updateResp = await fetch(
      `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/mainspring_orders?payment_gateway_ref=eq.${encodeURIComponent(paymentIntentId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ payment_status: paymentStatus }),
      }
    );

    if (!updateResp.ok) {
      console.error('Failed to update order', await updateResp.text());
      return res.status(500).send('DB update failed');
    }

    console.log(`Ziina webhook: order ${order.order_ref} → ${paymentStatus} (intent ${paymentIntentId})`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('ziina-webhook error:', err);
    return res.status(500).send('Internal server error');
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`ziina-webhook running on ${port}`));
