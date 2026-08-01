const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const paymentsPath = path.join(root, 'coolify/mainspring-payments/index.js');
const discountUtilsPath = path.join(root, 'coolify/mainspring-payments/discount-utils.js');
const appPath = path.join(root, 'js/app.js');
const orderStatusPath = path.join(root, 'supabase/functions/order-status/index.ts');
const emailUtils = require('../coolify/mainspring-payments/email-utils');

function sampleDiscountedOrder() {
    return {
        order_ref: 'MS-EMAIL-DISCOUNT',
        customer_name: 'Test Customer',
        customer_email: 'customer@example.com',
        customer_phone: '+971500000001',
        customer_address: 'Dubai',
        items: [{ id: 1, brand: 'Rolex', name: 'Datejust', price: 1000, qty: 1 }],
        subtotal_aed: 1000,
        discount_code: 'SAVE10',
        discount_type: 'percentage',
        discount_value: 10,
        discount_aed: 100,
        discounted_subtotal_aed: 900,
        surcharge_pct: 3,
        total_aed: 927,
        payment_method: 'ziina',
    };
}

test('discount helpers normalize codes and reject forged or duplicate cart records', () => {
    assert.equal(fs.existsSync(discountUtilsPath), true, 'discount utility exists');
    const { normalizeDiscountCode, normalizeCartItems } = require(discountUtilsPath);

    assert.equal(normalizeDiscountCode(' save 10 '), 'SAVE10');
    assert.equal(normalizeDiscountCode('bad code!'), null);
    assert.equal(normalizeDiscountCode('AB'), null);
    assert.equal(normalizeDiscountCode('A'.repeat(33)), null);

    assert.deepEqual(
        normalizeCartItems([{ id: '7', qty: 1, price: 1, total: 1 }]),
        [{ id: 7, qty: 1 }]
    );
    assert.equal(normalizeCartItems([{ id: 7, qty: 2 }]), null);
    assert.equal(normalizeCartItems([{ id: 7 }, { id: '7' }]), null);
    assert.equal(normalizeCartItems([{ id: 0, qty: 1 }]), null);
});

test('payments service previews discounts with the existing database limiter and revalidates at order creation', () => {
    const source = fs.readFileSync(paymentsPath, 'utf8');

    assert.match(source, /app\.post\('\/discounts\/validate'/);
    assert.match(source, /rpc\/consume_mainspring_order_submission_limit/);
    assert.match(source, /discount-validation:/);
    assert.match(source, /rpc\/validate_mainspring_discount/);
    assert.match(source, /status\(429\)/);
    assert.match(source, /discount_code/);
    assert.match(source, /p_discount_code/);
    assert.match(source, /discount_aed/);
    assert.match(source, /discounted_subtotal_aed/);
});

test('transactional order emails preserve the stored discount and post-discount surcharge breakdown', () => {
    const order = sampleDiscountedOrder();
    for (const email of [
        emailUtils.buildBusinessOrderEmail(order),
        emailUtils.buildBusinessPaymentEmail(order),
        emailUtils.buildCustomerPaymentEmail(order),
    ]) {
        assert.match(email.text, /Discount \(SAVE10\): -AED 100/);
        assert.match(email.text, /Card surcharge \(3%\): AED 27/);
        assert.match(email.text, /Total: AED 927/);
        assert.match(email.html, /Discount \(SAVE10\)/);
        assert.match(email.html, /Card surcharge \(3%\)/);
    }
});

test('storefront previews one code, invalidates stale previews, and submits only the code', () => {
    const source = fs.readFileSync(appPath, 'utf8');

    assert.match(source, /let appliedDiscount = null/);
    assert.match(source, /PAYMENTS_BASE \+ '\/discounts\/validate'/);
    assert.match(source, /async function applyDiscountCode\(\)/);
    assert.match(source, /function clearDiscountCode\(\)/);
    assert.match(source, /discount_code: appliedDiscount\?\.discount_code \|\| null/);
    assert.match(source, /appliedDiscount = null;[\s\S]{0,200}localStorage\.setItem\('mainspring_cart'/);
    assert.match(source, /Discount codes are not applied to cash enquiries/);
    assert.doesNotMatch(source, /discount_value\s*\/\s*100/);
});

test('order tracking exposes the immutable order discount snapshot', () => {
    const source = fs.readFileSync(orderStatusPath, 'utf8');
    assert.match(source, /discount_code/);
    assert.match(source, /discount_aed/);
    assert.match(source, /discounted_subtotal_aed/);
});
