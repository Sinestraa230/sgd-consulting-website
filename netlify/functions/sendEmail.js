/**
 * SGD Consulting — contact form handler (Resend, zero dependencies)
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint : POST /.netlify/functions/sendEmail   (application/json)
 * Runtime  : Node 18+ (uses the built-in fetch — no npm packages required)
 *
 * Environment variables (Netlify → Site configuration → Environment variables)
 *   RESEND_API_KEY   required  re_…  (Sending access, restricted to your domain)
 *   MAIL_TO          required  internal inbox(es), comma-separated
 *   MAIL_FROM        optional  default: SGD Consulting Notification <no-reply@sgdconsulting.com.vn>
 *   AUTO_REPLY       optional  "true" to send the client a confirmation email
 *   ALLOWED_ORIGINS  optional  comma-separated, overrides the default origin list
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const crypto = require('crypto');

/* ── Configuration ─────────────────────────────────────────────────────────── */
const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'SGD Consulting Notification <no-reply@sgdconsulting.com.vn>';
const AUTO_REPLY_FROM_NAME = 'SGD Consulting';
const DEFAULT_ORIGINS = ['https://www.sgdconsulting.com.vn', 'https://sgdconsulting.com.vn'];
const MAX_BODY_BYTES = 20 * 1024;          // a real enquiry is far smaller than this
const MIN_FILL_MS = 2500;                  // humans can't complete the form faster
const RESEND_TIMEOUT_MS = 5000;            // keeps us well inside Netlify's 10s limit

// Must match the <option> values of #cf-service in index.html.
// An allowlist (not free text) means nothing attacker-controlled reaches the
// subject line or the auto-reply sent to an arbitrary address.
const SERVICES = [
  'Fundraising & Grant Advisory',
  'Blended Finance & Investment Mobilisation',
  'Green Business & Impact Development',
  'GEDSI Integration',
  'Seminars, Workshops & Training',
  'MELA Framework',
  'Partnership & Ecosystem Engagement',
  'Project Evaluation',
  'Social & Environmental Impact Research',
  "Not sure — I'd like to discuss",
];

/* ── Small helpers ─────────────────────────────────────────────────────────── */
const norm = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim();
const SERVICE_SET = new Set(SERVICES.map(norm));

const allowedOrigins = () =>
  (process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ORIGINS);

function corsHeaders(origin) {
  const h = { 'Vary': 'Origin' };
  if (origin && allowedOrigins().includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;               // echo, never '*'
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function reply(statusCode, payload, origin, extra = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(origin),
      ...extra,
    },
    body: JSON.stringify(payload),
  };
}

// Strip control characters. Newlines are kept only where they're meaningful.
const clean = (v, max, keepNewlines = false) => {
  let s = typeof v === 'string' ? v : '';
  s = s.normalize('NFC');
  s = keepNewlines
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.trim();
  return s.length > max ? s.slice(0, max) : s;
};

const escapeHtml = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^[+()0-9\s.-]{7,20}$/;
// Letters from any script (Vietnamese diacritics included), spaces, . ' -
const SAFE_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,59}$/u;

function validate(input) {
  const d = {
    name:    clean(input.name, 100),
    email:   clean(input.email, 254).toLowerCase(),
    phone:   clean(input.phone, 30),
    company: clean(input.company, 150),
    service: norm(clean(input.service, 120)),
    message: clean(input.message, 5000, true),
  };
  const fields = {};
  if (d.name.length < 2)                  fields.name = 'Please enter your full name.';
  if (!EMAIL_RE.test(d.email))            fields.email = 'Please enter a valid email address.';
  if (d.phone && !PHONE_RE.test(d.phone)) fields.phone = 'Please enter a valid phone number.';
  if (!SERVICE_SET.has(d.service))        fields.service = 'Please choose a service.';
  if (d.message.length < 10)              fields.message = 'Please tell us a little more (at least 10 characters).';
  return { data: d, fields };
}

/* ── Resend call: timeout + one retry on 429/5xx (safe thanks to idempotency) ─ */
async function sendViaResend(payload, idempotencyKey) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RESEND_TIMEOUT_MS);
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, id: body.id };
      // 409 = this exact enquiry was already sent (double-click / retry): not an error
      if (res.status === 409) return { ok: true, duplicate: true };
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === 2) {
        return { ok: false, status: res.status, name: body.name, message: body.message };
      }
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      // Timeout or network failure. Don't retry a timeout: the first request may
      // still land, and a second one would only be deduplicated anyway.
      return { ok: false, status: 0, name: err.name, message: err.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ── Email templates ───────────────────────────────────────────────────────── */
const BRAND = { forest: '#1B4332', green: '#2D6A4F', mint: '#95D5B2', bg: '#F4F6F4',
                border: '#E2E8E4', text: '#1F2937', muted: '#6B7280', tint: '#F3F8F5' };
const FONT = "Arial,'Helvetica Neue',Helvetica,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

function leadHtml(d, receivedAt) {
  const row = (label, value, href) => {
    const v = value ? escapeHtml(value) : '<span style="color:#9CA3AF;">—</span>';
    const cell = value && href
      ? `<a href="${href}" style="color:${BRAND.green};text-decoration:none;font-weight:600;">${v}</a>`
      : `<span style="color:${BRAND.text};font-weight:600;">${v}</span>`;
    return `<tr>
      <td style="padding:12px 18px;border-bottom:1px solid ${BRAND.border};background:#FBFCFB;width:34%;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${BRAND.muted};vertical-align:top;">${label}</td>
      <td style="padding:12px 18px;border-bottom:1px solid ${BRAND.border};font-family:${FONT};font-size:14px;line-height:1.5;word-break:break-word;">${cell}</td>
    </tr>`;
  };
  const msg = escapeHtml(d.message).replace(/\n/g, '<br>');
  const first = escapeHtml(d.name.split(' ').slice(-1)[0] || d.name); // Vietnamese: given name is last
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>New enquiry</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">New enquiry from ${escapeHtml(d.name)} — ${escapeHtml(d.service)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid ${BRAND.border};">
  <tr><td style="background:${BRAND.forest};padding:26px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${SERIF};font-size:22px;font-weight:bold;color:#FFFFFF;">SGD Consulting
        <div style="font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${BRAND.mint};margin-top:6px;">Smart Green Development</div></td>
      <td align="right" style="vertical-align:top;"><span style="display:inline-block;background:${BRAND.green};color:#FFFFFF;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:6px 12px;border-radius:20px;">New lead</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="height:4px;background:${BRAND.green};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:26px 28px 4px;">
    <h1 style="margin:0 0 6px;font-family:${SERIF};font-size:20px;font-weight:normal;color:${BRAND.text};">New enquiry: ${escapeHtml(d.service)}</h1>
    <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.6;color:${BRAND.muted};">Received ${escapeHtml(receivedAt)} (Vietnam time) via the website contact form.</p>
  </td></tr>
  <tr><td style="padding:20px 28px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};border-radius:8px;border-collapse:separate;overflow:hidden;">
      ${row('Name', d.name)}
      ${row('Email', d.email, 'mailto:' + encodeURIComponent(d.email))}
      ${row('Phone', d.phone, d.phone ? 'tel:' + d.phone.replace(/[^+0-9]/g, '') : '')}
      ${row('Organisation', d.company)}
      ${row('Service', d.service)}
    </table>
  </td></tr>
  <tr><td style="padding:22px 28px 0;">
    <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${BRAND.muted};margin-bottom:8px;">Message</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="background:${BRAND.tint};border-left:4px solid ${BRAND.green};padding:16px 18px;font-family:${FONT};font-size:14px;line-height:1.7;color:${BRAND.text};word-break:break-word;">${msg}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 28px 28px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${BRAND.green};border-radius:6px;">
      <a href="mailto:${encodeURIComponent(d.email)}?subject=${encodeURIComponent('Re: Your enquiry — SGD Consulting')}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:13px;font-weight:700;color:#FFFFFF;text-decoration:none;">Reply to ${first} &rarr;</a>
    </td></tr></table>
    <p style="margin:12px 0 0;font-family:${FONT};font-size:12px;color:${BRAND.muted};">Or simply press Reply — this email is addressed back to the client.</p>
  </td></tr>
  <tr><td style="background:${BRAND.tint};border-top:1px solid ${BRAND.border};padding:18px 28px;font-family:${FONT};font-size:11px;line-height:1.6;color:${BRAND.muted};">
    Automated notification from sgdconsulting.com.vn. Please do not reply to no-reply@sgdconsulting.com.vn.
  </td></tr>
</table></td></tr></table></body></html>`;
}

function leadText(d, receivedAt) {
  return [
    `NEW ENQUIRY — ${d.service}`,
    `Received ${receivedAt} (Vietnam time)`,
    '',
    `Name:         ${d.name}`,
    `Email:        ${d.email}`,
    `Phone:        ${d.phone || '—'}`,
    `Organisation: ${d.company || '—'}`,
    `Service:      ${d.service}`,
    '',
    'MESSAGE',
    '-------',
    d.message,
    '',
    '—',
    'Press Reply to answer the client directly.',
  ].join('\n');
}

// The auto-reply goes to an address typed into a public form, so it must never
// echo free text: only an allowlisted service and a strictly validated name.
function autoReplyContent(d) {
  // Also reject anything domain-shaped ("www.spam.com": a dot followed by a
  // letter), so the form can't be used to mail links to arbitrary people.
  // Initials like "J. Smith" still pass (dot followed by a space).
  const looksLikeLink = /\.\p{L}/u.test(d.name) || /www|https?/i.test(d.name);
  const greetName = SAFE_NAME_RE.test(d.name) && !looksLikeLink ? d.name : '';
  const hello = greetName ? `Dear ${greetName},` : 'Hello,';
  const svc = d.service;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>We received your enquiry</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid ${BRAND.border};">
  <tr><td style="background:${BRAND.forest};padding:24px 28px;font-family:${SERIF};font-size:21px;font-weight:bold;color:#FFFFFF;">SGD Consulting
    <div style="font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${BRAND.mint};margin-top:6px;">Smart Green Development</div></td></tr>
  <tr><td style="height:4px;background:${BRAND.green};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:28px;font-family:${FONT};font-size:14px;line-height:1.75;color:${BRAND.text};">
    <p style="margin:0 0 14px;">${escapeHtml(hello)}</p>
    <p style="margin:0 0 14px;">Thank you for contacting SGD Consulting. We have received your enquiry regarding <strong>${escapeHtml(svc)}</strong>, and a member of our advisory team will be in touch within 24 hours on business days.</p>
    <p style="margin:0 0 14px;">If your matter is time-sensitive, you can simply reply to this email.</p>
    <p style="margin:22px 0 0;">Kind regards,<br><strong>The SGD Consulting Team</strong></p>
  </td></tr>
  <tr><td style="background:${BRAND.tint};border-top:1px solid ${BRAND.border};padding:16px 28px;font-family:${FONT};font-size:11px;line-height:1.6;color:${BRAND.muted};">
    You are receiving this because this address was entered in the contact form at sgdconsulting.com.vn. If that wasn't you, no action is needed.
  </td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    hello, '',
    `Thank you for contacting SGD Consulting. We have received your enquiry regarding "${svc}", and a member of our advisory team will be in touch within 24 hours on business days.`,
    '', 'If your matter is time-sensitive, you can simply reply to this email.',
    '', 'Kind regards,', 'The SGD Consulting Team', '', '—',
    "You are receiving this because this address was entered in the contact form at sgdconsulting.com.vn. If that wasn't you, no action is needed.",
  ].join('\n');
  return { html, text };
}

/* ── Handler ───────────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const origin = headers.origin || '';
  const originOk = allowedOrigins().includes(origin);

  // 1. Method + origin gate
  if (event.httpMethod === 'OPTIONS') {
    return originOk
      ? { statusCode: 204, headers: corsHeaders(origin), body: '' }
      : { statusCode: 403, headers: { 'Vary': 'Origin' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return reply(405, { success: false, error: 'Method not allowed.' }, origin, { Allow: 'POST, OPTIONS' });
  }
  if (!originOk) {
    return reply(403, { success: false, error: 'Forbidden.' }, origin);
  }
  if (!(headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return reply(415, { success: false, error: 'Unsupported content type.' }, origin);
  }

  // 2. Server configuration
  if (typeof fetch !== 'function') {
    console.error('[sendEmail] Global fetch missing — set Node 18+ for Netlify Functions.');
    return reply(500, { success: false, error: 'Mail service unavailable.' }, origin);
  }
  const mailTo = (process.env.MAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!process.env.RESEND_API_KEY || !mailTo.length) {
    console.error('[sendEmail] Missing RESEND_API_KEY or MAIL_TO environment variable.');
    return reply(500, { success: false, error: 'Mail service is not configured.' }, origin);
  }

  // 3. Parse
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return reply(413, { success: false, error: 'Submission too large.' }, origin);
  }
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { input = null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return reply(400, { success: false, error: 'Invalid request.' }, origin);
  }

  // 4. Anti-spam. Bots get a normal-looking success so they don't adapt and retry.
  const elapsed = Number(input._elapsed);
  if ((typeof input._gotcha === 'string' && input._gotcha.trim() !== '') ||
      !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
    console.warn('[sendEmail] Spam filter triggered (honeypot or too-fast submission).');
    return reply(200, { success: true }, origin);
  }

  // 5. Validate
  const { data, fields } = validate(input);
  if (Object.keys(fields).length) {
    return reply(422, { success: false, error: 'Please check the highlighted fields.', fields }, origin);
  }

  // 6. Send the lead
  const receivedAt = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'full', timeStyle: 'short' });
  const fingerprint = crypto.createHash('sha256')
    .update([data.email, data.name, data.service, data.message].join('\u0000'))
    .digest('hex').slice(0, 40);

  const lead = await sendViaResend({
    from: process.env.MAIL_FROM || DEFAULT_FROM,
    to: mailTo,
    reply_to: data.email,                      // REST API field name (the SDK calls it replyTo)
    subject: `[New Lead] - ${data.name} | ${data.service}`,
    html: leadHtml(data, receivedAt),
    text: leadText(data, receivedAt),
    tags: [{ name: 'category', value: 'lead' }],
  }, `lead/${fingerprint}`);

  if (!lead.ok) {
    // Log the provider's reason for you; never expose it to the browser.
    console.error('[sendEmail] Resend rejected lead:', lead.status, lead.name, lead.message);
    return reply(502, { success: false,
      error: 'We could not send your message right now. Please try again or email us directly.' }, origin);
  }

  // 7. Optional confirmation to the client. Its failure must never lose the lead.
  if (String(process.env.AUTO_REPLY).toLowerCase() === 'true' && !lead.duplicate) {
    const ack = autoReplyContent(data);
    const fromAddr = (process.env.MAIL_FROM || DEFAULT_FROM).replace(/^.*<([^>]+)>.*$/, '$1');
    const res = await sendViaResend({
      from: `${AUTO_REPLY_FROM_NAME} <${fromAddr}>`,
      to: [data.email],
      reply_to: mailTo[0],                     // client replies reach your team, not no-reply@
      subject: 'We received your enquiry — SGD Consulting',
      html: ack.html,
      text: ack.text,
      tags: [{ name: 'category', value: 'auto_reply' }],
    }, `ack/${fingerprint}`);
    if (!res.ok) console.error('[sendEmail] Auto-reply failed (lead was delivered):', res.status, res.name);
  }

  return reply(200, { success: true }, origin);
};

// Exposed for tests only
exports._internals = { validate, SERVICES, escapeHtml, autoReplyContent };
