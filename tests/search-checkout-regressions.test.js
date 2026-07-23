const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync('js/app.js', 'utf8');
const styles = fs.readFileSync('css/styles.css', 'utf8');
const header = fs.readFileSync('components/header.html', 'utf8');
const payments = fs.readFileSync('coolify/mainspring-payments/index.js', 'utf8');
const migrationPath = 'supabase/migrations/20260723_atomic_checkout_inventory.sql';
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
});

test('selecting a navbar result closes the overlay before opening the product', () => {
    assert.match(app, /function openProductFromSearch[\s\S]*?closeGlobalSearch\(\)[\s\S]*?showProductDetail/);
    assert.match(app, /openProductFromSearch\(event,/);
});

test('navbar search overlay has rounded chrome, larger zoomed images, and reduced card typography at all breakpoints', () => {
    assert.match(styles, /\.search-panel\s*\{[^}]*border-radius:\s*18px/s);
    assert.match(styles, /\.search-results \.product-image\s*\{[^}]*min-height:/s);
    assert.match(styles, /\.search-results \.product-image img\s*\{[^}]*transform:\s*scale\(1\.15\)/s);
    assert.match(styles, /\.search-results \.product-name\s*\{[^}]*font-size:\s*0\.504rem/s);
    assert.match(styles, /\.search-results \.product-brand\s*\{[^}]*font-size:\s*0\.805rem/s);
    assert.match(styles, /\.search-results \.product-price\s*\{[^}]*font-size:\s*0\.8925rem/s);
});

test('mobile navbar search keeps image sizing and shows compact brand, model, and price metadata', () => {
    const mobileStart = styles.indexOf('/* Mobile navbar search metadata */');
    const mobileEnd = styles.indexOf('/* End mobile navbar search metadata */', mobileStart);
    const mobileSearch = styles.slice(mobileStart, mobileEnd);

    assert.ok(mobileStart >= 0 && mobileEnd > mobileStart, 'mobile search metadata rules exist');
    assert.match(mobileSearch, /\.search-results \.product-card\s*\{[^}]*height:\s*auto/s);
    assert.match(mobileSearch, /\.search-results \.product-card \.product-info\s*\{[^}]*--product-model-font-size:\s*0\.68rem[^}]*display:\s*flex/s);
    assert.match(mobileSearch, /\.search-results \.product-card \.product-name\s*\{[^}]*font-size:\s*0\.68rem/s);
    assert.match(mobileSearch, /\.search-results \.product-card \.product-brand\s*\{[^}]*font-size:\s*0\.64rem/s);
    assert.match(mobileSearch, /\.search-results \.product-card \.product-price\s*\{[^}]*font-size:\s*0\.74rem/s);
    assert.doesNotMatch(mobileSearch, /\.search-results \.product-image\s*\{/);
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
    assert.match(step, /available within 48 hours/i);
    assert.doesNotMatch(step, /Tabby/i);
    assert.doesNotMatch(step, /Tamara/i);
    assert.doesNotMatch(step, /Cash on Delivery/i);
});

test('cash in-store confirmation explains the one-hour reservation and provides WhatsApp confirmation', () => {
    assert.match(app, /function showCashInStoreConfirmation/);
    assert.match(app, /reserved for one hour/i);
    assert.match(app, /available within 48 hours/i);
    assert.match(app, /sendOrderWhatsApp\('cash_in_store'/);
});

test('bank transfer confirmation uses the supplied account holder, IBAN, and BIC', () => {
    assert.match(app, /ERKAN GULMEZ TRADING L\.L\.C/);
    assert.match(app, /AE360860000009547681874/);
    assert.match(app, /WIOBAEADXXX/);
    assert.doesNotMatch(app, /AE00 0000 0000 0000 0000 000/);
});

test('order creation delegates price validation and reservation to one database transaction', () => {
    assert.match(payments, /validMethods\s*=\s*\['bank_transfer',\s*'ziina',\s*'cash_in_store'\]/);
    assert.match(payments, /rpc\/create_mainspring_order_with_reservation/);
    assert.doesNotMatch(payments, /Number\(item\.price\)/);
    assert.doesNotMatch(payments, /'tabby'|"tabby"|'tamara'|"tamara"/);
});

test('database migration locks inventory, expires one-hour reservations, and marks paid watches sold atomically', () => {
    assert.ok(fs.existsSync(migrationPath), 'atomic checkout migration exists');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    assert.match(sql, /reservation_expires_at\s+TIMESTAMPTZ/i);
    assert.match(sql, /reserved_by_order_id\s+UUID/i);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_mainspring_order_with_reservation/i);
    assert.match(sql, /FOR UPDATE/i);
    assert.match(sql, /INTERVAL '1 hour'/i);
    assert.match(sql, /status\s*=\s*'reserved'/i);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.sync_mainspring_inventory_from_order/i);
    assert.match(sql, /NEW\.payment_status\s*=\s*'paid'/i);
    assert.match(sql, /status\s*=\s*'sold'/i);
    assert.match(sql, /RAISE EXCEPTION[^;]*no longer reserved/i);
    assert.match(sql, /DROP POLICY IF EXISTS "Allow anonymous order creation"/i);
});
