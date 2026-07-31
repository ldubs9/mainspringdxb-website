const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const CONTACT_EMAIL = 'info@mainspringdubai.com';

function normalizeEmail(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254 || /[\s<>]/.test(email)) return null;

  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].length > 64) return null;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])) return null;
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(parts[1])) return null;

  return parts[0] + '@' + parts[1].toLowerCase();
}

function normalizeSender(value) {
  const sender = String(value || '').trim();
  if (!sender || sender.length > 320 || /[\r\n]/.test(sender)) return null;
  const bracketed = sender.match(/^([^<>]+)<([^<>]+)>$/);
  if (bracketed) {
    const name = bracketed[1].trim();
    const email = normalizeEmail(bracketed[2]);
    return name && email ? name + ' <' + email + '>' : null;
  }
  return normalizeEmail(sender);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatAED(value) {
  const amount = Number(value) || 0;
  return 'AED ' + amount.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function paymentMethodLabel(method) {
  return ({
    ziina: 'Card payment',
    bank_transfer: 'Bank transfer',
    cash_in_store: 'Cash payment in store',
    cash: 'Cash payment',
    tap_card: 'Card payment',
    tabby: 'Tabby',
    tamara: 'Tamara',
  })[method] || String(method || 'Not specified');
}

function orderItems(order) {
  return Array.isArray(order && order.items) ? order.items : [];
}

function itemLabel(item) {
  return [item && item.brand, item && item.name].filter(Boolean).join(' ').trim()
    || 'Product ' + ((item && item.id) || '');
}

function buildItemsHtml(order) {
  return orderItems(order).map((item) => {
    const qty = Number(item && item.qty) || 1;
    const price = Number(item && item.price) || 0;
    return '<tr>'
      + '<td style="padding:10px 0;border-bottom:1px solid #e8e3d8;color:#172d21;">' + escapeHtml(itemLabel(item)) + '</td>'
      + '<td style="padding:10px 0;border-bottom:1px solid #e8e3d8;text-align:center;color:#5c625e;">' + qty + '</td>'
      + '<td style="padding:10px 0;border-bottom:1px solid #e8e3d8;text-align:right;color:#172d21;">' + escapeHtml(formatAED(price * qty)) + '</td>'
      + '</tr>';
  }).join('');
}

function buildItemsText(order) {
  return orderItems(order).map((item) => {
    const qty = Number(item && item.qty) || 1;
    const price = Number(item && item.price) || 0;
    return '- ' + itemLabel(item) + ' x' + qty + ': ' + formatAED(price * qty);
  }).join('\n');
}

function totalsHtml(order) {
  return '<table role="presentation" style="width:100%;margin-top:18px;border-collapse:collapse;">'
    + '<tr><td style="padding:4px 0;color:#5c625e;">Subtotal</td><td style="padding:4px 0;text-align:right;">'
    + escapeHtml(formatAED(order && order.subtotal_aed)) + '</td></tr>'
    + '<tr><td style="padding:10px 0 4px;font-weight:700;border-top:1px solid #cfc7b7;">Total</td>'
    + '<td style="padding:10px 0 4px;text-align:right;font-weight:700;border-top:1px solid #cfc7b7;">'
    + escapeHtml(formatAED(order && order.total_aed)) + '</td></tr></table>';
}

function totalsText(order) {
  return 'Subtotal: ' + formatAED(order && order.subtotal_aed)
    + '\nTotal: ' + formatAED(order && order.total_aed);
}

function emailShell(title, intro, content) {
  return '<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,sans-serif;color:#172d21;">'
    + '<div style="max-width:640px;margin:0 auto;padding:28px 16px;">'
    + '<div style="background:#173d2c;color:#fff;padding:24px 28px;font-size:20px;letter-spacing:1.5px;">MAINSPRING DUBAI</div>'
    + '<div style="background:#fff;padding:28px;border:1px solid #e4ded1;">'
    + '<h1 style="font-size:24px;margin:0 0 12px;">' + escapeHtml(title) + '</h1>'
    + '<p style="line-height:1.6;color:#4f5853;">' + escapeHtml(intro) + '</p>'
    + content + '</div>'
    + '<p style="font-size:12px;line-height:1.5;color:#747b77;text-align:center;">Mainspring Dubai<br>'
    + 'The B1 Mall, Gate 11, Al Barsha, Dubai, UAE<br>' + CONTACT_EMAIL + '</p>'
    + '</div></body></html>';
}

function orderSummaryHtml(order, includeCustomer) {
  const customer = includeCustomer
    ? '<div style="background:#f7f5ef;padding:16px;margin:18px 0;line-height:1.6;">'
      + '<strong>Customer details</strong><br>'
      + escapeHtml(order && order.customer_name) + '<br>'
      + escapeHtml(order && order.customer_email) + '<br>'
      + escapeHtml(order && order.customer_phone) + '<br>'
      + ((order && order.customer_address) ? escapeHtml(order.customer_address) : 'No delivery address supplied')
      + '</div>'
    : '';

  return customer
    + '<p style="margin:18px 0 8px;"><strong>Order:</strong> ' + escapeHtml(order && order.order_ref)
    + '<br><strong>Payment method:</strong> ' + escapeHtml(paymentMethodLabel(order && order.payment_method)) + '</p>'
    + '<table role="presentation" style="width:100%;border-collapse:collapse;">'
    + '<thead><tr><th style="padding:8px 0;text-align:left;border-bottom:2px solid #173d2c;">Item</th>'
    + '<th style="padding:8px 0;text-align:center;border-bottom:2px solid #173d2c;">Qty</th>'
    + '<th style="padding:8px 0;text-align:right;border-bottom:2px solid #173d2c;">Amount</th></tr></thead>'
    + '<tbody>' + buildItemsHtml(order) + '</tbody></table>' + totalsHtml(order);
}

function orderSummaryText(order, includeCustomer) {
  const customer = includeCustomer
    ? 'Customer details\nName: ' + ((order && order.customer_name) || '')
      + '\nEmail: ' + ((order && order.customer_email) || '')
      + '\nPhone: ' + ((order && order.customer_phone) || '')
      + '\nAddress: ' + ((order && order.customer_address) || 'No delivery address supplied') + '\n\n'
    : '';

  return customer
    + 'Order: ' + ((order && order.order_ref) || '')
    + '\nPayment method: ' + paymentMethodLabel(order && order.payment_method)
    + '\n\nItems\n' + buildItemsText(order)
    + '\n\n' + totalsText(order);
}

function buildBusinessOrderEmail(order) {
  return {
    subject: 'New order ' + order.order_ref,
    html: emailShell(
      'New order received',
      'A customer has submitted order ' + order.order_ref + '.',
      orderSummaryHtml(order, true)
    ),
    text: 'New order received\n\nA customer has submitted order ' + order.order_ref
      + '.\n\n' + orderSummaryText(order, true),
  };
}

function buildBusinessPaymentEmail(order) {
  return {
    subject: 'Payment confirmed for ' + order.order_ref,
    html: emailShell(
      'Payment confirmed',
      'Payment has been verified for order ' + order.order_ref + '.',
      orderSummaryHtml(order, true)
    ),
    text: 'Payment confirmed\n\nPayment has been verified for order ' + order.order_ref
      + '.\n\n' + orderSummaryText(order, true),
  };
}

function buildCustomerPaymentEmail(order) {
  const customerName = String((order && order.customer_name) || '').trim();
  const intro = (customerName ? 'Hello ' + customerName + '. ' : '')
    + 'Your payment has been received and verified for order ' + order.order_ref + '.';

  return {
    subject: 'Payment confirmation for ' + order.order_ref,
    html: emailShell(
      'Payment confirmed',
      intro,
      orderSummaryHtml(order, false)
        + '<p style="margin-top:22px;line-height:1.6;color:#4f5853;">We will contact you with updates on your order. '
        + 'If you need help, reply to this email or contact ' + CONTACT_EMAIL + '.</p>'
    ),
    text: 'Payment confirmed\n\n' + intro + '\n\n' + orderSummaryText(order, false)
      + '\n\nWe will contact you with updates on your order. If you need help, reply to this email or contact '
      + CONTACT_EMAIL + '.',
  };
}

async function sendResendEmail(options) {
  const recipient = normalizeEmail(options.to);
  const sender = normalizeSender(options.from);
  const fetchImpl = options.fetchImpl || fetch;
  if (!options.apiKey || !sender || !recipient || !options.idempotencyKey) {
    throw new Error('Transactional email is missing required configuration or recipient data');
  }

  const response = await fetchImpl(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + options.apiKey,
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey,
    },
    body: JSON.stringify({
      from: sender,
      to: [recipient],
      reply_to: normalizeEmail(options.replyTo) || undefined,
      subject: options.subject,
      html: options.html,
      text: options.text,
    }),
  });

  if (!response.ok) {
    const detail = String(await response.text()).substring(0, 500);
    throw new Error('Email provider rejected the message (' + response.status + '): ' + detail);
  }

  const result = await response.json();
  if (!result || !result.id) throw new Error('Email provider returned no message id');
  return result;
}

module.exports = {
  CONTACT_EMAIL,
  buildBusinessOrderEmail,
  buildBusinessPaymentEmail,
  buildCustomerPaymentEmail,
  normalizeEmail,
  normalizeSender,
  sendResendEmail,
};
