const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminIndexPath = path.join('admin', 'index.html');
const adminScriptPath = path.join('admin', 'admin.js');
const adminUtilsPath = path.join('admin', 'admin-utils.js');
const statisticsIndexPath = path.join('admin', 'statistics.html');
const statisticsScriptPath = path.join('admin', 'statistics.js');
const migrationPath = path.join('supabase', 'migrations', '20260902_mainspring_admin_access.sql');

const readIfPresent = (filePath) => fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
const adminIndex = readIfPresent(adminIndexPath);
const adminScript = readIfPresent(adminScriptPath);
const adminCss = readIfPresent(path.join('admin', 'admin.css'));
const statisticsIndex = readIfPresent(statisticsIndexPath);
const statisticsScript = readIfPresent(statisticsScriptPath);
const migration = readIfPresent(migrationPath);

const PRODUCT_FIELDS = [
    'reference_code',
    'name',
    'brand',
    'model',
    'caption',
    'condition',
    'price',
    'category',
    'subcategory',
    'created_at',
    'watch_reference',
    'watch_year',
    'product_details',
    'status',
    'updated_at',
    'size',
    'gender',
    'country',
    'movement',
    'id',
    'image_urls',
    'deliverables',
    'sold_price',
    'sold_at',
    'cost_price',
    'draft_description',
    'draft_social',
];


test('admin route is an authenticated static application', () => {
    assert.ok(adminIndex, 'admin/index.html exists');
    assert.ok(adminIndex.includes('id="admin-login"'));
    assert.ok(adminIndex.includes('type="password"'));
    assert.ok(adminIndex.includes('@supabase/supabase-js'));
    assert.ok(adminIndex.includes('admin-utils.js'));
    assert.ok(adminIndex.includes('admin.js'));
});

test('admin editor represents every exported product field and marks system fields read-only', () => {
    assert.ok(adminScript, 'admin/admin.js exists');
    for (const field of PRODUCT_FIELDS) {
        assert.ok(adminScript.includes(field), `${field} is represented`);
    }

    for (const field of ['id', 'created_at', 'updated_at', 'sold_price', 'sold_at']) {
        const fieldStart = adminScript.indexOf(`name: '${field}'`);
        assert.ok(fieldStart >= 0, `${field} definition exists`);
        assert.ok(adminScript.slice(fieldStart, fieldStart + 220).includes('readOnly: true'), `${field} is read-only`);
    }
});

test('admin status editor exposes the three approved states and keeps the separate color marker non-persistent', () => {
    for (const status of ['available', 'reserved', 'sold']) {
        assert.ok(adminScript.includes(`value="${status}"`) || adminScript.includes(`'${status}'`), `${status} is exposed`);
    }
    assert.ok(adminScript.includes('status'));
    assert.ok(/localStorage|marker|color/i.test(adminScript));
    assert.doesNotMatch(adminScript, /admin_tag|admin_marker/);
});

test('admin marker choices apply a noticeable transparent overlay to the product row', () => {
    assert.match(adminScript, /const selectedMarker = state\.markers\[String\(product\.id\)\] \|\| 'none';/);
    assert.match(adminScript, /row\.dataset\.marker = selectedMarker;/);
    assert.match(adminCss, /\.admin-product-row::before[\s\S]*?pointer-events: none/);
    assert.match(adminCss, /\.admin-product-row\[data-marker="green"\]::before/);
    assert.match(adminCss, /\.admin-product-row\[data-marker="amber"\]::before/);
    assert.match(adminCss, /\.admin-product-row\[data-marker="red"\]::before/);
    assert.match(adminCss, /\.admin-product-row\[data-marker="blue"\]::before/);
    assert.match(adminCss, /z-index: 1/);
});

test('admin sold reporting derives combined months and ordering from sold_at only', () => {
    const utils = require(path.resolve(adminUtilsPath));
    const products = [
        { id: 1, reference_code: 'REF-1', status: 'sold', category: 'watch', sold_at: '2026-08-02 10:00:00+00' },
        { id: 2, reference_code: 'REF-2', status: 'sold', category: 'watch', sold_at: '2026-09-15 10:00:00+00' },
        { id: 3, reference_code: 'REF-3', status: 'sold', category: 'watch', sold_at: '2026-09-01 10:00:00+00' },
        { id: 4, reference_code: 'REF-4', status: 'sold', category: 'accessory', sold_at: '2026-09-20 10:00:00+00' },
        { id: 5, reference_code: 'REF-5', status: 'sold', category: 'watch', sold_at: null },
        { id: 6, reference_code: 'REF-6', status: 'available', category: 'watch', sold_at: '2026-09-25 10:00:00+00' },
    ];

    assert.equal(utils.getSoldMonthKey(products[0].sold_at), '2026-08');
    assert.equal(utils.getSoldMonthKey(products[4].sold_at), null);
    assert.deepEqual(utils.countSoldByMonth(products), [
        { month: '2026-09', count: 3 },
        { month: '2026-08', count: 1 },
        { month: utils.UNKNOWN_SOLD_MONTH, count: 1 },
    ]);
    assert.equal(utils.formatSoldMonth(utils.UNKNOWN_SOLD_MONTH), 'Date not recorded');
    assert.deepEqual(
        utils.sortSoldProducts(products.filter((product) => product.status === 'sold')).map((product) => product.id),
        [4, 2, 3, 1, 5]
    );
});

test('admin catalogue links to a separate statistics page and keeps filters focused', () => {
    assert.match(adminIndex, /href="statistics\.html"/);
    assert.match(adminIndex, /Sales statistics/);
    assert.doesNotMatch(adminIndex, /admin-sold-month-filter|admin-sold-report|admin-sold-month-summary/);
    assert.doesNotMatch(adminScript, /soldMonthFilter|renderSoldReport|populateSoldMonthFilter|soldMonth/);
    assert.match(adminScript, /sortSoldProducts\(/);
});

test('statistics page presents combined monthly sales without technical missing-field labels', () => {
    assert.ok(statisticsIndex, 'admin/statistics.html exists');
    assert.ok(statisticsScript, 'admin/statistics.js exists');
    assert.match(statisticsIndex, /Sales statistics/);
    assert.match(statisticsIndex, /id="admin-statistics-app"/);
    assert.match(statisticsIndex, /id="admin-statistics-months"/);
    assert.match(statisticsIndex, /id="admin-statistics-details"/);
    assert.match(statisticsScript, /from\('mainspring_products'\)/);
    assert.match(statisticsScript, /countSoldByMonth\(state\.products\)/);
    assert.match(statisticsScript, /sortSoldProducts\(/);
    assert.match(statisticsScript, /sold_at/);
    assert.match(statisticsScript, /Date not recorded/);
    assert.doesNotMatch(`${adminIndex}\n${adminScript}\n${statisticsIndex}\n${statisticsScript}\n${adminCss}`, /Missing sold_at/);
    assert.match(adminCss, /\.admin-statistics-page/);
    assert.match(adminCss, /\.admin-statistics-month-card/);
});

test('admin navigation and reload controls use the refined page hierarchy', () => {
    const catalogueTopbar = adminIndex.match(/<div class="admin-topbar-actions">[\s\S]*?<\/div>/)?.[0] || '';
    const statisticsTopbar = statisticsIndex.match(/<div class="admin-topbar-actions">[\s\S]*?<\/div>/)?.[0] || '';
    const summaryStart = adminIndex.indexOf('<section class="admin-summary"');
    const summaryEnd = adminIndex.indexOf('</section>', summaryStart);
    const summary = adminIndex.slice(summaryStart, summaryEnd);

    assert.match(catalogueTopbar, /href="statistics\.html">Sales statistics<\/a>[\s\S]*?href="\.\.\/" target="_blank"/);
    assert.match(statisticsTopbar, /href="\.\/">Catalogue<\/a>[\s\S]*?href="\.\.\/" target="_blank"/);
    assert.match(statisticsIndex, /class="admin-back-link" href="\.\/"[\s\S]*?admin-kicker">Commission view/);
    assert.match(adminIndex, /class="admin-catalogue-panel-actions"[\s\S]*?id="admin-refresh"[\s\S]*?admin-reload-icon[\s\S]*?id="admin-result-count"/);
    assert.doesNotMatch(summary, /admin-refresh|Sales statistics/);
    assert.match(adminCss, /\.admin-back-link/);
    assert.match(adminCss, /\.admin-catalogue-panel-actions/);
    assert.match(adminCss, /\.admin-reload-icon/);
});

test('admin specification fields expose only the approved dropdown values', () => {
    const utils = require(path.resolve(adminUtilsPath));
    assert.deepEqual(utils.CONDITION_OPTIONS, [
        'New - Unworn',
        'Used - Like New',
        'Used - Excellent',
        'Used - Very Good',
        'Used - Good',
    ]);
    assert.deepEqual(utils.CATEGORY_OPTIONS, ['watch', 'accessory']);
    assert.deepEqual(utils.ACCESSORY_SUBCATEGORY_OPTIONS, [
        'watch-straps',
        'watch-box',
        'standing-clocks',
        'books',
        'pocket-watch',
        'bags-and-more',
    ]);
    assert.deepEqual(utils.GENDER_OPTIONS, ['Unisex', 'Ladies', 'Mens']);
    assert.match(adminScript, /name: 'condition',[\s\S]*?type: 'select'/);
    assert.match(adminScript, /name: 'category',[\s\S]*?type: 'select'/);
    assert.match(adminScript, /name: 'subcategory',[\s\S]*?type: 'select'/);
    assert.match(adminScript, /name: 'gender',[\s\S]*?type: 'select'/);
});

test('admin update validation rejects non-canonical specification values', () => {
    const utils = require(path.resolve(adminUtilsPath));
    const validDraft = {
        id: 1,
        image_urls: [],
        condition: 'New - Unworn',
        category: 'watch',
        subcategory: null,
        gender: 'Unisex',
    };

    assert.equal(utils.buildProductUpdate(validDraft).subcategory, null);
    assert.throws(() => utils.buildProductUpdate({ ...validDraft, condition: 'Brand New' }), /condition/i);
    assert.throws(() => utils.buildProductUpdate({ ...validDraft, category: 'clock' }), /category/i);
    assert.throws(() => utils.buildProductUpdate({ ...validDraft, category: 'accessory', subcategory: 'other' }), /subcategory/i);
    assert.throws(() => utils.buildProductUpdate({ ...validDraft, gender: 'Men' }), /gender/i);
    assert.equal(
        utils.buildProductUpdate({
            ...validDraft,
            category: 'accessory',
            subcategory: 'watch-box',
        }).subcategory,
        'watch-box'
    );
});

test('admin save button states distinguish saved, dirty, and saving products', () => {
    const utils = require(path.resolve(adminUtilsPath));
    assert.deepEqual(
        utils.getSaveButtonState({ dirty: false, isSaving: false, saveStatus: 'saved' }),
        { label: 'Saved', disabled: true }
    );
    assert.deepEqual(
        utils.getSaveButtonState({ dirty: true, isSaving: false, saveStatus: 'idle' }),
        { label: 'Save changes', disabled: false }
    );
    assert.deepEqual(
        utils.getSaveButtonState({ dirty: true, isSaving: true, saveStatus: 'idle' }),
        { label: 'Saving...', disabled: true }
    );
    assert.match(adminScript, /renderEditor\(savedProduct, \{ saveStatus: 'saved' \}\)/);
    assert.match(adminScript, /state\.saveStatus = 'idle'/);
});

test('admin image drop targets resolve before and after positions without breaking order', () => {
    const utils = require(path.resolve(adminUtilsPath));
    assert.equal(utils.resolveDropIndex(0, 2, 'before', 4), 1);
    assert.equal(utils.resolveDropIndex(0, 2, 'after', 4), 2);
    assert.equal(utils.resolveDropIndex(3, 1, 'before', 4), 1);
    assert.equal(utils.resolveDropIndex(3, 1, 'after', 4), 2);
    assert.equal(utils.resolveDropIndex(1, 1, 'after', 4), 1);
    assert.equal(utils.resolveDropIndex(0, 9, 'before', 4), null);
    assert.match(adminScript, /resolveDropIndex\(/);
    assert.match(adminScript, /is-drag-over-before/);
    assert.match(adminScript, /is-drag-over-after/);
    assert.match(adminScript, /function bindImageDrag[\s\S]*?pointerdown[\s\S]*?pointermove[\s\S]*?pointerup[\s\S]*?pointercancel/);
    assert.match(adminScript, /setPointerCapture/);
});

test('admin image actions use compact icons with accessible hover labels', () => {
    assert.match(adminScript, /function createActionIcon\(/);
    assert.ok(adminScript.includes("thumbnailButton.className = 'admin-image-action admin-image-thumbnail-action'"));
    assert.ok(adminScript.includes("thumbnailButton.setAttribute('aria-label', index === 0 ? 'Current thumbnail' : 'Set as thumbnail')"));
    assert.ok(adminScript.includes("thumbnailButton.title = index === 0 ? 'Current thumbnail' : 'Set as thumbnail'"));
    assert.ok(adminScript.includes("upButton.setAttribute('aria-label', `Move image ${index + 1} left`)"));
    assert.ok(adminScript.includes("upButton.title = 'Move left'"));
    assert.ok(adminScript.includes("downButton.setAttribute('aria-label', `Move image ${index + 1} right`)"));
    assert.ok(adminScript.includes("downButton.title = 'Move right'"));
    assert.doesNotMatch(adminScript, /thumbnailButton\.textContent|upButton\.textContent|downButton\.textContent/);
    assert.match(adminCss, /\.admin-image-actions\s*\{[\s\S]*?min-height: 40px/);
    assert.match(adminCss, /\.admin-image-actions button\s*\{[\s\S]*?min-height: 32px[\s\S]*?height: 32px/);
    assert.match(adminCss, /\.admin-image-action-icon\s*\{[\s\S]*?width: 18px[\s\S]*?height: 18px/);
});

test('admin reload resets catalogue filters and the top bar uses the supplied logo asset', () => {
    assert.match(adminScript, /function resetCatalogueFilters[\s\S]*?elements\.search\.value = ''[\s\S]*?elements\.statusFilter\.value = ''[\s\S]*?elements\.categoryFilter\.value = ''[\s\S]*?state\.page = 1/);
    assert.match(adminScript, /elements\.refresh\.addEventListener\('click', handleRefresh\)/);
    assert.match(adminIndex, /class="admin-logo"/);
    assert.match(adminIndex, /src="\.\.\/header-icon-light\.png"/);
    assert.match(adminIndex, /admin-utils\.js\?v=5/);
    assert.match(adminIndex, /admin\.css\?v=5/);
    assert.match(adminIndex, /admin\.js\?v=5/);
    assert.doesNotMatch(adminIndex, /class="admin-wordmark"[^>]*>Mainspring<\/a>/);
});

test('admin save updates only the selected product and reads the saved row back', () => {
    assert.ok(adminScript.includes("from('mainspring_products')"));
    assert.ok(adminScript.includes('update(contentPayload)'));
    assert.ok(adminScript.includes('transition_mainspring_product_status'));
    assert.ok(adminScript.includes('status'));
    assert.ok(adminScript.includes('image_urls'));
    assert.ok(adminScript.includes("eq('id', product.id)"));
    assert.ok(adminScript.includes("select('*')"));
    assert.ok(/read.?back|reload|verify/i.test(adminScript));
});

test('admin image utilities reorder without mutating the source and promote a thumbnail', () => {
    assert.ok(fs.existsSync(adminUtilsPath), 'admin/admin-utils.js exists');
    const utils = require(path.resolve(adminUtilsPath));
    assert.deepEqual(utils.reorderImages(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
    assert.deepEqual(utils.setThumbnail(['a', 'b', 'c'], 1), ['b', 'a', 'c']);
    const source = ['a', 'b'];
    utils.setThumbnail(source, 1);
    assert.deepEqual(source, ['a', 'b']);
});

test('admin image URL validation rejects executable schemes', () => {
    const utils = require(path.resolve(adminUtilsPath));
    assert.equal(utils.isSafeImageUrl('https://cdn.example/image.jpg'), true);
    assert.equal(utils.isSafeImageUrl('http://cdn.example/image.jpg'), true);
    assert.equal(utils.isSafeImageUrl('javascript:alert(1)'), false);
    assert.equal(utils.isSafeImageUrl('data:text/html,<script>alert(1)</script>'), false);
});

test('public renderers escape admin-editable values and share the unavailable-product policy', () => {
    const app = fs.readFileSync('js/app.js', 'utf8');
    assert.ok(app.includes('escapeMarkup(firstImage)'));
    assert.ok(app.includes("escapeMarkup(displayName || '')"));
    assert.ok(app.includes("escapeMarkup(displayBrand)"));
    assert.ok(app.includes("excludeUnavailableProducts(supabaseClient"));
    assert.doesNotMatch(app, /const demoProducts/);
});

test('admin migration creates a closed admin allowlist and RLS-protected product writes', () => {
    const sql = migration.toLowerCase();
    assert.ok(migration, 'admin migration exists');
    assert.ok(sql.includes('create table if not exists public.mainspring_admin_users'));
    assert.ok(sql.includes('references auth.users(id)'));
    assert.ok(sql.includes('alter table public.mainspring_admin_users enable row level security'));
    assert.ok(sql.includes('create or replace function public.is_mainspring_admin'));
    assert.ok(sql.includes('auth.uid()'));
    assert.ok(sql.includes('create policy'));
    assert.ok(sql.includes('alter table public.mainspring_products enable row level security'));
    assert.ok(sql.includes('create view public.mainspring_public_products'));
    assert.ok(sql.includes("where status = 'available'"));
    assert.ok(sql.includes('grant select on table public.mainspring_public_products to anon, authenticated'));
    assert.doesNotMatch(sql, /grant select on table public\.mainspring_products to anon/);
    assert.ok(sql.includes('for update to authenticated'));
    assert.ok(sql.includes('is_mainspring_admin'));
    assert.ok(sql.includes('grant update'));
    assert.ok(sql.includes('transition_mainspring_product_status'));
    assert.ok(sql.includes('grant execute on function public.transition_mainspring_product_status'));
    assert.ok(sql.includes("'available', 'reserved', 'sold'"));
});

test('admin sources never contain a service-role credential', () => {
    assert.doesNotMatch(adminIndex + adminScript, /service[_ -]?role|sb_secret|secret_key/i);
});
