/**
 * Interpretacao do id de video que o Nuvio envia no pedido.
 *
 * O Nuvio constroi o URL como `/subtitles/{type}/{id}.json`, com o id
 * percent-encoded (`tt11093718%3A1%3A5`). Chega aqui ja descodificado pelo
 * router.
 */

/**
 * @typedef {object} VideoId
 * @property {'series'|'movie'} type
 * @property {string} imdbId  ex.: "tt11093718"
 * @property {number|null} season
 * @property {number|null} episode
 * @property {string} raw
 */

/**
 * @param {string} rawId
 * @param {string} type
 * @returns {VideoId|null} null quando o id nao e' utilizavel
 */
export function parseVideoId(rawId, type) {
  const raw = String(rawId || '').trim();
  if (raw === '') return null;

  const canonicalType = type === 'tv' ? 'series' : String(type || '').toLowerCase();
  const parts = raw.split(':');

  // tt1234567 | tt1234567:1:5
  if (/^tt\d{6,10}$/i.test(parts[0])) {
    const season = parts.length >= 3 ? Number(parts[1]) : null;
    const episode = parts.length >= 3 ? Number(parts[2]) : null;
    return {
      type: canonicalType === 'movie' ? 'movie' : 'series',
      imdbId: parts[0].toLowerCase(),
      season: Number.isFinite(season) ? season : null,
      episode: Number.isFinite(episode) ? episode : null,
      raw,
    };
  }

  // tmdb:1234 | tmdb:1234:1:5 — precisa de resolucao externa.
  if (/^tmdb$/i.test(parts[0]) && parts[1]) {
    const season = parts.length >= 4 ? Number(parts[2]) : null;
    const episode = parts.length >= 4 ? Number(parts[3]) : null;
    return {
      type: canonicalType === 'movie' ? 'movie' : 'series',
      imdbId: '',
      tmdbId: parts[1],
      season: Number.isFinite(season) ? season : null,
      episode: Number.isFinite(episode) ? episode : null,
      raw,
    };
  }

  return null;
}

/** Numero IMDb sem o prefixo `tt`, que e' o que as APIs de legendas querem. */
export function imdbNumber(imdbId) {
  const match = String(imdbId || '').match(/^tt0*(\d+)$/i);
  return match ? match[1] : '';
}

/**
 * Resolve um id TMDB para IMDb. So funciona com `TMDB_API_KEY` definida;
 * sem chave devolve string vazia e o pedido segue sem resultados em vez de
 * rebentar.
 */
export async function resolveTmdbToImdb(video, env, fetchJson) {
  if (!video.tmdbId || !env.TMDB_API_KEY) return '';

  const path = video.type === 'movie' ? 'movie' : 'tv';
  const url = `https://api.themoviedb.org/3/${path}/${encodeURIComponent(video.tmdbId)}/external_ids?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`;

  const data = await fetchJson(url).catch(() => null);
  return data && typeof data.imdb_id === 'string' ? data.imdb_id : '';
}

/** Chave estavel usada para a cache KV de um episodio. */
export function videoCacheKey(video) {
  const base = video.imdbId || `tmdb-${video.tmdbId}`;
  if (video.season !== null && video.episode !== null) {
    return `${base}-s${video.season}e${video.episode}`;
  }
  return base;
}

/** Pista textual para escolher o ficheiro certo dentro de um zip de temporada. */
export function episodeHint(video) {
  if (video.season === null || video.episode === null) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `s${pad(video.season)}e${pad(video.episode)}`;
}
