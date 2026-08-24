function uid_(prefix) {
  return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function nowIso_() {
  return new Date().toISOString();
}

class GasError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GasError';
    this.code = code || 'ERROR';
  }
}

function okEnvelope_(data) {
  return { ok: true, data: data, error: null };
}

function failEnvelope_(message, code) {
  return { ok: false, data: null, error: { message: String(message), code: code || 'ERROR' } };
}

function errorToEnvelope_(err) {
  if (err instanceof GasError) {
    return failEnvelope_(err.message, err.code);
  }
  var msg = (err && err.message) ? err.message : String(err);
  return failEnvelope_(msg, 'INTERNAL');
}

function isEmail_(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function truncate_(str, max) {
  str = String(str == null ? '' : str);
  return str.length > max ? str.slice(0, max) : str;
}

function stripHtml_(html) {
  return String(html == null ? '' : html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map(function (line) { return line.replace(/[ \t]+/g, ' ').trim(); })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
