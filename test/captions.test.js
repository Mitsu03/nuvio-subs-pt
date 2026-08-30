import test from 'node:test';
import assert from 'node:assert/strict';

import { pickTrack, json3ToCues, tidyCues } from '../src/providers/youtube.js';
import { captionsKey, isEnabled, ensureCaptions } from '../src/captions.js';

function fakeKv(inicial = {}) {
  const store = new Map(Object.entries(inicial));
  return {
    store,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
}

test('captions: a faixa escrita por gente ganha a` automatica', () => {
  const faixas = [
    { languageCode: 'tr', kind: 'asr', baseUrl: 'a' },
    { languageCode: 'tr', baseUrl: 'b' },
    { languageCode: 'en', baseUrl: 'c' },
  ];
  // Sem `kind` e' legenda humana; `asr` e' a gerada pela maquina.
  assert.equal(pickTrack(faixas, 'tr').baseUrl, 'b');

  // So havendo automatica, serve a automatica.
  assert.equal(pickTrack([faixas[0]], 'tr').baseUrl, 'a');
  assert.equal(pickTrack(faixas, 'pt'), null);
  assert.equal(pickTrack([], 'tr'), null);
});

test('captions: o json3 do YouTube vira deixas com tempos', () => {
  const cues = json3ToCues({
    events: [
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Merhaba' }, { utf8: ' dunya' }] },
      { tStartMs: 2000, segs: [{ utf8: '  Nasilsin?  ' }] },
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
      { tStartMs: 9000 },
    ],
  });

  assert.equal(cues.length, 2);
  // Os segmentos de uma deixa juntam-se num texto so.
  assert.deepEqual(cues[0], { start: 0, end: 1500, text: 'Merhaba dunya' });
  // Sem duracao declarada da'-se dois segundos, senao a deixa nao aparece.
  assert.deepEqual(cues[1], { start: 2000, end: 4000, text: 'Nasilsin?' });
});

test('captions: as chaves separam episodio de filme', () => {
  assert.equal(captionsKey({ imdbId: 'tt1', season: 2, episode: 5 }), 'yt:v1:tt1:2:5');
  assert.equal(captionsKey({ imdbId: 'tt1' }), 'yt:v1:tt1');
});

test('captions: liga por omissao e desliga com o interruptor', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ YOUTUBE_CAPTIONS: '0' }), false);
});

test('captions: o que ja esta guardado nao volta a pedir ao YouTube', async () => {
  const env = { SUBS: fakeKv({ 'yt:v1:tt1:1:1': '1\n00:00:01,000 --> 00:00:02,000\nOla\n' }) };
  let pediu = false;

  const resultado = await ensureCaptions({ imdbId: 'tt1', season: 1, episode: 1 }, env, async () => {
    pediu = true;
    return 'abc';
  });

  assert.deepEqual(resultado, { chave: 'yt:v1:tt1:1:1', kind: 'guardado' });
  // Nem sequer se resolve qual e' o video: o texto ja esta em casa.
  assert.equal(pediu, false);
});

test('captions: uma busca falhada fica marcada e nao se repete', async () => {
  const env = { SUBS: fakeKv({ 'yt:v1:tt1:1:1:miss': 'sem-faixa' }) };
  let pediu = false;

  const resultado = await ensureCaptions({ imdbId: 'tt1', season: 1, episode: 1 }, env, async () => {
    pediu = true;
    return 'abc';
  });

  assert.equal(resultado, null);
  assert.equal(pediu, false);
});

test('captions: sem video oficial nao se inventa uma legenda', async () => {
  const env = { SUBS: fakeKv() };
  const resultado = await ensureCaptions({ imdbId: 'tt1', season: 1, episode: 1 }, env, async () => '');
  assert.equal(resultado, null);
});

test('captions: sem KV nao corre, para nao pedir ao YouTube a cada visita', async () => {
  const resultado = await ensureCaptions({ imdbId: 'tt1' }, {}, async () => 'abc');
  assert.equal(resultado, null);
});

test('captions: uma recusa do YouTube nao e confundida com falta de legendas', async () => {
  const { fetchYoutubeCaptions } = await import('../src/providers/youtube.js');
  // Sem rede, o `watchConfig` falha — que e' o caso «o YouTube recusou».
  const resultado = await fetchYoutubeCaptions('naoexiste11', {});
  assert.equal(resultado.motivo, 'recusado');
  // O que importa e' nao devolver `null` nem `sem-faixa`: um bloqueio
  // passageiro marcado como definitivo perdia episodios que tinham legendas.
  assert.notEqual(resultado.motivo, 'sem-faixa');
});

test('captions: as deixas sobrepostas do ASR sao encadeadas', () => {
  // Como o YouTube emite de facto: janelas que se sobrepoem no tempo.
  const cruas = [
    { start: 560, end: 5160, text: 'Kesinlikle' },
    { start: 2879, end: 8440, text: 'karistirmam' },
    { start: 5160, end: 8440, text: 'olmasi lazim' },
  ];
  const arrumadas = tidyCues(cruas, 0, 110, 7000);

  // Nenhuma deixa comeca antes de a anterior acabar.
  for (let i = 1; i < arrumadas.length; i += 1) {
    assert.ok(arrumadas[i].start >= arrumadas[i - 1].end, 'deixas sobrepostas');
  }
});

test('captions: o texto escrito aos pedacos nao se repete', () => {
  // O ASR escreve a frase por partes: cada deixa e' o prefixo da seguinte.
  const cruas = [
    { start: 0, end: 1000, text: 'Merhaba' },
    { start: 1000, end: 2000, text: 'Merhaba dunya' },
    { start: 2000, end: 3000, text: 'Nasilsin' },
  ];
  const arrumadas = tidyCues(cruas, 0, 110, 7000);
  assert.deepEqual(arrumadas.map((c) => c.text), ['Merhaba dunya', 'Nasilsin']);
});

test('captions: nenhuma deixa fica mais do que o tecto no ecra', () => {
  const cruas = Array.from({ length: 20 }, (_, i) => ({
    start: i * 1000, end: i * 1000 + 900, text: `f${i}`,
  }));
  const arrumadas = tidyCues(cruas, 3500, 110, 7000);
  // Sem tecto, juntar produzia deixas de dezenas de segundos.
  for (const cue of arrumadas) assert.ok(cue.end - cue.start <= 7000, `${cue.end - cue.start}ms`);
});

test('captions: a legenda escrita por gente nao e mexida', () => {
  // `tidyCues` so corre no ASR; aqui garante-se que nao estraga tempos bons.
  const humanas = [
    { start: 0, end: 3000, text: '(Jenerik muzigi.)' },
    { start: 3500, end: 6000, text: 'Bey!' },
  ];
  assert.deepEqual(tidyCues(humanas, 0, 110, 7000), humanas);
});
