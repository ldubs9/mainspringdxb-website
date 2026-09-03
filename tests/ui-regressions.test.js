const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('js/app.js', 'utf8');
const watches = fs.readFileSync('components/page-watches.html', 'utf8');
const accessories = fs.readFileSync('components/page-accessories.html', 'utf8');
const navOverlay = fs.readFileSync('components/nav-overlay.html', 'utf8');
const pagesCss = fs.readFileSync('css/pages.css', 'utf8');
const stylesCss = fs.readFileSync('css/styles.css', 'utf8');
const home = fs.readFileSync('components/page-home.html', 'utf8');
const homeCss = fs.readFileSync('css/home.css', 'utf8');
const homeMotion = fs.readFileSync('js/home-motion.js', 'utf8');
const loader = fs.readFileSync('js/loader.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const supabaseClient = fs.readFileSync('js/supabase-client.js', 'utf8');

test('checkout WhatsApp icons inherit the light button foreground color', () => {
    assert.match(pagesCss, /\.checkout-confirm-btn\s+\.fa-whatsapp\s*\{[^}]*color:\s*inherit\s*!important;/s);
});

test('product metadata renders non-empty deliverables immediately after movement', () => {
    const movement = app.indexOf("renderDetailMeta('Movement', product.movement)");
    const deliverables = app.indexOf("renderDetailMeta('Deliverables', product.deliverables)");
    const country = app.indexOf("renderDetailMeta('Country of Origin', product.country)");

    assert.ok(movement >= 0, 'movement metadata is present');
    assert.ok(deliverables > movement, 'deliverables follows movement');
    assert.ok(country > deliverables, 'deliverables precedes country');
    assert.match(app, /renderDetailMeta\('Deliverables',\s*product\.deliverables\)/);
});

test('hero copy remains fully visible while scrolling the hero', () => {
    assert.doesNotMatch(homeMotion, /gsap\.to\('#msHero \.ms-hero-inner',[\s\S]*?opacity:\s*0\.2/);
});

test('homepage omits decorative eyebrow labels and uses shop blocks at 75% of their former height', () => {
    for (const removedCopy of [
        /Dubai\s*&middot;\s*UAE/i,
        /Est\. for the obsessed/i,
        /100% authentic with 3 months warranty/i,
        /01 \/ Multi-point inspection/i,
    ]) {
        assert.doesNotMatch(home, removedCopy);
    }

    assert.doesNotMatch(home, /class="ms-shop-num"/);
    assert.match(homeCss, /\.ms-shop\s*\{[^}]*min-height:\s*calc\(58\.5vh - 37\.5px\)/s);
    assert.match(homeCss, /@media \(max-width: 992px\)[\s\S]*?\.ms-shop-block\s*\{[^}]*min-height:\s*calc\(42vh - 37\.5px\)/);
    assert.doesNotMatch(homeMotion, /ms-hero-(?:eyebrow|rail|cue)/);
});

test('hero slideshow uses its original immediate transition without loading fallbacks', () => {
    assert.doesNotMatch(index, /<link rel="preload"[^>]*slideshow-1\.jpg/);
    assert.match(home, /class="slideshow-slide active"[^>]*slideshow-1\.jpg/);
    assert.doesNotMatch(home, /is-initial/);
    assert.doesNotMatch(stylesCss, /\.hero-slideshow\s*\{[^}]*background:[^;}]*slideshow-1\.jpg/s);
    assert.doesNotMatch(stylesCss, /\.slideshow-slide\.active\.is-initial/);
    assert.doesNotMatch(app, /preloadSlideImage|slideImageLoads|imageReady/);

    const autoplayStart = app.indexOf('function autoPlaySlideshow');
    const autoplayEnd = app.indexOf('// Parallax disabled', autoplayStart);
    const autoplay = app.slice(autoplayStart, autoplayEnd);
    assert.match(autoplay, /goToSlide\(nextIndex\);/);
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
    assert.match(helper, /query\.or\('status\.not\.in\.\(sold,reserved,archived\),status\.is\.null'\)/);
    assert.match(watches, /q = excludeUnavailableProducts\(q\)/);
});

test('watch condition control uses product conditions rather than availability status', () => {
    assert.match(watches, /id="conditionFilter"/);
    assert.match(watches, /id="drawerConditionDropdown"/);
    assert.match(watches, /selectFilter\('condition', '', this\)/);
    assert.doesNotMatch(watches, /<span class="drawer-section-title">Condition<\/span>[\s\S]*?Available Now/);
    assert.match(app, /loadConditionsFilter\(\)/);
    assert.match(app, /if \(conditionFilter\) q = q\.eq\('condition', conditionFilter\)/);
});

test('condition filter changes use fresh component and application assets', () => {
    assert.match(loader, /const COMPONENTS_VERSION = '10'/);
    assert.match(loader, /script\.src = 'js\/app\.js\?v=22'/);
    assert.match(index, /js\/loader\.js\?v=12/);
});

test('storefront derives Edge Functions URL from the shared Supabase client', () => {
    assert.match(supabaseClient, /config = Object\.freeze\(\{[\s\S]*url:/);
    assert.match(app, /const EDGE_FN_URL = window\.MainspringSupabase\.config\.url \+ '\/functions\/v1';/);
    assert.doesNotMatch(app, /const EDGE_FN_URL = SUPABASE_URL/);
});

test('reserved inventory is excluded from public UI while remaining an admin state', () => {
    assert.ok(app.includes('status.not.in.(sold,reserved,archived)'));
    assert.doesNotMatch(watches, /reserve action/i);
    assert.doesNotMatch(accessories, /reserve action/i);
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
