const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync('js/app.js', 'utf8');
const styles = fs.readFileSync('css/styles.css', 'utf8');
const pageStyles = fs.readFileSync('css/pages.css', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const loader = fs.readFileSync('js/loader.js', 'utf8');
const header = fs.readFileSync('components/header.html', 'utf8');
const payments = fs.readFileSync('coolify/mainspring-payments/index.js', 'utf8');
const migrationPath = 'supabase/migrations/20260807_payment_finalizes_inventory.sql';
const searchModulePath = path.resolve('js/product-search.js');

function loadSearchModule() {
    assert.ok(fs.existsSync(searchModulePath), 'shared product-search module exists');
    delete require.cache[searchModulePath];
    return require(searchModulePath);
}

test('shared search normalizes input, rejects stale requests, and ranks only actual matches', () => {
    const {
        normalizeProductSearchTerm,
        rankProductSearchResults,
        createLatestRequestGuard,
    } = loadSearchModule();

    assert.equal(normalizeProductSearchTerm('  RÓLEX,  '), 'rolex');

    const products = [
        { id: 1, brand: 'Louis Vuitton', model: 'Vintage luggage tags', name: 'Vintage luggage tags', status: 'available' },
        { id: 2, brand: 'Rolex', model: 'Oyster Perpetual', name: 'Rolex Oyster Perpetual', status: 'available' },
        { id: 3, brand: 'Rolex', model: 'Datejust', name: 'Rolex Datejust', status: 'sold' },
        { id: 4, brand: 'Elegant', model: 'Rectangular watch', name: 'Rectangular watch', status: 'available' },
    ];

    assert.deepEqual(
        rankProductSearchResults(products, 'ROLEX').map((product) => product.id),
        [2, 3],
        'a Rolex query cannot return unrelated products and available exact-brand matches rank first'
    );
    assert.deepEqual(
        rankProductSearchResults(products, 'ROLE').map((product) => product.id),
        [2, 3],
        'prefix searches return the same relevant Rolex records'
    );

    const guard = createLatestRequestGuard();
    const roleRequest = guard.next();
    const rolexRequest = guard.next();
    assert.equal(guard.isCurrent(roleRequest), false, 'an earlier ROLE response is stale after ROLEX is requested');
    assert.equal(guard.isCurrent(rolexRequest), true);
});

test('shared search finds reference codes without requiring the REF- prefix', () => {
    const {
        buildProductSearchFilter,
        normalizeProductSearchTerm,
        rankProductSearchResults,
    } = loadSearchModule();
    const products = [
        { id: 1, reference_code: 'REF-AX001', status: 'available' },
        { id: 2, reference_code: 'REF-A001', status: 'available' },
        { id: 3, reference_code: 'REF-B001', status: 'available' },
    ];

    assert.match(buildProductSearchFilter('AX001'), /reference_code\.ilike\.\*ax001\*/);
    assert.match(buildProductSearchFilter('A001'), /reference_code\.ilike\.\*a001\*/);
    // customers see PN-A001 on the site, the database stores REF-A001
    assert.equal(normalizeProductSearchTerm('PN-A001'), 'ref-a001');
    assert.equal(normalizeProductSearchTerm('pn a001'), 'ref-a001');
    assert.equal(normalizeProductSearchTerm('PN-AX012'), 'ref-ax012');
    assert.match(buildProductSearchFilter('PN-A001'), /reference_code\.ilike\.\*ref-a001\*/);
    assert.deepEqual(
        rankProductSearchResults(products, 'AX001').map((product) => product.id),
        [1]
    );
    assert.deepEqual(
        rankProductSearchResults(products, 'A001').map((product) => product.id),
        [2]
    );
});

test('shared search fetches every matching database page before ranking', async () => {
    const { fetchAllProductSearchResults } = loadSearchModule();
    const products = Array.from({ length: 7 }, (_, index) => ({
        id: index + 1,
        brand: 'Rolex',
        model: `Model ${index + 1}`,
        name: `Rolex Model ${index + 1}`,
        status: 'available',
    }));
    const ranges = [];

    function createQuery() {
        return {
            range(from, to) {
                ranges.push([from, to]);
                return Promise.resolve({ data: products.slice(from, to + 1), error: null });
            },
        };
    }

    const results = await fetchAllProductSearchResults(createQuery, 'rolex', { batchSize: 3 });
    assert.equal(results.length, 7);
    assert.deepEqual(ranges, [[0, 2], [3, 5], [6, 8]]);
});

test('navbar and collection searches use the shared all-record search path', () => {
    assert.match(app, /fetchAllProductSearchResults\(createGlobalProductSearchQuery/);
    assert.match(app, /fetchAllProductSearchResults\(createWatchSearchQuery/);
    assert.match(app, /globalSearchRequestGuard\.isCurrent/);
    assert.doesNotMatch(app, /\.limit\(40\)/);
    assert.match(index, /js\/product-search\.js\?v=4/);
});

test('selecting a navbar result closes the overlay before opening the product', () => {
    assert.match(app, /function openProductFromSearch[\s\S]*?closeGlobalSearch\(\)[\s\S]*?showProductDetail/);
    assert.match(app, /openProductFromSearch\(event,/);
});

test('navbar search overlay uses rounded chrome and standalone square result cards', () => {
    assert.match(styles, /\.search-panel\s*\{[^}]*border-radius:\s*18px/s);
    assert.match(pageStyles, /\.search-card-image\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/s);
    assert.match(pageStyles, /\.search-card:hover \.search-card-image img\s*\{[^}]*transform:\s*scale\(1\.06\)/s);
    assert.match(pageStyles, /\.search-card-brand\s*\{[^}]*font-size:\s*0\.682rem/s);
    assert.match(pageStyles, /\.search-card-model\s*\{[^}]*font-size:\s*0\.697rem/s);
});

test('mobile navbar search keeps compact brand and model metadata', () => {
    assert.match(pageStyles, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.search-card-image\s*\{[^}]*border-radius:\s*10px/s);
    assert.match(pageStyles, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.search-card-brand\s*\{[^}]*font-size:\s*0\.638rem/s);
    assert.match(pageStyles, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.search-card-model\s*\{[^}]*font-size:\s*0\.646rem/s);
    assert.match(app, /class="search-card-image"/);
    assert.match(app, /class="search-card-brand"/);
    assert.match(app, /class="search-card-model"/);
});

test('final stylesheet keeps navbar search independent from listing-card styles', () => {
    assert.match(pageStyles, /Standalone markup \(\.search-card\) rather than the listing card/);
    assert.match(pageStyles, /\.search-card-meta\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
    assert.doesNotMatch(app.slice(app.indexOf('function renderSearchResults'), app.indexOf('function renderProducts')), /product-card/);
    assert.match(index, /css\/pages\.css\?v=10/);
    assert.match(loader, /js\/app\.js\?v=23/);
});

test('More uses the same flex alignment box as the other desktop navigation links', () => {
    assert.match(header, /<li class="nav-more">/);
    assert.match(styles, /\.header-nav\s*>\s*li\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s);
    assert.match(styles, /\.header-nav\s*>\s*li\s*>\s*a\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s);
});

test('checkout offers only card, bank transfer, and cash payment in store', () => {
    const stepStart = app.indexOf('function renderCheckoutStep2');
    const stepEnd = app.indexOf('function selectPayment', stepStart);
    const step = app.slice(stepStart, stepEnd);

    assert.match(step, /Card Payment/);
    assert.match(step, /Bank Transfer/);
    assert.match(step, /Cash Payment in Store/);
    assert.match(step, /inventory is not held until payment is confirmed/i);
    assert.doesNotMatch(step, /available within 48 hours|Confirm the reservation/i);
    assert.doesNotMatch(step, /Tabby/i);
    assert.doesNotMatch(step, /Tamara/i);
    assert.doesNotMatch(step, /Cash on Delivery/i);
});

test('cart enforces one unit per inventory record and renders no quantity controls', () => {
    const normalizeStart = app.indexOf('function normalizeStoredCart');
    const normalizeEnd = app.indexOf('let storedCart;', normalizeStart);
    const addStart = app.indexOf('function addToCart');
    const addEnd = app.indexOf('function removeFromCart', addStart);
    const renderStart = app.indexOf('function renderCart');
    const renderEnd = app.indexOf('function getCartTotal', renderStart);
    const checkoutStart = app.indexOf('function renderCheckoutStep1');
    const checkoutEnd = app.indexOf('async function applyDiscountCode', checkoutStart);

    assert.ok(normalizeStart >= 0, 'stored cart normalization exists');
    const normalizeStoredCart = new Function(`${app.slice(normalizeStart, normalizeEnd)}; return normalizeStoredCart;`)();
    assert.deepEqual(
        normalizeStoredCart([
            { id: 7, name: 'First', price: 100, qty: 4 },
            { id: '7', name: 'Duplicate', price: 100, qty: 1 },
            { id: 8, name: 'Second', price: 200 },
        ]),
        [
            { id: 7, name: 'First', price: 100, qty: 1 },
            { id: 8, name: 'Second', price: 200, qty: 1 },
        ]
    );

    assert.match(app.slice(addStart, addEnd), /image_url:\s*getProductThumbnail\(product\)/);
    assert.match(app.slice(addStart, addEnd), /name:\s*product\.model\s*\|\|\s*product\.name/);
    assert.doesNotMatch(app.slice(addStart, addEnd), /existing\.qty\s*\+=/);
    assert.match(app.slice(renderStart, renderEnd), /<img[^>]+cart-item-thumbnail[^>]+src="\$\{escapeHtml\(item\.image_url\)\}"/);
    assert.doesNotMatch(app.slice(renderStart, renderEnd), /cart-item-qty|updateCartQty|item\.qty/);
    assert.doesNotMatch(app.slice(checkoutStart, checkoutEnd), /item-qty|x\$\{item\.qty\}/);
    assert.doesNotMatch(styles, /\.cart-item-qty/);
    assert.match(app, /function hydrateCartProductDetails/);
    assert.match(app, /\.from\('mainspring_public_products'\)[\s\S]*?\.in\('id',\s*missingIds\)/);
    assert.match(styles, /\.cart-item-thumbnail\s*\{[^}]*object-fit:\s*cover/s);
    assert.match(index, /css\/styles\.css\?v=12/);
    assert.match(index, /js\/loader\.js\?v=13/);
    assert.match(loader, /js\/app\.js\?v=23/);
});

test('cash checkout creates an order before opening a product-specific WhatsApp inquiry', () => {
    const confirmStart = app.indexOf('async function confirmCheckout');
    const confirmEnd = app.indexOf('// Tap card payment', confirmStart);
    const confirmCheckout = app.slice(confirmStart, confirmEnd);
    const messageStart = app.indexOf('function buildCashInquiryMessage');
    const messageEnd = app.indexOf('function startCashInquiryWhatsApp', messageStart);
    const helperStart = app.indexOf('function toPublicRef');
    const helperEnd = app.indexOf('if (!window.MainspringSearch)', helperStart);
    const helpers = app.slice(helperStart, helperEnd);
    const buildCashInquiryMessage = new Function(`${helpers}\n${app.slice(messageStart, messageEnd)}; return buildCashInquiryMessage;`)();
    const message = buildCashInquiryMessage([
        { brand: 'Dugena', name: 'Poseidon', reference_code: 'REF-A250', qty: 1 }
    ], { name: 'Luca', phone: '+971500000000' }, 'MS-CASH-1');

    assert.match(confirmCheckout, /fetch\(PAYMENTS_BASE \+ '\/create-order'/);
    assert.match(confirmCheckout, /selectedPaymentMethod\s*===\s*'cash_in_store'[\s\S]*?showCashInStoreConfirmation\(orderRef, orderTotal, orderedItems\)/);
    assert.match(app, /function buildCashInquiryMessage/);
    assert.match(app, /item\.reference_code/);
    assert.match(message, /\(PN-A250\)/);
    assert.doesNotMatch(message, /REF-A250/);
    assert.match(app, /item\.brand/);
    assert.match(app, /item\.name/);
    assert.match(app, /inventory is not held until payment is confirmed/i);
    assert.match(app, /const chatWindow = window\.open\(whatsappUrl, '_blank'\)/);
    assert.match(app, /if \(!chatWindow\)[\s\S]*?window\.location\.assign\(whatsappUrl\)[\s\S]*?return/);
    assert.match(app, /chatWindow\.opener = null/);
    assert.match(message, /Dugena Poseidon \(PN-A250\)/);
    assert.doesNotMatch(message, /x1/);
    assert.match(message, /Order Ref: MS-CASH-1/);
    assert.match(message, /Luca/);
    assert.match(message, /subject to availability until payment is confirmed/i);
    assert.match(app, /function showCashInStoreConfirmation/);
    assert.match(payments, /validMethods\s*=\s*\[[^\]]*cash_in_store/);
});

test('bank transfer confirmation uses the supplied account holder, IBAN, and BIC', () => {
    assert.match(app, /ERKAN GULMEZ TRADING L\.L\.C/);
    assert.match(app, /AE360860000009547681874/);
    assert.match(app, /WIOBAEADXXX/);
    assert.doesNotMatch(app, /AE00 0000 0000 0000 0000 000/);
});

test('order creation delegates price validation without changing inventory state', () => {
    assert.match(payments, /validMethods\s*=\s*\['bank_transfer',\s*'ziina',\s*'cash_in_store'\]/);
    assert.match(payments, /rpc\/create_mainspring_order/);
    assert.doesNotMatch(payments, /create_mainspring_order_with_reservation/);
    assert.doesNotMatch(payments, /reservation/i);
    assert.doesNotMatch(payments, /Number\(item\.price\)/);
    assert.doesNotMatch(payments, /'tabby'|"tabby"|'tamara'|"tamara"/);
});

test('database migration leaves inventory available at order creation and marks paid watches sold atomically', () => {
    assert.ok(fs.existsSync(migrationPath), 'payment-finalization inventory migration exists');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_mainspring_order\s*\(/i);
    assert.match(sql, /FOR UPDATE/i);
    const orderFunctionStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.create_mainspring_order');
    const paidFunctionStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mark_mainspring_inventory_sold_on_payment');
    const paidFunctionEnd = sql.indexOf('-- Backward-compatible RPC shapes');
    const orderFunction = sql.slice(orderFunctionStart, paidFunctionStart);
    const paidFunction = sql.slice(paidFunctionStart, paidFunctionEnd);
    const legacyFunctionEnd = sql.indexOf('DROP TRIGGER IF EXISTS mark_mainspring_inventory_sold_on_payment_trigger');
    const legacyFunction = sql.slice(
        sql.indexOf('CREATE OR REPLACE FUNCTION public.create_mainspring_order_with_reservation'),
        legacyFunctionEnd
    );
    assert.match(paidFunction, /CREATE OR REPLACE FUNCTION public\.mark_mainspring_inventory_sold_on_payment/i);
    assert.match(paidFunction, /NEW\.payment_status\s*<>\s*'paid'/i);
    assert.match(paidFunction, /status\s*=\s*'sold'/i);
    assert.match(paidFunction, /status\s+IN\s*\('available',\s*'active'\)/i);
    assert.match(legacyFunction, /FROM public\.create_mainspring_order/i);
    assert.doesNotMatch(legacyFunction, /SET\s+status\s*=\s*'reserved'/i);
    assert.doesNotMatch(sql, /SET\s+status\s*=\s*'reserved'/i);
    assert.doesNotMatch(orderFunction, /reservation_expires_at|reserved_by_order_id|reservation_previous_status/i);
    assert.doesNotMatch(paidFunction, /reservation_expires_at|reserved_by_order_id|reservation_previous_status/i);
});
