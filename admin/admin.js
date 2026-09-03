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
        { name: 'condition', label: 'Condition', type: 'select', options: utils.CONDITION_OPTIONS, section: 'specifications' },
        { name: 'price', label: 'Price (AED)', type: 'number', section: 'specifications', min: '0', step: '0.01' },
        { name: 'category', label: 'Category', type: 'select', options: utils.CATEGORY_OPTIONS, section: 'specifications' },
        { name: 'subcategory', label: 'Subcategory', type: 'select', options: utils.ACCESSORY_SUBCATEGORY_OPTIONS, section: 'specifications' },
        { name: 'created_at', label: 'Created at', type: 'text', section: 'system', readOnly: true },
        { name: 'watch_reference', label: 'Watch reference', type: 'text', section: 'specifications' },
        { name: 'watch_year', label: 'Watch year', type: 'text', section: 'specifications' },
        { name: 'product_details', label: 'Product details', type: 'textarea', section: 'content', wide: true },
        { name: 'status', label: 'Status', type: 'status', section: 'status' },
        { name: 'updated_at', label: 'Updated at', type: 'text', section: 'system', readOnly: true },
        { name: 'size', label: 'Size', type: 'text', section: 'specifications' },
        { name: 'gender', label: 'Gender', type: 'select', options: utils.GENDER_OPTIONS, section: 'specifications' },
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
        soldMonth: '',
        dirty: false,
        isSaving: false,
        saveStatus: 'idle',
        draggedImageIndex: null,
        dragOverImageIndex: null,
        dragOverPosition: null,
        pointerDrag: null,
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
        soldMonthFilter: document.getElementById('admin-sold-month-filter'),
        soldReport: document.getElementById('admin-sold-report'),
        soldMonthSummary: document.getElementById('admin-sold-month-summary'),
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

    function appendSelectOption(select, value, label, disabled = false) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.disabled = disabled;
        select.appendChild(option);
        return option;
    }

    function populateSelect(input, definition, value) {
        const normalizedValue = value === null || value === undefined ? '' : String(value).trim();
        const hasApprovedValue = definition.options.includes(normalizedValue);
        input.replaceChildren();

        if (normalizedValue && !hasApprovedValue) {
            appendSelectOption(input, '__legacy__', `Current value: ${normalizedValue}`, true);
        } else {
            appendSelectOption(input, '', definition.placeholder || `Select ${definition.label.toLowerCase()}`, true);
        }

        definition.options.forEach((optionValue) => {
            appendSelectOption(input, optionValue, optionValue);
        });
        input.value = hasApprovedValue ? normalizedValue : (normalizedValue ? '__legacy__' : '');
    }

    function syncSubcategoryField(category, value) {
        const input = elements.form.elements.namedItem('subcategory');
        const definition = PRODUCT_FIELD_DEFINITIONS.find((field) => field.name === 'subcategory');
        if (!input || !definition) return;

        if (category === 'accessory') {
            populateSelect(input, definition, value === undefined ? input.value : value);
            input.disabled = false;
            return;
        }

        input.replaceChildren();
        appendSelectOption(input, '', 'Not applicable for watches', true);
        input.value = '';
        input.disabled = true;
    }

    function createField(definition, product) {
        const wrapper = document.createElement('div');
        wrapper.className = `admin-field${definition.wide ? ' admin-field-wide' : ''}`;

        const label = document.createElement('label');
        label.htmlFor = `admin-field-${definition.name}`;
        label.textContent = definition.label;
        wrapper.appendChild(label);

        const value = product[definition.name];
        let input;
        if (definition.type === 'textarea') {
            input = document.createElement('textarea');
        } else if (definition.type === 'select') {
            input = document.createElement('select');
        } else {
            input = document.createElement('input');
        }
        input.id = `admin-field-${definition.name}`;
        input.name = definition.name;
        input.autocomplete = 'off';

        if (definition.type === 'number') {
            input.type = 'number';
            input.min = definition.min;
            input.step = definition.step;
            input.inputMode = 'decimal';
        } else if (definition.type === 'select') {
            input.setAttribute('aria-label', definition.label);
            populateSelect(input, definition, value);
        } else if (definition.type !== 'textarea') {
            input.type = 'text';
        }

        if (definition.type !== 'select') {
            input.value = value === null || value === undefined ? '' : String(value);
        }
        if (definition.readOnly) {
            input.readOnly = true;
            input.tabIndex = -1;
        } else if (definition.type === 'select') {
            input.addEventListener('change', () => {
                if (definition.name === 'category') syncSubcategoryField(input.value);
                markDirty();
            });
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
        syncSubcategoryField(product.category, product.subcategory);
    }

    function renderEditor(product, { saveStatus = 'idle' } = {}) {
        state.selectedProduct = cloneProduct(product);
        state.imageUrls = state.selectedProduct.image_urls.slice();
        state.selectedImageIndex = 0;
        state.dirty = false;
        state.saveStatus = saveStatus;
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
        state.saveStatus = 'idle';
        updateSaveState();
    }

    function updateSaveState() {
        elements.editorState.textContent = state.dirty ? 'Unsaved changes' : 'No unsaved changes';
        elements.editorState.classList.toggle('is-dirty', state.dirty);
        const buttonState = utils.getSaveButtonState({
            dirty: state.dirty,
            isSaving: state.isSaving,
            saveStatus: state.saveStatus,
        });
        elements.saveButton.disabled = buttonState.disabled;
        elements.saveButton.textContent = buttonState.label;
        elements.saveButton.classList.toggle('is-saved', buttonState.label === 'Saved');
        elements.saveNote.textContent = state.dirty
            ? 'Review the complete product before saving.'
            : 'Changes are not saved automatically.';
    }

    function renderImageDragFeedback() {
        elements.imageManager.querySelectorAll('.admin-image-item').forEach((item) => {
            const index = Number(item.dataset.index);
            item.classList.toggle('is-dragging', index === state.draggedImageIndex);
            item.classList.toggle(
                'is-drag-over-before',
                index === state.dragOverImageIndex && state.dragOverPosition === 'before'
            );
            item.classList.toggle(
                'is-drag-over-after',
                index === state.dragOverImageIndex && state.dragOverPosition === 'after'
            );
        });
    }

    function clearImageDragState() {
        state.draggedImageIndex = null;
        state.dragOverImageIndex = null;
        state.dragOverPosition = null;
        elements.imageManager.classList.remove('is-dragging');
    }

    function getImageItemAtPoint(event) {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const item = target && typeof target.closest === 'function'
            ? target.closest('.admin-image-item')
            : null;
        return item && elements.imageManager.contains(item) ? item : null;
    }

    function getDropPosition(event, item) {
        const rect = item.getBoundingClientRect();
        const midpointX = rect.left + (rect.width / 2);
        const midpointY = rect.top + (rect.height / 2);
        const horizontalDistance = Math.abs(event.clientX - midpointX);
        const verticalDistance = Math.abs(event.clientY - midpointY);
        if (horizontalDistance >= verticalDistance) {
            return event.clientX < midpointX ? 'before' : 'after';
        }
        return event.clientY < midpointY ? 'before' : 'after';
    }

    function updateImageDragTarget(event) {
        const item = getImageItemAtPoint(event);
        if (!item) {
            state.dragOverImageIndex = null;
            state.dragOverPosition = null;
            renderImageDragFeedback();
            return;
        }

        const targetIndex = Number(item.dataset.index);
        if (!Number.isInteger(targetIndex)) return;
        state.dragOverImageIndex = targetIndex;
        state.dragOverPosition = getDropPosition(event, item);
        renderImageDragFeedback();
    }

    function finishPointerImageDrag(event, cancelled = false) {
        const drag = state.pointerDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const targetItem = !cancelled && drag.active ? getImageItemAtPoint(event) : null;
        const targetIndex = targetItem
            ? Number(targetItem.dataset.index)
            : state.dragOverImageIndex;
        const position = targetItem ? getDropPosition(event, targetItem) : state.dragOverPosition;
        const fromIndex = drag.index;
        state.pointerDrag = null;
        clearImageDragState();

        if (!cancelled && drag.active && Number.isInteger(targetIndex) && position) {
            const toIndex = utils.resolveDropIndex(
                fromIndex,
                targetIndex,
                position,
                state.imageUrls.length
            );
            if (toIndex !== null && toIndex !== fromIndex) {
                moveImage(fromIndex, toIndex);
                return;
            }
        }
        renderImageManager();
    }

    function bindImageDrag(item, caption, index) {
        caption.addEventListener('pointerdown', (event) => {
            if (event.pointerType !== 'touch' && event.button !== 0) return;
            if (state.pointerDrag) return;
            state.pointerDrag = {
                active: false,
                caption,
                index,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
            };
            if (typeof caption.setPointerCapture === 'function') {
                caption.setPointerCapture(event.pointerId);
            }
        });

        caption.addEventListener('pointermove', (event) => {
            const drag = state.pointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
            if (!drag.active && distance < 6) return;
            if (!drag.active) {
                drag.active = true;
                state.draggedImageIndex = index;
                elements.imageManager.classList.add('is-dragging');
            }
            event.preventDefault();
            updateImageDragTarget(event);
        });

        caption.addEventListener('pointerup', (event) => finishPointerImageDrag(event));
        caption.addEventListener('pointercancel', (event) => finishPointerImageDrag(event, true));
        caption.addEventListener('lostpointercapture', (event) => {
            if (state.pointerDrag && state.pointerDrag.pointerId === event.pointerId) {
                finishPointerImageDrag(event, true);
            }
        });
    }

    function createActionIcon(pathData) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.classList.add('admin-image-action-icon');
        const paths = Array.isArray(pathData) ? pathData : [pathData];
        paths.forEach((data) => {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', data);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', 'currentColor');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('stroke-width', '1.8');
            svg.appendChild(path);
        });
        return svg;
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
            caption.title = 'Drag to reorder';
            const position = document.createElement('span');
            position.textContent = `Image ${index + 1}`;
            const role = document.createElement('strong');
            role.textContent = index === 0 ? 'Thumbnail' : 'Gallery';
            const dragHint = document.createElement('span');
            dragHint.className = 'admin-image-drag-hint';
            dragHint.textContent = 'Drag';
            dragHint.setAttribute('aria-hidden', 'true');
            caption.append(position, role, dragHint);
            item.appendChild(caption);

            const actions = document.createElement('div');
            actions.className = 'admin-image-actions';
            const thumbnailButton = document.createElement('button');
            thumbnailButton.type = 'button';
            thumbnailButton.className = 'admin-image-action admin-image-thumbnail-action';
            thumbnailButton.setAttribute('aria-label', index === 0 ? 'Current thumbnail' : 'Set as thumbnail');
            thumbnailButton.title = index === 0 ? 'Current thumbnail' : 'Set as thumbnail';
            thumbnailButton.appendChild(createActionIcon([
                'M4 5.5h16v13H4z',
                'M4 15.5l4.5-4.5 3.5 3.5 2.5-2.5 5.5 5',
                'M8 9h.01',
            ]));
            thumbnailButton.disabled = index === 0;
            thumbnailButton.addEventListener('click', () => promoteThumbnail(index));
            actions.appendChild(thumbnailButton);

            const upButton = document.createElement('button');
            upButton.type = 'button';
            upButton.className = 'admin-image-action admin-image-move-action';
            upButton.setAttribute('aria-label', `Move image ${index + 1} left`);
            upButton.title = 'Move left';
            upButton.appendChild(createActionIcon(['M19 12H5', 'M10 6l-6 6 6 6']));
            upButton.disabled = index === 0;
            upButton.addEventListener('click', () => moveImage(index, index - 1));
            actions.appendChild(upButton);

            const downButton = document.createElement('button');
            downButton.type = 'button';
            downButton.className = 'admin-image-action admin-image-move-action';
            downButton.setAttribute('aria-label', `Move image ${index + 1} right`);
            downButton.title = 'Move right';
            downButton.appendChild(createActionIcon(['M5 12h14', 'M14 6l6 6-6 6']));
            downButton.disabled = index === state.imageUrls.length - 1;
            downButton.addEventListener('click', () => moveImage(index, index + 1));
            actions.appendChild(downButton);
            item.appendChild(actions);

            bindImageDrag(item, caption, index);
            elements.imageManager.appendChild(item);
        });
    }

    function moveImage(fromIndex, toIndex, { restoreFocus = true } = {}) {
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.imageUrls.length || toIndex >= state.imageUrls.length) return;

        state.imageUrls = utils.reorderImages(state.imageUrls, fromIndex, toIndex);
        if (state.selectedImageIndex === fromIndex) {
            state.selectedImageIndex = toIndex;
        } else if (fromIndex < state.selectedImageIndex && state.selectedImageIndex <= toIndex) {
            state.selectedImageIndex -= 1;
        } else if (toIndex <= state.selectedImageIndex && state.selectedImageIndex < fromIndex) {
            state.selectedImageIndex += 1;
        }
        markDirty();
        renderImageManager();
        if (restoreFocus) {
            const movedItem = elements.imageManager.querySelector(`[data-index="${toIndex}"]`);
            const movedImage = movedItem && movedItem.querySelector('.admin-image-select');
            if (movedImage) movedImage.focus({ preventScroll: true });
        }
        setFeedback(elements.imageFeedback, 'Image order changed. Save changes to publish it.', '');
    }

    function promoteThumbnail(index) {
        if (index === 0) return;
        state.imageUrls = utils.setThumbnail(state.imageUrls, index);
        state.selectedImageIndex = 0;
        markDirty();
        renderImageManager();
        const thumbnailItem = elements.imageManager.querySelector('[data-index="0"]');
        const thumbnailImage = thumbnailItem && thumbnailItem.querySelector('.admin-image-select');
        if (thumbnailImage) thumbnailImage.focus({ preventScroll: true });
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
            renderEditor(savedProduct, { saveStatus: 'saved' });
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

    function populateSoldMonthFilter() {
        const isSoldView = elements.statusFilter.value === 'sold';
        const category = elements.categoryFilter.value;
        const current = state.soldMonth || elements.soldMonthFilter.value;
        const monthCounts = utils.countSoldByMonth(state.products, category);
        const availableMonths = new Set(monthCounts.map(({ month }) => month));

        elements.soldMonthFilter.replaceChildren();
        const allMonths = document.createElement('option');
        allMonths.value = '';
        allMonths.textContent = 'All sold months';
        elements.soldMonthFilter.appendChild(allMonths);
        monthCounts.forEach(({ month, count }) => {
            const option = document.createElement('option');
            option.value = month;
            option.textContent = `${utils.formatSoldMonth(month)} · ${count} sold`;
            elements.soldMonthFilter.appendChild(option);
        });

        state.soldMonth = isSoldView && availableMonths.has(current) ? current : '';
        elements.soldMonthFilter.value = state.soldMonth;
        elements.soldMonthFilter.disabled = !isSoldView;
    }

    function renderSoldReport() {
        const isSoldView = elements.statusFilter.value === 'sold';
        elements.soldReport.hidden = !isSoldView;
        elements.soldMonthSummary.replaceChildren();
        if (!isSoldView) return;

        const monthCounts = utils.countSoldByMonth(state.products, elements.categoryFilter.value);
        if (!monthCounts.length) {
            const empty = document.createElement('p');
            empty.className = 'admin-sold-report-empty';
            empty.textContent = 'No sold products are available for this category.';
            elements.soldMonthSummary.appendChild(empty);
            return;
        }

        monthCounts.forEach(({ month, count }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'admin-sold-month-summary-item';
            button.setAttribute('aria-pressed', String(state.soldMonth === month));
            button.setAttribute(
                'aria-label',
                `${utils.formatSoldMonth(month)}: ${count} sold product${count === 1 ? '' : 's'}`
            );
            button.title = state.soldMonth === month ? 'Show all sold months' : `Show ${utils.formatSoldMonth(month)}`;

            const label = document.createElement('span');
            label.textContent = utils.formatSoldMonth(month);
            const total = document.createElement('strong');
            total.textContent = String(count);
            button.append(label, total);
            button.addEventListener('click', () => {
                state.soldMonth = state.soldMonth === month ? '' : month;
                elements.soldMonthFilter.value = state.soldMonth;
                applyFilters();
            });
            elements.soldMonthSummary.appendChild(button);
        });
    }

    function productMatches(product, search, status, category, soldMonth) {
        if (status && utils.normalizeStatus(product.status) !== status) return false;
        if (category && product.category !== category) return false;
        if (status === 'sold' && soldMonth) {
            const productMonth = utils.getSoldMonthKey(product.sold_at) || utils.UNKNOWN_SOLD_MONTH;
            if (productMonth !== soldMonth) return false;
        }
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
        populateSoldMonthFilter();
        const search = elements.search.value.trim().toLowerCase();
        const status = elements.statusFilter.value;
        const category = elements.categoryFilter.value;
        state.filteredProducts = state.products.filter((product) => productMatches(product, search, status, category, state.soldMonth));
        if (status === 'sold') state.filteredProducts = utils.sortSoldProducts(state.filteredProducts);
        if (resetPage) state.page = 1;
        renderProductList();
        renderSoldReport();
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
        const selectedMarker = state.markers[String(product.id)] || 'none';
        row.className = `admin-product-row is-${normalizedStatus}`;
        row.dataset.marker = selectedMarker;
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
        const isSoldView = elements.statusFilter.value === 'sold';
        elements.resultCount.textContent = isSoldView
            ? `${total} sold product${total === 1 ? '' : 's'}`
            : `${total} result${total === 1 ? '' : 's'}`;
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

    function resetCatalogueFilters() {
        elements.search.value = '';
        elements.statusFilter.value = '';
        elements.categoryFilter.value = '';
        elements.soldMonthFilter.value = '';
        state.soldMonth = '';
        state.page = 1;
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
            populateSoldMonthFilter();
            renderSummary();
            renderProductList();
            renderSoldReport();
            setFeedback(elements.listFeedback, 'Unable to load the catalogue. Check your access and try again.', 'error');
        }
    }

    async function handleRefresh() {
        if (hasUnsavedChanges() && !root.confirm('Discard unsaved product changes and reload the catalogue?')) return;
        resetCatalogueFilters();
        await loadProducts();
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
        elements.refresh.addEventListener('click', handleRefresh);
        elements.search.addEventListener('input', () => applyFilters());
        elements.statusFilter.addEventListener('change', () => applyFilters());
        elements.categoryFilter.addEventListener('change', () => applyFilters());
        elements.soldMonthFilter.addEventListener('change', () => {
            state.soldMonth = elements.soldMonthFilter.value;
            applyFilters();
        });
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
