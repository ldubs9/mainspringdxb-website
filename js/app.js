        // Supabase Configuration
        const SUPABASE_URL = 'https://sldb.swiftloop.tech';
        // Using the anon (public) key — safe to expose in frontend code
        const SUPABASE_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc3NTgzMjI0MCwiZXhwIjo0OTMxNTA1ODQwLCJyb2xlIjoiYW5vbiJ9.G7a98S-SVHYk1h5hU2VjVmbu_RF42KOK8jVDrR1kOZM';

        // Initialize Supabase
        const { createClient } = supabase;
        const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });

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

        // Handle browser back/forward buttons
        window.addEventListener('popstate', function (event) {
            if (event.state) {
                if (event.state.page === 'detail' && event.state.productId) {
                    showProductDetail(event.state.productId, true);
                } else if (event.state.page === 'watches') {
                    currentPage = event.state.pg || 1;
                    showPage('watches', true, true);
                } else if (event.state.page === 'accessories' && event.state.category) {
                    currentAccessoryPage = event.state.pg || 1;
                    showAccessoryCategory(event.state.category, true);
                } else if (event.state.page === 'blog-detail' && event.state.blogId) {
                    showBlogDetail(event.state.blogId, true);
                } else if (event.state.page) {
                    showPage(event.state.page, true);
                }
            } else {
                showPage('home', true);
            }
        });

        // Cart (localStorage)
        let cart = JSON.parse(localStorage.getItem('mainspring_cart')) || [];

        function saveCart() {
            localStorage.setItem('mainspring_cart', JSON.stringify(cart));
            updateCartBadge();
        }

        function updateCartBadge() {
            const totalItems = cart.reduce((sum, item) => sum + item.qty, 0);
            document.getElementById('cartBadge').textContent = totalItems;
            document.getElementById('cartBadge').style.display = totalItems > 0 ? 'flex' : 'none';
            document.getElementById('cartBadgeMobile').textContent = totalItems;
            document.getElementById('cartBadgeMobile').style.display = totalItems > 0 ? 'flex' : 'none';
        }

        function addToCart(product) {
            const existing = cart.find(item => item.id === product.id);
            if (existing) {
                existing.qty += 1;
            } else {
                cart.push({
                    id: product.id,
                    name: product.name,
                    brand: product.brand,
                    price: product.price,
                    qty: 1
                });
            }
            saveCart();
            renderCart();
            openCart();
            trackClick('add_to_cart', product.name);
        }

        function removeFromCart(productId) {
            cart = cart.filter(item => item.id !== productId);
            saveCart();
            renderCart();
        }

        function updateCartQty(productId, delta) {
            const item = cart.find(i => i.id === productId);
            if (item) {
                item.qty += delta;
                if (item.qty <= 0) {
                    removeFromCart(productId);
                    return;
                }
                saveCart();
                renderCart();
            }
        }

        function openCart() {
            document.getElementById('cartSidebar').classList.add('active');
            renderCart();
        }

        function closeCart() {
            document.getElementById('cartSidebar').classList.remove('active');
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
            const totalAED = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
            document.getElementById('cartTotal').textContent = formatPrice(totalAED);
            document.getElementById('cartTotal').setAttribute('data-price-aed', totalAED);

            cartItemsEl.innerHTML = cart.map(item => `
                <div class="cart-item">
                    <div class="cart-item-image">
                        <i class="fas fa-clock"></i>
                    </div>
                    <div class="cart-item-details">
                        <p class="cart-item-name">${item.brand} ${item.name}</p>
                        <p class="cart-item-price" data-price-aed="${item.price}">${formatPrice(item.price)}</p>
                        <div class="cart-item-qty">
                            <button onclick="updateCartQty(${item.id}, -1)">−</button>
                            <span>${item.qty}</span>
                            <button onclick="updateCartQty(${item.id}, 1)">+</button>
                        </div>
                    </div>
                    <button class="cart-item-remove" onclick="removeFromCart(${item.id})">&times;</button>
                </div>
            `).join('');
        }

        function getCartTotal() {
            return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
        }

        // Checkout — Secure multi-step flow
        // Edge Functions URL (used by order tracking)
        const EDGE_FN_URL = SUPABASE_URL + '/functions/v1';

        // Payments service (Coolify "mainspringpayments" app). Handles
        // /create-order, /ziina-checkout and /ziina-webhook.
        const PAYMENTS_BASE = window.PAYMENTS_BASE || 'https://pay.mainspring.swiftloop.tech';

        let selectedPaymentMethod = null;
        let checkoutStep = 1; // 1=details, 2=payment, 3=confirm

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
            body.innerHTML = `
                ${renderStepIndicator(1)}
                <div class="checkout-form">
                    <p class="checkout-form-title">Your Details</p>
                    <div class="checkout-field">
                        <label>Full Name *</label>
                        <input type="text" id="checkoutName" value="${saved.name || ''}" placeholder="e.g. Ahmed Al Maktoum" required />
                        <p class="field-error" id="nameError">Please enter your name</p>
                    </div>
                    <div class="checkout-field">
                        <label>Phone Number *</label>
                        <input type="tel" id="checkoutPhone" value="${saved.phone || ''}" placeholder="+971 5X XXX XXXX" required />
                        <p class="field-error" id="phoneError">Please enter a valid phone number</p>
                    </div>
                    <div class="checkout-field">
                        <label>Email</label>
                        <input type="email" id="checkoutEmail" value="${saved.email || ''}" placeholder="your@email.com" />
                    </div>
                    <div class="checkout-field">
                        <label>Delivery Address</label>
                        <textarea id="checkoutAddress" placeholder="Street, Building, Area, City">${saved.address || ''}</textarea>
                    </div>
                </div>

                <div class="checkout-summary">
                    ${cart.map(item => `
                        <div class="checkout-summary-item">
                            <span class="item-name">${item.brand} ${item.name}</span>
                            <span class="item-qty">x${item.qty}</span>
                            <span data-price-aed="${item.price * item.qty}">${formatPrice(item.price * item.qty)}</span>
                        </div>
                    `).join('')}
                    <div class="checkout-summary-total">
                        <span>Subtotal</span>
                        <span data-price-aed="${getCartTotal()}">${formatPrice(getCartTotal())}</span>
                    </div>
                </div>

                <button class="checkout-confirm-btn" onclick="goToStep2()">CONTINUE TO PAYMENT</button>
            `;
        }

        function goToStep2() {
            const name = document.getElementById('checkoutName').value.trim();
            const phone = document.getElementById('checkoutPhone').value.trim();
            const email = document.getElementById('checkoutEmail').value.trim();
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
            if (!valid) return;

            // Save for convenience (no sensitive data)
            localStorage.setItem('mainspring_customer', JSON.stringify({ name, phone, email, address }));

            checkoutStep = 2;
            renderCheckoutStep2();
        }

        // Step 2: Payment method selection
        function renderCheckoutStep2() {
            const total = getCartTotal();
            const cardTotal = Math.round(total * 1.03);
            const body = document.getElementById('checkoutBody');

            body.innerHTML = `
                ${renderStepIndicator(2)}

                <p class="payment-method-label">Select Payment Method</p>
                <div class="payment-methods">
                    <div class="payment-method" onclick="selectPayment('ziina', this)">
                        <div class="payment-method-icon"><i class="fas fa-credit-card"></i></div>
                        <div class="payment-method-info">
                            <div class="payment-method-name">Card Payment</div>
                            <div class="payment-method-desc">Visa, Mastercard, Amex — secure via Ziina</div>
                            <div class="payment-method-surcharge">+3% surcharge</div>
                        </div>
                        <div class="payment-method-price" data-price-aed="${cardTotal}">${formatPrice(cardTotal)}</div>
                    </div>
                    <div class="payment-method" onclick="selectPayment('bank_transfer', this)">
                        <div class="payment-method-icon"><i class="fas fa-university"></i></div>
                        <div class="payment-method-info">
                            <div class="payment-method-name">Bank Transfer</div>
                            <div class="payment-method-desc">Transfer directly to our business account</div>
                        </div>
                        <div class="payment-method-price" data-price-aed="${total}">${formatPrice(total)}</div>
                    </div>
                    <div class="payment-method" onclick="selectPayment('cash_in_store', this)">
                        <div class="payment-method-icon"><i class="fas fa-store"></i></div>
                        <div class="payment-method-info">
                            <div class="payment-method-name">Cash Payment in Store</div>
                            <div class="payment-method-desc">Your watches will be available within 48 hours at the store. Confirm the reservation with us on WhatsApp.</div>
                        </div>
                        <div class="payment-method-price" data-price-aed="${total}">${formatPrice(total)}</div>
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
            const total = getCartTotal();

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
                    }),
                });

                const orderData = await orderResponse.json();

                if (!orderResponse.ok || !orderData.success) {
                    throw new Error(orderData.error || 'Failed to create order');
                }

                const orderRef = orderData.order_ref;
                const orderTotal = orderData.total_aed;

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
                    showCashInStoreConfirmation(orderRef, orderTotal);
                }

            } catch (err) {
                console.error('Checkout error:', err);
                const body = document.getElementById('checkoutBody');
                body.innerHTML = `
                    ${renderStepIndicator(2)}
                    <div class="checkout-error">
                        <strong>Something went wrong:</strong> ${err.message || 'Please try again.'}
                    </div>
                    <button class="checkout-confirm-btn" onclick="renderCheckoutStep2()">TRY AGAIN</button>
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

        // Cash payment in store confirmation
        function showCashInStoreConfirmation(orderRef, total) {
            const body = document.getElementById('checkoutBody');
            body.innerHTML = `
                ${renderStepIndicator(3)}
                <div class="checkout-confirmation">
                    <i class="fas fa-check-circle" style="color: #27ae60;"></i>
                    <h4>Reserved — Cash Payment in Store</h4>
                    <p>Your order <strong>${orderRef}</strong> is reserved for one hour.</p>
                    <p style="margin-top: 5px;">Total: <strong>${formatPrice(total)}</strong>, payable in cash at the store.</p>
                    <p style="margin-top: 10px; font-size: 0.9rem; color: var(--gray);">Your watches will be available within 48 hours at the store. Start a WhatsApp conversation now so we can confirm the reservation and collection details.</p>
                    <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('cash_in_store', '${orderRef}')"><i class="fab fa-whatsapp"></i> Confirm on WhatsApp</button>
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

        // Handle the Ziina card-payment return redirect
        function handlePaymentReturn() {
            const params = new URLSearchParams(window.location.search);
            const orderRef = params.get('order');
            const status = params.get('status');

            if (!orderRef || !status) return;

            // Clean the URL
            window.history.replaceState({}, '', window.location.pathname);

            const body = document.getElementById('checkoutBody');
            document.getElementById('checkoutOverlay').classList.add('active');

            if (status.includes('success') || status === 'ziina_success') {
                body.innerHTML = `
                    ${renderStepIndicator(3)}
                    <div class="checkout-confirmation">
                        <i class="fas fa-check-circle" style="color: #27ae60; font-size: 3.5rem;"></i>
                        <h4>Payment Successful!</h4>
                        <p>Your order <strong>${orderRef}</strong> has been confirmed.</p>
                        <p style="margin-top: 10px; color: var(--gray); font-size: 0.9rem;">We will contact you via WhatsApp with updates on your order.</p>
                        <button class="checkout-confirm-btn" onclick="closeCheckout(); showPage('home');">CONTINUE SHOPPING</button>
                        <button class="checkout-confirm-btn is-secondary" style="margin-top: 10px;" onclick="viewReceipt('${orderRef}');">VIEW RECEIPT</button>
                    </div>
                `;
            } else if (status.includes('cancel')) {
                body.innerHTML = `
                    ${renderStepIndicator(3)}
                    <div class="checkout-confirmation">
                        <i class="fas fa-times-circle" style="color: var(--gray); font-size: 3.5rem;"></i>
                        <h4>Payment Cancelled</h4>
                        <p>Your order <strong>${orderRef}</strong> payment was cancelled.</p>
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
                        <p>Your payment for order <strong>${orderRef}</strong> could not be processed.</p>
                        <p style="margin-top: 10px; color: var(--gray); font-size: 0.9rem;">Please try again or contact us for assistance.</p>
                        <button class="checkout-confirm-btn" onclick="sendOrderWhatsApp('failed', '${orderRef}')"><i class="fab fa-whatsapp"></i> Contact Us</button>
                        <button class="checkout-confirm-btn is-secondary" style="margin-top: 10px;" onclick="closeCheckout()">Close</button>
                    </div>
                `;
            }
        }

        // Receipt — opens a printable, branded invoice for the order in a new tab
        function viewReceipt(orderRef) {
            window.open('receipt.html?order=' + encodeURIComponent(orderRef), '_blank');
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
                                ${data.surcharge_pct > 0 ? `<p style="font-size: 0.78rem; color: var(--gray);">Includes ${data.surcharge_pct}% surcharge</p>` : ''}
                            </div>
                        </div>

                        <div style="border-top: 1px solid var(--cream); padding-top: 15px;">
                            <p style="font-size: 0.78rem; color: var(--gray); text-transform: uppercase; margin-bottom: 10px;">Items</p>
                            ${data.items.map(item => `
                                <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 0.9rem;">
                                    <span>${item.brand} ${item.name} <span style="color: var(--gray);">x${item.qty}</span></span>
                                    <span data-price-aed="${item.price * item.qty}">${formatPrice(item.price * item.qty)}</span>
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

        // Close nav function
        function closeNav() {
            burgerMenu.classList.remove('active');
            navOverlay.classList.remove('active');
            document.getElementById('navBackdrop').classList.remove('active');
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
                const createGlobalProductSearchQuery = () => supabaseClient
                    .from('mainspring_products')
                    .select('*')
                    .or(searchFilter);
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
        burgerMenu.addEventListener('click', () => {
            burgerMenu.classList.toggle('active');
            navOverlay.classList.toggle('active');
            document.getElementById('navBackdrop').classList.toggle('active');
        });

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

        function syncAndFilter(val) {
            document.getElementById('searchInput').value = val;
            applyFilters();
        }

        // Page navigation
        function handleNavClick(event, element, pageId) {
            if (window.innerWidth <= 992) {
                const wrapper = element.closest('.nav-item-wrapper');
                if (!wrapper.classList.contains('mobile-expanded')) {
                    document.querySelectorAll('.nav-item-wrapper.mobile-expanded').forEach(w => w.classList.remove('mobile-expanded'));
                    wrapper.classList.add('mobile-expanded');
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
            if (!skipReset) {
                if (pageName === 'watches') {
                    resetFilters();
                } else if (pageName === 'accessories') {
                    resetAccessoryFilters();
                }
            }

            document.querySelectorAll('.page-section').forEach(section => {
                section.classList.remove('active');
            });
            document.getElementById('page-' + pageName).classList.add('active');
            window.scrollTo(0, 0);

            // Load data if needed
            if (pageName === 'watches') {
                updatePriceDropdownLabels();
                loadBrandsFilter();
                loadWatches();
            } else if (pageName === 'accessories') {
                document.getElementById('accessoryProducts').style.display = 'none';
                document.getElementById('categoriesGrid').style.display = 'grid';
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
                    .from('mainspring_products')
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

        // Load watches from Supabase
        // Helper to get the date 30 days ago in ISO format
        function getThirtyDaysAgoISO() {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            return d.toISOString();
        }

        async function loadWatches() {
            const grid = document.getElementById('watchesGrid');
            grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            try {
                const brandFilter = document.getElementById('brandFilter').value;
                const priceFilter = document.getElementById('priceFilter').value;
                const searchTerm = document.getElementById('searchInput').value;
                const searchFilter = buildProductSearchFilter(searchTerm);
                const sortBy = document.getElementById('sortFilter').value;
                const statusFilter = document.getElementById('statusFilter').value;
                const genderFilter = document.getElementById('genderFilter').value;
                const movementFilter = document.getElementById('movementFilter').value;
                const countryFilter = document.getElementById('countryFilter').value;
                const thirtyDaysAgo = getThirtyDaysAgoISO();

                // Apply all active filters to a query builder
                function applyWatchFilters(q) {
                    q = q.eq('category', 'watch');
                    if (statusFilter === 'available') {
                        q = q.eq('status', 'available');
                    } else if (statusFilter === 'sold') {
                        q = q.eq('status', 'sold').gte('updated_at', thirtyDaysAgo);
                    } else if (statusFilter === 'reserved') {
                        q = q.eq('status', 'reserved');
                    }
                    // else: no status filter — show all watches
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

                const createWatchQuery = (columns = '*', options) => applyWatchFilters(
                    supabaseClient.from('mainspring_products').select(columns, options)
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
                    const result = await fetchProductsWithSoldLast(
                        createWatchQuery,
                        sortWatches,
                        currentPage
                    );
                    data = result.data;
                    count = result.count;
                }
                totalProducts = count;

                renderProducts(data, grid);
                updatePagination();
            } catch (error) {
                console.error('Error loading watches:', error);

                // No demo fallback — show no products found
                grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px; color: var(--gray);">No products found.</div>';
                totalProducts = 0;
                updatePagination();
            }
        }

        const PRODUCTS_PER_PAGE = 28;

        // Pagination must happen after the status split. Sorting a single page locally
        // can move sold products to the end of that page, but still leaves them before
        // available products that were placed on later pages by the database query.
        async function fetchProductsWithSoldLast(createQuery, sortQuery, page) {
            const [{ count: totalCount, error: totalError }, { count: availableCount, error: availableError }] = await Promise.all([
                createQuery('id', { count: 'exact', head: true }),
                createQuery('id', { count: 'exact', head: true })
                    .or('status.neq.sold,status.is.null')
            ]);

            if (totalError) throw totalError;
            if (availableError) throw availableError;

            const total = totalCount || 0;
            const available = availableCount || 0;
            const offset = (page - 1) * PRODUCTS_PER_PAGE;
            const fetchRange = (query, from, to) => sortQuery(query).range(from, to);
            let data = [];

            if (offset < available) {
                const availableOnPage = Math.min(PRODUCTS_PER_PAGE, available - offset);
                const availableQuery = fetchRange(
                    createQuery().or('status.neq.sold,status.is.null'),
                    offset,
                    offset + availableOnPage - 1
                );
                const soldOnPage = PRODUCTS_PER_PAGE - availableOnPage;
                const soldQuery = soldOnPage > 0
                    ? fetchRange(createQuery().eq('status', 'sold'), 0, soldOnPage - 1)
                    : null;
                const [availableResult, soldResult] = await Promise.all([availableQuery, soldQuery]);

                if (availableResult.error) throw availableResult.error;
                if (soldResult?.error) throw soldResult.error;
                data = [...(availableResult.data || []), ...(soldResult?.data || [])];
            } else {
                const soldOffset = offset - available;
                const soldResult = await fetchRange(
                    createQuery().eq('status', 'sold'),
                    soldOffset,
                    soldOffset + PRODUCTS_PER_PAGE - 1
                );

                if (soldResult.error) throw soldResult.error;
                data = soldResult.data || [];
            }

            return { data, count: total };
        }

        function openProductFromSearch(event, productIdentifier) {
            closeGlobalSearch();
            showProductDetail(event, productIdentifier);
        }

        function renderProducts(products, grid, options = {}) {
            if (!products || products.length === 0) {
                grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px;"><p>No products found.</p></div>';
                return;
            }

            grid.innerHTML = products.map(product => {
                // image_urls is an array — use the first image if available
                const firstImage = (Array.isArray(product.image_urls) && product.image_urls.length > 0) ? product.image_urls[0] : null;
                // Display name: use "brand + model" if model exists, otherwise just name
                const displayName = product.model ? product.model : product.name;
                const displayBrand = product.brand || '';
                const safeDisplayName = (displayName || '').replace(/'/g, "\\'");
                const safeBrand = (displayBrand || '').replace(/'/g, "\\'");
                const isSold = product.status === 'sold';
                const isReserved = product.status === 'reserved';
                const isUnavailable = isSold || isReserved;

                let additionalInfo = '';
                if (product.category === 'watch') {
                    // For watches: show watch_year and watch_reference
                    const year = product.watch_year || product.year || '';
                    const reference = product.watch_reference || product.reference_number || '';
                    if (year || reference) {
                        additionalInfo = `<p style="font-size: 0.75rem; color: var(--gray); margin-bottom: 4px;">`;
                        if (year) additionalInfo += `${year}`;
                        if (year && reference) additionalInfo += ` • `;
                        if (reference) additionalInfo += `Ref: ${reference}`;
                        additionalInfo += `</p>`;
                    }
                }

                const statusClass = isSold ? ' sold' : isReserved ? ' reserved' : '';
                const productIdentifier = product.reference_code || product.id;
                const openProductCall = options.fromGlobalSearch
                    ? `openProductFromSearch(event, '${productIdentifier}')`
                    : `showProductDetail(event, '${productIdentifier}')`;

                return `
                <div class="product-card${statusClass}">
                    <div class="product-image" onclick="${openProductCall}">
                        ${firstImage ?
                        `<img src="${firstImage}" alt="${displayBrand} ${displayName}" loading="lazy">` :
                        `<div class="product-placeholder"><i class="fas fa-clock"></i></div>`
                    }
                    </div>
                    <div class="product-info${options.fromGlobalSearch ? ' search-result-meta' : ''}">
                        <h3 class="product-name${options.fromGlobalSearch ? ' search-result-model' : ''}" onclick="${openProductCall}">${displayName}</h3>
                        <p class="product-brand${options.fromGlobalSearch ? ' search-result-brand' : ''}">${displayBrand}</p>
                        ${additionalInfo}
                        <p class="product-price${options.fromGlobalSearch ? ' search-result-price' : ''}" data-price-aed="${product.price}">${formatPrice(product.price)}</p>
                        <div style="display: flex; gap: 8px; margin-top: auto; padding-top: 15px;">
                            ${isUnavailable ? `
                            <button disabled style="flex: 1; padding: 10px; background: var(--gray); color: white; border: none; cursor: default; font-size: 0.8rem; opacity: 0.7;">
                                <i class="fas fa-ban"></i> ${isSold ? 'Sold' : 'Reserved'}
                            </button>
                            ` : `
                            <button onclick="event.stopPropagation(); addToCart({id: ${product.id}, name: '${safeDisplayName}', brand: '${safeBrand}', price: ${product.price}})" style="flex: 1; padding: 10px; background: var(--primary-green); color: white; border: none; cursor: pointer; font-size: 0.8rem; border-radius: 0;">
                                <i class="fas fa-shopping-bag"></i> Add to Cart
                            </button>
                            <button onclick="event.stopPropagation(); addToWishlist({id: ${product.id}, name: '${safeDisplayName}', brand: '${safeBrand}', price: ${product.price}})" style="padding: 10px 12px; background: none; border: 1px solid var(--cream-dark); cursor: pointer; font-size: 0.8rem; color: var(--primary-green); border-radius: 0;">
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
            const params = new URLSearchParams(window.location.search);
            params.set('pg', page);
            history.pushState({ page: 'watches', pg: page }, '', '?' + params.toString());
            loadWatches();
            window.scrollTo(0, 300);
        }

        // Load featured watches for the home page (12 watches)
        async function loadFeaturedWatches() {
            const grid = document.getElementById('featuredWatchesGrid');
            if (!grid) return; // Grid doesn't exist on non-home pages

            try {
                let query = supabaseClient
                    .from('mainspring_products')
                    .select('*')
                    .eq('category', 'watch')
                    // Live inventory uses status 'active' (the bulk), plus 'available'/'reserved'.
                    // 'sold', 'archived' and 'draft' are intentionally excluded from the featured rail.
                    .in('status', ['active', 'available', 'reserved'])
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

        // Apply filters
        function applyFilters() {
            currentPage = 1;
            loadWatches();
        }

        function syncSearchAndFilter(val) {
            document.getElementById('searchInput').value = val;
            applyFilters();
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

        // Reset all filters
        function resetFilters() {
            document.getElementById('brandFilter').value = '';
            document.getElementById('priceFilter').value = '';
            document.getElementById('sortFilter').value = 'newest';
            document.getElementById('statusFilter').value = '';
            document.getElementById('genderFilter').value = '';
            document.getElementById('movementFilter').value = '';
            document.getElementById('searchInput').value = '';
            if (document.getElementById('searchInputMobile')) document.getElementById('searchInputMobile').value = '';

            // Reset UI Dropdowns
            document.getElementById('brandDropdown').querySelector('.custom-dropdown-trigger').textContent = 'All Brands';
            document.getElementById('priceDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Price';
            
            // Reset Drawer Dropdowns if they exist
            if (document.getElementById('drawerSortDropdown')) document.getElementById('drawerSortDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Newest Arrivals';
            if (document.getElementById('drawerStatusDropdown')) document.getElementById('drawerStatusDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Condition';
            if (document.getElementById('genderDropdown')) document.getElementById('genderDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Gender';
            if (document.getElementById('drawerGenderDropdown')) document.getElementById('drawerGenderDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Gender';
            if (document.getElementById('drawerMovementDropdown')) document.getElementById('drawerMovementDropdown').querySelector('.custom-dropdown-trigger').textContent = 'Any Movement';

            document.querySelectorAll('.custom-dropdown-item').forEach(item => item.classList.remove('selected'));
            document.querySelectorAll('.custom-dropdown-item[data-value=""]').forEach(item => item.classList.add('selected'));
            document.querySelectorAll('.custom-dropdown-item[data-value="newest"]').forEach(item => item.classList.add('selected'));

            applyFilters();
        }

        function resetAccessoryFilters() {
            if (document.getElementById('accessorySortFilter')) document.getElementById('accessorySortFilter').value = 'newest';
            if (document.getElementById('accessoryStatusFilter')) document.getElementById('accessoryStatusFilter').value = '';
            applyAccessoryFilters();
        }

        function selectAccessoryFilter(type, value, element) {
            event.stopPropagation();

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
                const activeEl = document.activeElement;
                if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) return;
                const detailPage = document.getElementById('page-detail');
                if (detailPage && detailPage.classList.contains('active')) {
                    if (e.key === 'ArrowLeft') prevImage();
                    else nextImage();
                }
            }
        });

        // Filter by brand
        function filterByBrand(brand) {
            document.getElementById('brandFilter').value = brand;
            showPage('watches');
            setTimeout(() => {
                loadWatches();
            }, 100);
        }

        // Filter by gender
        function filterByGender(gender) {
            document.getElementById('brandFilter').value = '';
            document.getElementById('genderFilter').value = gender;
            showPage('watches');
            setTimeout(() => {
                loadWatches();
            }, 100);
        }

        // Show accessory category
        function showAccessoryCategory(category, skipPushState = false) {
            currentAccessoryCategory = category;
            currentAccessoryPage = 1;

            showPage('accessories', true);

            document.getElementById('categoriesGrid').style.display = 'none';
            document.getElementById('accessoryProducts').style.display = 'block';

            loadAccessories();
            document.getElementById('accessoryProducts').scrollIntoView({ behavior: 'smooth' });

            if (!skipPushState) {
                history.pushState({ page: 'accessories', category: category }, '', `?page=accessories&category=${encodeURIComponent(category)}`);
            }
        }

        // Show all accessories (no category filter)
        function showAllAccessories() {
            currentAccessoryCategory = null; // Clear category filter
            currentAccessoryPage = 1;

            showPage('accessories', true);

            document.getElementById('categoriesGrid').style.display = 'none';
            document.getElementById('accessoryProducts').style.display = 'block';

            loadAccessories();

            document.getElementById('accessoryProducts').scrollIntoView({ behavior: 'smooth' });

            history.pushState({ page: 'accessories', category: 'all' }, '', `?page=accessories&category=all`);
        }

        // Back to accessory categories
        function backToAccessoryCategories() {
            currentAccessoryCategory = null;
            document.getElementById('categoriesGrid').style.display = 'grid';
            document.getElementById('accessoryProducts').style.display = 'none';
            document.getElementById('categoriesGrid').scrollIntoView({ behavior: 'smooth' });

            history.pushState({ page: 'accessories' }, '', `?page=accessories`);
        }

        // Load accessories
        async function loadAccessories() {
            const grid = document.getElementById('accessoryGrid');
            grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

            try {
                const searchTerm = document.getElementById('accessorySearchInput')?.value || '';
                const sortBy = document.getElementById('accessorySortFilter')?.value || 'newest';
                const statusFilter = document.getElementById('accessoryStatusFilter')?.value || '';
                const thirtyDaysAgo = getThirtyDaysAgoISO();

                const createAccessoryQuery = (columns = '*', options) => {
                    let query = supabaseClient
                        .from('mainspring_products')
                        .select(columns, options)
                        .eq('category', 'accessory');

                    if (currentAccessoryCategory) {
                        query = query.eq('subcategory', currentAccessoryCategory);
                    }

                    if (statusFilter === 'available') {
                        query = query.eq('status', 'available');
                    } else if (statusFilter === 'sold') {
                        query = query.eq('status', 'sold').gte('updated_at', thirtyDaysAgo);
                    } else if (statusFilter === 'reserved') {
                        query = query.eq('status', 'reserved');
                    }

                    if (searchTerm) {
                        query = query.or(`name.ilike.*${searchTerm}*,brand.ilike.*${searchTerm}*,model.ilike.*${searchTerm}*`);
                    }

                    return query;
                };
                const sortAccessories = (query) => {
                    if (sortBy === 'price-low') return query.order('price', { ascending: true });
                    if (sortBy === 'price-high') return query.order('price', { ascending: false });
                    return query.order('id', { ascending: false });
                };
                const { data, count } = await fetchProductsWithSoldLast(
                    createAccessoryQuery,
                    sortAccessories,
                    currentAccessoryPage
                );
                totalAccessoryProducts = count;

                if (!data || data.length === 0) {
                    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--gray); font-size: 1.1rem;">No products found.</div>';
                } else {
                    renderProducts(data, grid);
                }

                updateAccessoryPagination();
            } catch (error) {
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
            const params = new URLSearchParams(window.location.search);
            params.set('pg', page);
            history.pushState({ page: 'accessories', category: currentAccessoryCategory, pg: page }, '', '?' + params.toString());
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
                let query = supabaseClient
                    .from('mainspring_products')
                    .select('*');

                if (isNumericId) {
                    query = query.eq('id', productIdentifier);
                } else {
                    query = query.eq('reference_code', productIdentifier);
                }

                const { data, error } = await query.single();

                if (!error && data) {
                    product = data;
                }
            } catch (e) {
                console.log('Supabase fetch failed, using demo data');
            }

            // Demo product data (fallback)
            if (!product) {
                const demoProducts = {
                    1: { id: 1, brand: 'Rolex', model: 'Submariner Date', name: 'Submariner Date', price: 14500, description: 'The Oyster Perpetual Submariner Date is a reference among divers\' watches.', image_urls: [] },
                    2: { id: 2, brand: 'Rolex', model: 'Daytona Cosmograph', name: 'Daytona Cosmograph', price: 28500, description: 'The Cosmograph Daytona is the ultimate racing watch.', image_urls: [] },
                    3: { id: 3, brand: 'Omega', model: 'Speedmaster Professional', name: 'Speedmaster Professional', price: 7500, description: 'The iconic moonwatch, the only chronograph worn on the Moon.', image_urls: [] },
                    4: { id: 4, brand: 'Patek Philippe', model: 'Nautilus 5711', name: 'Nautilus 5711', price: 125000, description: 'An icon of luxury sports watches. Designed by Gérald Genta in 1974.', image_urls: [] },
                    5: { id: 5, brand: 'Audemars Piguet', model: 'Royal Oak', name: 'Royal Oak', price: 45000, description: 'Revolutionized the watch industry when launched in 1972.', image_urls: [] }
                };
                product = demoProducts[productIdentifier];
                if (!product) {
                    const numericId = isNumericId ? Number(productIdentifier) : 1;
                    const brands = ['Rolex', 'Omega', 'Patek Philippe', 'Cartier', 'Tudor'];
                    const models = ['Classic', 'Sport', 'Diver', 'Chronograph', 'Dress'];
                    product = {
                        id: numericId,
                        brand: brands[numericId % brands.length],
                        model: `${models[numericId % models.length]} ${numericId}`,
                        name: `${models[numericId % models.length]} ${numericId}`,
                        price: (numericId * 2500) + 5000,
                        description: 'Experience the pinnacle of Swiss craftsmanship with this exceptional timepiece.',
                        image_urls: []
                    };
                }
            }

            // Normalize column names for display
            const displayName = product.model || product.name || 'Timepiece';
            const displayBrand = product.brand || '';
            const safeDisplayName = displayName.replace(/'/g, "\\'");
            const safeBrand = displayBrand.replace(/'/g, "\\'");
            const refNumber = product.reference_number || '';

            currentProduct = product;
            // Reset gallery index so the new product always starts at the first image
            currentImageIndex = 0;
            // image_urls is an array — use it directly for the gallery
            productImages = (Array.isArray(product.image_urls) && product.image_urls.length > 0) ? product.image_urls : [];

            // Render gallery
            renderGallery();

            // Render detail info
            const watchYear = product.watch_year || product.year || '';
            const watchReference = product.watch_reference || product.reference_number || '';
            const watchDetails = product.product_details || '';

            const isSoldProduct = product.status === 'sold';
            const isReservedProduct = product.status === 'reserved';
            const isUnavailableProduct = isSoldProduct || isReservedProduct;
            const unavailableLabel = isSoldProduct ? 'SOLD' : 'RESERVED';

            detailInfo.innerHTML = `
                ${isUnavailableProduct ? `<div style="background: var(--gray); color: white; padding: 10px 20px; margin-bottom: 20px; text-align: center; font-family: 'Fraunces', serif; font-size: 0.9rem; letter-spacing: 3px;">${unavailableLabel}</div>` : ''}
                <p class="detail-brand">${displayBrand}</p>
                <h1 class="detail-name">${displayName}</h1>
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
                        ? `<p style="font-size: 1.1rem; color: var(--gray); margin-bottom: 8px;">${infoItems.join(', ')}</p>`
                        : '';
                })()}
                <p class="detail-price" data-price-aed="${product.price}">${formatPrice(product.price)}</p>
                <p class="detail-description">${product.description || ''}</p>
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
                    <button class="btn-primary btn-whatsapp-action" style="background: #25D366;" onclick="inquireViaWhatsApp({id: ${product.id}, name: '${safeDisplayName}', brand: '${safeBrand}', price: ${product.price}, reference_number: '${refNumber}'})"><i class="fab fa-whatsapp"></i> WhatsApp Us</button>
                    <div class="detail-actions-row">
                        <button class="btn-primary btn-cart-action" onclick="addToCart({id: ${product.id}, name: '${safeDisplayName}', brand: '${safeBrand}', price: ${product.price}})"><i class="fas fa-shopping-bag"></i> Add to Cart</button>
                        <button class="btn-secondary btn-wishlist-action" onclick="addToWishlist({id: ${product.id}, name: '${safeDisplayName}', brand: '${safeBrand}', price: ${product.price}})"><i class="far fa-heart"></i></button>
                    </div>
                </div>
                `}
                <div class="detail-meta">
                    <div class="meta-item">
                        <span class="meta-label">Brand</span>
                        <span class="meta-value">${displayBrand}</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">Model</span>
                        <span class="meta-value">${displayName}</span>
                    </div>
                    ${watchReference ? `
                    <div class="meta-item">
                        <span class="meta-label">Reference Number</span>
                        <span class="meta-value">${watchReference}</span>
                    </div>` : ''}
                    ${watchYear ? `
                    <div class="meta-item">
                        <span class="meta-label">Year</span>
                        <span class="meta-value">${watchYear}</span>
                    </div>` : ''}
                    ${product.condition ? `
                    <div class="meta-item">
                        <span class="meta-label">Condition</span>
                        <span class="meta-value">${product.condition}</span>
                    </div>` : ''}
                    ${product.gender ? `
                    <div class="meta-item">
                        <span class="meta-label">Gender</span>
                        <span class="meta-value">${product.gender}</span>
                    </div>` : ''}
                    ${product.movement ? `
                    <div class="meta-item">
                        <span class="meta-label">Movement</span>
                        <span class="meta-value">${product.movement}</span>
                    </div>` : ''}
                    ${product.deliverables && String(product.deliverables).trim() ? `
                    <div class="meta-item">
                        <span class="meta-label">Deliverables</span>
                        <span class="meta-value">${String(product.deliverables).trim()}</span>
                    </div>` : ''}
                    ${product.country ? `
                    <div class="meta-item">
                        <span class="meta-label">Country of Origin</span>
                        <span class="meta-value">${product.country}</span>
                    </div>` : ''}
                    ${product.size ? `
                    <div class="meta-item">
                        <span class="meta-label">Diameter</span>
                        <span class="meta-value">${product.size}</span>
                    </div>` : ''}
                    ${product.bracelet ? `
                    <div class="meta-item">
                        <span class="meta-label">Bracelet</span>
                        <span class="meta-value">${product.bracelet}</span>
                    </div>` : ''}
                    ${product.material ? `
                    <div class="meta-item">
                        <span class="meta-label">Material</span>
                        <span class="meta-value">${product.material}</span>
                    </div>` : ''}
                    ${watchDetails ? `
                    <div style="border-top: 1px solid var(--cream-dark); padding-top: 20px; margin-top: 20px;">
                        <h4 style="font-size: 1rem; color: var(--black); margin-bottom: 15px;">Details</h4>
                        <p style="color: var(--gray); line-height: 1.8;">${watchDetails}</p>
                    </div>` : ''}
                </div>
            `;

            // Load recommendations
            loadRecommendations(product);

            // Update URL with resolved reference_code if it differs from what was initially pushed
            const urlIdentifier = product.reference_code || product.id;
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
                    <img src="${productImages[currentImageIndex]}" alt="Product Image" onclick="openImageZoom()">
                    ${currentProduct && currentProduct.reference_code ? `<div class="gallery-ref-code">${currentProduct.reference_code}</div>` : ''}
                    <div class="gallery-nav-bar">
                        <button class="gallery-nav prev" onclick="prevImage()"><i class="fas fa-chevron-left"></i></button>
                        <div class="gallery-dots">${dotsHtml}</div>
                        <button class="gallery-nav next" onclick="nextImage()"><i class="fas fa-chevron-right"></i></button>
                    </div>
                `;
                thumbs.innerHTML = productImages.map((img, i) => `
                    <div class="gallery-thumb ${i === currentImageIndex ? 'active' : ''}" onclick="selectImage(${i})">
                        <img src="${img}" alt="Thumbnail">
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

                // 1. Try to get products from the same category first
                const { data: sameCategoryProducts, error: categoryError } = await supabaseClient
                    .from('mainspring_products')
                    .select('*')
                    .eq('category', category)
                    .neq('id', currentProductId)
                    .limit(4);

                if (!categoryError && sameCategoryProducts && sameCategoryProducts.length > 0) {
                    recommendations = sameCategoryProducts;
                }

                // 2. If not enough, try to get products from the same subcategory
                if (recommendations.length < 4 && subcategory) {
                    const { data: sameSubcategoryProducts, error: subcategoryError } = await supabaseClient
                        .from('mainspring_products')
                        .select('*')
                        .eq('subcategory', subcategory)
                        .neq('id', currentProductId)
                        .limit(4 - recommendations.length);

                    if (!subcategoryError && sameSubcategoryProducts) {
                        // Add only products not already in recommendations
                        const recommendedIds = new Set(recommendations.map(p => p.id));
                        const newProducts = sameSubcategoryProducts.filter(p => !recommendedIds.has(p.id));
                        recommendations = [...recommendations, ...newProducts];
                    }
                }

                // 3. If still not enough, get products by similar factors (brand, price range, year)
                if (recommendations.length < 4) {
                    const recommendedIds = new Set(recommendations.map(p => p.id));
                    let additionalQuery = supabaseClient
                        .from('mainspring_products')
                        .select('*')
                        .neq('id', currentProductId);

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
                    const { data: anyProducts, error: anyError } = await supabaseClient
                        .from('mainspring_products')
                        .select('*')
                        .neq('id', currentProductId)
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
                const firstImage = (Array.isArray(product.image_urls) && product.image_urls.length > 0) ? product.image_urls[0] : null;
                // Display name: use "brand + model" if model exists, otherwise just name
                const displayName = product.model ? product.model : product.name;
                const displayBrand = product.brand || '';
                const safeDisplayName = (displayName || '').replace(/'/g, "\\'");
                const safeBrand = (displayBrand || '').replace(/'/g, "\\'");

                return `
                <div class="product-card">
                    <div class="product-image" onclick="showProductDetail(event, '${product.reference_code || product.id}')">
                        ${firstImage ?
                        `<img src="${firstImage}" alt="${displayBrand} ${displayName}" loading="lazy">` :
                        `<div class="product-placeholder"><i class="fas fa-clock"></i></div>`
                    }
                    </div>
                    <div class="product-info">
                        <h3 class="product-name" style="font-size: 1rem;" onclick="showProductDetail(event, '${product.reference_code || product.id}')">${displayName}</h3>
                        <p class="product-brand">${displayBrand}</p>
                        ${product.condition ? `<p style="font-size: 0.8rem; color: var(--gray); margin-bottom: 8px;">${product.condition}</p>` : ''}
                        <p class="product-price" data-price-aed="${product.price}">${formatPrice(product.price)}</p>
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

            if (pageName === 'detail' && productId) {
                showProductDetail(decodeURIComponent(productId), true);
                history.replaceState({ page: 'detail', productId: decodeURIComponent(productId) }, '', window.location.search);
            } else if (pageName === 'blog-detail' && blogPostId) {
                showBlogDetail(decodeURIComponent(blogPostId), true);
                history.replaceState({ page: 'blog-detail', blogId: decodeURIComponent(blogPostId) }, '', window.location.search);
            } else if (pageName === 'watches') {
                currentPage = urlPageNum;
                showPage('watches', true, true);
                history.replaceState({ page: 'watches', pg: urlPageNum }, '', window.location.search);
            } else if (pageName === 'accessories') {
                currentAccessoryPage = urlPageNum;
                const cat = urlParams.get('category');
                if (cat && cat !== 'all') {
                    showAccessoryCategory(cat, true);
                } else if (cat === 'all') {
                    showPage('accessories', true, true);
                    document.getElementById('categoriesGrid').style.display = 'none';
                    document.getElementById('accessoryProducts').style.display = 'block';
                    loadAccessories();
                } else {
                    showPage('accessories', true);
                }
                history.replaceState({ page: 'accessories', category: cat, pg: urlPageNum }, '', window.location.search);
            } else if (pageName) {
                showPage(pageName, true);
                history.replaceState({ page: pageName }, '', window.location.search);
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
            function escapeHtml(str) {
                return String(str || '').replace(/[&<>"']/g, function (c) {
                    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
                });
            }

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
                    track.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--gray);">Follow @mainspring.dxb on Instagram to see our latest content</div>';
                    return;
                }

                // Render the locally cached images, each linking to its real Instagram post
                const itemHtml = posts.map(post => {
                    const url = post.url || 'https://www.instagram.com/mainspring.dxb';
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
            async function loadReviews() {
                const track = document.getElementById('reviewsTrack');
                try {
                    const { data: reviews, error } = await supabaseClient
                        .from('mainspring_reviews')
                        .select('first_name, last_name, content, star_rating');

                    if (error) throw error;

                    if (!reviews || reviews.length === 0) {
                        track.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--gray);">No reviews yet.</div>';
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
                    console.error('Error loading reviews:', err);
                    track.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--gray);">Unable to load reviews.</div>';
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
