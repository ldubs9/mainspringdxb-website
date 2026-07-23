(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MainspringSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const SEARCH_FIELDS = [
        'brand',
        'model',
        'name',
        'reference_code',
        'watch_reference',
        'subcategory',
    ];

    function normalizeProductSearchTerm(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s\-/]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildProductSearchFilter(value) {
        const term = normalizeProductSearchTerm(value);
        if (!term) return '';
        return SEARCH_FIELDS.map((field) => `${field}.ilike.*${term}*`).join(',');
    }

    function searchableValues(product) {
        return SEARCH_FIELDS.map((field) => normalizeProductSearchTerm(product?.[field]));
    }

    function productSearchScore(product, value) {
        const term = normalizeProductSearchTerm(value);
        if (!term) return -1;

        const values = searchableValues(product);
        if (!values.some((field) => field.includes(term))) return -1;

        let score = 0;
        values.forEach((field, index) => {
            if (!field) return;
            const fieldWeight = index === 0 ? 60 : index <= 2 ? 30 : 15;
            if (field === term) score = Math.max(score, 1000 + fieldWeight);
            else if (field.startsWith(`${term} `) || field.startsWith(`${term}-`) || field.startsWith(term)) {
                score = Math.max(score, 800 + fieldWeight);
            } else if (field.split(/\s+/).some((word) => word.startsWith(term))) {
                score = Math.max(score, 650 + fieldWeight);
            } else {
                score = Math.max(score, 500 + fieldWeight);
            }
        });
        return score;
    }

    function statusPriority(status) {
        if (status === 'available' || status === 'active' || !status) return 0;
        if (status === 'reserved') return 1;
        if (status === 'sold') return 2;
        return 3;
    }

    function rankProductSearchResults(products, value) {
        return (products || [])
            .map((product, index) => ({
                product,
                index,
                score: productSearchScore(product, value),
            }))
            .filter((entry) => entry.score >= 0)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                const statusDifference = statusPriority(a.product.status) - statusPriority(b.product.status);
                if (statusDifference) return statusDifference;
                const referenceA = String(a.product.reference_code || '');
                const referenceB = String(b.product.reference_code || '');
                const referenceDifference = referenceB.localeCompare(referenceA, undefined, { numeric: true });
                if (referenceDifference) return referenceDifference;
                return a.index - b.index;
            })
            .map((entry) => entry.product);
    }

    async function fetchAllProductSearchResults(createQuery, value, options = {}) {
        const batchSize = Math.max(1, Number(options.batchSize) || 500);
        const maxBatches = Math.max(1, Number(options.maxBatches) || 100);
        const allProducts = [];

        for (let batch = 0; batch < maxBatches; batch += 1) {
            const from = batch * batchSize;
            const to = from + batchSize - 1;
            const { data, error } = await createQuery().range(from, to);
            if (error) throw error;
            const rows = data || [];
            allProducts.push(...rows);
            if (rows.length < batchSize) return rankProductSearchResults(allProducts, value);
        }

        throw new Error('Search result limit exceeded. Narrow your search and try again.');
    }

    function createLatestRequestGuard() {
        let latestRequest = 0;
        return {
            next() {
                latestRequest += 1;
                return latestRequest;
            },
            isCurrent(requestId) {
                return requestId === latestRequest;
            },
            invalidate() {
                latestRequest += 1;
            },
        };
    }

    return {
        SEARCH_FIELDS,
        normalizeProductSearchTerm,
        buildProductSearchFilter,
        productSearchScore,
        rankProductSearchResults,
        fetchAllProductSearchResults,
        createLatestRequestGuard,
    };
});
