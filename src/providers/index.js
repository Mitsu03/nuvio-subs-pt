/** Agregacao e ordenacao dos candidatos das varias fontes. */

import { searchOpenSubtitles } from './opensubtitles.js';
import { searchSubdl } from './subdl.js';

export const PT_LANGS = ['pt', 'pt-BR'];

/**
 * Procura em todas as fontes disponiveis. Uma fonte que falhe nao derruba as
 * outras: devolve lista vazia e o resultado agregado segue.
 *
 * @param {import('../ids.js').VideoId} video
 * @param {string[]} langs
 * @param {object} env
 * @returns {Promise<Array<object>>}
 */
export async function searchAllProviders(video, langs, env) {
  const searches = [
    searchOpenSubtitles(video, langs).catch(() => []),
    searchSubdl(video, langs, env).catch(() => []),
  ];

  const results = (await Promise.all(searches)).flat();
  return dedupe(results);
}

function dedupe(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.lang}|${candidate.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pontua um candidato. Serve para escolher a melhor legenda de partida para
 * traduzir e para ordenar o que se mostra ao utilizador.
 */
export function scoreCandidate(candidate, video) {
  let score = 0;

  score += Math.min(candidate.downloads / 200, 25);
  score += candidate.rating * 2;
  if (candidate.format === 'srt') score += 5;
  if (candidate.hearingImpaired) score -= 3;

  // Um nome de ficheiro que bata certo com o episodio e' o sinal mais forte de
  // que a legenda corresponde mesmo a este video.
  if (video.season !== null && video.episode !== null) {
    const pad = (value) => String(value).padStart(2, '0');
    const name = `${candidate.fileName} ${candidate.release}`.toLowerCase();
    const patterns = [
      `s${pad(video.season)}e${pad(video.episode)}`,
      `${video.season}x${pad(video.episode)}`,
      `${video.season}x${video.episode}`,
    ];
    if (patterns.some((pattern) => name.includes(pattern))) score += 60;
  }

  return score;
}

/** Ordena por pontuacao, do melhor para o pior. */
export function rankCandidates(candidates, video) {
  return [...candidates].sort((a, b) => scoreCandidate(b, video) - scoreCandidate(a, video));
}
