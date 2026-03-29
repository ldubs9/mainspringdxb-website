/**
 * loader.js — fetches all HTML components and injects them into the DOM,
 * then bootstraps the main application (js/app.js).
 *
 * Mount-point divs in index.html are replaced by the loaded component HTML.
 * Page sections are appended to <main id="main-pages"> in order.
 */
(async function () {
    // Components that replace a named mount div in index.html
    const mounts = [
        ['mount-header',           'components/header.html'],
        ['mount-nav',              'components/nav-overlay.html'],
        ['mount-whatsapp-float',   'components/whatsapp-float.html'],
        ['mount-cart-sidebar',     'components/cart-sidebar.html'],
        ['mount-wishlist-sidebar', 'components/wishlist-sidebar.html'],
        ['mount-checkout-overlay', 'components/checkout-overlay.html'],
        ['mount-footer',           'components/footer.html'],
        ['mount-search-overlay',   'components/search-overlay.html'],
    ];

    // Page sections (appended in order to <main id="main-pages">)
    const pages = [
        'components/page-home.html',
        'components/page-watches.html',
        'components/page-accessories.html',
        'components/page-detail.html',
        'components/page-blog.html',
        'components/page-blog-detail.html',
        'components/page-about.html',
        'components/page-contact.html',
        'components/page-faq.html',
        'components/page-warranty.html',
        'components/page-sourcing.html',
        'components/page-sell.html',
        'components/page-order-tracking.html',
    ];

    async function fetchHTML(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
        return res.text();
    }

    // Load all mount components and page sections in parallel
    const [mountHTMLs, pageHTMLs] = await Promise.all([
        Promise.all(mounts.map(([, src]) => fetchHTML(src))),
        Promise.all(pages.map(src => fetchHTML(src))),
    ]);

    // Inject mount components (replace each mount div with its loaded HTML)
    mounts.forEach(([id], i) => {
        const mount = document.getElementById(id);
        if (!mount) return;
        mount.insertAdjacentHTML('afterend', mountHTMLs[i]);
        mount.remove();
    });

    // Append page sections in order to main
    const main = document.getElementById('main-pages');
    pageHTMLs.forEach(html => main.insertAdjacentHTML('beforeend', html));

    // Bootstrap the app now that the full DOM is ready
    const script = document.createElement('script');
    script.src = 'js/app.js';
    document.body.appendChild(script);
})();
