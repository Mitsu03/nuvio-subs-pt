/**
 * Streams com audio turco.
 *
 * Motivo de existir, medido: para uma serie turca acabada de estrear
 * (`tt43351313`, *Muhtemel Ask*, Show TV, Junho de 2026) o Torrentio devolvia
 * 18 streams e os 18 eram a mesma dobragem russa do Rutracker; o MediaFusion
 * devolvia zero. Nao ha nada em turco no circuito de torrents, portanto
 * reordenar o que ja existe nao resolve nada — e' preciso outra fonte.
 *
 * A fonte e' o canal oficial. As estacoes turcas publicam os episodios
 * inteiros no YouTube, de graca e sem bloqueio por pais: as cinco series de
 * referencia deste addon foram todas encontradas assim, em canais da propria
 * serie ou da estacao.
 *
 * O que se devolve e' `externalUrl`, e nao `url` nem `ytId`. O `ytId` esta na
 * especificacao do Stremio mas e' letra morta nos clientes reais — o
 * NuvioMobile nem tem o campo no modelo e o NuvioTV le-o sem que nenhum ecra
 * o reproduza. Vai na mesma no objecto, para clientes que o percebam.
 */

import { fetchJson } from '../http.js';
import { absoluteEpisode, rankVideos } from './match.js';
import { searchYouTube, watchUrl } from './youtube.js';

const TMDB = 'https://api.themoviedb.org/3';

/**
 * Versao da forma do stream, e parte da chave da cache.
 *
 * INCREMENTAR sempre que `toStream` mudar o que produz — sem isto, uma
 * correccao ao formato so chega aos utilizadores quando a cache expirar.
 */
const STREAM_SHAPE_VERSION = 1;

const DAY = 86400;

/** Segundos abaixo dos quais um video nao pode ser o episodio. */
function minSeconds(env, type) {
  const configured = Number(env.YOUTUBE_MIN_MINUTES);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : 40;
  // Um filme turco anda pelas duas horas; um episodio de dizi tambem, mas ha
  // series antigas com episodios de 45 minutos, por isso o minimo e' menor.
  return (type === 'movie' ? Math.max(minutes, 60) : minutes) * 60;
}

function resultLimit(env) {
  const configured = Number(env.STREAM_RESULTS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 10) : 3;
}

/**
 * Identifica a obra no TMDB a partir do id IMDb, e diz se e' turca.
 *
 * Devolve `null` para tudo o que nao tenha turco como lingua original: este
 * recurso e' so para conteudo turco, e devolver videos do YouTube para uma
 * serie americana seria ruido puro na lista do utilizador.
 */
async function turkishTitle(video, env) {
  const key = `tr:v1:${video.imdbId}`;

  if (env.SUBS) {
    const cached = await env.SUBS.get(key, 'json').catch(() => null);
    if (cached) return cached.title ? cached : null;
  }

  const url = `${TMDB}/find/${encodeURIComponent(video.imdbId)}?api_key=${encodeURIComponent(env.TMDB_API_KEY)}&external_source=imdb_id`;
  const found = await fetchJson(url).catch(() => null);

  const list = video.type === 'movie' ? found && found.movie_results : found && found.tv_results;
  const hit = Array.isArray(list) ? list[0] : null;

  let info = { title: '', seasons: [] };

  if (hit && hit.original_language === 'tr') {
    info = {
      tmdbId: String(hit.id),
      title: hit.original_name || hit.original_title || hit.name || hit.title || '',
      seasons: [],
    };

    // As temporadas so interessam a series, e servem uma coisa so: converter
    // o numero por temporada no numero corrido que o YouTube usa.
    if (video.type !== 'movie' && info.tmdbId) {
      const details = await fetchJson(
        `${TMDB}/tv/${info.tmdbId}?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`,
      ).catch(() => null);

      info.seasons = ((details && details.seasons) || []).map((season) => ({
        season_number: Number(season.season_number),
        episode_count: Number(season.episode_count) || 0,
      }));
    }
  }

  if (env.SUBS) {
    // A resposta negativa vale a pena guardar: sem ela, cada abertura de uma
    // ficha nao-turca custava um pedido ao TMDB para dar em nada. Prazo curto
    // para as turcas, porque a contagem de episodios cresce com a temporada.
    const ttl = info.title === '' ? 30 * DAY : 7 * DAY;
    await env.SUBS.put(key, JSON.stringify(info), { expirationTtl: ttl }).catch(() => {});
  }

  return info.title ? info : null;
}

/** `8330` -> `2h18`. */
export function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}` : `${minutes}min`;
}

/** Converte um video escolhido no objecto de stream que o Nuvio le. */
export function toStream(video) {
  const detail = [
    `Canal: ${video.channel || 'YouTube'}`,
    humanDuration(video.seconds),
    'audio turco original',
  ].join(' · ');

  return {
    name: 'Turcas PT\nYouTube',
    title: `${video.title}\n${detail}`,
    // O Nuvio mostra o subtitulo a partir de `description`; o Stremio le
    // `title`. Custa uma linha repetida e evita uma entrada muda num deles.
    description: `${video.title}\n${detail}`,
    externalUrl: watchUrl(video.id),
    ytId: video.id,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: 'turcas-pt-youtube',
    },
  };
}

/**
 * Consultas a fazer, por ordem. Para a segunda so se avanca quando a primeira
 * nao deu nada.
 *
 * Series: a numeracao corrida e' a que o YouTube usa, mas nem sempre bate
 * certo com a do TMDB (temporadas divididas, especiais contados a mais), por
 * isso o numero por temporada fica de reserva.
 */
export function buildQueries(info, video) {
  if (video.type === 'movie') {
    return [
      { query: `${info.title} full film`, episode: null },
      { query: `${info.title} tek parça`, episode: null },
    ];
  }

  const absolute = absoluteEpisode(info.seasons, video.season, video.episode);
  const queries = [{ query: `${info.title} ${absolute}. Bölüm`, episode: absolute }];

  if (absolute !== video.episode) {
    queries.push({ query: `${info.title} ${video.episode}. Bölüm`, episode: video.episode });
  }

  return queries;
}

/**
 * Streams para um video. Nunca lanca e nunca devolve erro visivel: uma lista
 * vazia e' a resposta certa para tudo o que nao seja turco.
 *
 * @param {object} video id de video ja interpretado por `parseVideoId`
 * @param {object} env
 * @returns {Promise<{streams: Array}>}
 */
export async function buildStreams(video, env) {
  // Sem gate por `STREAMS` aqui, de proposito: essa variavel decide se o
  // recurso e' anunciado no manifesto, e nao se este endpoint responde. O
  // plugin do NuvioTV pergunta por aqui qual e' o video oficial, e desligar a
  // rota partia-o — com o agravante de o partir em silencio.
  if (!env.TMDB_API_KEY) return { streams: [] };
  if (!video || !video.imdbId) return { streams: [] };
  if (video.type !== 'movie' && (video.season === null || video.episode === null)) {
    return { streams: [] };
  }

  const season = video.season === null ? '' : video.season;
  const episode = video.episode === null ? '' : video.episode;
  const cacheKey = `yts:v${STREAM_SHAPE_VERSION}:${video.imdbId}:${season}:${episode}`;

  if (env.SUBS) {
    const cached = await env.SUBS.get(cacheKey, 'json').catch(() => null);
    if (cached) return { streams: cached };
  }

  const info = await turkishTitle(video, env);
  if (!info) return { streams: [] };

  const want = { title: info.title, minSeconds: minSeconds(env, video.type) };
  const limit = resultLimit(env);

  let chosen = [];
  for (const attempt of buildQueries(info, video)) {
    const found = await searchYouTube(attempt.query, env);
    chosen = rankVideos(found, { ...want, episode: attempt.episode }, limit);
    if (chosen.length > 0) break;
  }

  const streams = chosen.map(toStream);

  if (env.SUBS) {
    // Um episodio que existe nunca muda de endereco, mas um que ainda nao foi
    // publicado aparece daqui a dias — dai o prazo curto para a lista vazia.
    const ttl = streams.length > 0 ? 30 * DAY : 6 * 3600;
    await env.SUBS.put(cacheKey, JSON.stringify(streams), { expirationTtl: ttl }).catch(() => {});
  }

  return { streams };
}
