import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTurkish,
  durationToSeconds,
  iso8601ToSeconds,
  absoluteEpisode,
  scoreVideo,
  rankVideos,
} from '../src/streams/match.js';
import { buildQueries, toStream, humanDuration, buildStreams } from '../src/streams/index.js';
import { buildManifest } from '../src/manifest.js';

/** Temporadas do Kurulus Osman, na forma que o TMDB devolve. */
const KURULUS_SEASONS = [
  { season_number: 0, episode_count: 9 },
  { season_number: 1, episode_count: 27 },
  { season_number: 2, episode_count: 37 },
  { season_number: 3, episode_count: 33 },
];

test('streams: normaliza as letras proprias do alfabeto turco', () => {
  assert.equal(normalizeTurkish('Diriliş Ertuğrul'), 'dirilis ertugrul');
  assert.equal(normalizeTurkish('Muhtemel Aşk 1. Bölüm'), 'muhtemel ask 1 bolum');
  assert.equal(normalizeTurkish('Payitaht: Abdülhamid'), 'payitaht abdulhamid');
  // O I maiusculo turco nao e o I latino; sem tratamento a mao ficava um
  // caracter combinante pelo meio da palavra.
  assert.equal(normalizeTurkish('İstanbullu Gelin'), 'istanbullu gelin');
});

test('streams: le duracoes das duas fontes', () => {
  assert.equal(durationToSeconds('2:18:51'), 8331);
  assert.equal(durationToSeconds('43:42'), 2622);
  assert.equal(durationToSeconds('DIRETO'), 0);
  assert.equal(iso8601ToSeconds('PT2H18M51S'), 8331);
  assert.equal(iso8601ToSeconds('PT59S'), 59);
  assert.equal(iso8601ToSeconds('nada'), 0);
});

test('streams: numera o episodio como a televisao turca, de forma corrida', () => {
  // O primeiro episodio da segunda temporada do Kurulus Osman chama-se
  // "28. Bolum" no YouTube, e nao "Sezon 2 Bolum 1".
  assert.equal(absoluteEpisode(KURULUS_SEASONS, 2, 1), 28);
  assert.equal(absoluteEpisode(KURULUS_SEASONS, 1, 5), 5);
  assert.equal(absoluteEpisode(KURULUS_SEASONS, 3, 1), 65);
  // A temporada 0 sao especiais e nunca conta para a numeracao emitida.
  assert.equal(absoluteEpisode([{ season_number: 0, episode_count: 9 }], 1, 3), 3);
  assert.equal(absoluteEpisode(null, 2, 4), 4);
});

test('streams: o fragman e o excerto nunca passam por episodio', () => {
  const want = { title: 'Muhtemel Aşk', episode: 1, minSeconds: 2400 };

  const episode = {
    id: 'QvZHtdpkybc',
    title: 'Muhtemel Aşk 1. Bölüm',
    channel: 'Muhtemel Aşk',
    seconds: 8331,
  };
  // Titulo e duracao a condizer, mas e o trailer: o que aqui se testa e a
  // palavra, nao o relogio.
  const trailer = { ...episode, id: 'x', title: 'Muhtemel Aşk 1. Bölüm Fragmanı' };
  // Canal oficial, episodio certo, mas e o resumo de meia hora.
  const digest = {
    id: 'y',
    title: '30 Dakikada Muhtemel Aşk 1. Bölüm',
    channel: 'Muhtemel Aşk',
    seconds: 1805,
  };
  const other = { ...episode, id: 'z', title: 'Muhtemel Aşk 11. Bölüm' };

  assert.ok(scoreVideo(episode, want) > 0);
  assert.equal(scoreVideo(trailer, want), null);
  assert.equal(scoreVideo(digest, want), null);
  assert.equal(scoreVideo(other, want), null);
});

test('streams: o episodio 1 nao apanha o 11 nem o 21', () => {
  const want = { title: 'Teşkilat', episode: 1, minSeconds: 2400 };
  const base = { channel: 'Teşkilat', seconds: 7547 };

  assert.ok(scoreVideo({ ...base, id: 'a', title: 'Teşkilat 1. Bölüm' }, want) > 0);
  assert.equal(scoreVideo({ ...base, id: 'b', title: 'Teşkilat 11. Bölüm' }, want), null);
  assert.equal(scoreVideo({ ...base, id: 'c', title: 'Teşkilat 21. Bölüm' }, want), null);
});

test('streams: um video curto nao serve, por muito que o titulo bata certo', () => {
  const want = { title: 'Teşkilat', episode: 1, minSeconds: 2400 };
  const short = { id: 'a', title: 'Teşkilat 1. Bölüm', channel: 'Teşkilat', seconds: 600 };

  assert.equal(scoreVideo(short, want), null);
});

test('streams: o canal oficial ganha ao recopiador com o mesmo episodio', () => {
  const want = { title: 'Teşkilat', episode: 1, minSeconds: 2400 };
  const official = {
    id: 'official',
    title: 'Teşkilat 1. Bölüm',
    channel: 'Teşkilat',
    seconds: 7547,
  };
  const reupload = {
    id: 'reupload',
    title: 'Teşkilat 1 bölüm',
    channel: 'Vusal Vusal',
    seconds: 6859,
  };

  const ranked = rankVideos([reupload, official], want, 5);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'official');
});

test('streams: nao repete o mesmo video e respeita o limite', () => {
  const want = { title: 'Teşkilat', episode: 1, minSeconds: 2400 };
  const one = { id: 'a', title: 'Teşkilat 1. Bölüm', channel: 'Teşkilat', seconds: 7547 };
  const two = { id: 'b', title: 'Teşkilat 1. Bölüm (HD)', channel: 'atv', seconds: 7500 };

  assert.equal(rankVideos([one, one, two], want, 5).length, 2);
  assert.equal(rankVideos([one, two], want, 1).length, 1);
});

test('streams: a busca por temporada fica de reserva atras da corrida', () => {
  const info = { title: 'Kuruluş Osman', seasons: KURULUS_SEASONS };
  const queries = buildQueries(info, { type: 'series', season: 2, episode: 1 });

  assert.equal(queries.length, 2);
  assert.equal(queries[0].query, 'Kuruluş Osman 28. Bölüm');
  assert.equal(queries[0].episode, 28);
  assert.equal(queries[1].query, 'Kuruluş Osman 1. Bölüm');

  // Na primeira temporada os dois numeros sao o mesmo: uma consulta chega.
  const first = buildQueries(info, { type: 'series', season: 1, episode: 3 });
  assert.equal(first.length, 1);
  assert.equal(first[0].query, 'Kuruluş Osman 3. Bölüm');
});

test('streams: o filme procura-se por outro lado', () => {
  const queries = buildQueries({ title: 'Aile Arasında', seasons: [] }, { type: 'movie' });
  assert.equal(queries[0].query, 'Aile Arasında full film');
  assert.equal(queries[0].episode, null);
});

test('streams: o objecto devolvido nao usa `url` nem depende de `ytId`', () => {
  const stream = toStream({
    id: 'QvZHtdpkybc',
    title: 'Muhtemel Aşk 1. Bölüm',
    channel: 'Muhtemel Aşk',
    seconds: 8331,
  });

  // `url` faria o leitor tentar reproduzir uma pagina HTML; o `ytId` sozinho
  // nao toca em nenhum dos clientes do Nuvio, so o `externalUrl` abre.
  assert.equal(stream.url, undefined);
  assert.equal(stream.externalUrl, 'https://www.youtube.com/watch?v=QvZHtdpkybc');
  assert.equal(stream.ytId, 'QvZHtdpkybc');
  assert.match(stream.title, /2h19/);
  assert.match(stream.description, /audio turco original/);
});

test('streams: 8331 segundos mostram-se como 2h19', () => {
  assert.equal(humanDuration(8331), '2h19');
  assert.equal(humanDuration(2622), '44min');
  assert.equal(humanDuration(0), '0min');
});

test('streams: sem chave TMDB nao ha resposta nenhuma', async () => {
  const video = { type: 'series', imdbId: 'tt11093718', season: 1, episode: 1 };
  assert.deepEqual(await buildStreams(video, {}), { streams: [] });
});

test('streams: STREAMS=0 retira o recurso do manifesto', () => {
  const env = { TMDB_API_KEY: 'x', STREAMS: '0' };
  const names = buildManifest(env).resources.map((resource) => resource.name);

  assert.ok(!names.includes('stream'));
});

test('streams: uma ficha de serie sem episodio nao gasta pedidos', async () => {
  const video = { type: 'series', imdbId: 'tt11093718', season: null, episode: null };
  assert.deepEqual(await buildStreams(video, { TMDB_API_KEY: 'x' }), { streams: [] });
});

test('streams: o que nao e turco sai vazio e fica guardado assim', async () => {
  const store = new Map();
  const env = {
    TMDB_API_KEY: 'x',
    SUBS: {
      get: async (key, type) => {
        const value = store.get(key);
        if (value === undefined) return null;
        return type === 'json' ? JSON.parse(value) : value;
      },
      put: async (key, value) => void store.set(key, value),
    },
  };

  // Sem rede o `find` do TMDB nao devolve nada, que e o mesmo resultado que
  // uma serie sem turco como lingua original.
  const result = await buildStreams(
    { type: 'series', imdbId: 'tt0903747', season: 1, episode: 1 },
    env,
  );

  assert.deepEqual(result, { streams: [] });
  assert.equal(JSON.parse(store.get('tr:v1:tt0903747')).title, '');
});

test('streams: o recurso so entra no manifesto quando pode funcionar', () => {
  const names = (env) => buildManifest(env).resources.map((resource) => resource.name);

  assert.ok(!names({}).includes('stream'));
  assert.ok(names({ TMDB_API_KEY: 'x' }).includes('stream'));
  assert.ok(!names({ TMDB_API_KEY: 'x', STREAMS: '0' }).includes('stream'));
});

test('streams: a versao com audio-descricao nao fica a frente da normal', () => {
  const want = { title: 'Diriliş Ertuğrul', episode: 27, minSeconds: 2400 };
  const plain = {
    id: 'plain',
    title: 'Diriliş Ertuğrul 27. Bölüm',
    channel: 'Engelsiz TRT',
    seconds: 7980,
  };
  const described = { ...plain, id: 'described', title: 'Diriliş Ertuğrul 27. Bölüm Engelsiz' };

  const ranked = rankVideos([described, plain], want, 5);
  // Continua na lista: serve quem precisa dela.
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'plain');
});
