const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const emailUtilsPath = path.resolve('coolify/mainspring-payments/email-utils.js');
const paymentsPath = 'coolify/mainspring-payments/index.js';
const migrationPath = 'supabase/migrations/20260731_order_email_outbox.sql';
const appPath = 'js/app.js';

test('transactional email templates escape customer data and contain order details', () => {
    assert.ok(fs.existsSync(emailUtilsPath), 'email helper module exists');
    delete require.cache[emailUtilsPath];
    const {
        buildBusinessOrderEmail,
        buildBusinessPaymentEmail,
        buildCustomerPaymentEmail,
        normalizeEmail,
        normalizeSender,
    } = require(emailUtilsPath);

    const order = {
        order_ref: 'MS-EMAIL-1',
        customer_name: '<script>alert(1)</script>',
        customer_email: ' Customer@Example.com ',
        customer_phone: '+971500000000',
        customer_address: 'Dubai & UAE',
        items: [{ id: 42, brand: 'Rolex', name: '<b>Datejust</b>', price: 15000, qty: 1 }],
        subtotal_aed: 15000,
        total_aed: 15450,
        payment_method: 'ziina',
        payment_status: 'paid',
    };

    assert.equal(normalizeEmail(order.customer_email), 'Customer@example.com');
    assert.equal(normalizeEmail('not-an-email'), null);
    assert.equal(
        normalizeSender('Mainspring Dubai <orders@updates.mainspringdubai.com>'),
        'Mainspring Dubai <orders@updates.mainspringdubai.com>'
    );
    assert.equal(normalizeSender('Bad Sender <not-an-email>'), null);

    const businessOrder = buildBusinessOrderEmail(order);
    assert.match(businessOrder.subject, /New order MS-EMAIL-1/);
    assert.match(businessOrder.text, /Customer@Example\.com/);
    assert.match(businessOrder.text, /Rolex <b>Datejust<\/b>/);
    assert.doesNotMatch(businessOrder.html, /<script>/);
    assert.doesNotMatch(businessOrder.html, /<b>Datejust<\/b>/);
    assert.match(businessOrder.html, /&lt;b&gt;Datejust&lt;\/b&gt;/);

    const businessPayment = buildBusinessPaymentEmail(order);
    assert.match(businessPayment.subject, /Payment confirmed/);
    assert.match(businessPayment.text, /AED 15,450/);

    const customerPayment = buildCustomerPaymentEmail(order);
    assert.match(customerPayment.subject, /Payment confirmation/);
    assert.match(customerPayment.text, /MS-EMAIL-1/);
    assert.match(customerPayment.text, /info@mainspringdubai\.com/);
});

test('Resend transport sends one idempotent API request', async () => {
    assert.ok(fs.existsSync(emailUtilsPath), 'email helper module exists');
    delete require.cache[emailUtilsPath];
    const { sendResendEmail } = require(emailUtilsPath);
    const calls = [];

    const result = await sendResendEmail({
        apiKey: 're_test',
        from: 'Mainspring Dubai <orders@updates.mainspringdubai.com>',
        to: 'customer@example.com',
        replyTo: 'info@mainspringdubai.com',
        subject: 'Payment confirmation',
        html: '<p>Paid</p>',
        text: 'Paid',
        idempotencyKey: 'mainspring/payment-confirmed-customer/MS-1',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                status: 200,
                json: async () => ({ id: 'email_123' }),
            };
        },
    });

    assert.equal(result.id, 'email_123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(
        calls[0].options.headers['Idempotency-Key'],
        'mainspring/payment-confirmed-customer/MS-1'
    );
    assert.equal(calls[0].options.headers.Authorization, 'Bearer re_test');
    assert.deepEqual(JSON.parse(calls[0].options.body).to, ['customer@example.com']);
});

test('database migration queues each event once and remains independent of discounts', () => {
    assert.ok(fs.existsSync(migrationPath), 'order email outbox migration exists');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? public\.mainspring_order_email_events/i);
    assert.match(sql, /UNIQUE\s*\(order_id,\s*event_type\)/i);
    assert.match(sql, /AFTER INSERT ON public\.mainspring_orders/i);
    assert.match(sql, /AFTER UPDATE OF payment_status ON public\.mainspring_orders/i);
    assert.match(sql, /OLD\.payment_status IS DISTINCT FROM 'paid'/i);
    assert.match(sql, /NEW\.payment_status = 'paid'/i);
    assert.match(sql, /order_created_business/i);
    assert.match(sql, /payment_confirmed_business/i);
    assert.match(sql, /payment_confirmed_customer/i);
    assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
    assert.match(sql, /consume_mainspring_order_submission_limit/i);
    assert.match(sql, /REVOKE ALL ON TABLE public\.mainspring_order_email_events FROM anon, authenticated/i);
    assert.doesNotMatch(sql, /mainspring_discount|discount_code|discount_aed/i);
});

test('payments service requires customer email and runs the durable email worker', () => {
    const payments = fs.readFileSync(paymentsPath, 'utf8');
    const app = fs.readFileSync(appPath, 'utf8');

    assert.match(payments, /normalizeEmail\(customer_email\)/);
    assert.match(payments, /Missing required fields:[^']*customer_email/);
    assert.match(payments, /claim_mainspring_order_email_events/);
    assert.match(payments, /processEmailOutbox/);
    assert.match(payments, /BUSINESS_EMAIL/);
    assert.match(payments, /RESEND_API_KEY/);
    assert.match(payments, /TRANSACTIONAL_EMAIL_FROM/);
    assert.match(payments, /email_configured/);
    assert.match(payments, /consume_mainspring_order_submission_limit/);
    assert.match(payments, /status\(429\).*Too many order attempts/s);
    assert.doesNotMatch(payments, /discount/i);
    assert.match(app, /<label>Email \*<\/label>/);
    assert.match(app, /id="checkoutEmail"[^>]*required/);
    assert.match(app, /emailInput\.checkValidity\(\)/);
});
