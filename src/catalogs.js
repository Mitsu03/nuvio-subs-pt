/**
 * Coleccoes de series turcas para o Nuvio: "Em Alta" e "Populares".
 *
 * Fonte: TMDB, via `discover/tv` com `with_original_language=tr`. E' a unica
 * maneira de apanhar series turcas de verdade — filtrar por pais apanharia
 * co-producoes e dobragens, e nao existe genero "turco".
 *
 * Os ids devolvidos sao IMDb (`tt...`) sempre que existem, e nao `tmdb:`:
 * assim as fichas abrem com o Cinemeta, que toda a gente tem, e o addon de
 * legendas deste mesmo Worker reconhece-as sem precisar de chave nenhuma.
 */

import { fetchJson, mapLimit } from './http.js';

const TMDB = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p';
const PAGE_SIZE = 20;

export const CATALOG_TRENDING = 'turcas-em-alta';
export const CATALOG_POPULAR = 'turcas-populares';

/**
 * Versao da forma do meta, e parte da chave da cache.
 *
 * INCREMENTAR sempre que `toMeta` mudar o que produz. Sem isto, uma correccao
 * ao formato so chega aos utilizadores quando a cache expirar — ja aconteceu:
 * uma correccao de notas inflacionadas ficou invisivel apesar de publicada.
 */
const META_SHAPE_VERSION = 2;

/** Data em YYYY-MM-DD, deslocada de `offsetDays` a contar de hoje. */
function isoDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

function tmdbLanguage(env) {
  return env.PREFERRED_PT === 'pt-BR' ? 'pt-BR' : 'pt-PT';
}

/**
 * Constroi o pedido ao TMDB para cada coleccao.
 *
 * "Populares" e' o ranking de sempre. "Em Alta" sao as que estao mesmo a dar
 * agora: sem a janela de datas, as duas listas sairiam quase iguais e uma delas
 * nao valia a pena existir.
 */
function discoverUrl(catalogId, page, env) {
  const params = new URLSearchParams({
    api_key: env.TMDB_API_KEY,
    with_original_language: 'tr',
    sort_by: 'popularity.desc',
    include_adult: 'false',
    language: tmdbLanguage(env),
    page: String(page),
  });

  if (catalogId === CATALOG_TRENDING) {
    // Episodios emitidos nas ultimas semanas: series em curso, nao classicos.
    params.set('air_date.gte', isoDate(-45));
    params.set('air_date.lte', isoDate(7));
  } else {
    // Evita que series obscuras com dois votos apanhem boleia do ranking.
    params.set('vote_count.gte', '10');
  }

  return `${TMDB}/discover/tv?${params}`;
}

/** Mapa id->nome dos generos de TV, guardado porque muda uma vez por ano. */
async function genreNames(env) {
  const key = 'genres:v1:tv';

  if (env.SUBS) {
    const cached = await env.SUBS.get(key, 'json').catch(() => null);
    if (cached) return cached;
  }

  const url = `${TMDB}/genre/tv/list?api_key=${encodeURIComponent(env.TMDB_API_KEY)}&language=${tmdbLanguage(env)}`;
  const data = await fetchJson(url).catch(() => null);

  const map = {};
  for (const genre of (data && data.genres) || []) map[genre.id] = genre.name;

  if (env.SUBS && Object.keys(map).length > 0) {
    await env.SUBS.put(key, JSON.stringify(map), { expirationTtl: 30 * 86400 }).catch(() => {});
  }
  return map;
}

/**
 * Traduz um id TMDB para IMDb. A correspondencia nunca muda, por isso fica
 * guardada por um ano — sem isso, cada abertura do catalogo custava uma chamada
 * por serie.
 */
async function imdbIdFor(tmdbId, env) {
  const key = `imdb:v1:tmdb-${tmdbId}`;

  if (env.SUBS) {
    const cached = await env.SUBS.get(key).catch(() => null);
    if (cached) return cached === '-' ? '' : cached;
  }

  const url = `${TMDB}/tv/${tmdbId}/external_ids?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`;
  const data = await fetchJson(url).catch(() => null);
  const imdbId = data && typeof data.imdb_id === 'string' ? data.imdb_id : '';

  if (env.SUBS) {
    // O '-' marca "nao tem IMDb", para nao repetir a pergunta a cada visita.
    await env.SUBS.put(key, imdbId || '-', { expirationTtl: 365 * 86400 }).catch(() => {});
  }
  return imdbId;
}

/** Converte um resultado do TMDB no formato de meta que o Nuvio espera. */
export function toMeta(show, imdbId, genres = {}) {
  const meta = {
    id: imdbId || `tmdb:${show.id}`,
    type: 'series',
    name: show.name || show.original_name,
  };

  if (show.poster_path) meta.poster = `${IMAGE}/w500${show.poster_path}`;
  if (show.backdrop_path) meta.background = `${IMAGE}/original${show.backdrop_path}`;
  if (show.overview) meta.description = show.overview;

  const year = (show.first_air_date || '').slice(0, 4);
  if (year) meta.releaseInfo = year;

  // Uma nota de 10.0 assente em tres votos engana mais do que informa, e a
  // coleccao "Em Alta" nao filtra por numero de votos para nao excluir estreias.
  if (show.vote_average && (show.vote_count || 0) >= 10) {
    meta.imdbRating = show.vote_average.toFixed(1);
  }

  const names = (show.genre_ids || []).map((id) => genres[id]).filter(Boolean);
  if (names.length > 0) meta.genres = names;

  return meta;
}

/**
 * Devolve uma pagina de uma coleccao.
 *
 * @param {string} catalogId
 * @param {number} skip itens a saltar (o Nuvio pagina em multiplos da pagina)
 * @param {object} env
 * @returns {Promise<{ metas: Array, error?: string }>}
 */
export async function buildCatalog(catalogId, skip, env) {
  if (!env.TMDB_API_KEY) return { metas: [], error: 'TMDB_API_KEY nao esta definida' };

  const page = Math.floor(Math.max(0, skip) / PAGE_SIZE) + 1;
  const cacheKey = `cat:v${META_SHAPE_VERSION}:${catalogId}:${page}:${tmdbLanguage(env)}`;

  if (env.SUBS) {
    const cached = await env.SUBS.get(cacheKey, 'json').catch(() => null);
    if (cached) return { metas: cached };
  }

  const [data, genres] = await Promise.all([
    fetchJson(discoverUrl(catalogId, page, env)).catch(() => null),
    genreNames(env),
  ]);

  const shows = (data && data.results) || [];
  if (shows.length === 0) return { metas: [] };

  const imdbIds = await mapLimit(shows, 12, (show) => imdbIdFor(show.id, env).catch(() => ''));
  const metas = shows.map((show, index) => toMeta(show, imdbIds[index], genres));

  if (env.SUBS) {
    // "Em alta" muda ao dia; "populares" e' estavel. Ambos baratos de refazer.
    const ttl = catalogId === CATALOG_TRENDING ? 6 * 3600 : 24 * 3600;
    await env.SUBS.put(cacheKey, JSON.stringify(metas), { expirationTtl: ttl }).catch(() => {});
  }

  return { metas };
}

/** Le o `skip` da parte extra do caminho (`skip=40`) ou da query string. */
export function parseSkip(extra, url) {
  const fromPath = String(extra || '').match(/skip=(\d+)/);
  if (fromPath) return Number(fromPath[1]);

  const fromQuery = url && url.searchParams.get('skip');
  return fromQuery ? Number(fromQuery) || 0 : 0;
}
