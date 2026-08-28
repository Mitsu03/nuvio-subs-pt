/** Cache KV das legendas ja preparadas. */

const PREFIX = 'sub:v1:';

async function hashKey(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Chave estavel para uma legenda preparada, incluindo o motor de traducao. */
export async function cacheKey(payload, env) {
  const urls = Array.isArray(payload.urls) ? payload.urls.join(',') : payload.url || '';

  // O motor E o modelo entram na chave: trocar de modelo tem de dar uma legenda
  // nova, senao continuava a servir-se a traducao feita pelo modelo anterior.
  const engine = payload.tr
    ? `${env.TRANSLATE_PROVIDER || 'workersai'}:${env.WORKERSAI_MODEL || ''}`
    : 'raw';

  return PREFIX + (await hashKey([urls, payload.lang, payload.src || '', engine].join('|')));
}

export async function readCache(key, env) {
  if (!env.SUBS) return null;
  return env.SUBS.get(key).catch(() => null);
}

export async function writeCache(key, value, env, ttlSeconds) {
  if (!env.SUBS) return;
  const days = Number(env.CACHE_DAYS) || 30;
  await env.SUBS.put(key, value, { expirationTtl: ttlSeconds || days * 86400 }).catch(() => {});
}

// Uma tentativa falhada tem de poder repetir-se depressa; uma boa nao vale a
// pena refazer.
const TTL_PARCIAL = 6 * 3600;

/**
 * Quanto tempo guardar um resultado: `null` = validade normal, `0` = nao
 * guardar, ou um numero de segundos.
 *
 * Guardar uma traducao que falhou por inteiro seria servir o texto de partida
 * durante semanas, sem o utilizador ter como forcar nova tentativa. Uma
 * traducao parcial fica pouco tempo, para se poder tentar de novo.
 */
export function cacheTtlFor(payload, built) {
  if (!payload.tr) return null; // sem traducao pedida: validade normal

  const total = built.translated + built.failed;
  if (total === 0 || built.translated === 0) return 0;

  return built.translated / total < 0.9 ? TTL_PARCIAL : null;
}
