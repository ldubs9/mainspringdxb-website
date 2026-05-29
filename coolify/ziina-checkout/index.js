const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const ZIINA_API_KEY = process.env.MAINSPRING_ZIINA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://mainspringdxb.com';

if (!ZIINA_API_KEY) {
  console.error('MAINSPRING_ZIINA_API_KEY not set');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
}

app.options('/', (req, res) => res.sendStatus(200));

app.post('/', async (req, res) => {
  try {
    const { order_ref } = req.body;
    if (!order_ref) return res.status(400).json({ error: 'Missing order_ref' });

    // Fetch order from Supabase REST
    const orderResp = await fetch(
      `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/mainspring_orders?order_ref=eq.${encodeURIComponent(order_ref)}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!orderResp.ok) {
      console.error('Supabase fetch error', await orderResp.text());
      return res.status(404).json({ error: 'Order not found' });
    }

    const orders = await orderResp.json();
    const order = orders && orders[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order already paid' });
    }

    const amountInFils = Math.round((order.total_aed || 0) * 100);
    if (amountInFils < 200) {
      return res.status(400).json({ error: 'Order total is below the minimum payment amount (2 AED)' });
    }

    // Create Ziina payment intent
    const ziinaResp = await fetch('https://api-v2.ziina.com/api/payment_intent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZIINA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountInFils,
        currency_code: 'AED',
        message: `Mainspring Dubai — Order ${order_ref}`,
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

    // Update order with payment reference
    const updateResp = await fetch(
      `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/mainspring_orders?order_ref=eq.${encodeURIComponent(order_ref)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ payment_gateway_ref: ziinaData.id, payment_status: 'processing' }),
      }
    );

    if (!updateResp.ok) {
      console.error('Failed to update order', await updateResp.text());
    }

    return res.json({ success: true, payment_url: ziinaData.redirect_url, payment_intent_id: ziinaData.id });
  } catch (err) {
    console.error('ziina-checkout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ziina-checkout running on ${port}`));
