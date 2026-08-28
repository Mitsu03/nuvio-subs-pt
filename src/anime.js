/**
 * Deteccao de anime, para nao gastar o tradutor onde ele nao e' preciso.
 *
 * O anime tem legendas em portugues em abundancia e comunidades dedicadas a
 * traduzi-lo; gastar a quota diaria de traducao automatica ai e' desperdicio.
 * As series turcas, que e' para o que este addon existe, e' que quase nunca
 * tem legenda portuguesa.
 *
 * Isto so trava a TRADUCAO: as legendas portuguesas reais que existam continuam
 * a ser servidas normalmente para anime.
 */

import { fetchJson } from './http.js';

const TMDB = 'https://api.themoviedb.org/3';
const ANIMATION_GENRE = 16;

/**
 * True quando o titulo e' animacao de origem japonesa.
 *
 * A conjuncao das duas condicoes e' deliberada: so "animacao" apanharia
 * desenhos animados ocidentais, e so "japones" apanharia cinema japones de
 * imagem real. Juntas descrevem anime com pouca margem de erro.
 *
 * Sem chave TMDB devolve false — a duvida resolve-se a favor de traduzir, que
 * e' o comportamento pedido para o resto do catalogo.
 *
 * @param {import('./ids.js').VideoId} video
 * @param {object} env
 * @returns {Promise<boolean>}
 */
export async function isAnime(video, env) {
  if (!env.TMDB_API_KEY || !video || !video.imdbId) return false;

  const key = `anime:v1:${video.imdbId}`;
  if (env.SUBS) {
    const cached = await env.SUBS.get(key).catch(() => null);
    if (cached !== null) return cached === '1';
  }

  const url = `${TMDB}/find/${encodeURIComponent(video.imdbId)}?api_key=${encodeURIComponent(env.TMDB_API_KEY)}&external_source=imdb_id`;
  const data = await fetchJson(url).catch(() => null);
  if (!data) return false; // falha de rede nao deve travar a traducao

  const hit =
    (data.tv_results && data.tv_results[0]) || (data.movie_results && data.movie_results[0]);

  const anime = Boolean(
    hit && hit.original_language === 'ja' && (hit.genre_ids || []).includes(ANIMATION_GENRE),
  );

  if (env.SUBS) {
    // A lingua original e o genero de um titulo nao mudam.
    await env.SUBS.put(key, anime ? '1' : '0', { expirationTtl: 365 * 86400 }).catch(() => {});
  }
  return anime;
}
