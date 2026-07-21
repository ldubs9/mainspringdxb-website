const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('js/app.js', 'utf8');
const accessories = fs.readFileSync('components/page-accessories.html', 'utf8');
const pagesCss = fs.readFileSync('css/pages.css', 'utf8');
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
    for (const category of ['pocket-watch', 'standing-clocks', 'watch-box', 'bags-and-more', 'watch-straps']) {
        assert.match(accessories, new RegExp(`showAccessoryCategory\\('${category}'\\)`));
    }
});

test('opening a specific accessory category scrolls the filtered products into view', () => {
    const start = app.indexOf('function showAccessoryCategory');
    const end = app.indexOf('// Show all accessories', start);
    const fn = app.slice(start, end);
    assert.match(fn, /accessoryProducts['"]\)\.scrollIntoView\(\{\s*behavior:\s*['"]smooth['"]\s*\}\)/);
});
