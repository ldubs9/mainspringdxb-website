(function attachMainspringAdminUtils(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }

    root.MainspringAdminUtils = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMainspringAdminUtils() {
    'use strict';

    const STATUS_OPTIONS = Object.freeze(['available', 'reserved', 'sold']);
    const SYSTEM_FIELDS = Object.freeze(['id', 'created_at', 'updated_at', 'sold_price', 'sold_at']);
    const EDITABLE_FIELDS = Object.freeze([
        'reference_code',
        'name',
        'brand',
        'model',
        'caption',
        'condition',
        'price',
        'category',
        'subcategory',
        'watch_reference',
        'watch_year',
        'product_details',
        'status',
        'size',
        'gender',
        'country',
        'movement',
        'image_urls',
        'deliverables',
        'cost_price',
        'draft_description',
        'draft_social',
    ]);

    const NUMERIC_FIELDS = Object.freeze(['price', 'cost_price']);

    function copyImages(images) {
        return Array.isArray(images) ? images.slice() : [];
    }

    function isValidImageIndex(images, index) {
        return Number.isInteger(index) && index >= 0 && index < images.length;
    }

    function reorderImages(images, fromIndex, toIndex) {
        const source = copyImages(images);
        if (!isValidImageIndex(source, fromIndex) || !isValidImageIndex(source, toIndex)) {
            return source;
        }

        const [image] = source.splice(fromIndex, 1);
        source.splice(toIndex, 0, image);
        return source;
    }

    function setThumbnail(images, index) {
        return reorderImages(images, index, 0);
    }

    function isSafeImageUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return false;
        const trimmed = value.trim();
        if (!/^https?:\/\//i.test(trimmed)) return false;

        try {
            const parsed = new URL(trimmed);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (error) {
            return false;
        }
    }

    function validateImageUrls(images) {
        if (!Array.isArray(images)) {
            return 'Image URLs must be an array.';
        }

        const invalidIndex = images.findIndex((image) => !isSafeImageUrl(image));
        if (invalidIndex >= 0) {
            return `Image ${invalidIndex + 1} must be an absolute HTTP or HTTPS URL.`;
        }

        return null;
    }

    function normalizeStatus(status) {
        if (STATUS_OPTIONS.includes(status)) return status;
        if (status === 'active') return 'available';
        if (status === 'archived') return 'sold';
        return 'available';
    }

    function normalizeText(value) {
        if (value === null || value === undefined) return null;
        const normalized = String(value).trim();
        return normalized || null;
    }

    function normalizeNumeric(value, field) {
        if (value === null || value === undefined || String(value).trim() === '') {
            return field === 'price' ? 0 : null;
        }

        const normalized = Number(value);
        if (!Number.isFinite(normalized) || normalized < 0) {
            throw new Error(`${field} must be a non-negative number.`);
        }

        return normalized;
    }

    function buildProductUpdate(draft) {
        if (!draft || draft.id === null || draft.id === undefined) {
            throw new Error('A product id is required.');
        }

        const imageUrls = copyImages(draft.image_urls).map((image) => String(image).trim());
        const imageError = validateImageUrls(imageUrls);
        if (imageError) throw new Error(imageError);

        const payload = {};
        EDITABLE_FIELDS.forEach((field) => {
            if (field === 'image_urls') {
                payload[field] = imageUrls;
            } else if (field === 'status') {
                payload[field] = normalizeStatus(draft[field]);
            } else if (NUMERIC_FIELDS.includes(field)) {
                payload[field] = normalizeNumeric(draft[field], field);
            } else {
                payload[field] = normalizeText(draft[field]);
            }
        });

        return payload;
    }

    return Object.freeze({
        EDITABLE_FIELDS,
        NUMERIC_FIELDS,
        STATUS_OPTIONS,
        SYSTEM_FIELDS,
        buildProductUpdate,
        isSafeImageUrl,
        normalizeStatus,
        reorderImages,
        setThumbnail,
        validateImageUrls,
    });
}));
