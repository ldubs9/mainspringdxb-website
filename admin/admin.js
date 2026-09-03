(function bootstrapMainspringAdmin(root, document) {
    'use strict';

    const utils = root.MainspringAdminUtils;
    const supabaseFactory = root.MainspringSupabase;

    if (!utils || !supabaseFactory || typeof supabaseFactory.createAdminClient !== 'function') {
        throw new Error('Mainspring admin dependencies failed to load');
    }

    const supabaseClient = supabaseFactory.createAdminClient();
    const PAGE_SIZE = 36;
    const ADMIN_STATUS_OPTIONS = Object.freeze(['available', 'reserved', 'sold']);
    const MARKER_STORAGE_KEY = 'mainspring-admin-markers';
    const MARKERS = Object.freeze([
        { id: 'none', label: 'No marker' },
        { id: 'green', label: 'Green marker' },
        { id: 'amber', label: 'Amber marker' },
        { id: 'red', label: 'Red marker' },
        { id: 'blue', label: 'Blue marker' },
    ]);

    // This is the exported mainspring_products contract. System fields remain
    // visible for audit context but are never included in update payloads.
    const PRODUCT_FIELD_DEFINITIONS = Object.freeze([
        { name: 'reference_code', label: 'Reference code', type: 'text', section: 'content' },
        { name: 'name', label: 'Name', type: 'text', section: 'content' },
        { name: 'brand', label: 'Brand', type: 'text', section: 'content' },
        { name: 'model', label: 'Model', type: 'text', section: 'content' },
        { name: 'caption', label: 'Caption', type: 'textarea', section: 'content', wide: true },
        { name: 'condition', label: 'Condition', type: 'text', section: 'specifications' },
        { name: 'price', label: 'Price (AED)', type: 'number', section: 'specifications', min: '0', step: '0.01' },
        { name: 'category', label: 'Category', type: 'text', section: 'specifications' },
        { name: 'subcategory', label: 'Subcategory', type: 'text', section: 'specifications' },
        { name: 'created_at', label: 'Created at', type: 'text', section: 'system', readOnly: true },
        { name: 'watch_reference', label: 'Watch reference', type: 'text', section: 'specifications' },
        { name: 'watch_year', label: 'Watch year', type: 'text', section: 'specifications' },
        { name: 'product_details', label: 'Product details', type: 'textarea', section: 'content', wide: true },
        { name: 'status', label: 'Status', type: 'status', section: 'status' },
        { name: 'updated_at', label: 'Updated at', type: 'text', section: 'system', readOnly: true },
        { name: 'size', label: 'Size', type: 'text', section: 'specifications' },
        { name: 'gender', label: 'Gender', type: 'text', section: 'specifications' },
        { name: 'country', label: 'Country of origin', type: 'text', section: 'specifications' },
        { name: 'movement', label: 'Movement', type: 'text', section: 'specifications' },
        { name: 'id', label: 'Database id', type: 'text', section: 'system', readOnly: true },
        { name: 'image_urls', label: 'Product images', type: 'images', section: 'images' },
        { name: 'deliverables', label: 'Deliverables', type: 'textarea', section: 'specifications', wide: true },
        { name: 'sold_price', label: 'Sold price', type: 'text', section: 'system', readOnly: true },
        { name: 'sold_at', label: 'Sold at', type: 'text', section: 'system', readOnly: true },
        { name: 'cost_price', label: 'Cost price (AED)', type: 'number', section: 'specifications', min: '0', step: '0.01' },
        { name: 'draft_description', label: 'Draft description', type: 'textarea', section: 'drafts', wide: true },
        { name: 'draft_social', label: 'Draft social copy', type: 'textarea', section: 'drafts', wide: true },
    ]);

    const state = {
        session: null,
        products: [],
        filteredProducts: [],
        selectedProduct: null,
        imageUrls: [],
        selectedImageIndex: 0,
        page: 1,
        dirty: false,
        isSaving: false,
        draggedImageIndex: null,
        markers: readMarkers(),
        authTransition: 0,
    };

    const elements = {
        login: document.getElementById('admin-login'),
        loginForm: document.getElementById('admin-login-form'),
        loginButton: document.getElementById('admin-login-button'),
        email: document.getElementById('admin-email'),
        password: document.getElementById('admin-password'),
        authMessage: document.getElementById('admin-auth-message'),
        app: document.getElementById('admin-app'),
        sessionEmail: document.getElementById('admin-session-email'),
        signOut: document.getElementById('admin-sign-out'),
        refresh: document.getElementById('admin-refresh'),
        search: document.getElementById('admin-product-search'),
        statusFilter: document.getElementById('admin-status-filter'),
        categoryFilter: document.getElementById('admin-category-filter'),
        listFeedback: document.getElementById('admin-list-feedback'),
        productList: document.getElementById('admin-product-list'),
        resultCount: document.getElementById('admin-result-count'),
        pagination: document.getElementById('admin-pagination'),
        totalCount: document.getElementById('admin-total-count'),
        availableCount: document.getElementById('admin-available-count'),
        reservedCount: document.getElementById('admin-reserved-count'),
        soldCount: document.getElementById('admin-sold-count'),
        editorEmpty: document.getElementById('admin-editor-empty'),
        form: document.getElementById('admin-product-form'),
        editorKicker: document.getElementById('admin-editor-kicker'),
        editorTitle: document.getElementById('editor-title'),
        editorSubtitle: document.getElementById('admin-editor-subtitle'),
        editorState: document.getElementById('admin-editor-state'),
        status: document.getElementById('admin-field-status'),
        imageManager: document.getElementById('admin-image-manager'),
        imageFeedback: document.getElementById('admin-image-feedback'),
        contentFields: document.getElementById('admin-content-fields'),
        specificationFields: document.getElementById('admin-specification-fields'),
        draftFields: document.getElementById('admin-draft-fields'),
        systemFields: document.getElementById('admin-system-fields'),
        saveButton: document.getElementById('admin-save-button'),
        saveNote: document.getElementById('admin-save-note'),
        saveFeedback: document.getElementById('admin-save-feedback'),
    };

    function readMarkers() {
        try {
            const stored = JSON.parse(root.localStorage.getItem(MARKER_STORAGE_KEY) || '{}');
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
            const allowed = new Set(MARKERS.map((marker) => marker.id));
            return Object.fromEntries(
                Object.entries(stored).filter(([, marker]) => allowed.has(marker))
            );
        } catch (error) {
            return {};
        }
    }

    function persistMarkers() {
        try {
            root.localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(state.markers));
        } catch (error) {
            // A private browsing context may reject local storage. The marker is
            // still useful for the current view, so keep the in-memory state.
        }
    }

    function setMarker(productId, markerId) {
        if (markerId === 'none') {
            delete state.markers[String(productId)];
        } else {
            state.markers[String(productId)] = markerId;
        }
        persistMarkers();
        renderProductList();
    }

    function setFeedback(element, message, kind) {
        element.textContent = message || '';
        element.classList.toggle('is-error', kind === 'error');
        element.classList.toggle('is-success', kind === 'success');
    }

    function renderStatusOptions() {
        elements.status.replaceChildren();
        ADMIN_STATUS_OPTIONS.forEach((status) => {
            const option = document.createElement('option');
            option.value = status;
            option.textContent = normalizeStatusLabel(status);
            elements.status.appendChild(option);
        });
    }

    function cloneProduct(product) {
        return {
            ...product,
            image_urls: Array.isArray(product.image_urls) ? product.image_urls.slice() : [],
        };
    }

    function displayValue(value) {
        if (value === null || value === undefined || String(value).trim() === '') return '-';
        return String(value);
    }

    function normalizeStatusLabel(status) {
        const normalized = utils.normalizeStatus(status);
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    function statusClass(status) {
        return `status-${utils.normalizeStatus(status)}`;
    }

    function formatPrice(value) {
        const amount = Number(value);
        if (!Number.isFinite(amount)) return '-';
        return new Intl.NumberFormat('en-AE', {
            style: 'currency',
            currency: 'AED',
            maximumFractionDigits: 0,
        }).format(amount);
    }

    function createField(definition, product) {
        const wrapper = document.createElement('div');
        wrapper.className = `admin-field${definition.wide ? ' admin-field-wide' : ''}`;

        const label = document.createElement('label');
        label.htmlFor = `admin-field-${definition.name}`;
        label.textContent = definition.label;
        wrapper.appendChild(label);

        const value = product[definition.name];
        const input = definition.type === 'textarea'
            ? document.createElement('textarea')
            : document.createElement('input');
        input.id = `admin-field-${definition.name}`;
        input.name = definition.name;
        input.autocomplete = 'off';

        if (definition.type === 'number') {
            input.type = 'number';
            input.min = definition.min;
            input.step = definition.step;
            input.inputMode = 'decimal';
        } else if (definition.type !== 'textarea') {
            input.type = 'text';
        }

        input.value = value === null || value === undefined ? '' : String(value);
        if (definition.readOnly) {
            input.readOnly = true;
            input.tabIndex = -1;
        } else {
            input.addEventListener('input', markDirty);
        }

        wrapper.appendChild(input);
        return wrapper;
    }

    function renderEditorFields(product) {
        const containers = {
            content: elements.contentFields,
            specifications: elements.specificationFields,
            drafts: elements.draftFields,
            system: elements.systemFields,
        };

        Object.values(containers).forEach((container) => container.replaceChildren());
        PRODUCT_FIELD_DEFINITIONS
            .filter((definition) => ['content', 'specifications', 'drafts', 'system'].includes(definition.section))
            .filter((definition) => definition.name !== 'status')
            .forEach((definition) => containers[definition.section].appendChild(createField(definition, product)));
    }

    function renderEditor(product) {
        state.selectedProduct = cloneProduct(product);
        state.imageUrls = state.selectedProduct.image_urls.slice();
        state.selectedImageIndex = 0;
        state.dirty = false;
        elements.editorEmpty.hidden = true;
        elements.form.hidden = false;
        elements.editorKicker.textContent = product.reference_code || `Product ${product.id}`;
        elements.editorTitle.textContent = product.model || product.name || product.brand || 'Edit product';
        elements.editorSubtitle.textContent = [product.brand, product.reference_code || `ID ${product.id}`]
            .filter(Boolean)
            .join(' · ');
        elements.status.value = utils.normalizeStatus(product.status);
        elements.status.onchange = markDirty;
        renderEditorFields(product);
        renderImageManager();
        setFeedback(elements.imageFeedback, '', '');
        setFeedback(elements.saveFeedback, '', '');
        updateSaveState();
    }

    function hasUnsavedChanges() {
        return Boolean(state.dirty && state.selectedProduct);
    }

    function markDirty() {
        state.dirty = true;
        updateSaveState();
    }

    function updateSaveState() {
        elements.editorState.textContent = state.dirty ? 'Unsaved changes' : 'No unsaved changes';
        elements.editorState.classList.toggle('is-dirty', state.dirty);
        elements.saveButton.disabled = !state.dirty || state.isSaving;
        elements.saveButton.textContent = state.isSaving ? 'Saving...' : 'Save changes';
        elements.saveNote.textContent = state.dirty
            ? 'Review the complete product before saving.'
            : 'Changes are not saved automatically.';
    }

    function renderImageManager() {
        elements.imageManager.replaceChildren();
        if (!state.imageUrls.length) {
            const empty = document.createElement('p');
            empty.className = 'admin-section-description';
            empty.textContent = 'This product has no image URLs.';
            elements.imageManager.appendChild(empty);
            return;
        }

        state.imageUrls.forEach((url, index) => {
            const item = document.createElement('article');
            item.className = 'admin-image-item';
            item.draggable = true;
            item.dataset.index = String(index);
            item.classList.toggle('is-selected', state.selectedImageIndex === index);
            item.classList.toggle('is-thumbnail', index === 0);

            const selectButton = document.createElement('button');
            selectButton.type = 'button';
            selectButton.className = 'admin-image-select';
            selectButton.setAttribute('aria-label', `Select image ${index + 1}`);
            selectButton.setAttribute('aria-pressed', String(state.selectedImageIndex === index));
            selectButton.addEventListener('click', () => {
                state.selectedImageIndex = index;
                renderImageManager();
            });

            if (utils.isSafeImageUrl(url)) {
                const image = document.createElement('img');
                image.src = url;
                image.alt = `Product image ${index + 1}`;
                image.loading = 'lazy';
                image.draggable = false;
                if (state.selectedProduct && ['sold', 'reserved'].includes(state.selectedProduct.status)) {
                    image.classList.add('is-unavailable');
                }
                selectButton.appendChild(image);
            } else {
                const placeholder = document.createElement('span');
                placeholder.className = 'admin-image-placeholder';
                placeholder.textContent = '?';
                selectButton.appendChild(placeholder);
            }
            item.appendChild(selectButton);

            const caption = document.createElement('div');
            caption.className = 'admin-image-caption';
            const position = document.createElement('span');
            position.textContent = `Image ${index + 1}`;
            const role = document.createElement('strong');
            role.textContent = index === 0 ? 'Thumbnail' : 'Gallery';
            caption.append(position, role);
            item.appendChild(caption);

            const actions = document.createElement('div');
            actions.className = 'admin-image-actions';
            const thumbnailButton = document.createElement('button');
            thumbnailButton.type = 'button';
            thumbnailButton.textContent = index === 0 ? 'Thumbnail' : 'Set as thumbnail';
            thumbnailButton.disabled = index === 0;
            thumbnailButton.addEventListener('click', () => promoteThumbnail(index));
            actions.appendChild(thumbnailButton);

            const upButton = document.createElement('button');
            upButton.type = 'button';
            upButton.textContent = 'Up';
            upButton.setAttribute('aria-label', `Move image ${index + 1} up`);
            upButton.disabled = index === 0;
            upButton.addEventListener('click', () => moveImage(index, index - 1));
            actions.appendChild(upButton);

            const downButton = document.createElement('button');
            downButton.type = 'button';
            downButton.textContent = 'Down';
            downButton.setAttribute('aria-label', `Move image ${index + 1} down`);
            downButton.disabled = index === state.imageUrls.length - 1;
            downButton.addEventListener('click', () => moveImage(index, index + 1));
            actions.appendChild(downButton);
            item.appendChild(actions);

            item.addEventListener('dragstart', (event) => {
                state.draggedImageIndex = index;
                item.classList.add('is-dragging');
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
            });
            item.addEventListener('dragover', (event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            });
            item.addEventListener('drop', (event) => {
                event.preventDefault();
                const fromIndex = Number(event.dataTransfer.getData('text/plain'));
                const resolvedFrom = Number.isInteger(fromIndex) ? fromIndex : state.draggedImageIndex;
                moveImage(resolvedFrom, index);
            });
            item.addEventListener('dragend', () => {
                state.draggedImageIndex = null;
                item.classList.remove('is-dragging');
            });

            elements.imageManager.appendChild(item);
        });
    }

    function moveImage(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        state.imageUrls = utils.reorderImages(state.imageUrls, fromIndex, toIndex);
        state.selectedImageIndex = toIndex;
        markDirty();
        renderImageManager();
        setFeedback(elements.imageFeedback, 'Image order changed. Save changes to publish it.', '');
    }

    function promoteThumbnail(index) {
        if (index === 0) return;
        state.imageUrls = utils.setThumbnail(state.imageUrls, index);
        state.selectedImageIndex = 0;
        markDirty();
        renderImageManager();
        setFeedback(elements.imageFeedback, 'Thumbnail selected. Save changes to publish it.', '');
    }

    function collectDraftFromForm() {
        const draft = { ...state.selectedProduct, image_urls: state.imageUrls.slice() };
        utils.EDITABLE_FIELDS.forEach((field) => {
            if (field === 'image_urls' || field === 'status') return;
            const control = elements.form.elements.namedItem(field);
            if (control) draft[field] = control.value;
        });
        draft.status = elements.status.value;
        return draft;
    }

    function valuesMatch(left, right) {
        if (Array.isArray(left) || Array.isArray(right)) {
            return JSON.stringify(left || []) === JSON.stringify(right || []);
        }
        if (left === null || left === undefined || left === '') {
            return right === null || right === undefined || right === '';
        }
        return String(left) === String(right);
    }

    async function saveProduct(event) {
        event.preventDefault();
        if (!state.selectedProduct || state.isSaving) return;

        let payload;
        try {
            payload = utils.buildProductUpdate(collectDraftFromForm());
        } catch (error) {
            setFeedback(elements.saveFeedback, error.message, 'error');
            return;
        }

        const product = state.selectedProduct;
        const requestedStatus = payload.status;
        const contentPayload = { ...payload };
        delete contentPayload.status;
        state.isSaving = true;
        updateSaveState();
        setFeedback(elements.saveFeedback, 'Saving product changes...', '');

        try {
            let savedProduct;
            let contentUpdate = supabaseClient
                .from('mainspring_products')
                .update(contentPayload)
                .eq('id', product.id);

            if (product.updated_at) {
                contentUpdate = contentUpdate.eq('updated_at', product.updated_at);
            }

            const { data: contentProduct, error: updateError } = await contentUpdate
                .select('*')
                .maybeSingle();
            if (updateError) throw updateError;
            if (!contentProduct) {
                throw new Error('This product changed in another session. Reload it before saving again.');
            }

            savedProduct = contentProduct;
            if (utils.normalizeStatus(contentProduct.status) !== requestedStatus) {
                const { data: transitionData, error: transitionError } = await supabaseClient.rpc(
                    'transition_mainspring_product_status',
                    {
                        p_product_id: product.id,
                        p_new_status: requestedStatus,
                        p_expected_updated_at: contentProduct.updated_at,
                    }
                );
                if (transitionError) throw transitionError;
                savedProduct = Array.isArray(transitionData) ? transitionData[0] : transitionData;
                if (!savedProduct) throw new Error('Status transition returned no product.');
            }

            const mismatch = utils.EDITABLE_FIELDS.find((field) => !valuesMatch(savedProduct[field], payload[field]));
            if (mismatch) throw new Error(`Saved product verification failed for ${mismatch}.`);

            state.products = state.products.map((item) => item.id === savedProduct.id ? savedProduct : item);
            renderSummary();
            applyFilters(false);
            renderEditor(savedProduct);
            setFeedback(elements.saveFeedback, 'Changes saved and verified.', 'success');
        } catch (error) {
            console.error('Mainspring admin save failed', {
                productId: product.id,
                errorCode: error && error.code ? error.code : 'unknown',
            });
            setFeedback(elements.saveFeedback, 'Unable to save this product. Check your access or reload the product if another admin changed it.', 'error');
        } finally {
            state.isSaving = false;
            updateSaveState();
        }
    }

    function renderSummary() {
        const counts = { available: 0, reserved: 0, sold: 0 };
        state.products.forEach((product) => {
            const normalized = utils.normalizeStatus(product.status);
            if (Object.prototype.hasOwnProperty.call(counts, normalized)) counts[normalized] += 1;
        });
        elements.totalCount.textContent = String(state.products.length);
        elements.availableCount.textContent = String(counts.available);
        elements.reservedCount.textContent = String(counts.reserved);
        elements.soldCount.textContent = String(counts.sold);
    }

    function populateCategoryFilter() {
        const current = elements.categoryFilter.value;
        const categories = [...new Set(state.products.map((product) => product.category).filter(Boolean))]
            .sort((left, right) => String(left).localeCompare(String(right)));
        elements.categoryFilter.replaceChildren();
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'All categories';
        elements.categoryFilter.appendChild(all);
        categories.forEach((category) => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            elements.categoryFilter.appendChild(option);
        });
        elements.categoryFilter.value = categories.includes(current) ? current : '';
    }

    function productMatches(product, search, status, category) {
        if (status && utils.normalizeStatus(product.status) !== status) return false;
        if (category && product.category !== category) return false;
        if (!search) return true;
        const haystack = [
            product.reference_code,
            product.name,
            product.brand,
            product.model,
            product.caption,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(search);
    }

    function applyFilters(resetPage = true) {
        const search = elements.search.value.trim().toLowerCase();
        const status = elements.statusFilter.value;
        const category = elements.categoryFilter.value;
        state.filteredProducts = state.products.filter((product) => productMatches(product, search, status, category));
        if (resetPage) state.page = 1;
        renderProductList();
    }

    function createMarkerButton(product, marker) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `admin-marker-swatch is-${marker.id}`;
        button.setAttribute('aria-label', `${marker.label} for ${displayValue(product.reference_code || product.id)}`);
        button.setAttribute('aria-pressed', String((state.markers[String(product.id)] || 'none') === marker.id));
        button.title = marker.label;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            setMarker(product.id, marker.id);
        });
        return button;
    }

    function createProductRow(product) {
        const row = document.createElement('article');
        const normalizedStatus = utils.normalizeStatus(product.status);
        row.className = `admin-product-row is-${normalizedStatus}`;
        row.classList.toggle('is-selected', state.selectedProduct && state.selectedProduct.id === product.id);

        const mainButton = document.createElement('button');
        mainButton.type = 'button';
        mainButton.className = 'admin-product-row-main';
        mainButton.setAttribute('aria-label', `Edit ${displayValue(product.brand)} ${displayValue(product.model || product.name)}`);
        mainButton.addEventListener('click', () => selectProduct(product));

        const imageFrame = document.createElement('span');
        imageFrame.className = 'admin-product-row-image';
        const firstImage = Array.isArray(product.image_urls) ? product.image_urls[0] : null;
        if (utils.isSafeImageUrl(firstImage)) {
            const image = document.createElement('img');
            image.src = firstImage;
            image.alt = '';
            image.loading = 'lazy';
            imageFrame.appendChild(image);
        } else {
            const placeholder = document.createElement('span');
            placeholder.className = 'admin-image-placeholder';
            placeholder.textContent = '?';
            imageFrame.appendChild(placeholder);
        }
        mainButton.appendChild(imageFrame);

        const copy = document.createElement('span');
        copy.className = 'admin-product-row-copy';
        const title = document.createElement('span');
        title.className = 'admin-product-row-title';
        title.textContent = product.model || product.name || product.brand || 'Untitled product';
        copy.appendChild(title);
        const reference = document.createElement('span');
        reference.className = 'admin-product-row-reference';
        reference.textContent = product.brand ? `${product.brand} · ${displayValue(product.reference_code || product.id)}` : displayValue(product.reference_code || product.id);
        copy.appendChild(reference);
        const status = document.createElement('span');
        status.className = `admin-product-row-status ${statusClass(product.status)}`;
        status.textContent = normalizeStatusLabel(product.status);
        copy.appendChild(status);
        mainButton.appendChild(copy);
        row.appendChild(mainButton);

        const markerGroup = document.createElement('div');
        markerGroup.className = 'admin-marker-group';
        markerGroup.setAttribute('aria-label', 'Local admin marker');
        MARKERS.forEach((marker) => markerGroup.appendChild(createMarkerButton(product, marker)));
        row.appendChild(markerGroup);
        return row;
    }

    function renderPagination(totalPages) {
        elements.pagination.replaceChildren();
        if (totalPages <= 1) return;

        const createPageButton = (label, page, disabled, current) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.disabled = disabled;
            button.classList.toggle('is-current', current);
            button.setAttribute('aria-label', label === 'Previous' || label === 'Next' ? label : `Page ${label}`);
            button.addEventListener('click', () => {
                state.page = page;
                renderProductList();
                elements.productList.focus({ preventScroll: true });
            });
            return button;
        };

        elements.pagination.appendChild(createPageButton('Previous', state.page - 1, state.page === 1, false));
        for (let page = 1; page <= totalPages; page += 1) {
            if (page === 1 || page === totalPages || Math.abs(page - state.page) <= 2) {
                elements.pagination.appendChild(createPageButton(String(page), page, false, page === state.page));
            }
        }
        elements.pagination.appendChild(createPageButton('Next', state.page + 1, state.page === totalPages, false));
    }

    function renderProductList() {
        const total = state.filteredProducts.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        state.page = Math.min(state.page, totalPages);
        const start = (state.page - 1) * PAGE_SIZE;
        const pageProducts = state.filteredProducts.slice(start, start + PAGE_SIZE);
        elements.productList.replaceChildren();
        pageProducts.forEach((product) => elements.productList.appendChild(createProductRow(product)));
        elements.resultCount.textContent = `${total} result${total === 1 ? '' : 's'}`;
        setFeedback(elements.listFeedback, total ? '' : 'No products match these filters.', '');
        renderPagination(totalPages);
    }

    async function fetchAllProducts() {
        const products = [];
        let from = 0;
        const batchSize = 100;
        while (true) {
            const { data, error } = await supabaseClient
                .from('mainspring_products')
                .select('*')
                .order('reference_code', { ascending: true, nullsFirst: false })
                .range(from, from + batchSize - 1);
            if (error) throw error;
            products.push(...(data || []));
            if (!data || data.length < batchSize) break;
            from += batchSize;
        }
        return products;
    }

    async function loadProducts() {
        setFeedback(elements.listFeedback, 'Loading catalogue...', '');
        try {
            state.products = await fetchAllProducts();
            renderSummary();
            populateCategoryFilter();
            applyFilters();
            setFeedback(elements.listFeedback, `${state.products.length} products loaded.`, 'success');

            if (state.selectedProduct) {
                const refreshed = state.products.find((product) => product.id === state.selectedProduct.id);
                if (refreshed) renderEditor(refreshed);
            }
        } catch (error) {
            console.error('Mainspring admin catalogue load failed', {
                errorCode: error && error.code ? error.code : 'unknown',
            });
            state.products = [];
            state.filteredProducts = [];
            renderSummary();
            renderProductList();
            setFeedback(elements.listFeedback, 'Unable to load the catalogue. Check your access and try again.', 'error');
        }
    }

    function selectProduct(product) {
        if (hasUnsavedChanges() && !root.confirm('Discard unsaved product changes?')) return;
        renderEditor(product);
        renderProductList();
        elements.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function showLogin(message) {
        elements.login.hidden = false;
        elements.app.hidden = true;
        elements.email.focus();
        if (message) setFeedback(elements.authMessage, message, 'error');
    }

    function showApp(session) {
        elements.login.hidden = true;
        elements.app.hidden = false;
        elements.sessionEmail.textContent = session.user.email || 'Signed-in administrator';
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
                if (transition === state.authTransition) showLogin('This account is signed in but is not approved for Mainspring administration.');
                return;
            }
            if (transition !== state.authTransition) return;
            showApp(session);
            await loadProducts();
        } catch (error) {
            console.error('Mainspring admin authorization failed', {
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
            console.error('Mainspring admin login failed', { errorCode: error && error.code ? error.code : 'unknown' });
            setFeedback(elements.authMessage, 'Sign-in failed. Check the account details or administrator approval.', 'error');
        } finally {
            elements.loginButton.disabled = false;
            elements.loginButton.textContent = 'Sign in';
        }
    }

    async function handleSignOut() {
        if (hasUnsavedChanges() && !root.confirm('Discard unsaved product changes and sign out?')) return;
        await supabaseClient.auth.signOut();
    }

    function bindEvents() {
        elements.loginForm.addEventListener('submit', handleLogin);
        elements.signOut.addEventListener('click', handleSignOut);
        elements.refresh.addEventListener('click', loadProducts);
        elements.search.addEventListener('input', () => applyFilters());
        elements.statusFilter.addEventListener('change', () => applyFilters());
        elements.categoryFilter.addEventListener('change', () => applyFilters());
        elements.form.addEventListener('submit', saveProduct);
        root.addEventListener('beforeunload', (event) => {
            if (!hasUnsavedChanges()) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    async function init() {
        renderStatusOptions();
        bindEvents();
        try {
            const { data, error } = await supabaseClient.auth.getSession();
            if (error) throw error;
            await handleSession(data.session);
            supabaseClient.auth.onAuthStateChange((_event, session) => {
                root.setTimeout(() => handleSession(session), 0);
            });
        } catch (error) {
            console.error('Mainspring admin session check failed', { errorCode: error && error.code ? error.code : 'unknown' });
            showLogin('Unable to connect to the administrator sign-in service.');
        }
    }

    root.addEventListener('DOMContentLoaded', init);
    if (document.readyState !== 'loading') init();
}(window, document));
