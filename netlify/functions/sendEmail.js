/**
 * SGD Consulting — Contact form handler
 * Netlify Function (Node.js) + Nodemailer
 *
 * Endpoint:  /.netlify/functions/sendEmail
 * Method:    POST  (application/json)
 *
 * Required environment variables (set in Netlify Dashboard):
 *   SMTP_HOST   e.g. smtp.gmail.com
 *   SMTP_PORT   e.g. 587
 *   SMTP_USER   the mailbox that authenticates with the SMTP server
 *   SMTP_PASS   app password / SMTP password  (NEVER commit this)
 *   MAIL_TO     where enquiries are delivered, e.g. Customers.sgc@gmail.com
 *   MAIL_FROM   optional; defaults to SMTP_USER
 */

const nodemailer = require('nodemailer');

/* ── Helpers ──────────────────────────────────────────────────────────────── */

// Escape user input before embedding it in the HTML email.
// Without this, a malicious "name" could inject markup into your inbox.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const isValidPhone = (v) => /^[+()0-9\s-]{7,}$/.test(String(v).trim());

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(payload)
  };
}

/* ── Professional HTML email template ─────────────────────────────────────── *
 * Email clients (especially Outlook) ignore <style> blocks, flexbox and grid,
 * so this uses table-based layout with fully inline styles — the only reliable
 * approach for consistent rendering across Gmail, Outlook, and Apple Mail.
 * ─────────────────────────────────────────────────────────────────────────── */
function buildEmailHtml(data) {
  const BRAND = '#2D6A4F';       // Emerald green
  const BRAND_DARK = '#1B4332';  // Deep forest
  const BG = '#f4f6f4';
  const BORDER = '#e2e8e4';
  const TEXT = '#1f2937';
  const MUTED = '#6b7280';

  // A single detail row in the client-details table
  const row = (label, value, isLink) => {
    const safe = escapeHtml(value || '—');
    const cell = isLink && value
      ? `<a href="${isLink}${encodeURIComponent(value)}" style="color:${BRAND};text-decoration:none;font-weight:600;">${safe}</a>`
      : `<span style="color:${TEXT};font-weight:600;">${safe}</span>`;

    return `
      <tr>
        <td style="padding:13px 20px;border-bottom:1px solid ${BORDER};background:#fbfcfb;width:170px;
                   font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;
                   letter-spacing:.06em;text-transform:uppercase;color:${MUTED};vertical-align:top;">
          ${label}
        </td>
        <td style="padding:13px 20px;border-bottom:1px solid ${BORDER};
                   font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;">
          ${cell}
        </td>
      </tr>`;
  };

  // Preserve the line breaks the client typed in their message
  const messageHtml = escapeHtml(data.message || '').replace(/\r?\n/g, '<br>') ||
    '<span style="color:#9ca3af;font-style:italic;">No message provided.</span>';

  const receivedAt = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'full',
    timeStyle: 'short'
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>New Enquiry — SGD Consulting</title>
</head>
<body style="margin:0;padding:0;background:${BG};">

  <!-- Preheader: shown in the inbox preview line, hidden in the body -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    New enquiry from ${escapeHtml(data.name)}${data.company ? ' (' + escapeHtml(data.company) + ')' : ''} — ${escapeHtml(data.service || 'General enquiry')}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
    <tr>
      <td align="center">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;
                      box-shadow:0 2px 12px rgba(27,67,50,.08);">

          <!-- ── Header ────────────────────────────────────────────────── -->
          <tr>
            <td style="background:${BRAND_DARK};padding:30px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:bold;
                                color:#ffffff;letter-spacing:-.3px;">
                      SGD Consulting
                    </div>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;
                                letter-spacing:.14em;text-transform:uppercase;color:#95d5b2;margin-top:6px;">
                      Smart Green Development
                    </div>
                  </td>
                  <td align="right" style="vertical-align:top;">
                    <span style="display:inline-block;background:rgba(255,255,255,.14);color:#ffffff;
                                 font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;
                                 letter-spacing:.1em;text-transform:uppercase;padding:7px 14px;border-radius:20px;">
                      New Lead
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── Accent bar ────────────────────────────────────────────── -->
          <tr><td style="height:4px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td></tr>

          <!-- ── Intro ─────────────────────────────────────────────────── -->
          <tr>
            <td style="padding:30px 32px 6px;">
              <h1 style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:21px;
                         font-weight:normal;color:${TEXT};">
                New enquiry received
              </h1>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:${MUTED};">
                Submitted via the website contact form on ${escapeHtml(receivedAt)} (Hanoi time).
              </p>
            </td>
          </tr>

          <!-- ── Client details table ──────────────────────────────────── -->
          <tr>
            <td style="padding:22px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                     style="border:1px solid ${BORDER};border-radius:10px;overflow:hidden;border-collapse:separate;">
                ${row('Full Name', data.name)}
                ${row('Email', data.email, 'mailto:')}
                ${row('Phone', data.phone, 'tel:')}
                ${row('Organisation', data.company)}
                ${row('Service of Interest', data.service)}
              </table>
            </td>
          </tr>

          <!-- ── Message ───────────────────────────────────────────────── -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:bold;
                          letter-spacing:.06em;text-transform:uppercase;color:${MUTED};margin-bottom:10px;">
                Message
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f7faf8;border-left:3px solid ${BRAND};border-radius:0 8px 8px 0;
                             padding:18px 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;
                             line-height:1.75;color:${TEXT};">
                    ${messageHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── Reply CTA ─────────────────────────────────────────────── -->
          <tr>
            <td style="padding:26px 32px 30px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND};border-radius:50px;">
                    <a href="mailto:${escapeHtml(data.email)}?subject=Re:%20Your%20enquiry%20—%20SGD%20Consulting"
                       style="display:inline-block;padding:13px 30px;font-family:Arial,Helvetica,sans-serif;
                              font-size:13px;font-weight:bold;letter-spacing:.05em;color:#ffffff;
                              text-decoration:none;">
                      Reply to ${escapeHtml((data.name || '').split(' ')[0] || 'Client')} &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${MUTED};">
                You can also just hit <strong>Reply</strong> — this email is set to respond directly to the client.
              </p>
            </td>
          </tr>

          <!-- ── Footer ────────────────────────────────────────────────── -->
          <tr>
            <td style="background:#f7faf8;border-top:1px solid ${BORDER};padding:22px 32px;">
              <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:11px;
                        line-height:1.7;color:${MUTED};">
                <strong style="color:${TEXT};">SGD Consulting</strong> — Smart Green Development<br>
                Số 27/186 Ngoc Thuy Road, Bo De Ward, Hanoi City<br>
                Tel: +84 (0) 38 780 6068
              </p>
              <p style="margin:10px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#9ca3af;">
                Automated notification from the SGD Consulting website.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ── Plain-text fallback (improves deliverability; some clients prefer it) ─── */
function buildEmailText(d) {
  return [
    'NEW ENQUIRY — SGD CONSULTING',
    '================================',
    '',
    `Name:         ${d.name || '—'}`,
    `Email:        ${d.email || '—'}`,
    `Phone:        ${d.phone || '—'}`,
    `Organisation: ${d.company || '—'}`,
    `Service:      ${d.service || '—'}`,
    '',
    'MESSAGE',
    '--------------------------------',
    d.message || '(No message provided.)',
    '',
    '--------------------------------',
    'Sent from the SGD Consulting website contact form.'
  ].join('\n');
}

/* ── Handler ──────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  // Preflight (harmless for same-origin; useful if you ever call this from elsewhere)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  // 1. Only POST is allowed
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Method Not Allowed. Use POST.' });
  }

  // 2. Parse the JSON payload
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { success: false, error: 'Invalid JSON payload.' });
  }

  const name    = (data.name    || '').trim();
  const phone   = (data.phone   || '').trim();
  const email   = (data.email   || '').trim();
  const company = (data.company || '').trim();
  const service = (data.service || '').trim();
  const message = (data.message || '').trim();

  // 3. Honeypot — bots fill hidden fields, humans don't.
  //    Return 200 so the bot thinks it succeeded and doesn't retry.
  if (data.website) {
    return json(200, { success: true, message: 'Thank you.' });
  }

  // 4. Server-side validation (never trust the client)
  const errors = [];
  if (name.length < 2)        errors.push('A valid name is required.');
  if (!isValidEmail(email))   errors.push('A valid email address is required.');
  if (!isValidPhone(phone))   errors.push('A valid phone number is required.');
  if (message.length > 5000)  errors.push('Message is too long (5000 character limit).');

  if (errors.length) {
    return json(400, { success: false, error: errors.join(' ') });
  }

  // 5. Confirm the server is configured before attempting to send
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_TO, MAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    console.error('Missing SMTP environment variables.');
    return json(500, {
      success: false,
      error: 'The mail service is not configured. Please contact us directly.'
    });
  }

  const payload = { name, phone, email, company, service, message };

  // 6. Build the transport and send
  try {
    const port = Number(SMTP_PORT);
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465, // true for 465 (implicit TLS), false for 587 (STARTTLS)
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    await transporter.sendMail({
      // "from" must be a domain you're authorised to send as, hence SMTP_USER —
      // the client's address goes in replyTo so replies still reach them.
      from: `"SGD Consulting Website" <${MAIL_FROM || SMTP_USER}>`,
      to: MAIL_TO,
      replyTo: `"${name}" <${email}>`,
      subject: `[New Lead] - Enquiry from ${name} - SGD Consulting`,
      text: buildEmailText(payload),
      html: buildEmailHtml(payload)
    });

    return json(200, {
      success: true,
      message: 'Your message has been sent successfully.'
    });

  } catch (err) {
    // Log the real error for your Netlify function logs, but return a generic
    // message to the client — internal details shouldn't leak to the browser.
    console.error('Nodemailer error:', err);
    return json(500, {
      success: false,
      error: 'We could not send your message right now. Please email us directly at Customers.sgc@gmail.com.'
    });
  }
};
