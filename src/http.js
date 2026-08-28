/** Pedidos HTTP com timeout, User-Agent proprio e leitura tolerante. */

const DEFAULT_TIMEOUT_MS = 12000;
export const USER_AGENT = 'nuvio-subs-pt/1.0 (+https://github.com/)';

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** GET que devolve JSON, ou null se o pedido falhar ou o corpo nao for JSON. */
export async function fetchJson(url, options = {}) {
  const response = await request(url, options);
  if (!response.ok) return null;
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** GET que devolve bytes crus mais o content-type anunciado. */
export async function fetchBytes(url, options = {}) {
  const response = await request(url, { redirect: 'follow', ...options });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao descarregar ${new URL(url).hostname}`);
  }
  const buffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    contentType: response.headers.get('content-type') || '',
  };
}

/** Corre promessas com um limite de concorrencia, preservando a ordem. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
