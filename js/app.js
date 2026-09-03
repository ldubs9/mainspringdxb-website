        // Supabase configuration and the storefront client are shared with the
        // authenticated admin app. This client intentionally never persists a
        // customer session in the storefront browser.
        if (!window.MainspringSupabase || typeof window.MainspringSupabase.createStorefrontClient !== 'function') {
            throw new Error('Shared Supabase client failed to load');
        }
        const supabaseClient = window.MainspringSupabase.createStorefrontClient();

        // Customer-facing product numbers.
        // Internally (database, Telegram bot, staff email) a product keeps its
        // REF-A001 code. Customers only ever see PN-A001.
        function toPublicRef(code) {
            const value = String(code || '').trim();
            return value ? value.replace(/^REF-/i, 'PN-') : '';
        }

        function toInternalRef(code) {
            const value = String(code || '').trim();
            return value ? value.replace(/^PN-/i, 'REF-') : '';
        }

        if (!window.MainspringSearch) {
            throw new Error('Product search helpers failed to load');
        }
        const {
            buildProductSearchFilter,
            fetchAllProductSearchResults,
            createLatestRequestGuard,
        } = window.MainspringSearch;
        const globalSearchRequestGuard = createLatestRequestGuard();
        let globalSearchDebounceTimer = null;

        function escapeHtml(str) {
            return String(str || '').replace(/[&<>"']/g, function (character) {
                return {
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;'
                }[character];
            });
        }

        // Handle browser back/forward buttons
        window.addEventListener('popstate', function (event) {
            const state = event.state;
            if (!state || !state.page) {
                showPage('home', true);
                return;
            }

            if (state.page === 'detail' && state.productId) {
                showProductDetail(state.productId, true);
            } else if (state.page === 'watches') {
                currentPage = state.pg || 1;
                restoreWatchFilters(state.filters || {});
                showPage('watches', true, true);
            } else if (state.page === 'accessories' && state.category) {
                // 'all' is the "no subcategory" sentinel used in the URL. Passing
                // it through as a real subcategory matches nothing.
                currentAccessoryPage = state.pg || 1;
                restoreAccessoryFilters(state.filters || {});
                showAccessoryCategory(state.category === 'all' ? null : state.category, true, state.pg || 1);
            } else if (state.page === 'blog-detail' && state.blogId) {
                showBlogDetail(state.blogId, true);
            } else if (state.page === 'blog') {
                currentBlogPage = state.pg || 1;
                showPage('blog', true, true);
            } else {
                showPage(state.page, true);
            }
        });

        // Cart (localStorage). Every product is unique inventory, so legacy
        // carts are deduplicated and any old quantity is forced back to one.
        function normalizeStoredCart(items) {
            if (!Array.isArray(items)) return [];
            const seen = new Set();
            return items.reduce((normalized, item) => {
                const id = Number(item && item.id);
                if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return normalized;
                seen.add(id);
                normalized.push({ ...item, id, qty: 1 });
                return normalized;
            }, []);
        }

        let storedCart;
        try {
            storedCart = JSON.parse(localStorage.getItem('mainspring_cart'));
        } catch (_error) {
            storedCart = [];
        }
        let cart = normalizeStoredCart(storedCart);
        localStorage.setItem('mainspring_cart', JSON.stringify(cart));

        function saveCart() {
            appliedDiscount = null;
            discountDraft = '';
            discountFeedback = null;
            localStorage.setItem('mainspring_cart', JSON.stringify(cart));
            updateCartBadge();
        }

        function updateCartBadge() {
            const totalItems = cart.length;
            document.getElementById('cartBadge').textContent = totalItems;
            document.getElementById('cartBadge').style.display = totalItems > 0 ? 'flex' : 'none';
            document.getElementById('cartBadgeMobile').textContent = totalItems;
            document.getElementById('cartBadgeMobile').style.display = totalItems > 0 ? 'flex' : 'none';
        }

        function isSafeImageUrl(value) {
            if (typeof value !== 'string' || !value.trim()) return false;
            try {
                const parsed = new URL(value.trim(), window.location.origin);
                return parsed.protocol === 'http:' || parsed.protocol === 'https:';
            } catch (_error) {
                return false;
            }
        }

        function getProductThumbnail(product) {
            const candidate = product.image_url || (Array.isArray(product.image_urls) && product.image_urls.length > 0
                ? product.image_urls[0]
                : '');
            return isSafeImageUrl(candidate) ? candidate.trim() : '';
        }

        function encodeProductForCart(product) {
            return encodeURIComponent(JSON.stringify({
                id: product.id,
                name: product.model || product.name,
                brand: product.brand,
                price: product.price,
                image_url: getProductThumbnail(product),
                reference_code: product.reference_code || product.reference_number || ''
            })).replace(/'/g, '%27');
        }

        function addToCartEncodedProduct(encodedProduct) {
            addToCart(JSON.parse(decodeURIComponent(encodedProduct)));
        }

        function addToCart(product) {
            const productId = Number(product.id);
            if (!Number.isSafeInteger(productId) || productId <= 0) return;
            const existing = cart.find(item => item.id === productId);
            if (!existing) {
                cart.push({
                    id: productId,
                    name: product.model || product.name,
                    brand: product.brand,
                    price: product.price,
                    image_url: getProductThumbnail(product),
                    reference_code: product.reference_code || product.reference_number || '',
                    qty: 1
                });
                saveCart();
                trackClick('add_to_cart', product.name);
            }
            renderCart();
            openCart();
        }

        function removeFromCart(productId) {
            cart = cart.filter(item => item.id !== Number(productId));
            saveCart();
            renderCart();
        }

        function openCart() {
            document.getElementById('cartSidebar').classList.add('active');
            renderCart();
            hydrateCartProductDetails();
        }

        function closeCart() {
            document.getElementById('cartSidebar').classList.remove('active');
        }

        async function hydrateCartProductDetails() {
            const missingIds = cart
                .filter(item => !item.image_url || !item.reference_code)
                .map(item => item.id);
            if (missingIds.length === 0) return;

            try {
                const { data, error } = await supabaseClient
                    .from('mainspring_public_products')
                    .select('id,image_urls,reference_code,model,name,brand')
                    .in('id', missingIds);
                if (error) throw error;

                let changed = false;
                (data || []).forEach(product => {
                    const item = cart.find(cartItem => String(cartItem.id) === String(product.id));
                    if (!item) return;
                    const imageUrl = getProductThumbnail(product);
                    const referenceCode = product.reference_code || product.reference_number || '';
                    if (imageUrl && item.image_url !== imageUrl) {
                        item.image_url = imageUrl;
                        changed = true;
                    }
                    if (referenceCode && item.reference_code !== referenceCode) {
                        item.reference_code = referenceCode;
                        changed = true;
                    }
                    if (!item.name && (product.model || product.name)) {
                        item.name = product.model || product.name;
                        changed = true;
                    }
                    if (!item.brand && product.brand) {
                        item.brand = product.brand;
                        changed = true;
                    }
                });

                if (changed) {
                    saveCart();
                    renderCart();
                }
            } catch (error) {
                console.error('Unable to load cart product thumbnails:', error);
            }
        }

        function renderCart() {
            const cartItemsEl = document.getElementById('cartItems');
            const cartFooterEl = document.getElementById('cartFooter');

            if (cart.length === 0) {
                cartItemsEl.innerHTML = '<div class="cart-empty"><i class="fas fa-shopping-bag"></i><p>Your cart is empty</p></div>';
                cartFooterEl.style.display = 'none';
                return;
            }

            cartFooterEl.style.display = 'block';
            // Cart prices are VAT-exclusive; VAT is shown here and charged at checkout.
            const subtotalAED = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
            const totalAED = withVat(subtotalAED);
            const vatAED = totalAED - subtotalAED;
            const setAmount = (id, amountAED) => {
                const el = document.getElementById(id);
                el.textContent = formatPrice(amountAED);
                el.setAttribute('data-price-aed', amountAED);
            };
            setAmount('cartSubtotal', subtotalAED);
            setAmount('cartVat', vatAED);
            setAmount('cartTotal', totalAED);
            document.getElementById('cartVatLabel').textContent = `VAT (${VAT_PCT}%)`;

            cartItemsEl.innerHTML = cart.map(item => `
                <div class="cart-item">
                    <div class="cart-item-image">
                        ${item.image_url && isSafeImageUrl(item.image_url)
                            ? `<img class="cart-item-thumbnail" src="${escapeHtml(item.image_url)}" alt="${escapeHtml(`${item.brand || ''} ${item.name || ''}`.trim())}">`
                            : '<i class="fas fa-clock"></i>'}
                    </div>
                    <div class="cart-item-details">
                        <p class="cart-item-name">${item.brand} ${item.name}</p>
                        <p class="cart-item-price" data-price-aed="${item.price}">${formatPrice(item.price)}</p>
                    </div>
                    <button class="cart-item-remove" onclick="removeFromCart(${item.id})">&times;</button>
                </div>
            `).join('');
        }

        function getCartTotal() {
            return cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
        }

        // Checkout — Secure multi-step flow
        // Edge Functions URL (used by order tracking)
        const EDGE_FN_URL = SUPABASE_URL + '/functions/v1';

        // Payments service (Coolify "mainspringpayments" app). Handles
        // /create-order, /ziina-checkout and /ziina-webhook.
        const PAYMENTS_BASE = window.PAYMENTS_BASE || 'https://pay.mainspring.swiftloop.tech';

        // VAT is charged on every order, regardless of payment method.
        // The database remains authoritative; this only previews the total.
        const VAT_PCT = 5;
        const withVat = (amount) => Math.round(amount * (1 + VAT_PCT / 100));

        let selectedPaymentMethod = null;
        let checkoutStep = 1; // 1=details, 2=payment, 3=confirm
        let appliedDiscount = null;
        let discountDraft = '';
        let discountFeedback = null;

        function openCheckout() {
            closeCart();
            selectedPaymentMethod = null;
            checkoutStep = 1;
            renderCheckoutStep1();
            document.getElementById('checkoutOverlay').classList.add('active');
        }

        function closeCheckout() {
            document.getElementById('checkoutOverlay').classList.remove('active');
        }

        function renderStepIndicator(step) {
            return `<div class="checkout-steps">
                <div class="checkout-step ${step >= 1 ? 'active' : ''}"></div>
                <div class="checkout-step ${step >= 2 ? 'active' : ''}"></div>
                <div class="checkout-step ${step >= 3 ? 'active' : ''}"></div>
            </div>`;
        }

        // Step 1: Customer details
        function renderCheckoutStep1() {
            const body = document.getElementById('checkoutBody');
            const saved = JSON.parse(localStorage.getItem('mainspring_customer') || '{}');
            const subtotal = getCartTotal();
            const discountAmount = Number(appliedDiscount?.discount_aed || 0);
            const discountedSubtotal = appliedDiscount
                ? Number(appliedDiscount.discounted_subtotal_aed)
                : subtotal;
            body.innerHTML = `
                ${renderStepIndicator(1)}
                <div class="checkout-form">
                    <p class="checkout-form-title">Your Details</p>
                    <div class="checkout-field">
                        <label>Full Name *</label>
                        <input type="text" id="checkoutName" value="${escapeHtml(saved.name || '')}" placeholder="e.g. Ahmed Al Maktoum" required />
                        <p class="field-error" id="nameError">Please enter your name</p>
                    </div>
                    <div class="checkout-field">
                        <label>Phone Number *</label>
                        <input type="tel" id="checkoutPhone" value="${escapeHtml(saved.phone || '')}" placeholder="+971 5X XXX XXXX" required />
                        <p class="field-error" id="phoneError">Please enter a valid phone number</p>
                    </div>
                    <div class="checkout-field">
                        <label>Email *</label>
                        <input type="email" id="checkoutEmail" value="${escapeHtml(saved.email || '')}" placeholder="your@email.com" required />
                        <p class="field-error" id="emailError">Please enter a valid email address</p>
                    </div>
                    <div class="checkout-field">
                        <label>Delivery Address *</label>
                        <textarea id="checkoutAddress" placeholder="Street, Building, Area, City" required>${escapeHtml(saved.address || '')}</textarea>
                        <p class="field-error" id="addressError">Please enter your delivery address</p>
                    </div>
                </div>

                <div class="checkout-summary">
                    ${cart.map(item => `
                        <div class="checkout-summary-item">
                            <span class="item-name">${item.brand} ${item.name}</span>
                            <span data-price-aed="${item.price}">${formatPrice(item.price)}</span>
                        </div>
                    `).join('')}
                    <div class="checkout-discount">
                        <label for="checkoutDiscountCode">Discount code</label>
                        <div class="checkout-discount-controls">
                            <input
                                type="text"
                                id="checkoutDiscountCode"
                                value="${escapeHtml(appliedDiscount?.discount_code || discountDraft)}"
                                placeholder="Enter code"
                                maxlength="32"
                                autocomplete="off"
                                ${appliedDiscount ? 'readonly' : ''}
                            />
                            ${appliedDiscount
                                ? '<button type="button" onclick="clearDiscountCode()">Remove</button>'
                                : '<button type="button" id="applyDiscountBtn" onclick="applyDiscountCode()">Apply</button>'}
                        </div>
                        ${discountFeedback
                            ? `<p class="checkout-discount-feedback ${discountFeedback.type}">${escapeHtml(discountFeedback.message)}</p>`
                            : ''}
                    </div>
                    <div class="checkout-summary-total is-subtotal">
                        <span>Subtotal</span>
                        <span data-price-aed="${subtotal}">${formatPrice(subtotal)}</span>
                    </div>
                    ${appliedDiscount ? `
                        <div class="checkout-summary-discount">
                            <span>Discount (${escapeHtml(appliedDiscount.discount_code)})</span>
                            <span>-${formatPrice(discountAmount)}</span>
                        </div>
                        <div class="checkout-summary-total">
                            <span>Discounted subtotal</span>
                            <span data-price-aed="${discountedSubtotal}">${formatPrice(discountedSubtotal)}</span>
                        </div>
                    ` : ''}
                </div>

                <button class="checkout-confirm-btn" onclick="goToStep2()">CONTINUE TO PAYMENT</button>
            `;
        }

        function captureCheckoutCustomerDraft() {
            const existing = JSON.parse(localStorage.getItem('mainspring_customer') || '{}');
            const draft = {
                name: document.getElementById('checkoutName')?.value ?? existing.name ?? '',
                phone: document.getElementById('checkoutPhone')?.value ?? existing.phone ?? '',
                email: document.getElementById('checkoutEmail')?.value ?? existing.email ?? '',
                address: document.getElementById('checkoutAddress')?.value ?? existing.address ?? ''
            };
            localStorage.setItem('mainspring_customer', JSON.stringify(draft));
            return draft;
        }

        async function applyDiscountCode() {
            const input = document.getElementById('checkoutDiscountCode');
            const button = document.getElementById('applyDiscountBtn');
            discountDraft = input?.value || '';
            const customer = captureCheckoutCustomerDraft();
            if (!discountDraft.trim()) {
                discountFeedback = { type: 'error', message: 'Enter a discount code.' };
                renderCheckoutStep1();
                return;
            }

            if (button) {
                button.disabled = true;
                button.textContent = 'Checking...';
            }

            try {
                const response = await fetch(PAYMENTS_BASE + '/discounts/validate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        discount_code: discountDraft,
                        items: cart.map(item => ({ id: item.id, qty: 1 })),
                        customer_phone: customer.phone
                    })
                });
                const result = await response.json();
                if (!response.ok || !result.valid) {
                    appliedDiscount = null;
                    discountFeedback = {
                        type: 'error',
                        message: result.message || 'This discount code could not be applied.'
                    };
                } else {
                    appliedDiscount = result;
                    discountDraft = result.discount_code;
                    discountFeedback = { type: 'success', message: result.message || 'Discount applied.' };
                }
            } catch (error) {
                console.error('Discount validation error:', error);
                appliedDiscount = null;
                discountFeedback = {
                    type: 'error',
                    message: 'Discount validation is temporarily unavailable.'
                };
            }
            renderCheckoutStep1();
        }

        function clearDiscountCode() {
            captureCheckoutCustomerDraft();
            appliedDiscount = null;
            discountDraft = '';
            discountFeedback = null;
            renderCheckoutStep1();
        }

        function goToStep2() {
            const name = document.getElementById('checkoutName').value.trim();
            const phone = document.getElementById('checkoutPhone').value.trim();
            const emailInput = document.getElementById('checkoutEmail');
            const email = emailInput.value.trim();
            const address = document.getElementById('checkoutAddress').value.trim();

            // Validate
            let valid = true;
            if (!name) {
                document.getElementById('nameError').style.display = 'block';
                valid = false;
            }
            if (!phone || phone.replace(/[^\d]/g, '').length < 8) {
                document.getElementById('phoneError').style.display = 'block';
                valid = false;
            }
            if (!email || !emailInput.checkValidity()) {
                document.getElementById('emailError').style.display = 'block';
                valid = false;
            }
            if (!address) {
                document.getElementById('addressError').style.display = 'block';
                valid = false;
            }
            if (!valid) return;

            // Save for convenience (no sensitive data)
            localStorage.setItem('mainspring_customer', JSON.stringify({ name, phone, email, address }));

            checkoutStep = 2;
            renderCheckoutStep2();
        }

        // Step 2: Payment method selection
        function renderCheckoutStep2() {
            const originalSubtotal = getCartTotal();
            const total = appliedDiscount
                ? Number(appliedDiscount.discounted_subtotal_aed)
                : originalSubtotal;
            const payableTotal = withVat(total);
            const cashTotal = withVat(originalSubtotal);
            const body = document.getElementById('checkoutBody');

            body.innerHTML = `
                ${renderStepIndicator(2)}

                ${appliedDiscount ? `
                    <div class="checkout-discount-summary">
                        <span>${escapeHtml(appliedDiscount.discount_code)} applied</span>
                        <strong>-${formatPrice(Number(appliedDiscount.discount_aed))}</strong>
                    </div>
                ` : ''}

                <p class="payment-method-label">Select Payment Method</p>
                <div class="payment-methods">
                    <div class="payment-method" onclick="selectPayment('ziina', this)">
                        <div class="payment-method-icon"><i class="fas fa-credit-card"></i></div>
                        <div class="payment-method-info">
                            <div class="payment-method-name">Card Payment</div>
                            <div class="payment-method-desc">Visa, Mastercard, Amex — secure via Ziina</div>
                            <div class="payment-method-vat">Includes ${VAT_PCT}% VAT</div>
                        </div>
                        <div class="payment-method-price" data-price-aed="${payableTotal}">${formatPrice(payableTotal)}</div>
                    </div>
                    <div class="payment-method" onclick="selectPayment('bank_transfer', this)">
                        <div class="payment-method-icon"><i class="fas fa-university"></i></div>
                        <div class="payment-method-info">
                            <div class="payment-method-name">Bank Transfer</div>
                            <div class="payment-method-desc">Transfer directly to our business account</div>
                            <div class="payment-method-vat">Includes ${VAT_PCT}% VAT</div>
                        </div>
                        <div class="payment-method-price" data-price-aed="${payableTotal}">${formatPrice(payableTotal)}</div>
                    </div>
                    <div class="payment-method" onclick="selectPayment('cash_in_store', this)">
                        <div class="payment-method-icon"><i class="fas fa-store"></i></div>
                        <div class="payment-method-info">
                            <div class="payment-method-name">Cash Payment in Store</div>
                            <div class="payment-method-desc">Place the order, then continue on WhatsApp to arrange cash payment. Inventory is not held until payment is confirmed. Discount codes are not applied to cash orders.</div>
                            <div class="payment-method-vat">Includes ${VAT_PCT}% VAT</div>
                        </div>
                        <div class="payment-method-price" data-price-aed="${cashTotal}">${formatPrice(cashTotal)}</div>
                    </div>
                </div>

                <button class="checkout-confirm-btn" id="confirmCheckoutBtn" disabled onclick="confirmCheckout()">SELECT A PAYMENT METHOD</button>
            `;
        }

        function selectPayment(method, el) {
            selectedPaymentMethod = method;
            document.querySelectorAll('.payment-method').forEach(pm => pm.classList.remove('selected'));
            el.classList.add('selected');
            const btn = document.getElementById('confirmCheckoutBtn');
            btn.disabled = false;
            btn.textContent = 'PLACE ORDER';
        }

        // Step 3: Create order + process payment
        async function confirmCheckout() {
            if (!selectedPaymentMethod) return;

            const btn = document.getElementById('confirmCheckoutBtn');
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> PROCESSING...';

            const customer = JSON.parse(localStorage.getItem('mainspring_customer') || '{}');

            try {
                // Create order via secure Edge Function
                const orderResponse = await fetch(PAYMENTS_BASE + '/create-order', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + SUPABASE_KEY,
                    },
                    body: JSON.stringify({
                        customer_name: customer.name,
                        customer_email: customer.email,
                        customer_phone: customer.phone,
                        customer_address: customer.address,
                        items: cart,
                        payment_method: selectedPaymentMethod,
                        discount_code: appliedDiscount?.discount_code || null,
                    }),
                });

                const orderData = await orderResponse.json();

                if (!orderResponse.ok || !orderData.success) {
                    throw new Error(orderData.error || 'Failed to create order');
                }

                const orderRef = orderData.order_ref;
                const orderTotal = orderData.total_aed;
                const orderedItems = cart.slice();

                // Clear cart
                cart = [];
                saveCart();
                renderCart();
                trackClick('checkout_' + selectedPaymentMethod, orderRef);

                // Route to the appropriate payment flow
                checkoutStep = 3;

                if (selectedPaymentMethod === 'ziina') {
                    await handleZiinaPayment(orderRef);
                } else if (selectedPaymentMethod === 'bank_transfer') {
                    showBankTransferConfirmation(orderRef, orderTotal);
                } else if (selectedPaymentMethod === 'cash_in_store') {
                    showCashInStoreConfirmation(orderRef, orderTotal, orderedItems);
                }

            } catch (err) {
                console.error('Checkout error:', err);
                const discountRejected = /discount code/i.test(String(err.message || ''));
                if (discountRejected) {
                    appliedDiscount = null;
                    discountDraft = '';
                    discountFeedback = {
                        type: 'error',
                        message: 'The discount changed before checkout. Please review your order.'
                    };
                }
                const body = document.getElementById('checkoutBody');
                body.innerHTML = `
                    ${renderStepIndicator(2)}
                    <div class="checkout-error">
                        <strong>Something went wrong:</strong> ${err.message || 'Please try again.'}
                    </div>
                    <button class="checkout-confirm-btn" onclick="${discountRejected ? 'renderCheckoutStep1()' : 'renderCheckoutStep2()'}">${discountRejected ? 'REVIEW ORDER' : 'TRY AGAIN'}</button>
                `;
            }
        }

        // Tap card payment — redirect to Tap hosted checkout
        // Ziina card payment — redirect to Ziina hosted checkout
        async function handleZiinaPayment(orderRef) {
            const body = document.getElementById('checkoutBody');
            body.innerHTML = `
                ${renderStepIndicator(3)}
                <div class="checkout-loading">
                    <i class="fas fa-spinner"></i>
                    <p style="margin-top: 15px; color: var(--gray);">Setting up secure payment...</p>
                </div>
            `;

            try {
                const checkoutEndpoint = window.ZIINA_CHECKOUT_URL || (PAYMENTS_BASE + '/ziina-checkout');

                const res = await fetch(checkoutEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + SUPABASE_KEY,
                    },
                    body: JSON.stringify({ order_ref: orderRef }),
                });

                const data = await res.json();

                if (data.payment_url) {
                    // Redirect to Ziina's secure hosted payment page
                    window.location.href = data.payment_url;
                } else {
                    throw new Error(data.error || 'Payment setup failed');
                }
            } catch (err) {
                // Fallback: show WhatsApp option if Ziina isn't reachable
                body.innerHTML = `
                    ${renderStepIndicator(3)}
                    <div class="checkout-confirmation">
                        <i class="fas fa-credit-card"></i>
                        <h4>Card Payment</h4>
                        <p>Your order <strong>${orderRef}</strong> has been created.</p>
                        <p style="margin-top: 10px; color: var(--gray); font-size: 0.9rem;">Card payment gateway is unavailable. Please contact us via WhatsApp to arrange secure card payment.</p>
                        <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('ziina', '${orderRef}')"><i class="fab fa-whatsapp"></i> Arrange Payment via WhatsApp</button>
                    </div>
                `;
            }
        }

        // Bank transfer confirmation
        function showBankTransferConfirmation(orderRef, total) {
            const body = document.getElementById('checkoutBody');
            body.innerHTML = `
                ${renderStepIndicator(3)}
                <div class="checkout-confirmation">
                    <i class="fas fa-check-circle" style="color: #27ae60;"></i>
                    <h4>Order Placed — Bank Transfer</h4>
                    <p>Your order <strong>${orderRef}</strong> has been recorded.</p>
                    <p style="margin-top: 5px;">Please transfer the total to the following account:</p>
                    <div class="checkout-bank-details">
                        <p><strong>Account holder:</strong> ERKAN GULMEZ TRADING L.L.C</p>
                        <p><strong>IBAN:</strong> AE360860000009547681874</p>
                        <p><strong>BIC:</strong> WIOBAEADXXX</p>
                        <p><strong>Reference:</strong> ${orderRef}</p>
                        <p><strong>Amount:</strong> ${formatPrice(total)}</p>
                    </div>
                    <p style="font-size: 0.9rem; color: var(--gray);">Send a screenshot of your transfer confirmation via WhatsApp for faster processing.</p>
                    <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('bank_transfer', '${orderRef}')"><i class="fab fa-whatsapp"></i> Confirm via WhatsApp</button>
                    <button class="checkout-confirm-btn is-secondary" style="margin-top: 10px;" onclick="closeCheckout()">Done</button>
                </div>
            `;
        }

        function buildCashInquiryMessage(items, customer, orderRef) {
            const itemLines = items.map(item => {
                const name = `${item.brand || ''} ${item.name || ''}`.trim();
                const reference = item.reference_code ? ` (${toPublicRef(item.reference_code)})` : '';
                return `- ${name}${reference}`;
            }).join('\n');

            const orderLine = orderRef ? `Order Ref: ${orderRef}\n` : '';
            return `Hello Mainspring, I would like to discuss paying cash for:\n\n${itemLines}\n\n${orderLine}Name: ${customer.name || ''}\nPhone: ${customer.phone || ''}\n\nI understand the watch is subject to availability until payment is confirmed. Please confirm availability and the cash payment arrangements.`;
        }

        function startCashInquiryWhatsApp(orderRef, items) {
            const customer = JSON.parse(localStorage.getItem('mainspring_customer') || '{}');
            const message = buildCashInquiryMessage(items, customer, orderRef);
            const whatsappUrl = `https://wa.me/971585625042?text=${encodeURIComponent(message)}`;
            const chatWindow = window.open(whatsappUrl, '_blank');
            if (!chatWindow) {
                window.location.assign(whatsappUrl);
                return;
            }
            chatWindow.opener = null;
            trackClick('checkout_cash_inquiry', orderRef);
        }

        function showCashInStoreConfirmation(orderRef, total, items) {
            startCashInquiryWhatsApp(orderRef, items);
            const body = document.getElementById('checkoutBody');
            body.innerHTML = `
                ${renderStepIndicator(3)}
                <div class="checkout-confirmation">
                    <i class="fab fa-whatsapp" style="color: #25D366;"></i>
                    <h4>Order Placed — Cash Payment in Store</h4>
                    <p>Your order <strong>${escapeHtml(orderRef)}</strong> for <strong>${formatPrice(total)}</strong> has been recorded.</p>
                    <p style="margin-top: 10px; font-size: 0.9rem; color: var(--gray);">We opened WhatsApp so you can arrange the cash payment. Inventory is not held until payment is confirmed.</p>
                    <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('cash_in_store', '${escapeHtml(orderRef)}')"><i class="fab fa-whatsapp"></i> Open WhatsApp Again</button>
                    <button class="checkout-confirm-btn is-secondary" style="margin-top: 10px;" onclick="closeCheckout()">Done</button>
                </div>
            `;
        }

        function sendOrderWhatsApp(method, orderRef) {
            const methodNames = {
                bank_transfer: 'Bank Transfer',
                cash_in_store: 'Cash Payment in Store',
                ziina: 'Card Payment (Ziina)'
            };
            const customer = JSON.parse(localStorage.getItem('mainspring_customer') || '{}');
            const message = `Hello Mainspring, I have placed an order.\n\nOrder Ref: ${orderRef}\nName: ${customer.name || ''}\nPayment: ${methodNames[method] || method}\n\nPlease confirm and arrange the next steps. Thank you!`;
            const whatsappUrl = `https://wa.me/971585625042?text=${encodeURIComponent(message)}`;
            window.open(whatsappUrl, '_blank');
        }

        function renderZiinaVerificationPending(body, orderRef, detail) {
            body.innerHTML = `
                ${renderStepIndicator(3)}
                <div class="checkout-confirmation">
                    <i class="fas fa-clock" style="color: var(--gray); font-size: 3.5rem;"></i>
                    <h4>Payment Verification in Progress</h4>
                    <p>Ziina returned order <strong>${escapeHtml(orderRef)}</strong> to the website.</p>
                    <p style="margin-top: 10px; color: var(--gray); font-size: 0.9rem;">${escapeHtml(detail)} We will email you as soon as the payment is verified.</p>
                    <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('ziina', '${orderRef}')"><i class="fab fa-whatsapp"></i> Contact Us</button>
                    <button class="checkout-confirm-btn is-secondary" style="margin-top: 10px;" onclick="closeCheckout()">Close</button>
                </div>
            `;
        }

        function renderVerifiedZiinaSuccess(body, orderRef) {
            body.innerHTML = `
                ${renderStepIndicator(3)}
                <div class="checkout-confirmation">
                    <i class="fas fa-check-circle" style="color: #27ae60; font-size: 3.5rem;"></i>
                    <h4>Payment Verified!</h4>
                    <p>Your order <strong>${escapeHtml(orderRef)}</strong> has been confirmed.</p>
                    <p style="margin-top: 10px; color: var(--gray); font-size: 0.9rem;">Your payment receipt will be sent by email.</p>
                    <button class="checkout-confirm-btn" onclick="closeCheckout(); showPage('home');">CONTINUE SHOPPING</button>
                </div>
            `;
        }

        // Handle the Ziina card-payment return redirect. The browser redirect is
        // not payment proof, so ask the server to re-fetch the intent from Ziina.
        async function handlePaymentReturn() {
            const params = new URLSearchParams(window.location.search);
            const orderRef = params.get('order');
            const status = params.get('status');
            const paymentIntentId = params.get('payment_intent');

            if (!orderRef || !status) return;
            if (!/^MS-[A-Z0-9-]{1,80}$/i.test(orderRef)) return;

            // Clean the URL
            window.history.replaceState({}, '', window.location.pathname);

            const body = document.getElementById('checkoutBody');
            document.getElementById('checkoutOverlay').classList.add('active');

            if (status.includes('success') || status === 'ziina_success') {
                body.innerHTML = `
                    ${renderStepIndicator(3)}
                    <div class="checkout-loading">
                        <i class="fas fa-spinner fa-spin"></i>
                        <p style="margin-top: 15px; color: var(--gray);">Verifying your payment with Ziina...</p>
                    </div>
                `;

                if (!paymentIntentId || !/^[A-Z0-9-]{1,100}$/i.test(paymentIntentId)) {
                    renderZiinaVerificationPending(body, orderRef, 'Automatic verification is still running.');
                    return;
                }

                try {
                    const response = await fetch(PAYMENTS_BASE + '/ziina-reconcile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            order_ref: orderRef,
                            payment_intent_id: paymentIntentId,
                        }),
                    });
                    const result = await response.json();
                    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to verify payment');

                    if (result.payment_status === 'paid') {
                        renderVerifiedZiinaSuccess(body, orderRef);
                    } else if (result.payment_status === 'failed') {
                        body.innerHTML = `
                            ${renderStepIndicator(3)}
                            <div class="checkout-confirmation">
                                <i class="fas fa-exclamation-circle" style="color: #c0392b; font-size: 3.5rem;"></i>
                                <h4>Payment Failed</h4>
                                <p>Ziina could not complete payment for order <strong>${escapeHtml(orderRef)}</strong>.</p>
                                <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('failed', '${orderRef}')"><i class="fab fa-whatsapp"></i> Contact Us</button>
                            </div>
                        `;
                    } else {
                        renderZiinaVerificationPending(body, orderRef, 'Ziina is still processing the payment.');
                    }
                } catch (error) {
                    console.error('Ziina return verification error:', error);
                    renderZiinaVerificationPending(body, orderRef, 'Automatic verification is temporarily unavailable.');
                }
            } else if (status.includes('cancel')) {
                body.innerHTML = `
                    ${renderStepIndicator(3)}
                    <div class="checkout-confirmation">
                        <i class="fas fa-times-circle" style="color: var(--gray); font-size: 3.5rem;"></i>
                        <h4>Payment Cancelled</h4>
                        <p>Your order <strong>${escapeHtml(orderRef)}</strong> payment was cancelled.</p>
                        <p style="margin-top: 10px; color: var(--gray); font-size: 0.9rem;">You can contact us to retry or choose a different payment method.</p>
                        <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('cancelled', '${orderRef}')"><i class="fab fa-whatsapp"></i> Contact Us</button>
                        <button class="checkout-confirm-btn is-secondary" style="margin-top: 10px;" onclick="closeCheckout()">Close</button>
                    </div>
                `;
            } else if (status.includes('failure') || status.includes('fail')) {
                body.innerHTML = `
                    ${renderStepIndicator(3)}
                    <div class="checkout-confirmation">
                        <i class="fas fa-exclamation-circle" style="color: #c0392b; font-size: 3.5rem;"></i>
                        <h4>Payment Failed</h4>
                        <p>Your payment for order <strong>${escapeHtml(orderRef)}</strong> could not be processed.</p>
                        <p style="margin-top: 10px; color: var(--gray); font-size: 0.9rem;">Please try again or contact us for assistance.</p>
                        <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('failed', '${orderRef}')"><i class="fab fa-whatsapp"></i> Contact Us</button>
                        <button class="checkout-confirm-btn is-secondary" style="margin-top: 10px;" onclick="closeCheckout()">Close</button>
                    </div>
                `;
            }
        }

        // Order tracking page (currently hidden from navigation)
        function showOrderTracking(prefillRef) {
            showPage('order-tracking');

            // Pre-fill from saved customer
            const saved = JSON.parse(localStorage.getItem('mainspring_customer') || '{}');
            if (prefillRef) document.getElementById('trackOrderRef').value = prefillRef;
            if (saved.phone) document.getElementById('trackPhone').value = saved.phone;

            // Clear previous results
            document.getElementById('orderTrackingResult').innerHTML = '';
        }

        async function lookupOrder() {
            const orderRef = document.getElementById('trackOrderRef').value.trim();
            const phone = document.getElementById('trackPhone').value.trim();
            const resultEl = document.getElementById('orderTrackingResult');

            if (!orderRef || !phone) {
                resultEl.innerHTML = '<div class="checkout-error">Please enter both your order reference and phone number.</div>';
                return;
            }

            resultEl.innerHTML = '<div class="checkout-loading"><i class="fas fa-spinner"></i><p style="margin-top: 10px;">Looking up your order...</p></div>';

            try {
                const res = await fetch(EDGE_FN_URL + '/order-status', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + SUPABASE_KEY,
                    },
                    body: JSON.stringify({ order_ref: orderRef, phone }),
                });

                const data = await res.json();

                if (!res.ok) {
                    resultEl.innerHTML = `<div class="checkout-error">${data.error || 'Order not found.'}</div>`;
                    return;
                }

                const methodNames = {
                    bank_transfer: 'Bank Transfer',
                    cash_in_store: 'Cash Payment in Store',
                    ziina: 'Card (Ziina)'
                };

                resultEl.innerHTML = `
                    <div class="order-status-card">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                            <div>
                                <p style="font-size: 0.8rem; color: var(--gray); text-transform: uppercase; letter-spacing: 0.1em;">Order</p>
                                <p style="font-family: 'Fraunces', serif; font-size: 1.2rem;">${data.order_ref}</p>
                            </div>
                            <span class="order-status-badge ${data.order_status}">${data.order_status}</span>
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
                            <div>
                                <p style="font-size: 0.78rem; color: var(--gray); text-transform: uppercase;">Payment</p>
                                <p style="font-weight: 600;">${methodNames[data.payment_method] || data.payment_method}</p>
                                <span class="order-status-badge ${data.payment_status}" style="margin-top: 5px;">${data.payment_status}</span>
                            </div>
                            <div>
                                <p style="font-size: 0.78rem; color: var(--gray); text-transform: uppercase;">Total</p>
                                <p style="font-weight: 600;" data-price-aed="${data.total_aed}">${formatPrice(data.total_aed)}</p>
                                ${data.discount_code && Number(data.discount_aed) > 0
                                    ? `<p style="font-size: 0.78rem; color: var(--gray);">Discount ${escapeHtml(data.discount_code)}: -${formatPrice(Number(data.discount_aed))}</p>`
                                    : ''}
                                ${data.vat_pct > 0 ? `<p style="font-size: 0.78rem; color: var(--gray);">Includes ${data.vat_pct}% VAT</p>` : ''}
                                ${data.surcharge_pct > 0 ? `<p style="font-size: 0.78rem; color: var(--gray);">Includes ${data.surcharge_pct}% card surcharge</p>` : ''}
                            </div>
                        </div>

                        <div style="border-top: 1px solid var(--cream); padding-top: 15px;">
                            <p style="font-size: 0.78rem; color: var(--gray); text-transform: uppercase; margin-bottom: 10px;">Items</p>
                            ${data.items.map(item => `
                                <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 0.9rem;">
                                    <span>${item.brand} ${item.name}</span>
                                    <span data-price-aed="${item.price}">${formatPrice(item.price)}</span>
                                </div>
                            `).join('')}
                        </div>

                        ${data.tracking_number ? `
                        <div style="border-top: 1px solid var(--cream); padding-top: 15px; margin-top: 15px;">
                            <p style="font-size: 0.78rem; color: var(--gray); text-transform: uppercase;">Tracking Number</p>
                            <p style="font-weight: 600;">${data.tracking_number}</p>
                        </div>
                        ` : ''}

                        <p style="font-size: 0.78rem; color: var(--gray); margin-top: 15px;">Placed on ${new Date(data.created_at).toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                `;
            } catch (err) {
                resultEl.innerHTML = '<div class="checkout-error">Unable to look up order. Please try again later.</div>';
            }
        }

        // Close checkout on overlay click
        document.getElementById('checkoutOverlay').addEventListener('click', function (e) {
            if (e.target === this) closeCheckout();
        });

        // Check for payment return on page load
        handlePaymentReturn();

        // Initialize cart badge on load
        updateCartBadge();

        // Wishlist (localStorage)
        let wishlist = JSON.parse(localStorage.getItem('mainspring_wishlist')) || [];

        // Currency Conversion State
        let currentCurrency = localStorage.getItem('mainspring_currency') || 'AED';
        let exchangeRates = {
            'AED': 1,
            'USD': parseFloat(localStorage.getItem('mainspring_exchange_usd')) || 0.272,
            'GBP': parseFloat(localStorage.getItem('mainspring_exchange_gbp')) || 0.215,
            'EUR': parseFloat(localStorage.getItem('mainspring_exchange_eur')) || 0.26
        };
        let lastExchangeRateUpdate = parseInt(localStorage.getItem('mainspring_last_exchange_update')) || 0;

        // Pre-defined rounded price range labels per currency (internal filter values always stay in AED)
        const PRICE_LABELS = {
            '':            { AED: 'Any Price',          USD: 'Any Price',        GBP: 'Any Price',        EUR: 'Any Price'        },
            '0-1000':      { AED: 'Under 1,000 AED',   USD: 'Under $300',       GBP: 'Under £200',       EUR: 'Under €300'       },
            '0-5000':      { AED: 'Under 5,000 AED',   USD: 'Under $1,500',     GBP: 'Under £1,000',     EUR: 'Under €1,500'     },
            '5000-15000':  { AED: '5,000 - 15,000 AED',USD: '$1,500 - $4,000',  GBP: '£1,000 - £3,000',  EUR: '€1,500 - €4,000'  },
            '15000-30000': { AED: '15,000 - 30,000 AED',USD: '$4,000 - $8,000', GBP: '£3,000 - £6,500',  EUR: '€4,000 - €8,000'  },
            '30000-50000': { AED: '30,000 - 50,000 AED',USD: '$8,000 - $14,000',GBP: '£6,500 - £11,000', EUR: '€8,000 - €13,000' },
            '50000+':      { AED: '50,000+ AED',        USD: '$14,000+',         GBP: '£11,000+',         EUR: '€13,000+'         }
        };

        // Fetch exchange rates from API
        async function fetchExchangeRates() {
            try {
                // Using Open Exchange Rates API (free tier)
                // Rates will be fetched relative to AED (our base currency)
                const response = await fetch('https://api.exchangerate-api.com/v4/latest/AED');
                const data = await response.json();

                if (data.rates) {
                    exchangeRates['USD'] = data.rates.USD || 0.272;
                    exchangeRates['GBP'] = data.rates.GBP || 0.215;
                    exchangeRates['EUR'] = data.rates.EUR || 0.26;

                    // Save to localStorage
                    localStorage.setItem('mainspring_exchange_usd', exchangeRates['USD']);
                    localStorage.setItem('mainspring_exchange_gbp', exchangeRates['GBP']);
                    localStorage.setItem('mainspring_exchange_eur', exchangeRates['EUR']);
                    localStorage.setItem('mainspring_last_exchange_update', Date.now());

                    // Re-render any visible prices with fresh rates
                    rerenderAllPrices();
                }
            } catch (error) {
                console.error('Failed to fetch exchange rates:', error);
            }
        }

        // Initialize currency on page load
        function initializeCurrency() {
            updateCurrencyDisplay();

            // Check if we need to update rates (hourly)
            const now = Date.now();
            const hourInMs = 60 * 60 * 1000;
            if (now - lastExchangeRateUpdate > hourInMs) {
                fetchExchangeRates();
            }

            // Set up hourly updates
            setInterval(fetchExchangeRates, hourInMs);
        }

        // Toggle currency dropdown
        function toggleCurrencyDropdown() {
            const menu = document.getElementById('currencyDropdownMenu');
            menu.classList.toggle('active');
        }

        // Close currency dropdown when clicking outside
        document.addEventListener('click', function (event) {
            const selector = document.querySelector('.currency-selector');
            const menu = document.getElementById('currencyDropdownMenu');
            if (selector && !selector.contains(event.target) && menu) {
                menu.classList.remove('active');
            }
        });

        // Select a currency
        function selectCurrency(currency) {
            currentCurrency = currency;
            localStorage.setItem('mainspring_currency', currency);
            updateCurrencyDisplay();

            // Close dropdown
            document.getElementById('currencyDropdownMenu').classList.remove('active');

            // Re-render all prices on the page
            rerenderAllPrices();

            // Update price filter dropdown labels to the new currency
            updatePriceDropdownLabels();
        }

        // Update currency display in header
        function updateCurrencyDisplay() {
            const flagMap = {
                'AED': '🇦🇪',
                'USD': '🇺🇸',
                'GBP': '🇬🇧',
                'EUR': '🇪🇺'
            };

            document.getElementById('currencyFlag').textContent = flagMap[currentCurrency];
            document.getElementById('currencyCode').textContent = currentCurrency;

            // Update selected option highlighting
            document.querySelectorAll('.currency-option').forEach(option => {
                option.classList.remove('selected');
                if (option.dataset.currency === currentCurrency) {
                    option.classList.add('selected');
                }
            });
        }

        // Convert price based on current currency (base price is AED from the database)
        function convertPrice(priceInAED) {
            return priceInAED * exchangeRates[currentCurrency];
        }

        // Format price with currency symbol
        function formatPrice(priceInAED) {
            const convertedPrice = convertPrice(priceInAED);
            const currencySymbols = {
                'AED': 'AED ',
                'USD': '$',
                'GBP': '£',
                'EUR': '€'
            };

            return `${currencySymbols[currentCurrency]}${convertedPrice.toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
            })}`;
        }

        // Re-render all prices on the page using stored original AED values
        function rerenderAllPrices() {
            document.querySelectorAll('[data-price-aed]').forEach(element => {
                const priceInAED = parseFloat(element.dataset.priceAed);
                if (!isNaN(priceInAED)) {
                    element.textContent = formatPrice(priceInAED);
                }
            });
        }

        // Format a slider AED value in the current currency with nice rounding
        function formatSliderValue(aedVal) {
            if (currentCurrency === 'AED') {
                return 'AED ' + parseInt(aedVal).toLocaleString();
            }
            const symbols = { USD: '$', GBP: '£', EUR: '€' };
            const converted = aedVal * exchangeRates[currentCurrency];
            const rounded = converted < 10000
                ? Math.round(converted / 100) * 100
                : Math.round(converted / 1000) * 1000;
            return symbols[currentCurrency] + rounded.toLocaleString();
        }

        // Update price dropdown labels to reflect the currently selected currency
        function updatePriceDropdownLabels() {
            const dropdown = document.getElementById('priceDropdown');
            if (!dropdown) return;

            // Update each item's displayed text (data-value stays in AED)
            dropdown.querySelectorAll('.custom-dropdown-item[data-value]').forEach(item => {
                const val = item.dataset.value;
                if (PRICE_LABELS[val] && PRICE_LABELS[val][currentCurrency]) {
                    item.textContent = PRICE_LABELS[val][currentCurrency];
                }
            });

            // Update the trigger button text to match the currently selected price
            const priceFilterEl = document.getElementById('priceFilter');
            const trigger = dropdown.querySelector('.custom-dropdown-trigger');
            if (!priceFilterEl || !trigger) return;

            const currentVal = priceFilterEl.value;
            if (!currentVal) {
                trigger.textContent = 'Any Price';
            } else if (PRICE_LABELS[currentVal] && PRICE_LABELS[currentVal][currentCurrency]) {
                trigger.textContent = PRICE_LABELS[currentVal][currentCurrency];
            } else if (currentVal.startsWith('0-')) {
                // Slider set a non-standard AED value
                const aedMax = parseInt(currentVal.split('-')[1]);
                trigger.textContent = 'Under ' + formatSliderValue(aedMax);
            }

            // Refresh the slider display value too
            const sliderEl = dropdown.querySelector('.luxury-slider');
            if (sliderEl) updateSliderDisplay(sliderEl.value);
        }

        // Save wishlist to localStorage
        function saveWishlist() {
            localStorage.setItem('mainspring_wishlist', JSON.stringify(wishlist));
            updateWishlistBadge();
        }

        // Update wishlist badge
        function updateWishlistBadge() {
            document.getElementById('wishlistBadge').textContent = wishlist.length;
            document.getElementById('wishlistBadge').style.display = wishlist.length > 0 ? 'flex' : 'none';
            document.getElementById('wishlistBadgeMobile').textContent = wishlist.length;
            document.getElementById('wishlistBadgeMobile').style.display = wishlist.length > 0 ? 'flex' : 'none';
        }

        // Add to wishlist
        function addToWishlist(product) {
            const existingItem = wishlist.find(item => item.id === product.id);
            if (!existingItem) {
                wishlist.push({
                    id: product.id,
                    name: product.name,
                    brand: product.brand,
                    price: product.price
                });
                saveWishlist();
                trackClick('add_to_wishlist', product.name);
            }
        }

        // Remove from wishlist
        function removeFromWishlist(productId) {
            wishlist = wishlist.filter(item => item.id !== productId);
            saveWishlist();
            renderWishlist();
        }

        // Open/Close Wishlist
        function openWishlist() {
            document.getElementById('wishlistSidebar').classList.add('active');
            renderWishlist();
        }

        function closeWishlist() {
            document.getElementById('wishlistSidebar').classList.remove('active');
        }

        // Render Wishlist
        function renderWishlist() {
            const wishlistItems = document.getElementById('wishlistItems');

            if (wishlist.length === 0) {
                wishlistItems.innerHTML = '<div class="cart-empty"><i class="fas fa-heart"></i><p>Your wishlist is empty</p></div>';
                return;
            }

            wishlistItems.innerHTML = `
                <div class="wishlist-items">
                    ${wishlist.map(item => `
                        <div class="wishlist-item">
                            <button class="wishlist-item-remove" onclick="removeFromWishlist(${item.id})">&times;</button>
                            <div class="wishlist-item-image">
                                <i class="fas fa-clock"></i>
                            </div>
                            <p class="wishlist-item-name">${item.brand} ${item.name}</p>
                            <p class="cart-item-price" data-price-aed="${item.price}">${formatPrice(item.price)}</p>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Inquire via WhatsApp
        function inquireViaWhatsApp(product) {
            const refCode = product.reference_number ? ` - Ref: ${product.reference_number}` : '';
            const message = `Hello Mainspring, I am interested in ${product.brand} ${product.name}${refCode}. Please provide more information.`;
            const whatsappUrl = `https://wa.me/971585625042?text=${encodeURIComponent(message)}`;
            trackAndRedirect(product.id, product.reference_number || '', whatsappUrl);
        }

        // New tracking function
        async function trackAndRedirect(productId, referenceCode, whatsappUrl) {
            // Fire-and-forget click log
            fetch('https://sldb.swiftloop.tech/rest/v1/mainspring_watch_clicks', {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    product_id: productId,
                    reference_code: referenceCode,
                    user_agent: navigator.userAgent,
                    device_type: /Mobile|iPhone|Android/.test(navigator.userAgent) ? 'mobile' : 'desktop'
                })
            });
            // Redirect immediately (don't wait for the POST)
            window.open(whatsappUrl, '_blank');
        }

        // Track clicks to Supabase
        async function trackClick(element, productContext = null) {
            try {
                await supabaseClient
                    .from('mainspring_clicks')
                    .insert({
                        element_clicked: element,
                        page_path: window.location.pathname,
                        product_context: productContext
                    });
            } catch (error) {
                console.log('Click tracked locally:', element, productContext);
                // Store locally if table doesn't exist
                let localClicks = JSON.parse(localStorage.getItem('mainspring_clicks')) || [];
                localClicks.push({
                    element: element,
                    product: productContext,
                    timestamp: new Date().toISOString()
                });
                localStorage.setItem('mainspring_clicks', JSON.stringify(localClicks));
            }
        }

        // ---- Navigation overlay -------------------------------------------
        // The overlay's visibility is driven by CSS transitions (including
        // per-item stagger delays). If the document's animation timeline is
        // stalled — a restored/backgrounded tab, a throttled renderer, bfcache —
        // those transitions never advance and the menu is left either invisible
        // but "open", or stuck as an opaque black panel that swallows every tap
        // until the page is reloaded. `nav-settled` is the escape hatch: it drops
        // the transitions so the overlay snaps to whatever state it should be in.
        let navSettleTimer = null;

        function navIsOpen() {
            return navOverlay.classList.contains('active');
        }

        // Snap the overlay to its end state if the transition has not got there.
        function settleNav() {
            const open = navIsOpen();
            const opacity = parseFloat(getComputedStyle(navOverlay).opacity) || 0;
            const lastItem = navOverlay.querySelector('.nav-links > li:last-child');
            const lastOpacity = lastItem ? (parseFloat(getComputedStyle(lastItem).opacity) || 0) : 1;
            // An expanded submenu animates its max-height and stalls the same way.
            const expanded = navOverlay.querySelector('.nav-item-wrapper.mobile-expanded .nav-dropdown');
            const submenuStuck = !!expanded && expanded.getBoundingClientRect().height < 1;

            const settled = open
                ? (opacity > 0.95 && lastOpacity > 0.95 && !submenuStuck)
                : opacity < 0.05;
            if (!settled) navOverlay.classList.add('nav-settled');
        }

        // Re-check after a submenu expands, so a stalled max-height transition
        // does not leave the accessory categories collapsed and unreachable.
        function scheduleNavSettle(delay = 500) {
            clearTimeout(navSettleTimer);
            navSettleTimer = setTimeout(settleNav, delay);
        }

        function setNavOpen(open) {
            burgerMenu.classList.toggle('active', open);
            navOverlay.classList.toggle('active', open);
            document.getElementById('navBackdrop').classList.toggle('active', open);

            // Collapse any expanded submenu on close. Leaving it expanded kept a
            // 300px+ block of category links laid over the page, and the menu
            // also reopened with a submenu the user never asked for.
            if (!open) {
                navOverlay.querySelectorAll('.nav-item-wrapper.mobile-expanded')
                    .forEach(wrapper => wrapper.classList.remove('mobile-expanded'));
            }

            // Let the transition run normally first; only intervene if it stalls.
            navOverlay.classList.remove('nav-settled');
            // Longest path is the 0.68s stagger delay plus the 0.4s transition.
            scheduleNavSettle(1200);
        }

        function closeNav() {
            setNavOpen(false);
        }

        function toggleNav() {
            setNavOpen(!navIsOpen());
        }

        // A tab that comes back to the foreground (or out of bfcache) may have
        // left transitions frozen mid-flight. Re-settle rather than leave the
        // menu in a half-drawn, unusable state.
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                clearTimeout(navSettleTimer);
                navSettleTimer = setTimeout(settleNav, 60);
            }
        });
        window.addEventListener('pageshow', function () {
            clearTimeout(navSettleTimer);
            navSettleTimer = setTimeout(settleNav, 60);
        });

        // Overlays that cover the page or lock body scrolling. Any navigation has
        // to leave them closed — a leftover overlay (or its scroll lock) reads to
        // the user as a blank, frozen page.
        function closeTransientOverlays() {
            closeNav();
            closeGlobalSearch();
            closeFilterDrawer();
            closeImageZoom();
            closeCart();
            closeWishlist();
            document.querySelectorAll('.custom-dropdown.open').forEach(d => d.classList.remove('open'));
            const currencyMenu = document.getElementById('currencyDropdownMenu');
            if (currencyMenu) currencyMenu.classList.remove('active');
            document.body.style.overflow = '';
        }

        // Toggle Search - Focus on search input
        function toggleSearch() {
            const overlay = document.getElementById('globalSearchOverlay');
            const wasActive = overlay.classList.contains('active');
            if (wasActive) {
                closeGlobalSearch();
                return;
            }
            overlay.classList.add('active');
            document.getElementById('globalSearchInput').value = '';
            document.getElementById('globalSearchResults').innerHTML = '<div class="search-message">Type to search watches and accessories</div>';
            document.getElementById('globalSearchInput').focus();
        }

        function closeGlobalSearch() {
            const overlay = document.getElementById('globalSearchOverlay');
            overlay.classList.remove('active');
            clearTimeout(globalSearchDebounceTimer);
            globalSearchRequestGuard.invalidate();
            document.getElementById('globalSearchResults').innerHTML = '';
        }

        function queueGlobalSearch(value) {
            clearTimeout(globalSearchDebounceTimer);
            globalSearchDebounceTimer = setTimeout(() => performGlobalSearch(value), 180);
        }

        // Search every matching product record and discard responses from older keystrokes.
        async function performGlobalSearch(value) {
            const resultsContainer = document.getElementById('globalSearchResults');
            const searchFilter = buildProductSearchFilter(value);
            const requestId = globalSearchRequestGuard.next();

            if (!searchFilter) {
                resultsContainer.innerHTML = '<div class="search-message">Type to search watches and accessories</div>';
                return;
            }

            resultsContainer.innerHTML = '<div class="search-message"><div class="loading"><div class="loading-spinner"></div></div></div>';

            try {
                const createGlobalProductSearchQuery = () => excludeUnavailableProducts(supabaseClient
                    .from('mainspring_public_products')
                    .select(PUBLIC_PRODUCT_COLUMNS)
                    .or(searchFilter));
                const data = await fetchAllProductSearchResults(createGlobalProductSearchQuery, value);

                if (!globalSearchRequestGuard.isCurrent(requestId)) return;
                if (!data.length) {
                    resultsContainer.innerHTML = '<div class="search-message">No results found.</div>';
                    return;
                }

                renderProducts(data, resultsContainer, { fromGlobalSearch: true });
            } catch (err) {
                if (!globalSearchRequestGuard.isCurrent(requestId)) return;
                console.error('Product search failed:', err);
                resultsContainer.innerHTML = '<div class="search-message">Search is temporarily unavailable. Please try again.</div>';
            }
        }

        // State
        let currentPage = 1;
        let totalProducts = 0;
        let currentAccessoryPage = 1;
        let totalAccessoryProducts = 0;
        let currentAccessoryCategory = '';
        let currentProduct = null;
        let currentImageIndex = 0;
        let productImages = [];

        // DOM Elements
        const header = document.getElementById('header');
        const burgerMenu = document.getElementById('burgerMenu');
        const navOverlay = document.getElementById('navOverlay');

        // Header scroll effect
        function updateHeader() {
            const logoImg = document.getElementById('mainLogo');
            if (window.scrollY > 50) {
                header.classList.add('scrolled');
                if (logoImg) logoImg.src = 'header-icon-dark.png';
            } else {
                header.classList.remove('scrolled');
                if (logoImg) logoImg.src = 'header-icon-light.png';
            }
        }
        window.addEventListener('scroll', updateHeader);
        updateHeader();

        // Burger menu toggle
        burgerMenu.addEventListener('click', toggleNav);

        // FAQ accordion
        function toggleFaq(btn) {
            const item = btn.parentElement;
            const isOpen = item.classList.contains('open');
            document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
            if (!isOpen) item.classList.add('open');
        }

        // Filter Drawer Toggle
        function toggleFilterDrawer() {
            document.getElementById('filterDrawer').classList.toggle('active');
            document.getElementById('filterDrawerOverlay').classList.toggle('active');
            document.body.style.overflow = document.getElementById('filterDrawer').classList.contains('active') ? 'hidden' : '';
        }

        function closeFilterDrawer() {
            document.getElementById('filterDrawer').classList.remove('active');
            document.getElementById('filterDrawerOverlay').classList.remove('active');
            document.body.style.overflow = '';
        }

        // Expand/collapse a nav submenu that has no page of its own (MORE).
        // Without this it only opened on :hover, which touch devices do not
        // reliably deliver, leaving Warranty / Sourcing / Sell unreachable
        // from the mobile menu.
        function toggleNavSubmenu(event, element) {
            if (event) event.preventDefault();
            const wrapper = element.closest('.nav-item-wrapper');
            if (!wrapper) return;

            const willExpand = !wrapper.classList.contains('mobile-expanded');
            document.querySelectorAll('.nav-item-wrapper.mobile-expanded').forEach(w => w.classList.remove('mobile-expanded'));
            if (willExpand) {
                wrapper.classList.add('mobile-expanded');
                scheduleNavSettle(500);
            }
        }

        // Page navigation
        function handleNavClick(event, element, pageId) {
            if (window.innerWidth <= 992) {
                const wrapper = element.closest('.nav-item-wrapper');
                if (!wrapper) {
                    showPage(pageId);
                    closeNav();
                    return;
                }
                if (!wrapper.classList.contains('mobile-expanded')) {
                    document.querySelectorAll('.nav-item-wrapper.mobile-expanded').forEach(w => w.classList.remove('mobile-expanded'));
                    wrapper.classList.add('mobile-expanded');
                    scheduleNavSettle(500);
                } else {
                    wrapper.classList.remove('mobile-expanded');
                    showPage(pageId);
                    closeNav();
                }
            } else {
                showPage(pageId);
                closeNav();
            }
        }

        // Navigation logic
        function showPage(pageName, skipPushState = false, skipReset = false) {
            const target = document.getElementById('page-' + pageName);
            if (!target) {
                // Unknown page: a stale bookmark, a typo, or a legacy link.
                // Falling back to home keeps the site usable — throwing here used
                // to abort the caller (including initApp) and leave a blank page.
                console.warn('Unknown page "' + pageName + '" — falling back to home.');
                if (pageName !== 'home') showPage('home', skipPushState);
                return;
            }

            closeTransientOverlays();

            // Reset filter state without querying; the load below is the only one.
            if (!skipReset) {
                if (pageName === 'watches') {
                    resetFilters(false);
                    currentPage = 1;
                } else if (pageName === 'accessories') {
                    resetAccessoryFilters(false);
                    currentAccessoryCategory = '';
                    currentAccessoryPage = 1;
                } else if (pageName === 'blog') {
                    currentBlogPage = 1;
                }
            }

            document.querySelectorAll('.page-section').forEach(section => {
                section.classList.remove('active');
            });
            target.classList.add('active');
            window.scrollTo(0, 0);

            // Load data if needed
            if (pageName === 'watches') {
                updatePriceDropdownLabels();
                loadBrandsFilter();
                loadConditionsFilter();
                loadWatches();
            } else if (pageName === 'accessories') {
                setAccessoryCategoriesVisible(true);
            } else if (pageName === 'blog') {
                loadBlogPosts();
            } else if (pageName === 'home') {
                loadFeaturedWatches();
            }

            // Animate elements
            setTimeout(() => {
                document.querySelectorAll('.animate-on-scroll').forEach(el => {
                    el.classList.add('animated');
                });
            }, 100);

            // Push to browser history (unless being called from showProductDetail)
            if (!skipPushState && pageName !== 'detail') {
                history.pushState({ page: pageName }, '', `?page=${pageName}`);
            }
        }

        // Load brands from Supabase and populate the brand filter dropdown
        let brandsFilterLoaded = false;

        async function loadBrandsFilter() {
            if (brandsFilterLoaded) return;
            try {
                const { data, error } = await supabaseClient
                    .from('mainspring_public_products')
                    .select('brand')
                    .eq('category', 'watch')
                    .not('brand', 'is', null)
                    .neq('brand', '');

                if (error || !data) return;

                const brands = [...new Set(data.map(p => p.brand).filter(Boolean))].sort();

                const menu = document.getElementById('brandDropdown')?.querySelector('.custom-dropdown-menu');
                if (!menu) return;

                // Keep the "All Brands" item and remove any leftover items
                const allBrandsItem = menu.querySelector('.custom-dropdown-item[data-value=""]');
                menu.innerHTML = '';
                if (allBrandsItem) menu.appendChild(allBrandsItem);

                brands.forEach(brand => {
                    const item = document.createElement('div');
                    item.className = 'custom-dropdown-item';
                    item.dataset.value = brand;
                    item.textContent = brand;
                    item.addEventListener('click', function () {
                        selectFilter('brand', brand, this);
                    });
                    menu.appendChild(item);
                });

                brandsFilterLoaded = true;
            } catch (e) {
                // Silently fail — dropdown retains "All Brands" only
            }
        }

        // Load the exact condition values used by watch records. Keeping these
        // data-driven prevents the filter from drifting away from the catalogue.
        let conditionsFilterLoaded = false;

        async function loadConditionsFilter() {
            if (conditionsFilterLoaded) return;
            try {
                const { data, error } = await supabaseClient
                    .from('mainspring_public_products')
                    .select('condition')
                    .eq('category', 'watch')
                    .not('condition', 'is', null)
                    .neq('condition', '');

                if (error || !data) return;

                const conditions = [...new Set(data.map(p => p.condition).filter(Boolean))].sort();
                const dropdown = document.getElementById('drawerConditionDropdown');
                const menu = dropdown?.querySelector('.custom-dropdown-menu');
                if (!menu) return;

                const anyConditionItem = menu.querySelector('.custom-dropdown-item[data-value=""]');
                menu.innerHTML = '';
                if (anyConditionItem) menu.appendChild(anyConditionItem);

                conditions.forEach(condition => {
                    const item = document.createElement('div');
                    item.className = 'custom-dropdown-item';
                    item.dataset.value = condition;
                    item.textContent = condition;
                    item.addEventListener('click', function () {
                        selectFilter('condition', condition, this);
                    });
                    menu.appendChild(item);
                });

                setWatchFilter('condition', document.getElementById('conditionFilter')?.value || '');
                conditionsFilterLoaded = true;
            } catch (e) {
                // Silently fail — dropdown retains "Any Condition" only.
            }
        }

        // Load watches from Supabase
        // Sold and archived products are never shown on the site.
        function excludeUnavailableProducts(query) {
            return query.or('status.not.in.(sold,reserved,archived),status.is.null');
        }

        // Listing queries are fired from typing and from rapid filter changes.
        // Without a guard the slowest response wins and the grid ends up showing
        // results for a filter the user has already moved on from.
        const watchListRequestGuard = createLatestRequestGuard();
        const accessoryListRequestGuard = createLatestRequestGuard();

        async function loadWatches() {
            const grid = document.getElementById('watchesGrid');
            const requestId = watchListRequestGuard.next();
            grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            try {
                const brandFilter = document.getElementById('brandFilter').value;
                const priceFilter = document.getElementById('priceFilter').value;
                const searchTerm = document.getElementById('searchInput').value;
                const searchFilter = buildProductSearchFilter(searchTerm);
                const sortBy = document.getElementById('sortFilter').value;
                const conditionFilter = document.getElementById('conditionFilter').value;
                const genderFilter = document.getElementById('genderFilter').value;
                const movementFilter = document.getElementById('movementFilter').value;
                const countryFilter = document.getElementById('countryFilter').value;

                // Apply all active filters to a query builder
                function applyWatchFilters(q) {
                    q = q.eq('category', 'watch');
                    // Availability is a listing rule, not the product-condition filter.
                    q = excludeUnavailableProducts(q);
                    if (conditionFilter) q = q.eq('condition', conditionFilter);
                    if (brandFilter) q = q.eq('brand', brandFilter);
                    if (genderFilter) q = q.eq('gender', genderFilter);
                    if (movementFilter) q = q.eq('movement', movementFilter);
                    if (countryFilter) q = q.eq('country', countryFilter);
                    if (searchFilter) q = q.or(searchFilter);
                    if (priceFilter) {
                        if (priceFilter.includes('+')) {
                            q = q.gte('price', parseInt(priceFilter.replace('+', '')));
                        } else if (priceFilter.includes('-')) {
                            const [min, max] = priceFilter.split('-').map(p => parseInt(p));
                            if (!isNaN(min) && !isNaN(max)) q = q.gte('price', min).lte('price', max);
                        }
                    }
                    return q;
                }

                const createWatchQuery = (columns = PUBLIC_PRODUCT_COLUMNS, options) => applyWatchFilters(
                    supabaseClient.from('mainspring_public_products').select(columns, options)
                );
                const sortWatches = (query) => {
                    if (sortBy === 'price-low') return query.order('price', { ascending: true });
                    if (sortBy === 'price-high') return query.order('price', { ascending: false });
                    return query.order('reference_code', { ascending: false, nullsFirst: false });
                };
                let data;
                let count;
                if (searchFilter) {
                    const createWatchSearchQuery = () => sortWatches(createWatchQuery());
                    const matchingProducts = await fetchAllProductSearchResults(createWatchSearchQuery, searchTerm);
                    count = matchingProducts.length;
                    const offset = (currentPage - 1) * PRODUCTS_PER_PAGE;
                    data = matchingProducts.slice(offset, offset + PRODUCTS_PER_PAGE);
                } else {
                    const result = await fetchProductsPage(
                        createWatchQuery,
                        sortWatches,
                        currentPage
                    );
                    data = result.data;
                    count = result.count;
                }
                if (!watchListRequestGuard.isCurrent(requestId)) return;
                totalProducts = count;

                renderProducts(data, grid);
                updatePagination();
                syncWatchUrl();
            } catch (error) {
                if (!watchListRequestGuard.isCurrent(requestId)) return;
                console.error('Error loading watches:', error);

                // No demo fallback — show no products found
                grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px; color: var(--gray);">No products found.</div>';
                totalProducts = 0;
                updatePagination();
            }
        }

        const PRODUCTS_PER_PAGE = 28;

        async function fetchProductsPage(createQuery, sortQuery, page) {
            const { count, error: countError } = await createQuery('id', { count: 'exact', head: true });
            if (countError) throw countError;

            const offset = (page - 1) * PRODUCTS_PER_PAGE;
            const { data, error } = await sortQuery(createQuery()).range(offset, offset + PRODUCTS_PER_PAGE - 1);
            if (error) throw error;

            return { data: data || [], count: count || 0 };
        }

        function openProductFromSearch(event, productIdentifier) {
            closeGlobalSearch();
            showProductDetail(event, productIdentifier);
        }

        const PUBLIC_PRODUCT_COLUMNS = [
            'id',
            'reference_code',
            'name',
            'brand',
            'model',
            'caption',
            'condition',
            'price',
            'category',
            'subcategory',
            'created_at',
            'watch_reference',
            'watch_year',
            'product_details',
            'status',
            'updated_at',
            'size',
            'gender',
            'country',
            'movement',
            'image_urls',
            'deliverables',
        ].join(',');

        function escapeMarkup(value) {
            return String(value ?? '').replace(/[&<>"']/g, c => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        }

        // JSON is used for inline handlers that remain in the legacy storefront
        // renderer. Encode HTML-sensitive characters before placing it in an
        // attribute so edited catalogue text cannot become executable markup.
        function safeInlineJson(value) {
            return JSON.stringify(value)
                .replace(/</g, '\\u003c')
                .replace(/>/g, '\\u003e')
                .replace(/&/g, '\\u0026')
                .replace(/\u2028/g, '\\u2028')
                .replace(/\u2029/g, '\\u2029');
        }

        function renderDetailMeta(label, value) {
            if (value === null || value === undefined || String(value).trim() === '') return '';
            return `
                    <div class="meta-item">
                        <span class="meta-label">${escapeMarkup(label)}</span>
                        <span class="meta-value">${escapeMarkup(String(value).trim())}</span>
                    </div>`;
        }

        // brand and model underneath. They do not reuse the listing card markup.
        function renderSearchResults(products, grid) {
            grid.innerHTML = products.map(product => {
                const firstImageCandidate = (Array.isArray(product.image_urls) && product.image_urls.length > 0) ? product.image_urls[0] : null;
                const firstImage = isSafeImageUrl(firstImageCandidate) ? firstImageCandidate.trim() : null;
                const brand = escapeMarkup(product.brand || '');
                const model = escapeMarkup(product.model || product.name || '');
                const identifier = toPublicRef(product.reference_code) || product.id;
                const openProductCall = escapeMarkup(`openProductFromSearch(event, ${safeInlineJson(identifier)})`);
                const alt = escapeMarkup(`${product.brand || ''} ${product.model || product.name || ''}`.trim());

                return `
                <div class="search-card" role="button" tabindex="0"
                    onclick="${openProductCall}"
                    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${openProductCall};}">
                    <div class="search-card-image">
                        ${firstImage
                        ? `<img src="${escapeMarkup(firstImage)}" alt="${alt}" loading="lazy">`
                        : `<div class="search-card-placeholder"><i class="fas fa-clock"></i></div>`}
                    </div>
                    <div class="search-card-meta">
                        ${brand ? `<span class="search-card-brand">${brand}</span>` : ''}
                        <span class="search-card-model">${model}</span>
                    </div>
                </div>
            `;
            }).join('');
        }

        function renderProducts(products, grid, options = {}) {
            if (!products || products.length === 0) {
                grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px;"><p>No products found.</p></div>';
                return;
            }

            if (options.fromGlobalSearch) {
                renderSearchResults(products, grid);
                return;
            }

            grid.innerHTML = products.map(product => {
                // image_urls is an array — use the first image if available
                const firstImageCandidate = (Array.isArray(product.image_urls) && product.image_urls.length > 0) ? product.image_urls[0] : null;
                const firstImage = isSafeImageUrl(firstImageCandidate) ? firstImageCandidate.trim() : null;
                const displayName = product.model ? product.model : product.name;
                const displayBrand = product.brand || '';
                const displayNameMarkup = escapeMarkup(displayName || '');
                const displayBrandMarkup = escapeMarkup(displayBrand);
                const isUnavailable = ['sold', 'reserved'].includes(product.status);
                const unavailableLabel = product.status === 'reserved' ? 'Reserved' : 'Sold';
                const unavailableStatus = product.status === 'reserved' ? 'reserved' : 'sold';

                let additionalInfo = '';
                if (product.category === 'watch') {
                    // For watches: show watch_year and watch_reference
                    const year = product.watch_year || product.year || '';
                    const reference = product.watch_reference || product.reference_number || '';
                    const yearMarkup = escapeMarkup(year);
                    const referenceMarkup = escapeMarkup(reference);
                    if (year || reference) {
                        additionalInfo = `<p style="font-size: 0.75rem; color: var(--gray); margin-bottom: 4px;">`;
                        if (year) additionalInfo += `${yearMarkup}`;
                        if (year && reference) additionalInfo += ` • `;
                        if (reference) additionalInfo += `Ref: ${referenceMarkup}`;
                        additionalInfo += `</p>`;
                    }
                }

                const statusClass = isUnavailable ? ` ${unavailableStatus}` : '';
                const productIdentifier = toPublicRef(product.reference_code) || product.id;
                const openProductCall = escapeMarkup(`showProductDetail(event, ${safeInlineJson(productIdentifier)})`);
                const encodedCartProduct = encodeProductForCart(product);
                const addToCartCall = escapeMarkup(`event.stopPropagation(); addToCartEncodedProduct(${safeInlineJson(encodedCartProduct)})`);
                const wishlistCall = escapeMarkup(`event.stopPropagation(); addToWishlist(${safeInlineJson({
                    id: product.id,
                    name: displayName,
                    brand: displayBrand,
                    price: product.price,
                })})`);

                return `
                <div class="product-card${statusClass}">
                    <div class="product-image" onclick="${openProductCall}">
                        ${firstImage ?
                        `<img src="${escapeMarkup(firstImage)}" alt="${escapeMarkup(`${displayBrand} ${displayName}`)}" loading="lazy">` :
                        `<div class="product-placeholder"><i class="fas fa-clock"></i></div>`
                    }
                    </div>
                    <div class="product-info">
                        <h3 class="product-name" onclick="${openProductCall}">${displayNameMarkup}</h3>
                        <p class="product-brand">${displayBrandMarkup}</p>
                        ${additionalInfo}
                        <p class="product-price" data-price-aed="${escapeMarkup(product.price)}">${escapeMarkup(formatPrice(product.price))}</p>
                        <div style="display: flex; gap: 8px; margin-top: auto; padding-top: 15px;">
                            ${isUnavailable ? `
                            <button disabled style="flex: 1; padding: 10px; background: var(--gray); color: white; border: none; cursor: default; font-size: 0.8rem; opacity: 0.7;">
                                <i class="fas fa-ban"></i> ${unavailableLabel}
                            </button>
                            ` : `
                            <button onclick="${addToCartCall}" style="flex: 1; padding: 10px; background: var(--primary-green); color: white; border: none; cursor: pointer; font-size: 0.8rem; border-radius: 0;">
                                <i class="fas fa-shopping-bag"></i> Add to Cart
                            </button>
                            <button onclick="${wishlistCall}" style="padding: 10px 12px; background: none; border: 1px solid var(--cream-dark); cursor: pointer; font-size: 0.8rem; color: var(--primary-green); border-radius: 0;">
                                <i class="far fa-heart"></i>
                            </button>
                            `}
                        </div>
                    </div>
                </div>
            `}).join('');
        }

        

        function updatePagination() {
            const totalPages = Math.ceil(totalProducts / PRODUCTS_PER_PAGE) || 1;
            const container = document.getElementById('pagination');
            container.innerHTML = renderPaginationButtons(currentPage, totalPages, 'goToWatchPage');
        }

        function goToWatchPage(page) {
            currentPage = page;
            // A placeholder entry; loadWatches() replaces it with the full state
            // (page plus every active filter) once the grid has rendered.
            history.pushState({ page: 'watches', pg: page, filters: readWatchFilters() }, '', window.location.search);
            loadWatches();
            window.scrollTo(0, 300);
        }

        // Load featured watches for the home page (12 watches)
        async function loadFeaturedWatches() {
            const grid = document.getElementById('featuredWatchesGrid');
            if (!grid) return; // Grid doesn't exist on non-home pages

            try {
                let query = supabaseClient
                    .from('mainspring_public_products')
                    .select(PUBLIC_PRODUCT_COLUMNS)
                    .eq('category', 'watch')
                    .eq('status', 'available')
                    .order('reference_code', { ascending: false, nullsFirst: false })
                    .limit(12);

                const { data, error } = await query;

                if (error) throw error;

                if (data && data.length > 0) {
                    renderProducts(data, grid);
                } else {
                    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--gray);">No featured watches available.</div>';
                }
            } catch (error) {
                console.error('Error loading featured watches:', error);
                grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--gray);">No featured watches available.</div>';
            }
        }

        function renderPaginationButtons(current, total, fnName) {
            if (total <= 1) return '';
            let html = '';
            html += `<button ${current === 1 ? 'disabled' : ''} onclick="${fnName}(${current - 1})">Previous</button>`;
            const pages = [];
            pages.push(1);
            let start = Math.max(2, current - 2);
            let end = Math.min(total - 1, current + 2);
            if (start > 2) pages.push('...');
            for (let i = start; i <= end; i++) pages.push(i);
            if (end < total - 1) pages.push('...');
            if (total > 1) pages.push(total);
            pages.forEach(p => {
                if (p === '...') {
                    html += `<span class="pagination-ellipsis">...</span>`;
                } else {
                    html += `<button class="${p === current ? 'pagination-active' : ''}" onclick="${fnName}(${p})">${p}</button>`;
                }
            });
            html += `<button ${current >= total ? 'disabled' : ''} onclick="${fnName}(${current + 1})">Next</button>`;
            return html;
        }

        // ---- Watch filter state ------------------------------------------
        // Filters are kept in the CURRENT history entry, never in a new one.
        // Pushing an entry per filter change used to leave the stack full of
        // identical "?page=watches" steps, so pressing Back looked like it did
        // nothing. Keeping them in the entry also means a filtered view can be
        // reloaded, shared, and restored when returning from a product page.
        const WATCH_FILTER_KEYS = ['brand', 'price', 'sort', 'condition', 'gender', 'movement', 'country'];

        function readWatchFilters() {
            const filters = {};
            WATCH_FILTER_KEYS.forEach(key => {
                const input = document.getElementById(key + 'Filter');
                if (input && input.value && input.value !== 'newest') filters[key] = input.value;
            });
            const search = document.getElementById('searchInput');
            if (search && search.value.trim()) filters.q = search.value.trim();
            return filters;
        }

        function syncWatchUrl() {
            const section = document.getElementById('page-watches');
            if (!section || !section.classList.contains('active')) return;
            const filters = readWatchFilters();
            const params = new URLSearchParams({ page: 'watches' });
            Object.entries(filters).forEach(([key, value]) => params.set(key, value));
            if (currentPage > 1) params.set('pg', currentPage);
            history.replaceState({ page: 'watches', pg: currentPage, filters }, '', '?' + params.toString());
        }

        // Put the hidden inputs and every visible control back in agreement with
        // a saved filter set, without firing a query.
        function restoreWatchFilters(filters) {
            resetFilters(false);
            WATCH_FILTER_KEYS.forEach(key => {
                if (!filters[key]) return;
                if (key === 'price') {
                    document.getElementById('priceFilter').value = filters.price;
                } else {
                    setWatchFilter(key, filters[key]);
                }
            });
            const search = document.getElementById('searchInput');
            if (search) search.value = filters.q || '';
            const searchMobile = document.getElementById('searchInputMobile');
            if (searchMobile) searchMobile.value = filters.q || '';
            syncPriceControls();
        }

        // Keep the price slider and its dropdown label in step with priceFilter.
        function syncPriceControls() {
            const value = document.getElementById('priceFilter').value;
            const slider = document.querySelector('.luxury-slider');
            if (slider) {
                const max = value && value.startsWith('0-') ? parseInt(value.split('-')[1]) : 150000;
                slider.value = isNaN(max) ? 150000 : max;
                updateSliderDisplay(slider.value);
            }
            updatePriceDropdownLabels();
        }

        // Apply filters
        function applyFilters() {
            currentPage = 1;
            loadWatches();
        }

        // Typing runs a full search across every matching record, so it is
        // debounced rather than fired on each keystroke.
        let watchSearchDebounceTimer = null;

        function queueWatchSearch(val) {
            const desktop = document.getElementById('searchInput');
            const mobile = document.getElementById('searchInputMobile');
            if (desktop && desktop.value !== val) desktop.value = val;
            if (mobile && mobile.value !== val) mobile.value = val;
            clearTimeout(watchSearchDebounceTimer);
            watchSearchDebounceTimer = setTimeout(applyFilters, 250);
        }

        function syncSearchAndFilter(val) {
            queueWatchSearch(val);
        }

        function updateSliderDisplay(val) {
            const display = document.getElementById('sliderValueDisplay');
            if (val >= 150000) {
                display.textContent = 'Any';
            } else {
                display.textContent = formatSliderValue(val);
            }
        }

        function applySliderValue(val) {
            const dropdown = document.getElementById('priceDropdown');
            const trigger = dropdown.querySelector('.custom-dropdown-trigger');

            if (val >= 150000) {
                document.getElementById('priceFilter').value = '';
                trigger.textContent = 'Any Price';
            } else {
                document.getElementById('priceFilter').value = '0-' + val;
                trigger.textContent = 'Under ' + formatSliderValue(val);
            }
            
            dropdown.querySelectorAll('.custom-dropdown-item').forEach(item => item.classList.remove('selected'));
            dropdown.classList.remove('open');
            applyFilters();
        }

        // Custom dropdown functions

        function toggleDropdown(event, dropdownId) {
            const dropdown = document.getElementById(dropdownId);
            const wasOpen = dropdown.classList.contains('open');

            // Close all dropdowns
            document.querySelectorAll('.custom-dropdown').forEach(d => d.classList.remove('open'));

            // Toggle the clicked dropdown
            if (!wasOpen) {
                dropdown.classList.add('open');
            }

            // Stop propagation to prevent closing when clicking inside
            if (event) {
                event.stopPropagation();
            }
        }

        function selectFilter(type, value, element) {
            // Update the hidden input
            const input = document.getElementById(type + 'Filter');
            if (input) input.value = value;

            // Update traditional dropdown UI if element exists
            if (element) {
                const dropdown = element.closest('.custom-dropdown');
                const trigger = dropdown.querySelector('.custom-dropdown-trigger');

                // Update trigger text
                trigger.textContent = element.textContent;

                // Update selected state
                dropdown.querySelectorAll('.custom-dropdown-item').forEach(item => item.classList.remove('selected'));
                element.classList.add('selected');

                // Close dropdown
                dropdown.classList.remove('open');

                // Sync gender between desktop and drawer dropdowns
                if (type === 'gender') {
                    const syncIds = ['genderDropdown', 'drawerGenderDropdown'];
                    syncIds.forEach(id => {
                        const el = document.getElementById(id);
                        if (el && el !== dropdown) {
                            el.querySelector('.custom-dropdown-trigger').textContent = element.textContent;
                            el.querySelectorAll('.custom-dropdown-item').forEach(item => item.classList.remove('selected'));
                            const match = el.querySelector(`.custom-dropdown-item[data-value="${value}"]`);
                            if (match) match.classList.add('selected');
                        }
                    });
                }
            }

            // Apply filter
            applyFilters();
        }

        // Reset all filters. Pass applyAfter = false to reset without querying,
        // e.g. when a caller is about to set its own filter and load once.
        function resetFilters(applyAfter = true) {
            clearTimeout(watchSearchDebounceTimer);

            document.getElementById('brandFilter').value = '';
            document.getElementById('priceFilter').value = '';
            document.getElementById('sortFilter').value = 'newest';
            document.getElementById('conditionFilter').value = '';
            document.getElementById('genderFilter').value = '';
            document.getElementById('movementFilter').value = '';
            document.getElementById('countryFilter').value = '';
            document.getElementById('searchInput').value = '';
            if (document.getElementById('searchInputMobile')) document.getElementById('searchInputMobile').value = '';

            // Reset UI Dropdowns
            document.getElementById('brandDropdown').querySelector('.custom-dropdown-trigger').textContent = 'All Brands';
            document.getElementById('priceDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Price';

            // Reset Drawer Dropdowns if they exist
            if (document.getElementById('drawerSortDropdown')) document.getElementById('drawerSortDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Newest Arrivals';
            if (document.getElementById('drawerConditionDropdown')) document.getElementById('drawerConditionDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Condition';
            if (document.getElementById('genderDropdown')) document.getElementById('genderDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Gender';
            if (document.getElementById('drawerGenderDropdown')) document.getElementById('drawerGenderDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Gender';
            if (document.getElementById('drawerMovementDropdown')) document.getElementById('drawerMovementDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Movement';

            // Scoped to the watches page: a global querySelectorAll here also wiped
            // the selected state out of the accessories dropdowns.
            const watchesPage = document.getElementById('page-watches');
            if (watchesPage) {
                watchesPage.querySelectorAll('.custom-dropdown-item').forEach(item => item.classList.remove('selected'));
                watchesPage.querySelectorAll('.custom-dropdown-item[data-value=""]').forEach(item => item.classList.add('selected'));
                watchesPage.querySelectorAll('.custom-dropdown-item[data-value="newest"]').forEach(item => item.classList.add('selected'));
            }

            // The slider is a real control — leaving it parked at the old value
            // contradicted the "Any Price" label it sits under.
            const slider = document.querySelector('.luxury-slider');
            if (slider) {
                slider.value = 150000;
                updateSliderDisplay(150000);
            }

            if (applyAfter) applyFilters();
        }

        const ACCESSORY_FILTERS = {
            sort: { input: 'accessorySortFilter', dropdown: 'accessorySortDropdown' },
            status: { input: 'accessoryStatusFilter', dropdown: 'accessoryStatusDropdown' },
        };

        // Set an accessory filter and its dropdown UI without running a query.
        function setAccessoryFilter(type, value) {
            const config = ACCESSORY_FILTERS[type];
            if (!config) return;

            const input = document.getElementById(config.input);
            if (input) input.value = value;

            const dropdown = document.getElementById(config.dropdown);
            if (!dropdown) return;
            dropdown.querySelectorAll('.custom-dropdown-item').forEach(i => i.classList.remove('selected'));
            const item = dropdown.querySelector(`.custom-dropdown-item[data-value="${value}"]`);
            if (!item) return;
            item.classList.add('selected');
            const trigger = dropdown.querySelector('.custom-dropdown-trigger');
            if (trigger) trigger.textContent = item.textContent.trim();
        }

        function resetAccessoryFilters(applyAfter = true) {
            clearTimeout(accessorySearchDebounceTimer);
            const searchInput = document.getElementById('accessorySearchInput');
            if (searchInput) searchInput.value = '';
            setAccessoryFilter('sort', 'newest');
            setAccessoryFilter('status', '');
            if (applyAfter) applyAccessoryFilters();
        }

        // Put the accessory controls back in agreement with a saved filter set,
        // without running a query — used when restoring a history entry.
        function restoreAccessoryFilters(filters) {
            resetAccessoryFilters(false);
            if (filters.sort) setAccessoryFilter('sort', filters.sort);
            if (filters.status) setAccessoryFilter('status', filters.status);
            const searchInput = document.getElementById('accessorySearchInput');
            if (searchInput) searchInput.value = filters.q || '';
        }

        // Same reasoning as the watches search: one full query per keystroke is
        // both slow and prone to rendering a stale response last.
        let accessorySearchDebounceTimer = null;

        function queueAccessorySearch(val) {
            const input = document.getElementById('accessorySearchInput');
            if (input && input.value !== val) input.value = val;
            clearTimeout(accessorySearchDebounceTimer);
            accessorySearchDebounceTimer = setTimeout(applyAccessoryFilters, 250);
        }

        function selectAccessoryFilter(type, value, element) {
            if (event) event.stopPropagation();

            const dropdown = element.closest('.custom-dropdown');
            const trigger = dropdown.querySelector('.custom-dropdown-trigger');

            // Update trigger text
            trigger.textContent = element.textContent;

            // Update selected state
            dropdown.querySelectorAll('.custom-dropdown-item').forEach(item => item.classList.remove('selected'));
            element.classList.add('selected');

            // Close dropdown
            dropdown.classList.remove('open');

            // Apply accessory filter
            if (type === 'sort') {
                document.getElementById('accessorySortFilter').value = value;
            } else if (type === 'status') {
                document.getElementById('accessoryStatusFilter').value = value;
            }

            applyAccessoryFilters();
        }

        // Close dropdowns when clicking outside
        document.addEventListener('click', function (e) {
            if (!e.target.closest('.custom-dropdown')) {
                document.querySelectorAll('.custom-dropdown').forEach(d => d.classList.remove('open'));
            }
        });

        // Keyboard navigation: ESC closes zoom/search, arrow keys navigate gallery
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                const zoomOverlay = document.getElementById('galleryZoomOverlay');
                if (zoomOverlay && zoomOverlay.classList.contains('active')) {
                    closeImageZoom();
                    return;
                }
                const overlay = document.getElementById('globalSearchOverlay');
                if (overlay && overlay.classList.contains('active')) {
                    closeGlobalSearch();
                }
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const zoomOverlay = document.getElementById('galleryZoomOverlay');
                if (zoomOverlay && zoomOverlay.classList.contains('active')) {
                    e.preventDefault();
                    if (e.key === 'ArrowLeft') zoomPrevImage(e);
                    else zoomNextImage(e);
                    return;
                }
                const activeEl = document.activeElement;
                if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) return;
                const detailPage = document.getElementById('page-detail');
                if (detailPage && detailPage.classList.contains('active')) {
                    if (e.key === 'ArrowLeft') prevImage();
                    else nextImage();
                }
            }
        });

        // Visible dropdowns mirroring each hidden watch filter input, so the
        // shortcuts below can set a filter and keep the controls in agreement.
        const WATCH_FILTER_DROPDOWNS = {
            brand: ['brandDropdown'],
            gender: ['genderDropdown', 'drawerGenderDropdown'],
            condition: ['drawerConditionDropdown'],
            movement: ['drawerMovementDropdown'],
            sort: ['drawerSortDropdown'],
        };

        // Set a watch filter and its dropdown UI without running a query.
        function setWatchFilter(type, value) {
            const input = document.getElementById(type + 'Filter');
            if (input) input.value = value;

            (WATCH_FILTER_DROPDOWNS[type] || []).forEach(id => {
                const dropdown = document.getElementById(id);
                if (!dropdown) return;
                const trigger = dropdown.querySelector('.custom-dropdown-trigger');
                const item = [...dropdown.querySelectorAll('.custom-dropdown-item')]
                    .find(option => option.dataset.value === value);

                dropdown.querySelectorAll('.custom-dropdown-item').forEach(i => i.classList.remove('selected'));
                if (item) {
                    item.classList.add('selected');
                    if (trigger) trigger.textContent = item.textContent.trim();
                } else if (trigger && value) {
                    // Data-driven brand and condition items are populated asynchronously.
                    trigger.textContent = value;
                }
            });
        }

        // Filter by brand
        function filterByBrand(brand) {
            resetFilters(false);
            setWatchFilter('brand', brand);
            currentPage = 1;
            // skipReset, otherwise showPage would clear the filter we just set.
            showPage('watches', false, true);
        }

        // Filter by gender
        function filterByGender(gender) {
            resetFilters(false);
            setWatchFilter('gender', gender);
            currentPage = 1;
            showPage('watches', false, true);
        }

        // Swap the accessories page between the category picker and the product
        // list. The whole section is toggled, not just the grid, so its padding
        // does not leave a blank band above the products.
        function setAccessoryCategoriesVisible(visible) {
            const grid = document.getElementById('categoriesGrid');
            const products = document.getElementById('accessoryProducts');
            if (grid) {
                grid.style.display = visible ? 'grid' : 'none';
                const section = grid.closest('.categories-section');
                if (section) section.style.display = visible ? '' : 'none';
            }
            if (products) products.style.display = visible ? 'none' : 'block';
        }

        // Show accessory category. `category` is null/'' for "All Accessories";
        // 'all' is only ever a URL sentinel and must not reach the query.
        // `page` restores a paginated view when returning through history.
        function showAccessoryCategory(category, skipPushState = false, page = 1) {
            currentAccessoryCategory = (!category || category === 'all') ? null : category;
            currentAccessoryPage = page;

            // skipReset, so the caller's filter state survives and we load once.
            showPage('accessories', true, true);
            setAccessoryCategoriesVisible(false);

            loadAccessories();
            document.getElementById('accessoryProducts').scrollIntoView({ behavior: 'smooth' });

            if (!skipPushState) {
                const slug = currentAccessoryCategory || 'all';
                history.pushState(
                    { page: 'accessories', category: slug, pg: currentAccessoryPage, filters: readAccessoryFilters() },
                    '',
                    `?page=accessories&category=${encodeURIComponent(slug)}`
                );
            }
        }

        // Show all accessories (no category filter)
        function showAllAccessories() {
            resetAccessoryFilters(false);
            showAccessoryCategory(null);
        }

        // Back to accessory categories
        function backToAccessoryCategories() {
            currentAccessoryCategory = null;
            currentAccessoryPage = 1;
            resetAccessoryFilters(false);
            setAccessoryCategoriesVisible(true);
            document.getElementById('categoriesGrid').scrollIntoView({ behavior: 'smooth' });

            history.pushState({ page: 'accessories' }, '', `?page=accessories`);
        }

        function readAccessoryFilters() {
            const filters = {};
            const sort = document.getElementById('accessorySortFilter');
            const status = document.getElementById('accessoryStatusFilter');
            const search = document.getElementById('accessorySearchInput');
            if (sort && sort.value && sort.value !== 'newest') filters.sort = sort.value;
            if (status && status.value) filters.status = status.value;
            if (search && search.value.trim()) filters.q = search.value.trim();
            return filters;
        }

        // Keep the current history entry in step with the accessory view, so a
        // reload or a return from a product page lands back on the same list.
        function syncAccessoryUrl() {
            const section = document.getElementById('page-accessories');
            const products = document.getElementById('accessoryProducts');
            if (!section || !section.classList.contains('active')) return;
            if (!products || products.style.display === 'none') return;

            const slug = currentAccessoryCategory || 'all';
            const filters = readAccessoryFilters();
            const params = new URLSearchParams({ page: 'accessories', category: slug });
            Object.entries(filters).forEach(([key, value]) => params.set(key, value));
            if (currentAccessoryPage > 1) params.set('pg', currentAccessoryPage);
            history.replaceState(
                { page: 'accessories', category: slug, pg: currentAccessoryPage, filters },
                '',
                '?' + params.toString()
            );
        }

        // Load accessories
        async function loadAccessories() {
            const grid = document.getElementById('accessoryGrid');
            const requestId = accessoryListRequestGuard.next();
            grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            try {
                const searchTerm = document.getElementById('accessorySearchInput')?.value || '';
                // Same normalizer as the navbar and collection searches. Raw
                // interpolation let commas, brackets and '*' break out of the
                // PostgREST filter, so "strap,box" returned nothing and "a*b"
                // matched everything. It also searches reference codes now.
                const searchFilter = buildProductSearchFilter(searchTerm);
                const sortBy = document.getElementById('accessorySortFilter')?.value || 'newest';
                const statusFilter = document.getElementById('accessoryStatusFilter')?.value || '';

                const createAccessoryQuery = (columns = PUBLIC_PRODUCT_COLUMNS, options) => {
                    let query = supabaseClient
                        .from('mainspring_public_products')
                        .select(columns, options)
                        .eq('category', 'accessory');

                    if (currentAccessoryCategory) {
                        query = query.eq('subcategory', currentAccessoryCategory);
                    }

                    if (statusFilter === 'available') {
                        query = query.eq('status', 'available');
                    } else {
                        // No status filter selected — still never show sold/archived products.
                        query = excludeUnavailableProducts(query);
                    }

                    if (searchFilter) {
                        query = query.or(searchFilter);
                    }

                    return query;
                };
                const sortAccessories = (query) => {
                    if (sortBy === 'price-low') return query.order('price', { ascending: true });
                    if (sortBy === 'price-high') return query.order('price', { ascending: false });
                    return query.order('id', { ascending: false });
                };
                const { data, count } = await fetchProductsPage(
                    createAccessoryQuery,
                    sortAccessories,
                    currentAccessoryPage
                );
                if (!accessoryListRequestGuard.isCurrent(requestId)) return;
                totalAccessoryProducts = count;

                if (!data || data.length === 0) {
                    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--gray); font-size: 1.1rem;">No products found.</div>';
                } else {
                    renderProducts(data, grid);
                }

                updateAccessoryPagination();
                syncAccessoryUrl();
            } catch (error) {
                if (!accessoryListRequestGuard.isCurrent(requestId)) return;
                console.error('Error loading accessories:', error);
                grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--gray); font-size: 1.1rem;">No products found.</div>';
                totalAccessoryProducts = 0;
                updateAccessoryPagination();
            }
        }

        function updateAccessoryPagination() {
            const totalPages = Math.ceil(totalAccessoryProducts / PRODUCTS_PER_PAGE) || 1;
            const container = document.getElementById('accessoryPagination');
            container.innerHTML = renderPaginationButtons(currentAccessoryPage, totalPages, 'goToAccessoryPage');
        }

        function goToAccessoryPage(page) {
            currentAccessoryPage = page;
            // A placeholder entry; loadAccessories() replaces it with the full
            // state (category, page, filters) once the list has rendered.
            history.pushState(
                { page: 'accessories', category: currentAccessoryCategory || 'all', pg: page, filters: readAccessoryFilters() },
                '',
                window.location.search
            );
            loadAccessories();
            window.scrollTo(0, 300);
        }

        // Apply accessory filters
        function applyAccessoryFilters() {
            currentAccessoryPage = 1;
            loadAccessories();
        }


        // Show product detail
        // Accepts either (productIdentifier, skipPushState) or (event, productIdentifier, skipPushState)
        async function showProductDetail(evtOrId, maybeId, maybeSkip) {
            let event = null;
            let productIdentifier;
            let skipPushState = false;

            // Detect calling signature
            if (evtOrId && (evtOrId instanceof Event || (typeof evtOrId === 'object' && ('metaKey' in evtOrId || 'ctrlKey' in evtOrId || 'button' in evtOrId)))) {
                event = evtOrId;
                productIdentifier = maybeId;
                skipPushState = !!maybeSkip;
            } else {
                productIdentifier = evtOrId;
                skipPushState = !!maybeId;
            }

            // If the user used Cmd/Ctrl click or middle mouse button, open detail in a new tab using a real URL
            if (event && (event.metaKey || event.ctrlKey || event.button === 1)) {
                const url = window.location.pathname + `?page=detail&product=${encodeURIComponent(productIdentifier)}`;
                window.open(url, '_blank');
                return;
            }

            const detailInfo = document.getElementById('detailInfo');
            detailInfo.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            showPage('detail', true);

            // Push history immediately (before async load) so back/forward works correctly
            if (!skipPushState) {
                history.pushState({ page: 'detail', productId: productIdentifier }, '', `?page=detail&product=${encodeURIComponent(productIdentifier)}`);
            }

            // Determine if identifier is a numeric ID or a reference_number string
            const isNumericId = /^\d+$/.test(String(productIdentifier));

            // Try to load from Supabase first (fetch by ID or reference_code, no status filter)
            let product = null;
            try {
                let query = excludeUnavailableProducts(supabaseClient
                    .from('mainspring_public_products')
                    .select(PUBLIC_PRODUCT_COLUMNS));

                if (isNumericId) {
                    query = query.eq('id', productIdentifier);
                } else {
                    query = query.eq('reference_code', toInternalRef(productIdentifier));
                }

                const { data, error } = await query.single();

                if (!error && data) {
                    product = data;
                }
            } catch (e) {
                console.warn('Supabase product fetch failed:', e && e.message ? e.message : e);
            }

            if (!product) {
                detailInfo.innerHTML = `
                    <div class="detail-unavailable-message">
                        <h1>Product unavailable</h1>
                        <p>This product is no longer available in the public catalogue.</p>
                    </div>
                `;
                return;
            }

            // Normalize column names for display
            const displayName = product.model || product.name || 'Timepiece';
            const displayBrand = product.brand || '';
            const displayNameMarkup = escapeMarkup(displayName);
            const displayBrandMarkup = escapeMarkup(displayBrand);

            currentProduct = product;
            // Reset gallery index so the new product always starts at the first image
            currentImageIndex = 0;
            // image_urls is an array — use it directly for the gallery
            productImages = (Array.isArray(product.image_urls) ? product.image_urls : [])
                .filter(isSafeImageUrl)
                .map(image => image.trim());

            // Render gallery
            renderGallery();

            // Render detail info
            const watchYear = product.watch_year || product.year || '';
            const watchReference = product.watch_reference || product.reference_number || product.reference_code || '';
            const watchDetails = product.product_details || '';
            const caption = product.caption || '';
            const isUnavailableProduct = ['sold', 'reserved'].includes(product.status);
            const unavailableLabel = product.status === 'reserved' ? 'RESERVED' : 'SOLD';
            const contactProduct = {
                id: product.id,
                name: displayName,
                brand: displayBrand,
                price: product.price,
                reference_number: watchReference,
            };
            const wishlistProduct = {
                id: product.id,
                name: displayName,
                brand: displayBrand,
                price: product.price,
            };
            const whatsappCall = escapeMarkup(`inquireViaWhatsApp(${safeInlineJson(contactProduct)})`);
            const wishlistCall = escapeMarkup(`addToWishlist(${safeInlineJson(wishlistProduct)})`);

            detailInfo.innerHTML = `
                ${isUnavailableProduct ? `<div style="background: var(--gray); color: white; padding: 10px 20px; margin-bottom: 20px; text-align: center; font-family: 'Fraunces', serif; font-size: 0.9rem; letter-spacing: 3px;">${unavailableLabel}</div>` : ''}
                <p class="detail-brand">${displayBrandMarkup}</p>
                <h1 class="detail-name">${displayNameMarkup}</h1>
                ${(() => {
                    const primaryFields = [product.gender, product.movement, product.country];
                    const fallbackFields = [product.size, product.watch_year, product.watch_reference];
                    const infoItems = [];
                    let fallbackIndex = 0;
                    for (let i = 0; i < primaryFields.length; i++) {
                        const val = primaryFields[i];
                        if (val && String(val).trim()) {
                            infoItems.push(String(val).trim());
                        } else {
                            while (fallbackIndex < fallbackFields.length) {
                                const fb = fallbackFields[fallbackIndex++];
                                if (fb && String(fb).trim()) {
                                    infoItems.push(String(fb).trim());
                                    break;
                                }
                            }
                        }
                    }
                    return infoItems.length > 0
                        ? `<p style="font-size: 1.1rem; color: var(--gray); margin-bottom: 8px;">${infoItems.map(escapeMarkup).join(', ')}</p>`
                        : '';
                })()}
                <p class="detail-price" data-price-aed="${escapeMarkup(product.price)}">${escapeMarkup(formatPrice(product.price))}</p>
                <p class="detail-description">${escapeMarkup(caption)}</p>
                ${isUnavailableProduct ? `
                <div class="detail-actions">
                    <button class="btn-primary" disabled style="opacity: 0.5; cursor: default;"><i class="fas fa-ban"></i> ${unavailableLabel}</button>
                    <div class="detail-actions-row">
                        <button class="btn-primary btn-cart-action" disabled style="opacity: 0.4; cursor: default;"><i class="fas fa-shopping-bag"></i> Add to Cart</button>
                        <button class="btn-secondary btn-wishlist-action" disabled style="opacity: 0.4; cursor: default;"><i class="far fa-heart"></i></button>
                    </div>
                </div>
                ` : `
                <div class="detail-actions">
                    <button class="btn-primary btn-whatsapp-action" style="background: #25D366;" onclick="${whatsappCall}"><i class="fab fa-whatsapp"></i> WhatsApp Us</button>
                    <div class="detail-actions-row">
                        <button class="btn-primary btn-cart-action" onclick="addToCart(currentProduct)"><i class="fas fa-shopping-bag"></i> Add to Cart</button>
                        <button class="btn-secondary btn-wishlist-action" onclick="${wishlistCall}"><i class="far fa-heart"></i></button>
                    </div>
                </div>
                `}
                <div class="detail-meta">
                    ${renderDetailMeta('Brand', displayBrand)}
                    ${renderDetailMeta('Model', displayName)}
                    ${renderDetailMeta('Reference Number', watchReference)}
                    ${renderDetailMeta('Year', watchYear)}
                    ${renderDetailMeta('Condition', product.condition)}
                    ${renderDetailMeta('Gender', product.gender)}
                    ${renderDetailMeta('Movement', product.movement)}
                    ${renderDetailMeta('Deliverables', product.deliverables)}
                    ${renderDetailMeta('Country of Origin', product.country)}
                    ${renderDetailMeta('Size', product.size)}
                    ${renderDetailMeta('Bracelet', product.bracelet)}
                    ${renderDetailMeta('Material', product.material)}
                    ${watchDetails ? `
                    <div style="border-top: 1px solid var(--cream-dark); padding-top: 20px; margin-top: 20px;">
                        <h4 style="font-size: 1rem; color: var(--black); margin-bottom: 15px;">Details</h4>
                        <p style="color: var(--gray); line-height: 1.8;">${escapeMarkup(watchDetails)}</p>
                    </div>` : ''}
                </div>
            `;

            // Load recommendations
            loadRecommendations(product);

            // Update URL with resolved reference_code if it differs from what was initially pushed
            const urlIdentifier = toPublicRef(product.reference_code) || product.id;
            if (String(urlIdentifier) !== String(productIdentifier)) {
                history.replaceState({ page: 'detail', productId: urlIdentifier }, '', `?page=detail&product=${encodeURIComponent(urlIdentifier)}`);
            }
        }

        // Render gallery
        function renderGallery() {
            const main = document.getElementById('galleryMain');
            const thumbs = document.getElementById('galleryThumbs');

            if (productImages.length > 0) {
                const dotsHtml = productImages.map((_, i) =>
                    `<button class="gallery-dot ${i === currentImageIndex ? 'active' : ''}" onclick="selectImage(${i})"></button>`
                ).join('');
                main.innerHTML = `
                    <img src="${escapeMarkup(productImages[currentImageIndex])}" alt="Product Image" onclick="openImageZoom()">
                    ${currentProduct && currentProduct.reference_code ? `<div class="gallery-ref-code">${escapeMarkup(toPublicRef(currentProduct.reference_code))}</div>` : ''}
                    <div class="gallery-nav-bar">
                        <button class="gallery-nav prev" onclick="prevImage()"><i class="fas fa-chevron-left"></i></button>
                        <div class="gallery-dots">${dotsHtml}</div>
                        <button class="gallery-nav next" onclick="nextImage()"><i class="fas fa-chevron-right"></i></button>
                    </div>
                `;
                thumbs.innerHTML = productImages.map((img, i) => `
                    <div class="gallery-thumb ${i === currentImageIndex ? 'active' : ''}" onclick="selectImage(${i})">
                        <img src="${escapeMarkup(img)}" alt="Thumbnail">
                    </div>
                `).join('');
                // Update scroll buttons after render
                requestAnimationFrame(() => {
                    updateThumbScrollButtons();
                    // Scroll active thumb into view
                    const activeThumb = thumbs.querySelector('.gallery-thumb.active');
                    if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
                });
                // Listen for scroll to update button visibility
                thumbs.removeEventListener('scroll', updateThumbScrollButtons);
                thumbs.addEventListener('scroll', updateThumbScrollButtons, { passive: true });
            } else {
                main.innerHTML = `
                    <div class="gallery-placeholder">
                        <i class="fas fa-clock"></i>
                    </div>
                `;
                thumbs.innerHTML = `
                    <div class="gallery-thumb active">
                        <div class="gallery-placeholder" style="background: var(--cream);">
                            <i class="fas fa-clock" style="font-size: 2rem; color: var(--cream-dark);"></i>
                        </div>
                    </div>
                `;
            }
        }

        // Gallery navigation
        function selectImage(index) {
            currentImageIndex = index;
            renderGallery();
        }

        function prevImage() {
            if (productImages.length > 0) {
                currentImageIndex = (currentImageIndex - 1 + productImages.length) % productImages.length;
                renderGallery();
            }
        }

        function nextImage() {
            if (productImages.length > 0) {
                currentImageIndex = (currentImageIndex + 1) % productImages.length;
                renderGallery();
            }
        }

        // Scroll thumbnail strip left or right
        function scrollThumbs(direction) {
            const thumbsContainer = document.getElementById('galleryThumbs');
            if (!thumbsContainer) return;
            const scrollAmount = 180; // px per click
            thumbsContainer.scrollBy({ left: direction * scrollAmount, behavior: 'smooth' });
        }

        // Update visibility of thumb scroll buttons based on scroll position
        function updateThumbScrollButtons() {
            const thumbs = document.getElementById('galleryThumbs');
            const leftBtn = document.getElementById('thumbScrollLeft');
            const rightBtn = document.getElementById('thumbScrollRight');
            if (!thumbs || !leftBtn || !rightBtn) return;
            const hasOverflow = thumbs.scrollWidth > thumbs.clientWidth;
            leftBtn.style.display = hasOverflow && thumbs.scrollLeft > 0 ? 'flex' : 'none';
            rightBtn.style.display = hasOverflow && thumbs.scrollLeft < thumbs.scrollWidth - thumbs.clientWidth - 1 ? 'flex' : 'none';
        }

        // ---- IMAGE ZOOM ----
        let zoomLevel = 1;
        let zoomTranslateX = 0;
        let zoomTranslateY = 0;
        let zoomIsDragging = false;
        let zoomDragStartX = 0;
        let zoomDragStartY = 0;
        let zoomDragStartTransX = 0;
        let zoomDragStartTransY = 0;
        let zoomPinchStartDist = 0;
        let zoomPinchStartLevel = 1;
        const ZOOM_MIN = 1;
        const ZOOM_MAX = 5;

        function updateZoomTransform() {
            const img = document.getElementById('galleryZoomImg');
            if (!img) return;
            // Clamp translation so the image can't be dragged off-screen
            const rect = img.getBoundingClientRect();
            const imgW = img.offsetWidth;
            const imgH = img.offsetHeight;
            const maxX = Math.max(0, (imgW * zoomLevel - imgW) / 2);
            const maxY = Math.max(0, (imgH * zoomLevel - imgH) / 2);
            zoomTranslateX = Math.min(maxX, Math.max(-maxX, zoomTranslateX));
            zoomTranslateY = Math.min(maxY, Math.max(-maxY, zoomTranslateY));
            img.style.transform = `translate(${zoomTranslateX}px, ${zoomTranslateY}px) scale(${zoomLevel})`;
            img.style.cursor = zoomLevel > ZOOM_MIN ? 'grab' : 'zoom-in';
        }

        function openImageZoom() {
            if (productImages.length === 0) return;
            const overlay = document.getElementById('galleryZoomOverlay');
            const img = document.getElementById('galleryZoomImg');
            if (!overlay || !img) return;
            zoomLevel = ZOOM_MIN;
            zoomTranslateX = 0;
            zoomTranslateY = 0;
            img.src = productImages[currentImageIndex];
            updateZoomTransform();
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        function closeImageZoom() {
            const overlay = document.getElementById('galleryZoomOverlay');
            if (!overlay) return;
            overlay.classList.remove('active');
            document.body.style.overflow = '';
            zoomLevel = ZOOM_MIN;
            zoomTranslateX = 0;
            zoomTranslateY = 0;
        }

        function zoomPrevImage(e) {
            if (e) e.stopPropagation();
            if (productImages.length === 0) return;
            currentImageIndex = (currentImageIndex - 1 + productImages.length) % productImages.length;
            const img = document.getElementById('galleryZoomImg');
            if (img) img.src = productImages[currentImageIndex];
            zoomLevel = ZOOM_MIN;
            zoomTranslateX = 0;
            zoomTranslateY = 0;
            updateZoomTransform();
            renderGallery();
        }

        function zoomNextImage(e) {
            if (e) e.stopPropagation();
            if (productImages.length === 0) return;
            currentImageIndex = (currentImageIndex + 1) % productImages.length;
            const img = document.getElementById('galleryZoomImg');
            if (img) img.src = productImages[currentImageIndex];
            zoomLevel = ZOOM_MIN;
            zoomTranslateX = 0;
            zoomTranslateY = 0;
            updateZoomTransform();
            renderGallery();
        }

        function getPinchDistance(touches) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        function setupZoomEvents() {
            const overlay = document.getElementById('galleryZoomOverlay');
            if (!overlay) return;

            // Click on dark backdrop closes zoom — only if mousedown AND mouseup are both on the overlay
            let zoomMouseDownTarget = null;
            let zoomMouseDownPos = { x: 0, y: 0 };
            overlay.addEventListener('mousedown', (e) => {
                zoomMouseDownTarget = e.target;
                zoomMouseDownPos = { x: e.clientX, y: e.clientY };
            });
            overlay.addEventListener('mouseup', (e) => {
                const dist = Math.hypot(e.clientX - zoomMouseDownPos.x, e.clientY - zoomMouseDownPos.y);
                if (zoomMouseDownTarget === overlay && e.target === overlay && !zoomIsDragging && dist < 5) {
                    closeImageZoom();
                }
                zoomMouseDownTarget = null;
            });

            // Click-to-toggle 30% zoom on desktop (only if not dragging)
            const zoomImg = document.getElementById('galleryZoomImg');
            if (zoomImg) {
                zoomImg.addEventListener('click', (e) => {
                    // Ignore if this was a drag
                    const dist = Math.hypot(e.clientX - zoomMouseDownPos.x, e.clientY - zoomMouseDownPos.y);
                    if (dist > 5) return;
                    // Ignore on touch devices
                    if ('ontouchstart' in window && window.innerWidth <= 1024) return;
                    // Toggle between 1x and 1.3x
                    if (zoomLevel <= ZOOM_MIN) {
                        zoomLevel = 1.6;
                        zoomTranslateX = 0;
                        zoomTranslateY = 0;
                    } else {
                        zoomLevel = ZOOM_MIN;
                        zoomTranslateX = 0;
                        zoomTranslateY = 0;
                    }
                    updateZoomTransform();
                });
            }

            // Wheel: ctrl+scroll = trackpad pinch zoom, plain scroll = pan when zoomed / zoom when not
            overlay.addEventListener('wheel', (e) => {
                e.preventDefault();
                if (e.ctrlKey) {
                    // Pinch gesture on trackpad — zoom
                    const delta = -e.deltaY * 0.015;
                    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLevel * Math.exp(delta)));
                    if (newZoom <= ZOOM_MIN) { zoomTranslateX = 0; zoomTranslateY = 0; }
                    zoomLevel = newZoom;
                } else if (zoomLevel > ZOOM_MIN) {
                    // Two-finger scroll when zoomed in — pan
                    zoomTranslateX -= e.deltaX;
                    zoomTranslateY -= e.deltaY;
                } else {
                    // Not zoomed in — scroll to zoom
                    const delta = -e.deltaY * 0.004;
                    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLevel * Math.exp(delta)));
                    zoomLevel = newZoom;
                }
                updateZoomTransform();
            }, { passive: false });

            // Touch: pinch to zoom + single-finger drag to pan
            let touchDragStartX = 0, touchDragStartY = 0;
            let touchDragStartTransX = 0, touchDragStartTransY = 0;
            let isTouchPanning = false;

            overlay.addEventListener('touchstart', (e) => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    isTouchPanning = false;
                    zoomPinchStartDist = getPinchDistance(e.touches);
                    zoomPinchStartLevel = zoomLevel;
                } else if (e.touches.length === 1 && zoomLevel > ZOOM_MIN) {
                    isTouchPanning = true;
                    touchDragStartX = e.touches[0].clientX;
                    touchDragStartY = e.touches[0].clientY;
                    touchDragStartTransX = zoomTranslateX;
                    touchDragStartTransY = zoomTranslateY;
                }
            }, { passive: false });

            overlay.addEventListener('touchmove', (e) => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    isTouchPanning = false;
                    const dist = getPinchDistance(e.touches);
                    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomPinchStartLevel * (dist / zoomPinchStartDist)));
                    if (newZoom <= ZOOM_MIN) { zoomTranslateX = 0; zoomTranslateY = 0; }
                    zoomLevel = newZoom;
                    updateZoomTransform();
                } else if (e.touches.length === 1 && isTouchPanning && zoomLevel > ZOOM_MIN) {
                    e.preventDefault();
                    zoomTranslateX = touchDragStartTransX + (e.touches[0].clientX - touchDragStartX);
                    zoomTranslateY = touchDragStartTransY + (e.touches[0].clientY - touchDragStartY);
                    updateZoomTransform();
                }
            }, { passive: false });

            overlay.addEventListener('touchend', () => {
                isTouchPanning = false;
            });

            // Mouse drag to pan when zoomed in
            overlay.addEventListener('mousedown', (e) => {
                if (e.target === overlay) return;
                if (zoomLevel <= ZOOM_MIN) return;
                zoomIsDragging = true;
                zoomDragStartX = e.clientX;
                zoomDragStartY = e.clientY;
                zoomDragStartTransX = zoomTranslateX;
                zoomDragStartTransY = zoomTranslateY;
                const img = document.getElementById('galleryZoomImg');
                if (img) img.style.cursor = 'grabbing';
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!zoomIsDragging) return;
                zoomTranslateX = zoomDragStartTransX + (e.clientX - zoomDragStartX);
                zoomTranslateY = zoomDragStartTransY + (e.clientY - zoomDragStartY);
                updateZoomTransform();
            });

            window.addEventListener('mouseup', () => {
                if (zoomIsDragging) {
                    zoomIsDragging = false;
                    updateZoomTransform();
                }
            });
        }

        // Load recommendations
        async function loadRecommendations(currentProduct) {
            const grid = document.getElementById('recommendationsGrid');
            grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            let recommendations = [];

            try {
                const currentProductId = currentProduct.id;
                const category = currentProduct.category;
                const subcategory = currentProduct.subcategory;
                const price = currentProduct.price;
                const brand = currentProduct.brand;
                const year = currentProduct.watch_year || currentProduct.year;

                // 1. Closest match first: same subcategory (a strap suggests other
                //    straps, not books). Category-wide comes after, as a filler.
                if (subcategory) {
                    const { data: sameSubcategoryProducts, error: subcategoryError } = await excludeUnavailableProducts(supabaseClient
                        .from('mainspring_public_products')
                        .select(PUBLIC_PRODUCT_COLUMNS)
                        .eq('subcategory', subcategory)
                        .neq('id', currentProductId))
                        .limit(4);

                    if (!subcategoryError && sameSubcategoryProducts) {
                        recommendations = sameSubcategoryProducts;
                    }
                }

                // 2. If not enough, widen to the same category
                if (recommendations.length < 4) {
                    const recommendedIds = new Set(recommendations.map(p => p.id));
                    const { data: sameCategoryProducts, error: categoryError } = await excludeUnavailableProducts(supabaseClient
                        .from('mainspring_public_products')
                        .select(PUBLIC_PRODUCT_COLUMNS)
                        .eq('category', category)
                        .neq('id', currentProductId))
                        .limit(4);

                    if (!categoryError && sameCategoryProducts) {
                        const newProducts = sameCategoryProducts.filter(p => !recommendedIds.has(p.id));
                        recommendations = [...recommendations, ...newProducts].slice(0, 4);
                    }
                }

                // 3. If still not enough, get products by similar factors (brand, price range, year)
                if (recommendations.length < 4) {
                    const recommendedIds = new Set(recommendations.map(p => p.id));
                    let additionalQuery = excludeUnavailableProducts(supabaseClient
                        .from('mainspring_public_products')
                        .select(PUBLIC_PRODUCT_COLUMNS)
                        .neq('id', currentProductId));

                    // Prefer same brand
                    if (brand) {
                        additionalQuery = additionalQuery.eq('brand', brand);
                    }

                    const { data: similarProducts, error: similarError } = await additionalQuery
                        .limit(4 - recommendations.length);

                    if (!similarError && similarProducts) {
                        const newProducts = similarProducts.filter(p => !recommendedIds.has(p.id));
                        recommendations = [...recommendations, ...newProducts];
                    }
                }

                // 4. If still not enough, just get any other products
                if (recommendations.length < 4) {
                    const recommendedIds = new Set(recommendations.map(p => p.id));
                    const { data: anyProducts, error: anyError } = await excludeUnavailableProducts(supabaseClient
                        .from('mainspring_public_products')
                        .select(PUBLIC_PRODUCT_COLUMNS)
                        .neq('id', currentProductId))
                        .limit(4 - recommendations.length);

                    if (!anyError && anyProducts) {
                        const newProducts = anyProducts.filter(p => !recommendedIds.has(p.id));
                        recommendations = [...recommendations, ...newProducts];
                    }
                }
            } catch (e) {
                console.log('Failed to load recommendations:', e);
            }

            // Display recommendations or show message if none available
            if (recommendations.length === 0) {
                grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px;"><p style="color: var(--gray);">No similar items available at this time.</p></div>';
                return;
            }

            grid.innerHTML = recommendations.map(product => {
                // Extract first image from image_urls array if available
                const firstImageCandidate = (Array.isArray(product.image_urls) && product.image_urls.length > 0) ? product.image_urls[0] : null;
                const firstImage = isSafeImageUrl(firstImageCandidate) ? firstImageCandidate.trim() : null;
                const displayName = product.model ? product.model : product.name;
                const displayBrand = product.brand || '';
                const displayNameMarkup = escapeMarkup(displayName || '');
                const displayBrandMarkup = escapeMarkup(displayBrand);
                const conditionMarkup = escapeMarkup(product.condition || '');
                const productIdentifier = toPublicRef(product.reference_code) || product.id;
                const openProductCall = escapeMarkup(`showProductDetail(event, ${safeInlineJson(productIdentifier)})`);

                return `
                <div class="product-card">
                    <div class="product-image" onclick="${openProductCall}">
                        ${firstImage ?
                        `<img src="${escapeMarkup(firstImage)}" alt="${escapeMarkup(`${displayBrand} ${displayName}`)}" loading="lazy">` :
                        `<div class="product-placeholder"><i class="fas fa-clock"></i></div>`
                    }
                    </div>
                    <div class="product-info">
                        <h3 class="product-name" onclick="${openProductCall}">${displayNameMarkup}</h3>
                        <p class="product-brand">${displayBrandMarkup}</p>
                        ${product.condition ? `<p style="font-size: 0.8rem; color: var(--gray); margin-bottom: 8px;">${conditionMarkup}</p>` : ''}
                        <p class="product-price" data-price-aed="${escapeMarkup(product.price)}">${escapeMarkup(formatPrice(product.price))}</p>
                    </div>
                </div>
            `;
            }).join('');
        }

        // Touch swipe support for gallery (1-finger on mobile/tablet)
        let touchStartX = 0;
        let touchEndX = 0;

        document.getElementById('galleryMain').addEventListener('touchstart', e => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        document.getElementById('galleryMain').addEventListener('touchend', e => {
            touchEndX = e.changedTouches[0].screenX;
            handleSwipe();
        }, { passive: true });

        function handleSwipe() {
            const swipeThreshold = 50;
            const diff = touchStartX - touchEndX;
            if (Math.abs(diff) > swipeThreshold) {
                if (diff > 0) nextImage();
                else prevImage();
            }
        }

        // Trackpad two-finger horizontal swipe for gallery (laptop/desktop)
        let galleryWheelAccum = 0;
        let galleryWheelReset;
        let galleryWheelCooldown = false;

        document.getElementById('galleryMain').addEventListener('wheel', (e) => {
            if (e.ctrlKey) return; // pinch gesture — let browser handle page zoom
            if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scroll — ignore
            e.preventDefault();
            if (galleryWheelCooldown) return; // prevent rapid switching
            galleryWheelAccum += e.deltaX * 0.3; // dampen input sensitivity
            clearTimeout(galleryWheelReset);
            galleryWheelReset = setTimeout(() => { galleryWheelAccum = 0; }, 600);
            if (galleryWheelAccum > 120) {
                galleryWheelAccum = 0;
                galleryWheelCooldown = true;
                setTimeout(() => { galleryWheelCooldown = false; }, 400);
                nextImage();
            } else if (galleryWheelAccum < -120) {
                galleryWheelAccum = 0;
                galleryWheelCooldown = true;
                setTimeout(() => { galleryWheelCooldown = false; }, 400);
                prevImage();
            }
        }, { passive: false });

        // Initialise zoom overlay event handlers
        setupZoomEvents();

        // Blog state
        let currentBlogPage = 1;
        let totalBlogPosts = 0;

        // Load blog posts from Supabase
        async function loadBlogPosts() {
            const grid = document.getElementById('blogGrid');
            grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            try {
                const from = (currentBlogPage - 1) * 9;
                const to = from + 8;

                const { data, error, count } = await supabaseClient
                    .from('mainspring_blog')
                    .select('*', { count: 'exact' })
                    .eq('status', 'published')
                    .order('published_at', { ascending: false })
                    .range(from, to);

                if (error) throw error;

                totalBlogPosts = count || 0;

                if (!data || data.length === 0) {
                    grid.innerHTML = `
                        <div class="blog-empty" style="grid-column: 1/-1;">
                            <i class="fas fa-newspaper"></i>
                            <p>No blog posts yet. Check back soon for stories and guides from Mainspring Dubai.</p>
                        </div>`;
                    document.getElementById('blogPagination').style.display = 'none';
                    return;
                }

                grid.innerHTML = data.map(post => {
                    const date = post.published_at ? new Date(post.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
                    return `
                    <div class="blog-card" onclick="showBlogDetail('${post.slug || post.id}')">
                        <div class="blog-card-image">
                            ${post.featured_image ?
                            `<img src="${post.featured_image}" alt="${post.title}" loading="lazy">` :
                            `<div class="blog-placeholder"><i class="fas fa-feather-alt"></i></div>`
                        }
                        </div>
                        <div class="blog-card-body">
                            <div class="blog-card-meta">
                                ${post.category_name ? `<span class="blog-card-category">${post.category_name}</span>` : ''}
                                <span class="blog-card-date">${date}</span>
                                ${post.reading_time ? `<span class="blog-card-date">${post.reading_time} min read</span>` : ''}
                            </div>
                            <h3 class="blog-card-title">${post.title}</h3>
                            <p class="blog-card-excerpt">${post.excerpt || ''}</p>
                            <span class="blog-card-readmore">Read More &rarr;</span>
                        </div>
                    </div>`;
                }).join('');

                // Show/hide pagination
                const totalPages = Math.ceil(totalBlogPosts / 9);
                if (totalPages > 1) {
                    document.getElementById('blogPagination').style.display = 'flex';
                    document.getElementById('blogPageInfo').textContent = `Page ${currentBlogPage} of ${totalPages}`;
                    document.getElementById('prevBlogPage').disabled = currentBlogPage === 1;
                    document.getElementById('nextBlogPage').disabled = currentBlogPage >= totalPages;
                } else {
                    document.getElementById('blogPagination').style.display = 'none';
                }
            } catch (error) {
                console.error('Error loading blog posts:', error);
                grid.innerHTML = `
                    <div class="blog-empty" style="grid-column: 1/-1;">
                        <i class="fas fa-newspaper"></i>
                        <p>No blog posts yet. Check back soon for stories and guides from Mainspring Dubai.</p>
                    </div>`;
            }
        }

        function changeBlogPage(direction) {
            currentBlogPage += direction;
            loadBlogPosts();
            window.scrollTo(0, 300);
        }

        // Show blog detail
        async function showBlogDetail(slugOrId, skipPushState = false) {
            showPage('blog-detail', true);

            if (!skipPushState) {
                history.pushState({ page: 'blog-detail', blogId: slugOrId }, '', `?page=blog-detail&post=${encodeURIComponent(slugOrId)}`);
            }

            const container = document.getElementById('blogDetailContent');
            container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            try {
                const isNumeric = /^\d+$/.test(String(slugOrId));
                let query = supabaseClient.from('mainspring_blog').select('*');
                if (isNumeric) {
                    query = query.eq('id', slugOrId);
                } else {
                    query = query.eq('slug', slugOrId);
                }

                const { data, error } = await query.single();

                if (error) throw error;

                // Increment views
                if (data.id) {
                    supabaseClient.from('mainspring_blog').update({ views: (data.views || 0) + 1 }).eq('id', data.id).then(() => { });
                }

                const date = data.published_at ? new Date(data.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

                container.innerHTML = `
                    <a href="#" onclick="event.preventDefault(); showPage('blog');" style="display: inline-block; margin-bottom: 30px; color: var(--gray); text-decoration: none; font-size: 0.9rem; letter-spacing: 0.1em;">
                        <i class="fas fa-arrow-left"></i> Back to Journal
                    </a>
                    ${data.featured_image ? `<img src="${data.featured_image}" alt="${data.title}" class="blog-detail-hero-img">` : ''}
                    <h1 class="blog-detail-title">${data.title}</h1>
                    <div class="blog-detail-meta">
                        ${data.author ? `<span style="color: var(--black); font-weight: 500;">By ${data.author}</span>` : ''}
                        <span style="color: var(--gray);">${date}</span>
                        ${data.reading_time ? `<span style="color: var(--gray);">${data.reading_time} min read</span>` : ''}
                    </div>
                    <div class="blog-detail-content">${data.content || ''}</div>
                `;
            } catch (error) {
                console.error('Error loading blog detail:', error);
                container.innerHTML = `
                    <div class="blog-empty">
                        <i class="fas fa-exclamation-circle"></i>
                        <p>Could not load this blog post.</p>
                        <a href="#" onclick="event.preventDefault(); showPage('blog');" style="color: var(--gold);">Back to Journal</a>
                    </div>`;
            }
        }

        // Slideshow functionality
        let currentSlideIndex = 0;
        let slideShowInterval;

        function goToSlide(index) {
            const slides = document.querySelectorAll('.slideshow-slide');
            const dots = document.querySelectorAll('.dot');

            // Validate index
            if (index < 0 || index >= slides.length) return;

            // Clear any existing auto-play interval
            clearInterval(slideShowInterval);

            // Get current and next slides
            const currentSlide = slides[currentSlideIndex];
            const nextSlide = slides[index];

            // Remove active and prev classes from all slides
            slides.forEach(slide => {
                slide.classList.remove('active', 'prev');
            });

            // Remove active class from all dots
            dots.forEach(dot => {
                dot.classList.remove('active');
            });

            // Mark current slide as prev (exiting)
            currentSlide.classList.add('prev');

            // Set new slide as active (entering)
            nextSlide.classList.add('active');

            // Update dot
            dots[index].classList.add('active');

            // Update current index
            currentSlideIndex = index;

            // Restart auto-play after 1 second (duration of animation)
            slideShowInterval = setTimeout(() => {
                autoPlaySlideshow();
            }, 3500);
        }

        function nextSlide() {
            const slides = document.querySelectorAll('.slideshow-slide');
            let nextIndex = (currentSlideIndex + 1) % slides.length;
            goToSlide(nextIndex);
        }

        function autoPlaySlideshow() {
            const slides = document.querySelectorAll('.slideshow-slide');
            if (slides.length === 0) return;

            let nextIndex = (currentSlideIndex + 1) % slides.length;
            goToSlide(nextIndex);

            // Set interval to auto-play every 5 seconds
            slideShowInterval = setInterval(() => {
                nextIndex = (currentSlideIndex + 1) % slides.length;
                const dots = document.querySelectorAll('.dot');
                const currentSlide = slides[currentSlideIndex];
                const nextSlide = slides[nextIndex];

                // Remove active and prev classes
                slides.forEach(slide => {
                    slide.classList.remove('active', 'prev');
                });

                // Remove active class from dots
                dots.forEach(dot => {
                    dot.classList.remove('active');
                });

                // Mark current slide as prev
                currentSlide.classList.add('prev');

                // Set new slide as active
                nextSlide.classList.add('active');

                // Update dot
                dots[nextIndex].classList.add('active');

                // Update index
                currentSlideIndex = nextIndex;
            }, 5000);
        }

        // Parallax disabled — all elements are static

        // Initialize — wrapped in function called by loader.js or DOMContentLoaded
        function initApp() {
            if (window.appInitialized) return;
            window.appInitialized = true;
            
            // Check if page elements exist before running
            if (!document.getElementById('page-home')) {
               console.warn("Mainspring App: Home page component not found in DOM yet. Retrying shortly.");
               window.appInitialized = false;
               return;
            }

            console.log("Mainspring App: Initializing components and state.");
            
            // Update wishlist badge
            updateWishlistBadge();

            // Initialize currency conversion
            initializeCurrency();

            // Initialize slideshow
            autoPlaySlideshow();

            // Handle browser history - restore page from URL on load
            const urlParams = new URLSearchParams(window.location.search);
            const pageName = urlParams.get('page');
            const productId = urlParams.get('product');
            const blogPostId = urlParams.get('post');
            const urlPageNum = parseInt(urlParams.get('pg')) || 1;

            // Filters travel in the query string, so a filtered listing can be
            // reloaded, bookmarked or shared and come back the same.
            const urlWatchFilters = {};
            WATCH_FILTER_KEYS.forEach(key => {
                const value = urlParams.get(key);
                if (value) urlWatchFilters[key] = value;
            });
            if (urlParams.get('q')) urlWatchFilters.q = urlParams.get('q');

            const urlAccessoryFilters = {};
            ['sort', 'status'].forEach(key => {
                const value = urlParams.get(key);
                if (value) urlAccessoryFilters[key] = value;
            });
            if (urlParams.get('q')) urlAccessoryFilters.q = urlParams.get('q');

            if (pageName === 'detail' && productId) {
                showProductDetail(decodeURIComponent(productId), true);
                history.replaceState({ page: 'detail', productId: decodeURIComponent(productId) }, '', window.location.search);
            } else if (pageName === 'blog-detail' && blogPostId) {
                showBlogDetail(decodeURIComponent(blogPostId), true);
                history.replaceState({ page: 'blog-detail', blogId: decodeURIComponent(blogPostId) }, '', window.location.search);
            } else if (pageName === 'watches') {
                currentPage = urlPageNum;
                restoreWatchFilters(urlWatchFilters);
                history.replaceState({ page: 'watches', pg: urlPageNum, filters: urlWatchFilters }, '', window.location.search);
                showPage('watches', true, true);
            } else if (pageName === 'accessories') {
                const cat = urlParams.get('category');
                restoreAccessoryFilters(urlAccessoryFilters);
                if (cat) {
                    history.replaceState({ page: 'accessories', category: cat, pg: urlPageNum, filters: urlAccessoryFilters }, '', window.location.search);
                    showAccessoryCategory(cat, true, urlPageNum);
                } else {
                    history.replaceState({ page: 'accessories' }, '', window.location.search);
                    showPage('accessories', true);
                }
            } else if (pageName === 'blog') {
                currentBlogPage = urlPageNum;
                history.replaceState({ page: 'blog', pg: urlPageNum }, '', window.location.search);
                showPage('blog', true, true);
            } else if (pageName === 'detail' || pageName === 'blog-detail') {
                // A detail URL with no product/post would sit on a spinner forever.
                showPage('home', true);
                history.replaceState({ page: 'home' }, '', window.location.pathname);
            } else if (pageName) {
                // showPage falls back to home for anything unrecognised.
                showPage(pageName, true);
                const resolved = document.getElementById('page-' + pageName) ? pageName : 'home';
                history.replaceState({ page: resolved }, '', resolved === pageName ? window.location.search : window.location.pathname);
            } else {
                showPage('home', true);
                history.replaceState({ page: 'home' }, '', window.location.pathname);
            }

            // Add animation to elements on scroll
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('animated');
                    }
                });
            }, { threshold: 0.1 });

            document.querySelectorAll('.animate-on-scroll').forEach(el => {
                observer.observe(el);
            });

            // ====== TOUCH & MOUSE DRAG CAROUSELS ======
            // Makes both the Reviews and Instagram carousels draggable
            // by finger (touch) or mouse cursor, while keeping auto-scroll.

            function setupDragCarousel(trackSelector, containerSelector) {
                const track = document.querySelector(trackSelector);
                const container = document.querySelector(containerSelector);
                if (!track || !container) return;

                let isDragging = false;
                let isPendingDrag = false;
                let startX = 0;
                let startY = 0;
                let scrollStart = 0;
                let currentTranslate = 0;
                let resumeTimer = null;
                let lastX = 0;
                let lastTime = 0;
                let velocity = 0;
                let momentumTimer = null;
                let autoScrollTimer = null;
                let lastFrameTime = 0;

                const DRAG_THRESHOLD = 10;

                const isMobile = window.matchMedia('(max-width: 768px)').matches;
                const scrollDuration = isMobile ? 60 : 90;

                function getAutoScrollSpeed() {
                    const trackWidth = track.scrollWidth / 2;
                    return trackWidth / scrollDuration;
                }

                function getCurrentTranslateX() {
                    const style = window.getComputedStyle(track);
                    const matrix = new DOMMatrix(style.transform);
                    return matrix.m41;
                }

                function setTranslateX(x) {
                    const halfWidth = track.scrollWidth / 2;
                    if (halfWidth > 0) {
                        while (x < -halfWidth) x += halfWidth;
                        while (x > 0) x -= halfWidth;
                    }
                    currentTranslate = x;
                    track.style.transform = `translateX(${x}px)`;
                }

                function startAutoScroll() {
                    stopAutoScroll();
                    lastFrameTime = performance.now();
                    function step(now) {
                        const delta = (now - lastFrameTime) / 1000;
                        lastFrameTime = now;
                        const speed = getAutoScrollSpeed();
                        currentTranslate -= speed * delta;
                        setTranslateX(currentTranslate);
                        autoScrollTimer = requestAnimationFrame(step);
                    }
                    autoScrollTimer = requestAnimationFrame(step);
                }

                function stopAutoScroll() {
                    if (autoScrollTimer) {
                        cancelAnimationFrame(autoScrollTimer);
                        autoScrollTimer = null;
                    }
                }

                startAutoScroll();

                // Cancel any drag/pending state and resume auto-scroll
                function cancelDragAndResume() {
                    isPendingDrag = false;
                    isDragging = false;
                    velocity = 0;
                    lastTime = 0;

                    if (momentumTimer) {
                        cancelAnimationFrame(momentumTimer);
                        momentumTimer = null;
                    }
                    if (resumeTimer) {
                        clearTimeout(resumeTimer);
                        resumeTimer = null;
                    }

                    track.classList.remove('dragging');
                    currentTranslate = getCurrentTranslateX();
                    startAutoScroll();
                }

                function onPointerDown(x, y) {
                    isPendingDrag = true;
                    isDragging = false;
                    startX = x;
                    startY = y;
                    currentTranslate = getCurrentTranslateX();
                    scrollStart = currentTranslate;

                    if (resumeTimer) {
                        clearTimeout(resumeTimer);
                        resumeTimer = null;
                    }
                }

                function activateDrag() {
                    isDragging = true;
                    isPendingDrag = false;
                    stopAutoScroll();
                    track.classList.add('dragging');
                    setTranslateX(scrollStart);
                }

                function onPointerMove(x, y) {
                    if (!isPendingDrag && !isDragging) return;

                    const diffX = x - startX;
                    const diffY = y - startY;

                    if (isPendingDrag && !isDragging) {
                        if (Math.abs(diffY) > Math.abs(diffX) && Math.abs(diffY) >= DRAG_THRESHOLD) {
                            isPendingDrag = false;
                            return;
                        }
                        if (Math.abs(diffX) >= DRAG_THRESHOLD) {
                            activateDrag();
                        } else {
                            return;
                        }
                    }

                    setTranslateX(scrollStart + diffX);

                    const currentTime = Date.now();
                    if (lastTime !== 0) {
                        const timeDiff = currentTime - lastTime;
                        if (timeDiff > 0) {
                            velocity = (x - lastX) / timeDiff;
                        }
                    }
                    lastX = x;
                    lastTime = currentTime;
                }

                function applyMomentum() {
                    if (Math.abs(velocity) < 0.01) return;
                    const friction = 0.95;
                    velocity *= friction;
                    setTranslateX(currentTranslate + velocity * 16);
                    momentumTimer = requestAnimationFrame(applyMomentum);
                }

                function onPointerEnd() {
                    if (isPendingDrag && !isDragging) {
                        isPendingDrag = false;
                        return;
                    }
                    if (!isDragging) return;
                    isDragging = false;
                    isPendingDrag = false;

                    if (momentumTimer) {
                        cancelAnimationFrame(momentumTimer);
                        momentumTimer = null;
                    }

                    // Small flick: apply momentum then resume
                    if (Math.abs(velocity) > 0.1) {
                        momentumTimer = requestAnimationFrame(applyMomentum);
                    }

                    // Resume auto-scroll after 3 seconds
                    resumeTimer = setTimeout(() => {
                        track.classList.remove('dragging');
                        velocity = 0;
                        lastTime = 0;
                        currentTranslate = getCurrentTranslateX();
                        startAutoScroll();
                    }, 3000);
                }

                // ---- MOUSE events (all scoped to container) ----
                container.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    onPointerDown(e.clientX, e.clientY);
                });

                container.addEventListener('mousemove', (e) => {
                    onPointerMove(e.clientX, e.clientY);
                });

                container.addEventListener('mouseup', () => {
                    onPointerEnd();
                });

                // Cancel drag when mouse leaves the carousel
                container.addEventListener('mouseleave', () => {
                    if (isDragging || isPendingDrag) {
                        cancelDragAndResume();
                    }
                });

                // ---- TOUCH events (all scoped to container) ----
                container.addEventListener('touchstart', (e) => {
                    velocity = 0;
                    lastTime = 0;
                    const touch = e.touches[0];
                    lastX = touch.clientX;
                    onPointerDown(touch.clientX, touch.clientY);
                }, { passive: true });

                container.addEventListener('touchmove', (e) => {
                    if (!isPendingDrag && !isDragging) return;
                    onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
                }, { passive: true });

                container.addEventListener('touchend', () => {
                    if (isPendingDrag || isDragging) {
                        onPointerEnd();
                    }
                }, { passive: true });

                container.addEventListener('touchcancel', () => {
                    cancelDragAndResume();
                }, { passive: true });

                // ---- TRACKPAD GESTURES (two-finger swipe on laptops) ----
                container.addEventListener('wheel', (e) => {
                    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                        e.preventDefault();

                        if (!isDragging) {
                            isDragging = true;
                            currentTranslate = getCurrentTranslateX();
                            scrollStart = currentTranslate;
                            stopAutoScroll();
                            track.classList.add('dragging');

                            if (resumeTimer) {
                                clearTimeout(resumeTimer);
                                resumeTimer = null;
                            }
                        }

                        currentTranslate = scrollStart - e.deltaX;
                        setTranslateX(currentTranslate);
                        scrollStart = currentTranslate;

                        if (resumeTimer) {
                            clearTimeout(resumeTimer);
                        }
                        resumeTimer = setTimeout(() => {
                            isDragging = false;
                            track.classList.remove('dragging');
                            currentTranslate = getCurrentTranslateX();
                            startAutoScroll();
                        }, 500);
                    }
                }, { passive: false });

                // Prevent click events right after dragging (avoids accidental link clicks)
                container.addEventListener('click', (e) => {
                    if (Math.abs(scrollStart - currentTranslate) > 10) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }, true);
            }

            // Load Instagram posts into carousel
            async function loadInstagramReels() {
                const track = document.getElementById('instagramTrack');

                // Posts are produced by the igfetch GitHub Action, which writes
                // data/instagram.json and downloads each post image into images/.
                let posts = [];
                try {
                    const response = await fetch('data/instagram.json', { cache: 'no-cache' });
                    if (response.ok) {
                        const data = await response.json();
                        if (Array.isArray(data)) posts = data;
                    }
                } catch (e) {
                    console.log('Note: could not load data/instagram.json.', e);
                }

                if (posts.length === 0) {
                    track.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--gray);">Follow @mainspring.ae on Instagram to see our latest content</div>';
                    return;
                }

                // Render the locally cached images, each linking to its real Instagram post
                const itemHtml = posts.map(post => {
                    const url = post.url || 'https://www.instagram.com/mainspring.ae';
                    const img = post.image_url || '';
                    const cap = escapeHtml((post.caption || '').slice(0, 140));
                    return `
                    <a class="instagram-item" href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="${cap || 'View Instagram post'}">
                        <div class="ms-ig-media">
                            <img src="${escapeHtml(img)}" alt="${cap}" loading="lazy" draggable="false">
                        </div>
                    </a>`;
                }).join('');
                track.innerHTML = itemHtml;
            }

            // Load reviews from Supabase and render into carousel
            // Hide the whole reviews band rather than leaving a permanent error
            // strip on the home page when there is nothing to show.
            function hideReviewsSection() {
                const track = document.getElementById('reviewsTrack');
                const section = track && track.closest('.ms-reviews, .reviews-section, section');
                if (section) section.style.display = 'none';
                else if (track) track.innerHTML = '';
            }

            async function loadReviews() {
                const track = document.getElementById('reviewsTrack');
                if (!track) return;
                try {
                    const { data: reviews, error } = await supabaseClient
                        .from('mainspring_reviews')
                        .select('first_name, last_name, content, star_rating');

                    if (error) throw error;

                    if (!reviews || reviews.length === 0) {
                        hideReviewsSection();
                        return;
                    }

                    function renderStars(rating) {
                        const fullStars = Math.floor(rating);
                        const halfStar = rating % 1 >= 0.5;
                        let html = '';
                        for (let i = 0; i < fullStars; i++) {
                            html += '<i class="fas fa-star"></i>';
                        }
                        if (halfStar) {
                            html += '<i class="fas fa-star-half-alt"></i>';
                        }
                        const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
                        for (let i = 0; i < emptyStars; i++) {
                            html += '<i class="far fa-star"></i>';
                        }
                        return html;
                    }

                    const cardsHtml = reviews.map(review => `
                        <div class="review-card">
                            <div class="review-stars">${renderStars(review.star_rating)}</div>
                            <p class="review-text">"${review.content}"</p>
                            <p class="review-author">${review.first_name} ${review.last_name}</p>
                        </div>
                    `).join('');

                    // Duplicate for infinite scroll
                    track.innerHTML = cardsHtml + cardsHtml;
                } catch (err) {
                    console.warn('Reviews unavailable:', err && err.message ? err.message : err);
                    hideReviewsSection();
                }
            }

            // Load reviews then set up carousel
            loadReviews().then(() => {
                setupDragCarousel('#reviewsTrack', '.reviews-container');
            });

            // Load reels on page load
            loadInstagramReels();

            // Refresh Instagram reels every 12 hours (43200000 ms)
            setInterval(loadInstagramReels, 12 * 60 * 60 * 1000);
        }

        // Run on DOMContentLoaded or custom event from loader
        document.addEventListener('DOMContentLoaded', initApp);
        window.addEventListener('componentsLoaded', initApp);
        
        // Final fallback: if window already loaded (happens with fast caches)
        if (document.readyState === 'complete') initApp();
