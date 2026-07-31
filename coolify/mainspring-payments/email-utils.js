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
      + '<td style="padding:13px 0;border-bottom:1px solid #d9d3c7;color:#141414;">' + escapeHtml(itemLabel(item)) + '</td>'
      + '<td style="padding:13px 0;border-bottom:1px solid #d9d3c7;text-align:center;color:#6b6b6b;">' + qty + '</td>'
      + '<td style="padding:13px 0;border-bottom:1px solid #d9d3c7;text-align:right;color:#141414;">' + escapeHtml(formatAED(price * qty)) + '</td>'
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
    + '<tr><td style="padding:5px 0;color:#6b6b6b;">Subtotal</td><td style="padding:5px 0;text-align:right;color:#141414;">'
    + escapeHtml(formatAED(order && order.subtotal_aed)) + '</td></tr>'
    + '<tr><td style="padding:13px 0 4px;font-family:Georgia,serif;font-size:18px;font-weight:700;border-top:2px solid #c4a265;">Total</td>'
    + '<td style="padding:13px 0 4px;text-align:right;font-family:Georgia,serif;font-size:18px;font-weight:700;border-top:2px solid #c4a265;">'
    + escapeHtml(formatAED(order && order.total_aed)) + '</td></tr></table>';
}

function totalsText(order) {
  return 'Subtotal: ' + formatAED(order && order.subtotal_aed)
    + '\nTotal: ' + formatAED(order && order.total_aed);
}

function emailShell(title, intro, content) {
  return '<!doctype html><html><body style="margin:0;background:#f0ece4;font-family:Arial,Helvetica,sans-serif;color:#141414;">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + escapeHtml(intro) + '</div>'
    + '<table role="presentation" style="width:100%;border-collapse:collapse;background:#f0ece4;"><tr><td style="padding:32px 14px;">'
    + '<table role="presentation" style="width:100%;max-width:640px;margin:0 auto;border-collapse:collapse;background:#ffffff;border:1px solid #d9d3c7;">'
    + '<tr><td style="background:#141414;padding:28px 32px;border-bottom:4px solid #c4a265;">'
    + '<div style="font-family:Georgia,Times New Roman,serif;color:#ffffff;font-size:24px;letter-spacing:3px;line-height:1.2;">MAINSPRING DUBAI</div>'
    + '<div style="margin-top:7px;color:#c4a265;font-size:10px;letter-spacing:2px;text-transform:uppercase;">Vintage and pre-owned timepieces</div>'
    + '</td></tr>'
    + '<tr><td style="padding:34px 32px 38px;">'
    + '<div style="width:42px;height:3px;background:#c4a265;margin-bottom:18px;"></div>'
    + '<h1 style="font-family:Georgia,Times New Roman,serif;color:#141414;font-size:28px;font-weight:400;line-height:1.25;margin:0 0 14px;">' + escapeHtml(title) + '</h1>'
    + '<p style="margin:0 0 24px;line-height:1.7;color:#6b6b6b;font-size:15px;">' + escapeHtml(intro) + '</p>'
    + content + '</td></tr>'
    + '<tr><td style="background:#141414;padding:24px 32px;text-align:center;color:#d9d3c7;font-size:12px;line-height:1.7;">'
    + '<div style="font-family:Georgia,Times New Roman,serif;color:#ffffff;letter-spacing:2px;margin-bottom:7px;">MAINSPRING DUBAI</div>'
    + 'The B1 Mall, Gate 11, Al Barsha, Dubai, UAE<br>' + CONTACT_EMAIL + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function orderSummaryHtml(order, includeCustomer) {
  const customer = includeCustomer
    ? '<div style="background:#f0ece4;border-left:3px solid #c4a265;padding:16px;margin:18px 0;line-height:1.6;">'
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
    + '<thead><tr><th style="padding:9px 0;text-align:left;color:#6b6b6b;font-size:11px;letter-spacing:1px;text-transform:uppercase;border-bottom:2px solid #141414;">Item</th>'
    + '<th style="padding:9px 0;text-align:center;color:#6b6b6b;font-size:11px;letter-spacing:1px;text-transform:uppercase;border-bottom:2px solid #141414;">Qty</th>'
    + '<th style="padding:9px 0;text-align:right;color:#6b6b6b;font-size:11px;letter-spacing:1px;text-transform:uppercase;border-bottom:2px solid #141414;">Amount</th></tr></thead>'
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
    subject: 'Payment receipt for ' + order.order_ref,
    html: emailShell(
      'Payment receipt',
      intro,
      '<div style="display:inline-block;background:#f0ece4;border:1px solid #c4a265;color:#141414;padding:6px 12px;margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1.5px;">PAID</div>'
        + orderSummaryHtml(order, false)
        + '<p style="margin-top:22px;line-height:1.6;color:#4f5853;">We will contact you with updates on your order. '
        + 'If you need help, reply to this email or contact ' + CONTACT_EMAIL + '.</p>'
    ),
    text: 'Payment receipt\n\n' + intro + '\n\n' + orderSummaryText(order, false)
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
