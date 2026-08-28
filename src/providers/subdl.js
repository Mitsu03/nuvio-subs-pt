/**
 * Fonte SubDL. Opcional: so entra em jogo quando `SUBDL_API_KEY` esta definida.
 *
 * Cobre bastantes series turcas que o OpenSubtitles nao tem, e entrega os
 * ficheiros em `.zip` (tratado em ../format/archive.js).
 */

import { fetchJson } from '../http.js';

const API = 'https://api.subdl.com/api/v1/subtitles';
const DOWNLOAD_BASE = 'https://dl.subdl.com';

// Codigos que o SubDL usa no parametro `languages`.
const LANG_TO_API = {
  pt: 'PT',
  'pt-BR': 'BR',
  en: 'EN',
  tr: 'TR',
};

function normalizeLang(entry) {
  const raw = String(entry.language || entry.lang || '').toLowerCase();
  if (raw.includes('brazil') || raw === 'br' || raw === 'pt-br') return 'pt-BR';
  if (raw.startsWith('portug') || raw === 'pt') return 'pt';
  if (raw.startsWith('turk') || raw === 'tr') return 'tr';
  if (raw.startsWith('eng') || raw === 'en') return 'en';
  return raw || 'unknown';
}

function matchesEpisode(entry, video) {
  if (video.type !== 'series' || video.season === null || video.episode === null) return true;
  const season = Number(entry.season);
  const episode = Number(entry.episode);
  // Entradas de pack de temporada nao trazem episodio: aceitam-se e o ficheiro
  // certo e' escolhido depois, dentro do zip, pela pista do nome.
  if (!Number.isFinite(episode)) return !Number.isFinite(season) || season === video.season;
  return season === video.season && episode === video.episode;
}

/**
 * @param {import('../ids.js').VideoId} video
 * @param {string[]} langs
 * @param {object} env
 * @returns {Promise<Array<object>>}
 */
export async function searchSubdl(video, langs, env) {
  if (!env.SUBDL_API_KEY || !video.imdbId) return [];

  const apiLangs = langs.map((lang) => LANG_TO_API[lang]).filter(Boolean);
  if (apiLangs.length === 0) return [];

  const params = new URLSearchParams({
    api_key: env.SUBDL_API_KEY,
    imdb_id: video.imdbId,
    languages: apiLangs.join(','),
    subs_per_page: '30',
  });
  if (video.type === 'series' && video.season !== null) {
    params.set('season_number', String(video.season));
    if (video.episode !== null) params.set('episode_number', String(video.episode));
  }

  const data = await fetchJson(`${API}?${params.toString()}`).catch(() => null);
  if (!data || data.status === false || !Array.isArray(data.subtitles)) return [];

  return data.subtitles
    .filter((entry) => entry.url && matchesEpisode(entry, video))
    .map((entry, index) => ({
      provider: 'subdl',
      id: `subdl-${index}-${entry.url.replace(/\W+/g, '').slice(-12)}`,
      url: entry.url.startsWith('http') ? entry.url : `${DOWNLOAD_BASE}${entry.url}`,
      lang: normalizeLang(entry),
      fileName: entry.release_name || entry.name || '',
      release: entry.release_name || '',
      encoding: '',
      format: 'srt',
      downloads: 0,
      rating: 0,
      hearingImpaired: Boolean(entry.hi),
    }));
}
