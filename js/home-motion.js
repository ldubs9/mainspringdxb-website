/* ============================================================================
   home-motion.js — GSAP + ScrollTrigger choreography for the Mainspring home.
   Defensive by design: if GSAP is missing or motion is reduced, the page is
   fully visible and functional. Nothing is left hidden by a failed animation.
   ============================================================================ */
(function () {
    'use strict';

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var built = false;

    function ready() {
        return typeof window.gsap !== 'undefined' &&
            typeof window.ScrollTrigger !== 'undefined' &&
            document.getElementById('page-home');
    }

    /* ---- text splitting ---------------------------------------------------- */
    function splitWords(el) {
        if (el.dataset.msSplit) return;
        el.dataset.msSplit = '1';
        // Preserve <br> as line breaks
        var html = el.innerHTML;
        var lines = html.split(/<br\s*\/?>/i);
        el.innerHTML = '';
        lines.forEach(function (line, li) {
            var lineWrap = document.createElement('span');
            lineWrap.className = 'ms-line-wrap';
            var inner = document.createElement('span');
            inner.className = 'ms-line';
            var words = line.trim().split(/\s+/);
            words.forEach(function (w, i) {
                var word = document.createElement('span');
                word.className = 'ms-word';
                var wi = document.createElement('span');
                wi.className = 'ms-word-inner';
                wi.textContent = w;
                word.appendChild(wi);
                inner.appendChild(word);
                if (i < words.length - 1) inner.appendChild(document.createTextNode(' '));
            });
            lineWrap.appendChild(inner);
            el.appendChild(lineWrap);
        });
    }

    function wordInners(el) {
        return el.querySelectorAll('.ms-word-inner');
    }

    /* ---- manifesto word highlight ----------------------------------------- */
    function wrapManifesto(el) {
        if (el.dataset.msWords) return [];
        el.dataset.msWords = '1';
        var text = el.textContent.trim().replace(/\s+/g, ' ');
        el.innerHTML = '';
        var spans = [];
        text.split(' ').forEach(function (w, i) {
            var s = document.createElement('span');
            s.className = 'ms-w';
            s.textContent = w;
            s.style.color = 'rgba(11,11,11,0.18)';
            el.appendChild(s);
            spans.push(s);
            if (i < text.split(' ').length - 1) el.appendChild(document.createTextNode(' '));
        });
        return spans;
    }

    /* ---- counters ---------------------------------------------------------- */
    function buildCounters() {
        document.querySelectorAll('#page-home .ms-stat-num').forEach(function (el) {
            var target = parseFloat(el.dataset.count || '0');
            var suffix = el.dataset.suffix || '';
            function render(v) {
                el.innerHTML = Math.round(v) + '<span class="ms-suffix">' + suffix + '</span>';
            }
            if (reduce) { render(target); return; }
            render(0);
            var obj = { v: 0 };
            gsap.to(obj, {
                v: target, duration: 1.8, ease: 'power2.out',
                scrollTrigger: { trigger: el, start: 'top 85%', once: true },
                onUpdate: function () { render(obj.v); }
            });
        });
    }

    /* ---- magnetic buttons -------------------------------------------------- */
    function magnetic() {
        if (reduce || window.matchMedia('(pointer: coarse)').matches) return;
        document.querySelectorAll('#page-home [data-magnetic]').forEach(function (el) {
            if (el.dataset.msMag) return;
            el.dataset.msMag = '1';
            var strength = 0.35;
            el.addEventListener('mousemove', function (e) {
                var r = el.getBoundingClientRect();
                var x = (e.clientX - r.left - r.width / 2) * strength;
                var y = (e.clientY - r.top - r.height / 2) * strength;
                gsap.to(el, { x: x, y: y, duration: 0.4, ease: 'power3.out' });
            });
            el.addEventListener('mouseleave', function () {
                gsap.to(el, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1, 0.4)' });
            });
        });
    }

    /* ---- main build -------------------------------------------------------- */
    function build() {
        if (built || !ready()) return;
        built = true;
        gsap.registerPlugin(ScrollTrigger);

        // pre-split titles
        document.querySelectorAll('#page-home [data-split="lines"]').forEach(splitWords);

        if (reduce) {
            // ensure everything visible, just wire counters + refresh
            gsap.set('#page-home .ms-word-inner, #page-home [data-reveal]', { clearProps: 'all' });
            buildCounters();
            ScrollTrigger.refresh();
            return;
        }

        /* HERO intro timeline */
        var hero = document.getElementById('msHero');
        if (hero) {
            var heroTitle = hero.querySelector('.ms-hero-title');
            var tl = gsap.timeline({ delay: 0.15, defaults: { ease: 'power4.out' } });
            tl.from('#msHero .ms-hero-eyebrow', { y: 24, opacity: 0, duration: 0.8 });
            if (heroTitle) {
                tl.from(wordInners(heroTitle), { yPercent: 115, duration: 1.1, stagger: 0.08 }, '-=0.4');
            }
            tl.from('#msHero .ms-hero-meta', { y: 30, opacity: 0, duration: 0.9 }, '-=0.5')
              .from('#msHero .ms-hero-dots', { y: 16, opacity: 0, duration: 0.7 }, '-=0.6')
              .from('#msHero .ms-hero-cue', { opacity: 0, duration: 0.8 }, '-=0.4')
              .from('#msHero .ms-hero-rail', { opacity: 0, duration: 0.9, stagger: 0.1 }, '-=0.7');

            // Safety net: the intro is rAF-driven. If the ticker never runs
            // (e.g. the page loaded in a fully throttled/background context),
            // force the hero content visible after the intro should have ended.
            // This setTimeout fires on the macrotask queue regardless of rAF.
            setTimeout(function () {
                var eb = document.querySelector('#msHero .ms-hero-eyebrow');
                if (eb && parseFloat(getComputedStyle(eb).opacity) < 0.05) {
                    gsap.set('#msHero .ms-hero-eyebrow, #msHero .ms-hero-meta, #msHero .ms-hero-dots, #msHero .ms-hero-cue, #msHero .ms-hero-rail', { clearProps: 'opacity,transform,x,y' });
                    if (heroTitle) gsap.set(wordInners(heroTitle), { yPercent: 0 });
                }
            }, 2800);

            // hero media parallax + scale on scroll.
            // The media layer is oversized with a top buffer in CSS (.ms-hero-media
            // .slideshow-slides) so this downward travel never exposes the hero
            // background at the top edge.
            gsap.to('#msHeroMedia .slideshow-slides', {
                yPercent: 12, ease: 'none',
                scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true }
            });
            // Fade the hero copy as the hero scrolls away. Start at 'top top' (not
            // 'center center'): when the hero is shorter than the viewport, a
            // center-based start resolves to a negative scroll position, leaving
            // the text stuck partially faded at the top of the page.
            gsap.to('#msHero .ms-hero-inner', {
                yPercent: -8, opacity: 0.2, ease: 'none',
                scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true }
            });
        }

        /* Manifesto word-by-word color */
        var man = document.querySelector('#page-home .ms-manifesto-text');
        if (man) {
            var spans = wrapManifesto(man);
            if (spans.length) {
                gsap.to(spans, {
                    color: '#0b0b0b', stagger: 1, ease: 'none',
                    scrollTrigger: { trigger: man, start: 'top 78%', end: 'bottom 55%', scrub: true }
                });
            }
        }
        gsap.utils.toArray('#page-home .ms-manifesto-top, #page-home .ms-manifesto-foot').forEach(function (el) {
            gsap.from(el, { y: 26, opacity: 0, duration: 0.9, ease: 'power3.out',
                scrollTrigger: { trigger: el, start: 'top 88%' } });
        });

        /* Featured head reveal + card stagger */
        gsap.from('#page-home .ms-featured-head-left > *', {
            y: 40, opacity: 0, duration: 0.9, stagger: 0.08, ease: 'power3.out',
            scrollTrigger: { trigger: '#msFeatured', start: 'top 75%' }
        });

        /* Showcase: parallax media + split title */
        var showcase = document.querySelector('#page-home .ms-showcase');
        if (showcase) {
            gsap.to('#page-home .ms-showcase-media', {
                yPercent: 16, ease: 'none',
                scrollTrigger: { trigger: showcase, start: 'top bottom', end: 'bottom top', scrub: true }
            });
            var sct = showcase.querySelector('.ms-showcase-title');
            if (sct) {
                gsap.from(wordInners(sct), {
                    yPercent: 115, duration: 1, stagger: 0.07, ease: 'power4.out',
                    scrollTrigger: { trigger: showcase, start: 'top 60%' }
                });
            }
            gsap.from('#page-home .ms-showcase-inner .ms-kicker, #page-home .ms-showcase-copy', {
                y: 26, opacity: 0, duration: 0.9, stagger: 0.12, ease: 'power3.out',
                scrollTrigger: { trigger: showcase, start: 'top 55%' }
            });
        }

        /* Shop blocks reveal */
        gsap.from('#page-home .ms-shop-block', {
            opacity: 0, duration: 1, stagger: 0.12, ease: 'power2.out',
            scrollTrigger: { trigger: '#page-home .ms-shop', start: 'top 80%' }
        });

        /* Standard head + rows */
        var stdTitle = document.querySelector('#page-home .ms-standard .ms-section-title');
        if (stdTitle) {
            splitWords(stdTitle);
            gsap.from(wordInners(stdTitle), {
                yPercent: 115, duration: 1, stagger: 0.06, ease: 'power4.out',
                scrollTrigger: { trigger: '#page-home .ms-standard', start: 'top 72%' }
            });
        }
        gsap.utils.toArray('#page-home .ms-standard-row').forEach(function (row) {
            gsap.from(row, {
                y: 50, opacity: 0, duration: 0.9, ease: 'power3.out',
                scrollTrigger: { trigger: row, start: 'top 85%' }
            });
        });

        /* Stats reveal */
        gsap.from('#page-home .ms-stat', {
            y: 40, opacity: 0, duration: 0.8, stagger: 0.1, ease: 'power3.out',
            scrollTrigger: { trigger: '#page-home .ms-stats', start: 'top 82%' }
        });
        buildCounters();

        /* IG head */
        gsap.from('#page-home .ms-ig-head > *', {
            y: 30, opacity: 0, duration: 0.9, stagger: 0.1, ease: 'power3.out',
            scrollTrigger: { trigger: '#page-home .ms-ig', start: 'top 80%' }
        });

        /* Closer */
        var closer = document.querySelector('#page-home .ms-closer');
        if (closer) {
            var ct = closer.querySelector('.ms-closer-title');
            if (ct) {
                gsap.from(wordInners(ct), {
                    yPercent: 115, duration: 1, stagger: 0.07, ease: 'power4.out',
                    scrollTrigger: { trigger: closer, start: 'top 70%' }
                });
            }
            gsap.from('#page-home .ms-closer .ms-kicker, #page-home .ms-closer-copy, #page-home .ms-closer-actions', {
                y: 28, opacity: 0, duration: 0.9, stagger: 0.12, ease: 'power3.out',
                scrollTrigger: { trigger: closer, start: 'top 62%' }
            });
        }

        /* generic reveal fallback for any [data-reveal] not otherwise handled */
        gsap.utils.toArray('#page-home [data-reveal]').forEach(function (el) {
            if (el.closest('.ms-standard-row') || el.classList.contains('ms-standard-row') || el.classList.contains('ms-stat')) return;
            gsap.from(el, { y: 40, opacity: 0, duration: 0.9, ease: 'power3.out',
                scrollTrigger: { trigger: el, start: 'top 85%' } });
        });

        magnetic();
        ScrollTrigger.refresh();
    }

    /* ---- SPA awareness: refresh triggers when home becomes visible --------- */
    function wrapShowPage() {
        if (window.__msShowPageWrapped) return;
        var orig = window.showPage;
        if (typeof orig !== 'function') return;
        window.__msShowPageWrapped = true;
        window.showPage = function (name) {
            var r = orig.apply(this, arguments);
            if (name === 'home' && window.ScrollTrigger) {
                requestAnimationFrame(function () {
                    window.scrollTo(0, 0);
                    ScrollTrigger.refresh();
                });
            }
            return r;
        };
    }

    function boot() {
        build();
        wrapShowPage();
    }

    if (document.readyState !== 'loading') {
        // page may already be assembled
        setTimeout(boot, 0);
    }
    window.addEventListener('componentsLoaded', function () { setTimeout(boot, 60); });
    window.addEventListener('load', function () { setTimeout(boot, 120); });

    // Re-run magnetic + refresh after async content (featured, instagram) loads
    window.addEventListener('load', function () {
        var tries = 0;
        var iv = setInterval(function () {
            tries++;
            if (window.ScrollTrigger) { magnetic(); ScrollTrigger.refresh(); }
            if (tries >= 6) clearInterval(iv);
        }, 900);
    });
})();
