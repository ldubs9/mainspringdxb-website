const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('js/app.js', 'utf8');
const accessories = fs.readFileSync('components/page-accessories.html', 'utf8');
const navOverlay = fs.readFileSync('components/nav-overlay.html', 'utf8');
const pagesCss = fs.readFileSync('css/pages.css', 'utf8');
const stylesCss = fs.readFileSync('css/styles.css', 'utf8');
const homeMotion = fs.readFileSync('js/home-motion.js', 'utf8');

test('checkout WhatsApp icons inherit the light button foreground color', () => {
    assert.match(pagesCss, /\.checkout-confirm-btn\s+\.fa-whatsapp\s*\{[^}]*color:\s*inherit\s*!important;/s);
});

test('product metadata renders non-empty deliverables immediately after movement', () => {
    const movement = app.indexOf('<span class="meta-label">Movement</span>');
    const deliverables = app.indexOf('<span class="meta-label">Deliverables</span>');
    const country = app.indexOf('<span class="meta-label">Country of Origin</span>');

    assert.ok(movement >= 0, 'movement metadata is present');
    assert.ok(deliverables > movement, 'deliverables follows movement');
    assert.ok(country > deliverables, 'deliverables precedes country');
    assert.match(app, /product\.deliverables\s*&&\s*String\(product\.deliverables\)\.trim\(\)/);
});

test('hero copy remains fully visible while scrolling the hero', () => {
    assert.doesNotMatch(homeMotion, /gsap\.to\('#msHero \.ms-hero-inner',[\s\S]*?opacity:\s*0\.2/);
});

test('accessory cards use the canonical Supabase subcategory values', () => {
    for (const category of ['pocket-watch', 'books', 'standing-clocks', 'watch-box', 'bags-and-more', 'watch-straps']) {
        assert.match(accessories, new RegExp(`showAccessoryCategory\\('${category}'\\)`));
    }
});

test('accessory categories expose Books & Catalogues and Pocket Watches and Dials', () => {
    assert.match(accessories, /<h3>BOOKS &amp; CATALOGUES<\/h3>/);
    assert.match(accessories, /accessories-books-catalogues\.png/);
    assert.match(accessories, /<h3>POCKET WATCHES AND DIALS<\/h3>/);
});

test('mobile accessory navigation uses the same canonical categories and labels', () => {
    assert.match(navOverlay, /showAccessoryCategory\('books'\)/);
    assert.match(navOverlay, /Books &amp; Catalogues/);
    assert.match(navOverlay, /showAccessoryCategory\('pocket-watch'\)/);
    assert.match(navOverlay, /Pocket Watches and Dials/);
    assert.doesNotMatch(navOverlay, /showAccessoryCategory\('(pocket-watches|watch-boxes|bags-and-others)'\)/);
});

test('opening a specific accessory category scrolls the filtered products into view', () => {
    const start = app.indexOf('function showAccessoryCategory');
    const end = app.indexOf('// Show all accessories', start);
    const fn = app.slice(start, end);
    assert.match(fn, /accessoryProducts['"]\)\.scrollIntoView\(\{\s*behavior:\s*['"]smooth['"]\s*\}\)/);
});

test('product listing queries exclude sold and archived products by default', () => {
    const helperStart = app.indexOf('function excludeUnavailableProducts');
    const helperEnd = app.indexOf('// Listing queries are fired', helperStart);
    const helper = app.slice(helperStart, helperEnd);
    const watchesStart = app.indexOf('async function loadWatches');
    const watchesEnd = app.indexOf('const PRODUCTS_PER_PAGE', watchesStart);
    const watches = app.slice(watchesStart, watchesEnd);

    assert.ok(helperStart >= 0, 'unavailable-product filter helper is present');
    assert.match(helper, /query\.or\('status\.not\.in\.\(sold,archived\),status\.is\.null'\)/);
    assert.match(watches, /q = excludeUnavailableProducts\(q\)/);
});

test('recommendation card headings use the same left-aligned model treatment as collection cards', () => {
    const recommendationsStart = app.indexOf('grid.innerHTML = recommendations.map');
    const recommendationsEnd = app.indexOf('// Touch swipe support for gallery', recommendationsStart);
    const recommendationsRenderer = app.slice(recommendationsStart, recommendationsEnd);

    assert.ok(recommendationsStart >= 0, 'recommendation card renderer is present');
    assert.match(recommendationsRenderer, /class="product-name"/);
    assert.doesNotMatch(recommendationsRenderer, /class="product-name"\s+style=/);
    assert.match(stylesCss, /\.recommendations\s*>\s*h3\s*\{/);
    assert.match(pagesCss, /\.recommendations\s*>\s*h3\s*\{/);
    assert.doesNotMatch(stylesCss, /\.recommendations\s+h3\s*\{/);
    assert.doesNotMatch(pagesCss, /\.recommendations\s+h3\s*\{/);
});

test('gallery arrow keys update both the detail gallery and the active zoom image', () => {
    const keyboardStart = app.indexOf('// Keyboard navigation: ESC closes zoom/search, arrow keys navigate gallery');
    const keyboardEnd = app.indexOf('// Visible dropdowns mirroring each hidden watch filter input', keyboardStart);
    const keyboardHandler = app.slice(keyboardStart, keyboardEnd);

    assert.ok(keyboardStart >= 0, 'gallery keyboard handler is present');
    assert.match(keyboardHandler, /zoomOverlay[\s\S]*classList\.contains\('active'\)/);
    assert.match(keyboardHandler, /zoomPrevImage\(e\)/);
    assert.match(keyboardHandler, /zoomNextImage\(e\)/);
    assert.ok(
        keyboardHandler.indexOf('const zoomOverlay') < keyboardHandler.indexOf('const activeEl'),
        'the active zoom overlay takes priority over form-control focus'
    );
});

test('active zoom navigation wins even when the background page retains input focus', () => {
    const keyboardStart = app.indexOf('// Keyboard navigation: ESC closes zoom/search, arrow keys navigate gallery');
    const keyboardEnd = app.indexOf('// Visible dropdowns mirroring each hidden watch filter input', keyboardStart);
    const keyboardHandler = app.slice(keyboardStart, keyboardEnd);
    const calls = [];
    let keydownHandler;

    vm.runInNewContext(keyboardHandler, {
        closeGlobalSearch() {},
        closeImageZoom() {},
        document: {
            activeElement: { tagName: 'INPUT' },
            addEventListener(type, handler) {
                if (type === 'keydown') keydownHandler = handler;
            },
            getElementById(id) {
                if (id === 'galleryZoomOverlay') {
                    return { classList: { contains: (className) => className === 'active' } };
                }
                return { classList: { contains: () => true } };
            },
        },
        zoomNextImage() {
            calls.push('next');
        },
        zoomPrevImage() {
            calls.push('previous');
        },
        nextImage() {
            calls.push('detail-next');
        },
        prevImage() {
            calls.push('detail-previous');
        },
    });

    let prevented = false;
    keydownHandler({
        key: 'ArrowRight',
        preventDefault() {
            prevented = true;
        },
    });

    assert.equal(prevented, true);
    assert.deepEqual(calls, ['next']);
});
