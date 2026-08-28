import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSubtitle,
  serializeSrt,
  stripPromoCues,
  wrapCueText,
  flattenCueText,
  formatTimecode,
} from '../src/format/srt.js';
import { decodeSubtitleBytes } from '../src/format/decode.js';
import { unpackSubtitle, isGzip, isZip } from '../src/format/archive.js';
import { parseVideoId, imdbNumber, episodeHint, videoCacheKey } from '../src/ids.js';
import { signToken, verifyToken, isAllowedSource, payloadUrls } from '../src/token.js';
import { buildBatches, resolveEngineName, translateLines } from '../src/translate/index.js';
import { rankCandidates, scoreCandidate } from '../src/providers/index.js';
import { cacheTtlFor, cacheKey } from '../src/cache.js';
import { parseSkip, toMeta, buildCatalog } from '../src/catalogs.js';
import { buildManifest } from '../src/manifest.js';
import { isAnime } from '../src/anime.js';

test('SRT: le blocos com CRLF, numeracao e timecodes com virgula', () => {
  const input = '1\r\n00:00:01,000 --> 00:00:03,500\r\nOla\r\nmundo\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\nAdeus\r\n';
  const cues = parseSubtitle(input);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1000);
  assert.equal(cues[0].end, 3500);
  assert.equal(cues[0].text, 'Ola\nmundo');
  assert.equal(cues[1].start, 62250);
});

test('SRT: le WebVTT, ignorando cabecalho e definicoes de cue', () => {
  const input = 'WEBVTT\n\nNOTE isto e um comentario\n\n00:00:05.000 --> 00:00:07.000 line:90%\nTexto\n';
  const cues = parseSubtitle(input);

  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 5000);
  assert.equal(cues[0].text, 'Texto');
});

test('SRT: escreve numeracao sequencial e timecodes canonicos', () => {
  const output = serializeSrt([
    { start: 0, end: 1500, text: 'A' },
    { start: 2000, end: 3000, text: 'B' },
  ]);

  assert.match(output, /^1\n00:00:00,000 --> 00:00:01,500\nA\n\n2\n/);
  assert.equal(formatTimecode(3661001), '01:01:01,001');
});

test('SRT: remove publicidade nas pontas mas nao no meio', () => {
  const cues = [
    { start: 0, end: 1, text: 'Legenda por www.opensubtitles.org' },
    { start: 2, end: 3, text: 'Dialogo real' },
    { start: 4, end: 5, text: 'Ele foi ate ao subscene do bazar' },
    { start: 6, end: 7, text: 'Mais dialogo' },
    { start: 8, end: 9, text: 'Visita www.exemplo-fansub.com' },
  ];
  const kept = stripPromoCues(cues);

  assert.equal(kept.length, 3);
  assert.equal(kept[0].text, 'Dialogo real');
  assert.equal(kept.at(-1).text, 'Mais dialogo');
});

test('SRT: apanha publicidade em dominios fora dos TLD classicos', () => {
  // Caso real observado num ficheiro do OpenSubtitles: o primeiro padrao so
  // cobria .com/.org/.net/.tv e este anuncio usava .link, por isso passava.
  const cues = [
    { start: 0, end: 1, text: 'Watch Online Movies and\nSeries for FREE www.exemplo.link/lm' },
    { start: 2, end: 3, text: 'Vamos comecar, filho' },
  ];

  assert.deepEqual(stripPromoCues(cues), [cues[1]]);
});

test('SRT: junta e reparte o texto da deixa', () => {
  assert.equal(flattenCueText('uma\nlinha  partida'), 'uma linha partida');
  assert.equal(wrapCueText('curto'), 'curto');
  // Uma deixa curta fica como esta; so se parte quando passa dos 42 caracteres.
  assert.equal(wrapCueText('- Quem vem la? - Sou eu.'), '- Quem vem la? - Sou eu.');
  assert.equal(
    wrapCueText('- Quem vem la a esta hora da noite? - Sou eu, Osman Bey, abre o portao.'),
    '- Quem vem la a esta hora da noite?\n- Sou eu, Osman Bey, abre o portao.',
  );

  const wrapped = wrapCueText('Este texto e suficientemente longo para ter mesmo de ser repartido em duas');
  assert.equal(wrapped.split('\n').length, 2);
  assert.ok(wrapped.split('\n').every((line) => line.length <= 45));
});

test('decode: UTF-8 valido ganha sempre', () => {
  const result = decodeSubtitleBytes(new TextEncoder().encode('acentuacao portuguesa'), { sourceLang: 'pt' });
  assert.equal(result.encoding, 'utf-8');
});

test('decode: bytes turcos caem em windows-1254', () => {
  const bytes = new Uint8Array([0xde, 0x75, 0x20, 0xd0, 0x20, 0xfd]);
  const result = decodeSubtitleBytes(bytes, { sourceLang: 'tr' });

  assert.equal(result.encoding, 'windows-1254');
  assert.equal(result.text.length, 6);
  assert.equal(result.text.charCodeAt(0), 0x015e); // S cedilhado
  assert.equal(result.text.charCodeAt(5), 0x0131); // i sem ponto
});

test('decode: bytes latinos caem em windows-1252', () => {
  const bytes = new Uint8Array([0x61, 0xe7, 0xe3, 0x6f]);
  const result = decodeSubtitleBytes(bytes, { sourceLang: 'pt' });

  assert.equal(result.encoding, 'windows-1252');
  assert.equal(result.text, 'ação');
});

test('decode: a mesma sequencia muda de leitura conforme a lingua', () => {
  const bytes = new Uint8Array([0xd0, 0xfd]);
  const turkish = decodeSubtitleBytes(bytes, { sourceLang: 'tr' }).text;
  const latin = decodeSubtitleBytes(bytes, { sourceLang: 'pt' }).text;

  assert.notEqual(turkish, latin);
});

test('decode: BOM UTF-8 e removido do texto', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
  assert.equal(decodeSubtitleBytes(bytes).text, 'A');
});

test('archive: reconhece assinaturas e deixa passar bytes crus', async () => {
  const plain = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nA\n');

  assert.equal(isGzip(plain), false);
  assert.equal(isZip(plain), false);

  const unpacked = await unpackSubtitle(plain);
  assert.equal(unpacked.bytes.length, plain.length);
});

test('archive: descomprime gzip', async () => {
  const source = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nOla\n');
  const stream = new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());

  assert.equal(isGzip(compressed), true);

  const unpacked = await unpackSubtitle(compressed);
  assert.equal(new TextDecoder().decode(unpacked.bytes), new TextDecoder().decode(source));
});

test('ids: le as formas imdb e tmdb', () => {
  assert.deepEqual(parseVideoId('tt11093718:1:5', 'series'), {
    type: 'series',
    imdbId: 'tt11093718',
    season: 1,
    episode: 5,
    raw: 'tt11093718:1:5',
  });

  assert.equal(parseVideoId('tt11093718', 'movie').season, null);
  assert.equal(parseVideoId('tmdb:90681:2:3', 'tv').tmdbId, '90681');
  assert.equal(parseVideoId('kitsu:123', 'series'), null);
  assert.equal(parseVideoId('', 'series'), null);
});

test('ids: tipo tv e normalizado para series', () => {
  assert.equal(parseVideoId('tt11093718:1:5', 'tv').type, 'series');
});

test('ids: chaves e pistas derivadas', () => {
  assert.equal(imdbNumber('tt0011093718'), '11093718');
  assert.equal(imdbNumber('lixo'), '');
  assert.equal(episodeHint({ season: 1, episode: 5 }), 's01e05');
  assert.equal(episodeHint({ season: null, episode: null }), '');
  assert.equal(videoCacheKey({ imdbId: 'tt1', season: 2, episode: 9 }), 'tt1-s2e9');
});

test('token: assinatura valida, chave errada rejeitada', async () => {
  const payload = { url: 'https://dl.opensubtitles.org/a.gz', lang: 'pt' };
  const token = await signToken(payload, 'segredo');

  assert.deepEqual(await verifyToken(token, 'segredo'), payload);
  assert.equal(await verifyToken(token, 'outro-segredo'), null);
  assert.equal(await verifyToken('lixo', 'segredo'), null);
});

test('token: aceita varias origens e valida-as todas', async () => {
  const payload = {
    urls: ['https://dl.opensubtitles.org/a.gz', 'https://dl.subdl.com/subtitle/b.zip'],
    lang: 'pt',
  };
  const token = await signToken(payload, 'segredo');
  assert.deepEqual(await verifyToken(token, 'segredo'), payload);

  // Basta uma origem fora da lista para o token inteiro cair: senao bastava
  // acompanhar uma origem legitima para arrastar outra qualquer.
  const misto = await signToken(
    { urls: ['https://dl.opensubtitles.org/a.gz', 'https://evil.example/x'], lang: 'pt' },
    'segredo',
  );
  assert.equal(await verifyToken(misto, 'segredo'), null);

  // Sem origem nenhuma tambem nao passa.
  assert.equal(await verifyToken(await signToken({ urls: [], lang: 'pt' }, 'segredo'), 'segredo'), null);
});

test('token: payloadUrls aceita a forma antiga e a nova', () => {
  assert.deepEqual(payloadUrls({ url: 'https://a/1.gz' }), ['https://a/1.gz']);
  assert.deepEqual(payloadUrls({ urls: ['https://a/1.gz', 'https://b/2.zip'] }), [
    'https://a/1.gz',
    'https://b/2.zip',
  ]);
  assert.deepEqual(payloadUrls({}), []);
});

test('token: nao serve de proxy aberto para hosts arbitrarios', async () => {
  assert.equal(isAllowedSource('https://evil.example/x'), false);
  assert.equal(isAllowedSource('file:///etc/passwd'), false);
  assert.equal(isAllowedSource('https://dl.subdl.com/subtitle/1.zip'), true);

  // Mesmo assinado por quem tem a chave, um host de fora nao passa na validacao.
  const token = await signToken({ url: 'https://evil.example/x' }, 'segredo');
  assert.equal(await verifyToken(token, 'segredo'), null);
});

test('translate: os lotes respeitam os limites e preservam todas as linhas', () => {
  const lines = Array.from({ length: 95 }, (_, i) => `Linha ${i}`);
  const batches = buildBatches(lines, 40, 2400);

  assert.deepEqual(batches.map((batch) => batch.length), [40, 40, 15]);
  assert.deepEqual(batches.flat(), lines);

  const longLines = Array.from({ length: 10 }, () => 'x'.repeat(500));
  assert.ok(buildBatches(longLines, 40, 2400).every((batch) => batch.length <= 5));
});

test('translate: escolha de motor respeita a configuracao e o que esta disponivel', () => {
  assert.equal(resolveEngineName({ TRANSLATE_PROVIDER: 'none' }), null);
  assert.equal(resolveEngineName({ TRANSLATE_PROVIDER: 'deepl', DEEPL_API_KEY: 'k' }), 'deepl');
  assert.equal(resolveEngineName({ TRANSLATE_PROVIDER: 'workersai', AI: {} }), 'workersai');
  // Sem binding AI cai para o primeiro motor utilizavel, em vez de rebentar.
  assert.ok(resolveEngineName({ TRANSLATE_PROVIDER: 'workersai' }));
});

test('translate: um motor que falha devolve o original sem desalinhar', async () => {
  const env = { TRANSLATE_PROVIDER: 'libre', LIBRE_URL: 'https://host.invalido.teste/translate' };
  const result = await translateLines(['a', 'b', 'c'], { from: 'en', to: 'pt' }, env);

  assert.deepEqual(result.lines, ['a', 'b', 'c']);
  assert.equal(result.failed, 3);
  assert.equal(result.translated, 0);
});

test('translate: um modelo que salta linhas nao desalinha a legenda', async () => {
  const env = {
    TRANSLATE_PROVIDER: 'workersai',
    MAX_TRANSLATE_CALLS: '10',
    AI: {
      // Devolve so as linhas de indice par, simulando um modelo que junta deixas.
      run: async (model, input) => {
        const lines = input.messages.at(-1).content.split('\n');
        return { response: lines.filter((line, index) => index % 2 === 0).join('\n') };
      },
    },
  };

  const lines = Array.from({ length: 45 }, (_, i) => `Linha ${i}`);
  const result = await translateLines(lines, { from: 'en', to: 'pt' }, env);

  assert.equal(result.lines.length, 45);
  assert.equal(result.engine, 'workersai');
  // A linha que o modelo saltou fica com o texto de origem.
  assert.equal(result.lines[1], 'Linha 1');
});

test('translate: MAX_TRANSLATE_CALLS trava o numero de chamadas', async () => {
  let calls = 0;
  const env = {
    TRANSLATE_PROVIDER: 'workersai',
    MAX_TRANSLATE_CALLS: '2',
    AI: {
      run: async (model, input) => {
        calls += 1;
        const lines = input.messages.at(-1).content.split('\n');
        return { response: lines.map((line, index) => `${index + 1}. PT`).join('\n') };
      },
    },
  };

  const lines = Array.from({ length: 200 }, (_, i) => `Linha ${i}`);
  const result = await translateLines(lines, { from: 'en', to: 'pt' }, env);

  assert.equal(calls, 2);
  assert.equal(result.lines.length, 200);
  assert.ok(result.failed > 0);
});

test('cache: trocar de modelo da uma chave diferente', async () => {
  const payload = { urls: ['https://dl.subdl.com/a.zip'], lang: 'pt', src: 'en', tr: 1 };
  const base = { TRANSLATE_PROVIDER: 'workersai' };

  const antigo = await cacheKey(payload, { ...base, WORKERSAI_MODEL: '@cf/meta/modelo-antigo' });
  const novo = await cacheKey(payload, { ...base, WORKERSAI_MODEL: '@cf/meta/modelo-novo' });

  // Sem isto, trocar de modelo continuava a servir a traducao do anterior.
  assert.notEqual(antigo, novo);
  assert.equal(antigo, await cacheKey(payload, { ...base, WORKERSAI_MODEL: '@cf/meta/modelo-antigo' }));

  // Uma legenda servida tal e qual nao depende de modelo nenhum.
  const crua = { urls: ['https://dl.subdl.com/a.zip'], lang: 'pt', tr: 0 };
  assert.equal(
    await cacheKey(crua, { ...base, WORKERSAI_MODEL: 'a' }),
    await cacheKey(crua, { ...base, WORKERSAI_MODEL: 'b' }),
  );
});

test('cache: uma traducao que falhou por inteiro nao fica guardada', () => {
  // O caso real: o prewarm falhou a traducao toda, guardou o texto ingles e
  // passou a servi-lo durante 30 dias sem hipotese de nova tentativa.
  assert.equal(cacheTtlFor({ tr: 1 }, { translated: 0, failed: 833 }), 0);
  assert.equal(cacheTtlFor({ tr: 1 }, { translated: 0, failed: 0 }), 0);
});

test('cache: uma traducao parcial fica pouco tempo, uma boa fica o normal', () => {
  const parcial = cacheTtlFor({ tr: 1 }, { translated: 120, failed: 713 });
  assert.ok(parcial > 0 && parcial <= 6 * 3600);

  assert.equal(cacheTtlFor({ tr: 1 }, { translated: 830, failed: 3 }), null);
  // Sem traducao pedida nao ha nada que possa ter corrido mal.
  assert.equal(cacheTtlFor({ tr: 0 }, { translated: 0, failed: 0 }), null);
});

test('catalogos: o skip vem do caminho ou da query', () => {
  assert.equal(parseSkip('skip=40', null), 40);
  assert.equal(parseSkip('genre=Drama&skip=100', null), 100);
  assert.equal(parseSkip('', new URL('https://x/y.json?skip=20')), 20);
  assert.equal(parseSkip(undefined, new URL('https://x/y.json')), 0);
  assert.equal(parseSkip('lixo', null), 0);
});

test('catalogos: o meta prefere o id IMDb e cai para tmdb quando nao ha', () => {
  const show = {
    id: 95603,
    name: 'Kurulus Osman',
    poster_path: '/p.jpg',
    first_air_date: '2019-11-20',
    vote_average: 7.4,
    vote_count: 500,
    genre_ids: [18, 10759],
  };

  // Id IMDb: as fichas abrem com o Cinemeta e as legendas reconhecem-nas.
  const comImdb = toMeta(show, 'tt11093718', { 18: 'Drama', 10759: 'Accao' });
  assert.equal(comImdb.id, 'tt11093718');
  assert.equal(comImdb.releaseInfo, '2019');
  assert.equal(comImdb.imdbRating, '7.4');
  assert.deepEqual(comImdb.genres, ['Drama', 'Accao']);
  assert.ok(comImdb.poster.endsWith('/w500/p.jpg'));

  // Uma nota assente em meia duzia de votos e omitida em vez de mostrada.
  const poucosVotos = toMeta({ ...show, vote_average: 10, vote_count: 3 }, 'tt1', {});
  assert.ok(!('imdbRating' in poucosVotos));

  const semImdb = toMeta(show, '', {});
  assert.equal(semImdb.id, 'tmdb:95603');
  // Campos sem valor sao omitidos, em vez de irem como undefined.
  assert.ok(!('genres' in semImdb));
  assert.ok(!('description' in semImdb));
  assert.ok(!('background' in semImdb));
});

test('catalogos: sem chave TMDB nao ha catalogos no manifesto', () => {
  const semChave = buildManifest({ PREFERRED_PT: 'pt' });
  assert.deepEqual(semChave.catalogs, []);
  // Uma coleccao sempre vazia no ecra inicial e pior do que coleccao nenhuma.
  assert.ok(!semChave.resources.some((r) => r.name === 'catalog'));
  assert.ok(semChave.resources.some((r) => r.name === 'subtitles'));

  const comChave = buildManifest({ PREFERRED_PT: 'pt', TMDB_API_KEY: 'k' });
  assert.equal(comChave.catalogs.length, 2);
  assert.deepEqual(comChave.catalogs.map((c) => c.id), ['turcas-em-alta', 'turcas-populares']);
  assert.ok(comChave.catalogs.every((c) => c.type === 'series'));
  assert.ok(comChave.resources.some((r) => r.name === 'catalog'));
});

test('catalogos: sem chave TMDB o catalogo responde vazio em vez de rebentar', async () => {
  const resultado = await buildCatalog('turcas-em-alta', 0, {});
  assert.deepEqual(resultado.metas, []);
  assert.match(resultado.error, /TMDB_API_KEY/);
});

test('anime: sem chave TMDB a duvida resolve-se a favor de traduzir', async () => {
  assert.equal(await isAnime({ imdbId: 'tt0388629' }, {}), false);
  assert.equal(await isAnime(null, { TMDB_API_KEY: 'k' }), false);
  assert.equal(await isAnime({ imdbId: '' }, { TMDB_API_KEY: 'k' }), false);
});

test('anime: a resposta guardada e reutilizada sem tocar na rede', async () => {
  const store = new Map([
    ['anime:v1:tt0388629', '1'],
    ['anime:v1:tt11093718', '0'],
  ]);
  const env = {
    TMDB_API_KEY: 'k',
    SUBS: {
      get: async (key) => (store.has(key) ? store.get(key) : null),
      put: async () => {
        throw new Error('nao devia escrever: o valor ja estava em cache');
      },
    },
  };

  assert.equal(await isAnime({ imdbId: 'tt0388629' }, env), true);
  assert.equal(await isAnime({ imdbId: 'tt11093718' }, env), false);
});

test('providers: o nome do ficheiro que bate certo com o episodio manda', () => {
  const video = { type: 'series', season: 1, episode: 5 };
  const generic = {
    fileName: 'pack.srt',
    release: '',
    downloads: 5000,
    rating: 0,
    format: 'srt',
    hearingImpaired: false,
  };
  const exact = {
    fileName: 'Serie.S01E05.WEB.srt',
    release: '',
    downloads: 10,
    rating: 0,
    format: 'srt',
    hearingImpaired: false,
  };

  assert.ok(scoreCandidate(exact, video) > scoreCandidate(generic, video));
  assert.equal(rankCandidates([generic, exact], video)[0], exact);
});
