/**
 * Escolha do video certo entre os resultados de uma busca.
 *
 * Tudo aqui e' funcao pura: recebe a lista de candidatos ja normalizada pelo
 * lado que fala com a rede e devolve os que servem, por ordem. E' onde vive o
 * conhecimento sobre como o YouTube turco nomeia episodios, e e' a parte que
 * os testes cobrem sem tocar na rede.
 */

/** Redes que publicam os episodios completos nos seus proprios canais. */
const NETWORKS = [
  'atv',
  'show tv',
  'showtv',
  'star tv',
  'startv',
  'kanal d',
  'kanald',
  'trt',
  'now',
  'tv8',
  'fox',
  'tabii',
  'puhutv',
  'blutv',
  'teve2',
  'dmax',
];

/**
 * Palavras que marcam um excerto e nao o episodio.
 *
 * Sem isto a busca por "X 1. Bolum" devolve em primeiro os fragmanlar, que sao
 * os videos mais vistos do canal: um trailer de 60 segundos apanha mais
 * visualizacoes do que o episodio de duas horas.
 */
const EXCERPT = new RegExp(
  [
    'fragman',
    'teaser',
    'tanitim',
    'ozet',
    'klip',
    'sahne',
    'dakikada',
    'analiz',
    'tepki',
    'reaction',
    'jenerik',
    'muzik',
    'sarki',
    'kamera arkasi',
    'roportaj',
    'ilk bakis',
  ].join('|'),
  'i',
);

/**
 * Versoes acessiveis: audio-descricao e lingua gestual. Sao o mesmo episodio e
 * servem quem precisa delas, por isso nao se excluem — mas quem nao as procura
 * nao as quer em primeiro, e a narracao por cima do dialogo estraga a legenda.
 */
const ACCESSIBLE = /engelsiz|sesli betimleme|isaret dili/i;

/**
 * Passa o texto para minusculas sem diacriticos turcos e sem pontuacao.
 *
 * `String.normalize` nao chega: o `i` sem ponto e o `s` com cedilha sao letras
 * proprias do alfabeto turco e nao decompoem em latim base mais acento, por
 * isso tem de ser traduzidas a mao. Sem isto "Dirilis Ertugrul" nunca bate
 * certo com o que o TMDB devolve.
 */
export function normalizeTurkish(text) {
  const from = 'ışğçöüâîûİIŞĞÇÖÜ';
  const to = 'isgcouaiuiisgcou';

  let out = String(text || '');
  for (let i = 0; i < from.length; i += 1) out = out.split(from[i]).join(to[i]);

  return out
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Palavras com peso do titulo, sem as curtas que aparecem em tudo. */
function titleTokens(title) {
  return normalizeTurkish(title)
    .split(' ')
    .filter((token) => token.length >= 3);
}

/** `2:18:51` ou `43:42` em segundos. Devolve 0 quando nao consegue ler. */
export function durationToSeconds(text) {
  const parts = String(text || '')
    .trim()
    .split(':');
  if (parts.length < 2 || parts.length > 3) return 0;

  let total = 0;
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part)) return 0;
    total = total * 60 + Number(part);
  }
  return total;
}

/** `PT2H18M51S`, que e' o formato da API oficial do YouTube. */
export function iso8601ToSeconds(text) {
  const match = String(text || '').match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  return (
    Number(match[1] || 0) * 86400 +
    Number(match[2] || 0) * 3600 +
    Number(match[3] || 0) * 60 +
    Number(match[4] || 0)
  );
}

/**
 * Numero absoluto do episodio.
 *
 * A televisao turca numera os episodios de forma corrida ao longo de toda a
 * serie — o primeiro episodio da segunda temporada do Kurulus Osman chama-se
 * "28. Bolum", e nao "Sezon 2 Bolum 1". O IMDb e o TMDB numeram por temporada,
 * por isso e' preciso somar as anteriores, ou a busca falha em tudo o que nao
 * seja a primeira temporada.
 *
 * @param {Array<{season_number:number, episode_count:number}>} seasons
 * @param {number} season
 * @param {number} episode
 */
export function absoluteEpisode(seasons, season, episode) {
  if (!Array.isArray(seasons) || !Number.isFinite(season) || !Number.isFinite(episode)) {
    return episode;
  }

  let before = 0;
  for (const item of seasons) {
    const number = Number(item && item.season_number);
    // A temporada 0 do TMDB sao especiais e extras, que nunca entram na
    // numeracao emitida.
    if (!Number.isFinite(number) || number <= 0 || number >= season) continue;
    before += Number(item.episode_count) || 0;
  }

  return before + episode;
}

/** Apanha "12. Bolum", "12.Bolum" e "12 bolum", mas nao o "12" dentro de 121. */
function episodePattern(number) {
  return new RegExp(`(?:^|[^0-9])${number}\\s*bolum(?:$|[^0-9])`);
}

/**
 * Pontua um candidato. Devolve `null` quando o video nao serve de todo — o que
 * e' o caso mais comum, porque a busca traz sobretudo excertos.
 *
 * @param {{id:string, title:string, channel:string, seconds:number}} video
 * @param {{title:string, episode:number|null, minSeconds:number}} want
 * @returns {number|null}
 */
export function scoreVideo(video, want) {
  const title = String((video && video.title) || '');
  if (!video || !video.id || title === '') return null;

  const normalized = normalizeTurkish(title);
  if (EXCERPT.test(normalized)) return null;

  // A duracao e' o filtro que faz o trabalho todo: um episodio de dizi anda
  // pelas duas horas e nenhum excerto se aproxima disso.
  const seconds = Number(video.seconds) || 0;
  if (seconds < want.minSeconds) return null;

  const tokens = titleTokens(want.title);
  if (tokens.length === 0) return null;
  if (!tokens.every((token) => normalized.includes(token))) return null;

  const episode = want.episode;
  if (episode !== null && episode !== undefined && Number.isFinite(episode)) {
    if (!episodePattern(episode).test(normalized)) return null;
  }

  const channel = normalizeTurkish(video.channel);
  let score = 0;

  // Um canal com o nome da serie e' o canal oficial dela; a seguir vem o canal
  // da estacao. Ambos sao mais fiaveis do que um recopiador qualquer.
  if (tokens.every((token) => channel.includes(token))) score += 25;
  else if (NETWORKS.some((network) => channel.includes(normalizeTurkish(network)))) score += 15;

  if (ACCESSIBLE.test(normalized)) score -= 20;
  if (normalized.startsWith(normalizeTurkish(want.title))) score += 10;
  if (/(^| )4k( |$)|ultra hd/.test(normalized)) score += 8;
  else if (/(^| )hd( |$)/.test(normalized)) score += 3;

  // Entre duas copias do mesmo episodio, a mais longa e' a que nao esta
  // cortada. Limitado para nao premiar compilacoes de temporada inteira.
  score += Math.min(seconds, 3 * 3600) / 600;

  return score;
}

/**
 * Ordena e limita os candidatos, um por video.
 *
 * @param {Array} videos
 * @param {{title:string, episode:number|null, minSeconds:number}} want
 * @param {number} limit
 */
export function rankVideos(videos, want, limit = 4) {
  const scored = [];
  const seen = new Set();

  for (const video of videos || []) {
    if (!video || seen.has(video.id)) continue;
    const score = scoreVideo(video, want);
    if (score === null) continue;
    seen.add(video.id);
    scored.push({ ...video, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit));
}
