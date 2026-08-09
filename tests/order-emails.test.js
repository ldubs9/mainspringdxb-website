const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const emailUtilsPath = path.resolve('coolify/mainspring-payments/email-utils.js');
const paymentsPath = 'coolify/mainspring-payments/index.js';
const migrationPath = 'supabase/migrations/20260731_order_email_outbox.sql';
const checkoutMigrationPath = 'supabase/migrations/20260807_payment_finalizes_inventory.sql';
const statusTriggerRepairPath = 'supabase/migrations/20260731_repair_order_status_trigger.sql';
const referenceMigrationPath = 'supabase/migrations/20260809_order_reference_codes_and_email_routing.sql';
const appPath = 'js/app.js';

test('transactional email templates escape customer data and contain order details', () => {
    assert.ok(fs.existsSync(emailUtilsPath), 'email helper module exists');
    delete require.cache[emailUtilsPath];
    const {
        buildBusinessOrderEmail,
        buildBusinessPaymentEmail,
        buildBusinessPaymentReviewEmail,
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
        items: [{
            id: 42,
            brand: 'Rolex',
            name: '<b>Datejust</b>',
            price: 15000,
            qty: 1,
            reference_code: 'REF-A001',
            thumbnail_url: 'https://cdn.example.com/watches/ref-a001.jpg?size=small&crop=1',
        }],
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
    assert.match(businessOrder.text, /REF-A001/);
    assert.match(businessOrder.html, /<img[^>]+https:\/\/cdn\.example\.com\/watches\/ref-a001\.jpg\?size=small&amp;crop=1/);
    assert.doesNotMatch(businessOrder.html, /<script>/);
    assert.doesNotMatch(businessOrder.html, /<b>Datejust<\/b>/);
    assert.match(businessOrder.html, /&lt;b&gt;Datejust&lt;\/b&gt;/);

    const businessPayment = buildBusinessPaymentEmail(order);
    assert.match(businessPayment.subject, /Payment confirmed/);
    assert.match(businessPayment.text, /AED 15,450/);
    assert.match(businessPayment.text, /REF-A001/);
    assert.match(businessPayment.html, /ref-a001\.jpg/);

    const paymentReview = buildBusinessPaymentReviewEmail(order);
    assert.match(paymentReview.subject, /ACTION REQUIRED/);
    assert.match(paymentReview.text, /REF-A001/);
    assert.match(paymentReview.html, /ref-a001\.jpg/);

    const customerPayment = buildCustomerPaymentEmail(order);
    assert.match(customerPayment.subject, /Payment receipt/);
    assert.match(customerPayment.text, /MS-EMAIL-1/);
    assert.match(customerPayment.text, /info@mainspringdubai\.com/);
    assert.doesNotMatch(customerPayment.text, /REF-A001/);
    assert.doesNotMatch(customerPayment.html, /REF-A001/);
    assert.match(customerPayment.html, /ref-a001\.jpg/);
    assert.match(customerPayment.html, /MAINSPRING DUBAI/);
    assert.match(customerPayment.html, /#f0ece4/i);
    assert.match(customerPayment.html, /#c4a265/i);
    assert.match(customerPayment.html, /#141414/i);
});

test('transactional email templates reject unsafe thumbnail URLs', () => {
    assert.ok(fs.existsSync(emailUtilsPath), 'email helper module exists');
    delete require.cache[emailUtilsPath];
    const { buildBusinessOrderEmail } = require(emailUtilsPath);
    const email = buildBusinessOrderEmail({
        order_ref: 'MS-UNSAFE-IMAGE',
        items: [{
            id: 9,
            brand: 'Omega',
            name: 'Unsafe',
            price: 100,
            qty: 1,
            reference_code: 'REF-UNSAFE',
            thumbnail_url: 'javascript:alert(1)',
        }],
    });

    assert.doesNotMatch(email.html, /javascript:/i);
    assert.doesNotMatch(email.html, /<img/);
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

test('payments service requires customer email and delivery address and runs the durable email worker', () => {
    const payments = fs.readFileSync(paymentsPath, 'utf8');
    const app = fs.readFileSync(appPath, 'utf8');

    assert.match(payments, /normalizeEmail\(customer_email\)/);
    assert.match(payments, /Missing required fields:[^']*customer_email[^']*customer_address/);
    assert.match(payments, /claim_mainspring_order_email_events/);
    assert.match(payments, /processEmailOutbox/);
    assert.match(payments, /BUSINESS_EMAIL/);
    assert.match(payments, /RESEND_API_KEY/);
    assert.match(payments, /TRANSACTIONAL_EMAIL_FROM/);
    assert.match(payments, /email_configured/);
    assert.match(payments, /consume_mainspring_order_submission_limit/);
    assert.match(payments, /status\(429\).*Too many order attempts/s);
    assert.match(app, /<label>Email \*<\/label>/);
    assert.match(app, /id="checkoutEmail"[^>]*required/);
    assert.match(app, /emailInput\.checkValidity\(\)/);
    assert.match(app, /<label>Delivery Address \*<\/label>/);
    assert.match(app, /id="checkoutAddress"[^>]*required/);
    assert.match(app, /if \(!address\)/);
    assert.match(app, /id="addressError"/);
});

test('checkout can access the HTML escaping helper before rendering customer fields', () => {
    const app = fs.readFileSync(appPath, 'utf8');
    const helperIndex = app.indexOf('function escapeHtml');
    const checkoutIndex = app.indexOf('function renderCheckoutStep1');
    const helperDefinitions = app.match(/function escapeHtml\s*\(/g) || [];

    assert.ok(helperIndex >= 0, 'HTML escaping helper exists');
    assert.ok(checkoutIndex >= 0, 'checkout renderer exists');
    assert.ok(helperIndex < checkoutIndex, 'HTML escaping helper is in checkout scope');
    assert.equal(helperDefinitions.length, 1, 'one shared HTML escaping helper is defined');
});

test('paid customers receive their receipt only by email', () => {
    const payments = fs.readFileSync(paymentsPath, 'utf8');
    const app = fs.readFileSync(appPath, 'utf8');

    assert.doesNotMatch(app, /VIEW RECEIPT|viewReceipt\(|receipt\.html/i);
    assert.doesNotMatch(payments, /app\.get\('\/order\/:order_ref'/);
    assert.equal(fs.existsSync('receipt.html'), false);
});

test('Ziina returns are verified server-side and processing payments are reconciled', () => {
    const payments = fs.readFileSync(paymentsPath, 'utf8');
    const app = fs.readFileSync(appPath, 'utf8');

    assert.match(payments, /payment_intent=\{PAYMENT_INTENT_ID\}/);
    assert.match(payments, /app\.post\('\/ziina-reconcile'/);
    assert.match(payments, /reconcileZiinaPaymentIntent\(paymentIntentId, orderRef\)/);
    assert.match(payments, /const limiterKey = 'ziina-reconcile:'/);
    assert.match(payments, /app\.post\('\/ziina-reconcile'[\s\S]*consume_mainspring_order_submission_limit/);
    assert.match(payments, /status\(429\).*Too many verification attempts/s);
    assert.match(payments, /payment_status=in\.\(processing,pending\)/);
    assert.match(payments, /setInterval\(runPaymentReconciler, PAYMENT_RECONCILE_INTERVAL_MS\)/);
    assert.match(payments, /paymentStatus === 'paid'[\s\S]*?sendZiinaFinalizationAlert\(order, paymentIntentId\)/);
    assert.match(payments, /mainspring\/ziina-finalization-review/);
    assert.match(payments, /payment_reconciliation_enabled/);
    assert.match(app, /async function handlePaymentReturn\(\)/);
    assert.match(app, /PAYMENTS_BASE \+ '\/ziina-reconcile'/);
    assert.match(app, /result\.payment_status === 'paid'/);
    assert.match(app, /Payment Verification in Progress/);
    assert.doesNotMatch(app, /<h4>Payment Successful!<\/h4>/);
});

test('paid inventory rows are locked before availability is checked and marked sold', () => {
    const sql = fs.readFileSync(checkoutMigrationPath, 'utf8');
    const paidFunctionStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mark_mainspring_inventory_sold_on_payment');
    const paidFunctionEnd = sql.indexOf('-- Backward-compatible RPC shapes');
    const paidBranch = sql.slice(paidFunctionStart, paidFunctionEnd);

    assert.match(paidBranch, /NEW\.payment_status\s*<>\s*'paid'/i);
    assert.match(paidBranch, /SELECT\s+COUNT\(\*\),\s*COUNT\(DISTINCT/i);
    assert.match(paidBranch, /PERFORM p\.id[\s\S]*ORDER BY p\.id[\s\S]*FOR UPDATE;/i);
    assert.match(paidBranch, /FOR UPDATE;[\s\S]*SELECT\s+COUNT\(\*\),[\s\S]*COUNT\(\*\)\s+FILTER/i);
    assert.match(paidBranch, /status\s+IN\s*\('available',\s*'active'\)/i);
    assert.match(paidBranch, /SET status = 'sold'/i);
    assert.doesNotMatch(paidBranch, /reserved_by_order_id|reservation_expires_at|reservation_previous_status/i);
});

test('legacy Mainspring status trigger is replaced with the canonical history table', () => {
    const sql = fs.readFileSync(statusTriggerRepairPath, 'utf8');

    assert.match(sql, /DROP TRIGGER IF EXISTS orders_status_change_trigger\s+ON public\.mainspring_orders/i);
    assert.match(sql, /INSERT INTO public\.mainspring_order_status_history/i);
    assert.doesNotMatch(sql, /INSERT INTO public\.order_status_history/i);
    assert.match(sql, /CREATE TRIGGER mainspring_orders_status_change_trigger/i);
    assert.match(sql, /NOTIFY pgrst, 'reload schema'/i);
});

test('forward migration snapshots watch references and suppresses pending Ziina owner emails', () => {
    assert.ok(fs.existsSync(referenceMigrationPath), 'reference and routing migration exists');
    const sql = fs.readFileSync(referenceMigrationPath, 'utf8');

    assert.match(sql, /ALTER TABLE public\.mainspring_orders[\s\S]*ADD COLUMN IF NOT EXISTS reference_codes TEXT\[\]/i);
    assert.match(sql, /ALTER TABLE public\.mainspring_order_status_history[\s\S]*ADD COLUMN IF NOT EXISTS reference_codes TEXT\[\]/i);
    assert.match(sql, /'reference_code'\s*,\s*CASE WHEN TG_OP = 'INSERT'[\s\S]*?p\.reference_code/i);
    assert.match(sql, /'thumbnail_url'/i);
    assert.match(sql, /NEW\.payment_method\s*<>\s*'ziina'/i);
    assert.match(sql, /event_type\s*=\s*'order_created_business'[\s\S]*payment_method\s*=\s*'ziina'/i);
    assert.match(sql, /e\.status IN \('pending', 'processing', 'failed'\)/i);
    assert.match(sql, /AND NOT \([\s\S]*e\.event_type = 'order_created_business'[\s\S]*o\.payment_method = 'ziina'/i);
    assert.match(sql, /'reference_codes'\s*,\s*o\.reference_codes/i);
});
