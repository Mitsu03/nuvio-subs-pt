/**
 * Fonte OpenSubtitles (endpoint REST publico, sem chave).
 *
 * A API so aceita uma lingua por pedido, por isso faz-se uma consulta por
 * lingua pedida. Cada resultado ja traz um link `.gz` directo, sem quota de
 * download nem sessao.
 */

import { fetchJson } from '../http.js';
import { imdbNumber } from '../ids.js';

const BASE = 'https://rest.opensubtitles.org/search';

// Codigos ISO 639-2 usados por esta API, mapeados para os codigos que o Nuvio
// entende (`pt` = Portugal, `pt-BR` = Brasil).
const LANG_TO_API = {
  pt: 'por',
  'pt-BR': 'pob',
  en: 'eng',
  tr: 'tur',
  es: 'spa',
  fr: 'fre',
};

const API_TO_LANG = Object.fromEntries(
  Object.entries(LANG_TO_API).map(([lang, api]) => [api, lang]),
);

function buildUrl(video, apiLang) {
  const id = imdbNumber(video.imdbId);
  if (!id) return null;

  // A API exige os segmentos por ordem alfabetica.
  if (video.type === 'series' && video.season !== null && video.episode !== null) {
    return `${BASE}/episode-${video.episode}/imdbid-${id}/season-${video.season}/sublanguageid-${apiLang}`;
  }
  return `${BASE}/imdbid-${id}/sublanguageid-${apiLang}`;
}

function matchesEpisode(entry, video) {
  if (video.type !== 'series' || video.season === null || video.episode === null) return true;
  const season = Number(entry.SeriesSeason);
  const episode = Number(entry.SeriesEpisode);
  // Alguns registos vem sem numeracao; nesses confia-se na consulta.
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return true;
  return season === video.season && episode === video.episode;
}

/**
 * @param {import('../ids.js').VideoId} video
 * @param {string[]} langs codigos no formato do Nuvio (`pt`, `pt-BR`, `en`, `tr`)
 * @returns {Promise<Array<object>>} candidatos normalizados
 */
export async function searchOpenSubtitles(video, langs) {
  const queries = langs
    .map((lang) => ({ lang, apiLang: LANG_TO_API[lang] }))
    .filter((query) => Boolean(query.apiLang));

  const responses = await Promise.all(
    queries.map(async (query) => {
      const url = buildUrl(video, query.apiLang);
      if (!url) return [];
      const data = await fetchJson(url).catch(() => null);
      return Array.isArray(data) ? data : [];
    }),
  );

  const results = [];
  for (const entries of responses) {
    for (const entry of entries) {
      if (!entry.SubDownloadLink || !matchesEpisode(entry, video)) continue;

      const lang = API_TO_LANG[entry.SubLanguageID] || entry.ISO639 || 'unknown';
      results.push({
        provider: 'opensubtitles',
        id: `os-${entry.IDSubtitleFile || entry.IDSubtitle}`,
        url: entry.SubDownloadLink,
        lang,
        fileName: entry.SubFileName || '',
        release: entry.MovieReleaseName || '',
        encoding: entry.SubEncoding || '',
        format: (entry.SubFormat || 'srt').toLowerCase(),
        downloads: Number(entry.SubDownloadsCnt) || 0,
        rating: Number(entry.SubRating) || 0,
        hearingImpaired: entry.SubHearingImpaired === '1',
      });
    }
  }

  return results;
}
