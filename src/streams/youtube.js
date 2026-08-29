/**
 * Busca no YouTube, que e' onde os episodios completos das series turcas
 * estao mesmo.
 *
 * Duas estrategias, pela mesma interface:
 *
 *   1. API oficial, quando ha `YOUTUBE_API_KEY`. Estavel, mas com quota (uma
 *      busca custa 100 dos 10 000 pontos diarios do plano gratuito).
 *   2. A pagina de resultados, sem chave nenhuma. E' o que se usa por omissao,
 *      mas o YouTube pode responder com o muro de consentimento a IPs de
 *      datacentro — dai o cookie `SOCS`, que e' a resposta a esse muro.
 *
 * Nenhuma das duas descarrega video: o addon devolve o endereco do YouTube e
 * e' o leitor do utilizador que o abre. Extrair o ficheiro seria contra os
 * termos do YouTube e, testado, nem sequer funciona — o `youtubei/v1/player`
 * responde `UNPLAYABLE` sem token de sessao.
 */

import { fetchJson } from '../http.js';
import { durationToSeconds, iso8601ToSeconds } from './match.js';

const SEARCH_TIMEOUT_MS = 15000;

/** Cabecalhos de um browser turco, incluindo a aceitacao do consentimento. */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.6',
  // Sem este cookie o YouTube devolve a pagina de consentimento em vez dos
  // resultados, e o `ytInitialData` que la vem nao traz videos nenhuns.
  Cookie: 'SOCS=CAI; PREF=hl=tr&gl=TR',
};

/** Percorre a arvore do `ytInitialData` a juntar os cartoes de video. */
function collectVideoRenderers(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const renderer = node.videoRenderer;
  if (renderer && renderer.videoId) {
    const runs = (renderer.title && renderer.title.runs) || [];
    const owner = renderer.ownerText && renderer.ownerText.runs && renderer.ownerText.runs[0];
    out.push({
      id: renderer.videoId,
      title: runs.map((run) => run.text || '').join(''),
      channel: (owner && owner.text) || '',
      seconds: durationToSeconds((renderer.lengthText && renderer.lengthText.simpleText) || ''),
    });
  }

  for (const value of Object.values(node)) collectVideoRenderers(value, out);
}

/** Busca sem chave, a ler o JSON que a propria pagina traz embutido. */
async function searchByScraping(query) {
  // `sp=EgIQAQ%3D%3D` e' o filtro "so videos": corta canais, playlists e
  // seccoes promocionais, que so acrescentavam candidatos para descartar.
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D&hl=tr&gl=TR`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  let html;
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (!response.ok) return [];
    html = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  const match =
    html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/) ||
    html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return [];

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const videos = [];
  collectVideoRenderers(data, videos);
  return videos;
}

/**
 * Busca pela API oficial. Sao dois pedidos: a busca nao devolve duracoes, e a
 * duracao e' precisamente o filtro que distingue o episodio do fragman.
 */
async function searchByApi(query, apiKey) {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '12',
    regionCode: 'TR',
    relevanceLanguage: 'tr',
    q: query,
    key: apiKey,
  })}`;

  const found = await fetchJson(searchUrl, { timeoutMs: SEARCH_TIMEOUT_MS });
  const ids = ((found && found.items) || [])
    .map((item) => item.id && item.id.videoId)
    .filter(Boolean);
  if (ids.length === 0) return [];

  const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
    part: 'contentDetails,snippet',
    id: ids.join(','),
    key: apiKey,
  })}`;

  const details = await fetchJson(detailsUrl, { timeoutMs: SEARCH_TIMEOUT_MS });
  return ((details && details.items) || []).map((item) => ({
    id: item.id,
    title: (item.snippet && item.snippet.title) || '',
    channel: (item.snippet && item.snippet.channelTitle) || '',
    seconds: iso8601ToSeconds(item.contentDetails && item.contentDetails.duration),
  }));
}

/**
 * Procura no YouTube e devolve candidatos no formato que o `match.js` pontua.
 * Nunca lanca: uma fonte que falha vale zero resultados, e nao um erro na cara
 * do utilizador.
 *
 * @param {string} query
 * @param {object} env
 * @returns {Promise<Array<{id:string,title:string,channel:string,seconds:number}>>}
 */
export async function searchYouTube(query, env) {
  try {
    return env.YOUTUBE_API_KEY
      ? await searchByApi(query, env.YOUTUBE_API_KEY)
      : await searchByScraping(query);
  } catch (error) {
    console.error('busca no YouTube falhou:', error && error.message);
    return [];
  }
}

/** Endereco publico do video, que e' o que se entrega ao leitor. */
export function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
