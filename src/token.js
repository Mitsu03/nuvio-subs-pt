/**
 * Assinatura dos URLs `/sub/*.srt`.
 *
 * O Worker vai buscar o ficheiro a um host externo e devolve-o ao leitor. Sem
 * assinatura, qualquer pessoa podia usar este endpoint como proxy aberto para
 * qualquer URL. O token leva a origem embutida e um HMAC que so o Worker sabe
 * produzir, e a origem e' na mesma validada contra uma lista de hosts.
 */

const ALLOWED_HOSTS = [
  'dl.opensubtitles.org',
  'www.opensubtitles.org',
  'opensubtitles.org',
  'rest.opensubtitles.org',
  'api.opensubtitles.com',
  'dl.subdl.com',
  'subdl.com',
];

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** True se o URL for de uma fonte que este addon serve. */
export function isAllowedSource(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * @param {object} payload  descricao da legenda a servir
 * @param {string} secret
 * @returns {Promise<string>} token URL-safe
 */
export async function signToken(payload, secret) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, body);
  return `${base64UrlEncode(body)}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * @returns {Promise<object|null>} payload quando a assinatura confere
 */
export async function verifyToken(token, secret) {
  const [bodyPart, signaturePart] = String(token || '').split('.');
  if (!bodyPart || !signaturePart) return null;

  let body;
  let signature;
  try {
    body = base64UrlDecode(bodyPart);
    signature = base64UrlDecode(signaturePart);
  } catch {
    return null;
  }

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, signature, body);
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(body));
    // Um token pode trazer varias origens de reserva; todas tem de passar a
    // lista de hosts, senao bastava assinar uma boa para arrastar outra.
    const urls = payloadUrls(payload);
    if (urls.length === 0 || !urls.every(isAllowedSource)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Origens de um payload, na ordem em que devem ser tentadas. */
export function payloadUrls(payload) {
  if (Array.isArray(payload.urls)) return payload.urls.filter((url) => typeof url === 'string');
  return typeof payload.url === 'string' ? [payload.url] : [];
}
