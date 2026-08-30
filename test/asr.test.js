import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSidx, chunkFragments, parseRange } from '../src/youtube/sidx.js';
import { blockOffsets } from '../src/asr/audio.js';
import { asrKey, asrStateKey, isEnabled, readTranscript, runPass } from '../src/asr/index.js';
import { loadCues } from '../src/subtitles.js';

/** Um KV de mentira, com o mesmo contrato do binding da Cloudflare. */
function fakeKv(inicial = {}) {
  const store = new Map(Object.entries(inicial));
  return {
    store,
    get: async (key, type) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
}

test('asr: as chaves distinguem episodio de filme e o trabalho do resultado', () => {
  const episodio = { imdbId: 'tt43351313', season: 1, episode: 1 };
  assert.equal(asrKey(episodio), 'asr:v1:tt43351313:1:1');
  assert.equal(asrStateKey(episodio), 'asr:v1:tt43351313:1:1:state');

  // Um filme nao tem sufixo de episodio.
  assert.equal(asrKey({ imdbId: 'tt0120791' }), 'asr:v1:tt0120791');
});

test('asr: so liga com o interruptor e com Workers AI', () => {
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled({ ASR: '1' }), false);
  assert.equal(isEnabled({ AI: {} }), false);
  assert.equal(isEnabled({ ASR: '1', AI: {} }), true);
});

test('asr: os blocos agrupam fragmentos e os deslocamentos somam', () => {
  const fragmentos = Array.from({ length: 10 }, (_, i) => ({
    start: i * 1000,
    end: i * 1000 + 999,
    seconds: 10,
  }));

  const blocos = chunkFragments(fragmentos, 30);
  // 10 fragmentos de 10s em blocos de 30s: 4 blocos (3+3+3+1).
  assert.equal(blocos.length, 4);
  assert.equal(blocos[0].fragments, 3);
  assert.equal(blocos[0].from, 0);
  assert.equal(blocos[0].to, 2999);

  // Cada bloco comeca onde o anterior acabou, em tempo.
  assert.deepEqual(blockOffsets(blocos), [0, 30, 60, 90]);
});

test('asr: o `403` intermitente nao e confundido com fim do bloco', () => {
  // parseRange e' a porta de entrada dos cortes; um intervalo mal formado tem
  // de dar null em vez de NaN, senao pedia-se `bytes=NaN-NaN`.
  assert.deepEqual(parseRange({ start: '723', end: '10774' }), { start: 723, end: 10774 });
  assert.equal(parseRange(null), null);
  assert.equal(parseRange({ start: 'x', end: '1' }), null);
});

test('asr: sem caixa sidx o erro e explicito, nao um rebentar', () => {
  const lixo = new Uint8Array(64).buffer;
  const resultado = parseSidx(lixo, 0);
  assert.match(resultado.error, /sidx/);
});

test('asr: uma transcricao ja pronta e reutilizada sem tocar no YouTube', async () => {
  const video = { imdbId: 'tt43351313', season: 1, episode: 1 };
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nMerhaba\n';
  const env = { ASR: '1', AI: {}, SUBS: fakeKv({ 'asr:v1:tt43351313:1:1': srt }) };

  assert.equal(await readTranscript(video, env), srt);

  // `runPass` sai logo, sem rede: o trabalho ja esta feito.
  const resultado = await runPass(video, 'QvZHtdpkybc', env);
  assert.deepEqual(resultado, { done: true, jaEstava: true });
});

test('asr: a legenda transcrita e lida do KV, e nao descarregada', async () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nMerhaba dunya\n';
  const env = { SUBS: fakeKv({ 'asr:v1:tt1:1:1': srt }) };

  const { cues, encoding } = await loadCues({ asr: 'asr:v1:tt1:1:1', urls: [] }, env);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Merhaba dunya');
  // Uma transcricao ja sai em UTF-8; nao ha windows-1254 para adivinhar.
  assert.equal(encoding, 'utf-8');
});

test('asr: uma transcricao que ainda nao existe da erro claro, nao vazio', async () => {
  const env = { SUBS: fakeKv() };
  await assert.rejects(
    () => loadCues({ asr: 'asr:v1:tt1:1:1', urls: [] }, env),
    /ainda nao esta pronta/,
  );
});

test('asr: sem KV nao se comeca um trabalho que nao se pode guardar', async () => {
  const resultado = await runPass({ imdbId: 'tt1', season: 1, episode: 1 }, 'x', { ASR: '1', AI: {} });
  assert.match(resultado.error, /KV/);
});

test('asr: desligado nao corre, mesmo com KV e AI', async () => {
  const env = { AI: {}, SUBS: fakeKv() };
  const resultado = await runPass({ imdbId: 'tt1', season: 1, episode: 1 }, 'x', env);
  assert.match(resultado.error, /desligado/);
});
