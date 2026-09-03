(function bootstrapMainspringStatistics(root, document) {
    'use strict';

    const utils = root.MainspringAdminUtils;
    const supabaseFactory = root.MainspringSupabase;
    const UNDATED_LABEL = 'Date not recorded';

    if (!utils || !supabaseFactory || typeof supabaseFactory.createAdminClient !== 'function') {
        throw new Error('Mainspring statistics dependencies failed to load');
    }

    const supabaseClient = supabaseFactory.createAdminClient();
    const state = {
        session: null,
        products: [],
        selectedMonth: null,
        authTransition: 0,
    };

    const elements = {
        login: document.getElementById('admin-login'),
        loginForm: document.getElementById('admin-login-form'),
        loginButton: document.getElementById('admin-login-button'),
        email: document.getElementById('admin-email'),
        password: document.getElementById('admin-password'),
        authMessage: document.getElementById('admin-auth-message'),
        app: document.getElementById('admin-statistics-app'),
        sessionEmail: document.getElementById('admin-session-email'),
        signOut: document.getElementById('admin-sign-out'),
        total: document.getElementById('admin-statistics-total'),
        recorded: document.getElementById('admin-statistics-recorded'),
        undated: document.getElementById('admin-statistics-undated'),
        months: document.getElementById('admin-statistics-months'),
        details: document.getElementById('admin-statistics-details'),
        detailsTitle: document.getElementById('admin-statistics-details-title'),
        detailsCount: document.getElementById('admin-statistics-detail-count'),
        detailsDescription: document.getElementById('admin-statistics-details-description'),
        detailsBody: document.getElementById('admin-statistics-details-body'),
        feedback: document.getElementById('admin-statistics-feedback'),
    };

    function setFeedback(element, message, tone = '') {
        element.textContent = message;
        element.classList.toggle('is-error', tone === 'error');
        element.classList.toggle('is-success', tone === 'success');
    }

    function getSoldProducts() {
        return state.products.filter((product) => utils.normalizeStatus(product.status) === 'sold');
    }

    function getMonthLabel(month) {
        return month === utils.UNKNOWN_SOLD_MONTH ? UNDATED_LABEL : utils.formatSoldMonth(month);
    }

    function getMonthProducts(month) {
        return utils.sortSoldProducts(getSoldProducts().filter((product) => {
            const productMonth = utils.getSoldMonthKey(product.sold_at) || utils.UNKNOWN_SOLD_MONTH;
            return productMonth === month;
        }));
    }

    function getDefaultMonth(monthCounts) {
        return monthCounts.find(({ month }) => month !== utils.UNKNOWN_SOLD_MONTH)?.month
            || monthCounts[0]?.month
            || null;
    }

    function renderOverview() {
        const soldProducts = getSoldProducts();
        const monthCounts = utils.countSoldByMonth(state.products);
        const undatedCount = monthCounts.find(({ month }) => month === utils.UNKNOWN_SOLD_MONTH)?.count || 0;

        elements.total.textContent = String(soldProducts.length);
        elements.recorded.textContent = String(soldProducts.length - undatedCount);
        elements.undated.textContent = String(undatedCount);
    }

    function createMonthCard(month, count) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'admin-statistics-month-card';
        if (month === utils.UNKNOWN_SOLD_MONTH) button.classList.add('is-undated');
        button.setAttribute('aria-pressed', String(state.selectedMonth === month));
        button.setAttribute('aria-label', `${getMonthLabel(month)}: ${count} sale${count === 1 ? '' : 's'}`);

        const copy = document.createElement('span');
        copy.className = 'admin-statistics-month-card-copy';
        const label = document.createElement('span');
        label.className = 'admin-statistics-month-card-label';
        label.textContent = getMonthLabel(month);
        const caption = document.createElement('span');
        caption.className = 'admin-statistics-month-card-caption';
        caption.textContent = month === utils.UNKNOWN_SOLD_MONTH ? 'Outside monthly totals' : 'All products';
        copy.append(label, caption);

        const total = document.createElement('strong');
        total.className = 'admin-statistics-month-card-total';
        total.textContent = String(count);
        button.append(copy, total);
        button.addEventListener('click', () => {
            state.selectedMonth = month;
            renderMonthCards(true);
            renderDetails();
        });
        return button;
    }

    function renderMonthCards(restoreFocus = false) {
        const monthCounts = utils.countSoldByMonth(state.products);
        if (!monthCounts.some(({ month }) => month === state.selectedMonth)) {
            state.selectedMonth = getDefaultMonth(monthCounts);
        }

        elements.months.replaceChildren();
        if (!monthCounts.length) {
            const empty = document.createElement('p');
            empty.className = 'admin-statistics-empty';
            empty.textContent = 'No completed sales are available yet.';
            elements.months.appendChild(empty);
            return;
        }

        monthCounts.forEach(({ month, count }) => {
            elements.months.appendChild(createMonthCard(month, count));
        });
        if (restoreFocus) {
            elements.months.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
        }
    }

    function appendDetailCell(row, value, className = '') {
        const cell = document.createElement('td');
        if (className) cell.className = className;
        cell.textContent = value;
        row.appendChild(cell);
    }

    function renderDetails() {
        const selectedMonth = state.selectedMonth;
        const products = selectedMonth ? getMonthProducts(selectedMonth) : [];
        const label = selectedMonth ? getMonthLabel(selectedMonth) : 'Selected month';

        elements.detailsTitle.textContent = label;
        elements.detailsCount.textContent = products.length
            ? `${products.length} sale${products.length === 1 ? '' : 's'}`
            : '';
        elements.detailsDescription.textContent = selectedMonth
            ? `${products.length} product${products.length === 1 ? '' : 's'} included in ${label.toLowerCase()}.`
            : 'Select a month above to review its sold products.';
        elements.detailsBody.replaceChildren();

        if (!products.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 4;
            cell.className = 'admin-statistics-table-empty';
            cell.textContent = 'No products to display for this selection.';
            row.appendChild(cell);
            elements.detailsBody.appendChild(row);
            return;
        }

        products.forEach((product) => {
            const row = document.createElement('tr');
            const productName = product.model || product.name || product.brand || 'Untitled product';
            const category = product.category === 'watch'
                ? 'Watch'
                : product.category === 'accessory'
                    ? 'Accessory'
                    : product.category || '—';
            appendDetailCell(row, productName, 'admin-statistics-table-product');
            appendDetailCell(row, product.reference_code || '—', 'admin-statistics-table-reference');
            appendDetailCell(row, category, 'admin-statistics-table-category');
            appendDetailCell(row, utils.formatSoldDate(product.sold_at), 'admin-statistics-table-date');
            elements.detailsBody.appendChild(row);
        });
    }

    async function fetchAllProducts() {
        const products = [];
        let from = 0;
        const batchSize = 100;
        while (true) {
            const { data, error } = await supabaseClient
                .from('mainspring_products')
                .select('id, reference_code, name, brand, model, category, status, sold_at')
                .order('reference_code', { ascending: true, nullsFirst: false })
                .range(from, from + batchSize - 1);
            if (error) throw error;
            products.push(...(data || []));
            if (!data || data.length < batchSize) break;
            from += batchSize;
        }
        return products;
    }

    async function isAdminSession(session) {
        const { data, error } = await supabaseClient
            .from('mainspring_admin_users')
            .select('user_id, active')
            .eq('user_id', session.user.id)
            .eq('active', true)
            .maybeSingle();
        if (error) throw error;
        return Boolean(data);
    }

    async function loadProducts() {
        setFeedback(elements.feedback, 'Loading sales statistics...', '');
        try {
            state.products = await fetchAllProducts();
            renderOverview();
            renderMonthCards();
            renderDetails();
            setFeedback(elements.feedback, 'Sales statistics updated.', 'success');
        } catch (error) {
            console.error('Mainspring sales statistics load failed', {
                errorCode: error && error.code ? error.code : 'unknown',
            });
            state.products = [];
            state.selectedMonth = null;
            renderOverview();
            renderMonthCards();
            renderDetails();
            setFeedback(elements.feedback, 'Unable to load sales statistics. Check your access and try again.', 'error');
        }
    }

    function showLogin(message) {
        elements.login.hidden = false;
        elements.app.hidden = true;
        if (message) setFeedback(elements.authMessage, message, 'error');
        elements.email.focus();
    }

    function showApp(session) {
        elements.login.hidden = true;
        elements.app.hidden = false;
        elements.sessionEmail.textContent = session.user.email || 'Signed-in administrator';
    }

    async function handleSession(session) {
        const transition = state.authTransition + 1;
        state.authTransition = transition;
        state.session = session;
        if (!session) {
            showLogin('');
            return;
        }

        setFeedback(elements.authMessage, 'Checking administrator access...', '');
        try {
            if (!await isAdminSession(session)) {
                await supabaseClient.auth.signOut();
                if (transition === state.authTransition) {
                    showLogin('This account is signed in but is not approved for Mainspring administration.');
                }
                return;
            }
            if (transition !== state.authTransition) return;
            showApp(session);
            await loadProducts();
        } catch (error) {
            console.error('Mainspring statistics authorization failed', {
                errorCode: error && error.code ? error.code : 'unknown',
            });
            await supabaseClient.auth.signOut();
            if (transition === state.authTransition) showLogin('Unable to verify administrator access. Try again later.');
        }
    }

    async function handleLogin(event) {
        event.preventDefault();
        const email = elements.email.value.trim();
        const password = elements.password.value;
        if (!email || !password) {
            setFeedback(elements.authMessage, 'Enter your email address and password.', 'error');
            return;
        }

        elements.loginButton.disabled = true;
        elements.loginButton.textContent = 'Signing in...';
        setFeedback(elements.authMessage, 'Signing in...', '');
        try {
            const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
        } catch (error) {
            console.error('Mainspring statistics login failed', {
                errorCode: error && error.code ? error.code : 'unknown',
            });
            setFeedback(elements.authMessage, 'Sign-in failed. Check the account details or administrator approval.', 'error');
        } finally {
            elements.loginButton.disabled = false;
            elements.loginButton.textContent = 'Sign in';
        }
    }

    async function handleSignOut() {
        await supabaseClient.auth.signOut();
    }

    function bindEvents() {
        elements.loginForm.addEventListener('submit', handleLogin);
        elements.signOut.addEventListener('click', handleSignOut);
    }

    async function init() {
        bindEvents();
        try {
            const { data, error } = await supabaseClient.auth.getSession();
            if (error) throw error;
            await handleSession(data.session);
            supabaseClient.auth.onAuthStateChange((_event, session) => {
                root.setTimeout(() => handleSession(session), 0);
            });
        } catch (error) {
            console.error('Mainspring statistics session check failed', {
                errorCode: error && error.code ? error.code : 'unknown',
            });
            showLogin('Unable to connect to the administrator sign-in service.');
        }
    }

    root.addEventListener('DOMContentLoaded', init);
    if (document.readyState !== 'loading') init();
}(window, document));
