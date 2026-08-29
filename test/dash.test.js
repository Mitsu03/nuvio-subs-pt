import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMpd, isGoogleVideoUrl, readMpd } from '../src/dash.js';
import { buildPluginManifest, buildPluginSource } from '../src/plugin/index.js';

const GV = 'https://rr8---sn-2vgu0b5a.googlevideo.com/videoplayback?expire=1&sig=a&x=1';

const VIDEO = {
  itag: 137,
  url: GV,
  codecs: 'avc1.640028',
  width: 1920,
  height: 1080,
  fps: 25,
  bitrate: 4356890,
  initRange: { start: '0', end: '741' },
  indexRange: { start: '742', end: '20297' },
};

const AUDIO = {
  itag: 140,
  url: GV,
  codecs: 'mp4a.40.2',
  bitrate: 138272,
  audioSampleRate: 44100,
  channels: 2,
  initRange: { start: '0', end: '722' },
  indexRange: { start: '723', end: '10774' },
};

test('dash: so aceita enderecos do googlevideo', () => {
  assert.equal(isGoogleVideoUrl(GV), true);
  // Sem isto o Worker publicava, no proprio dominio, um documento a apontar
  // para onde quem chamasse quisesse.
  assert.equal(isGoogleVideoUrl('https://exemplo.pt/a.mp4'), false);
  assert.equal(isGoogleVideoUrl('http://rr8.googlevideo.com/x'), false);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com.mau.pt/x'), false);
  assert.equal(isGoogleVideoUrl(''), false);
});

test('dash: escreve o manifesto com os intervalos e escapa o XML', () => {
  const mpd = buildMpd({ durationSeconds: 8331, video: [VIDEO], audio: [AUDIO] });

  assert.match(mpd, /mediaPresentationDuration="PT8331\.0S"/);
  assert.match(mpd, /<Representation id="137" codecs="avc1\.640028" width="1920" height="1080"/);
  assert.match(mpd, /<SegmentBase indexRange="742-20297">/);
  assert.match(mpd, /<Initialization range="0-741"\/>/);
  assert.match(mpd, /audioSamplingRate="44100"/);
  assert.match(mpd, /AudioChannelConfiguration[^>]*value="2"/);
  // Um `&` cru no BaseURL da um manifesto que nao abre de todo.
  assert.ok(mpd.includes('expire=1&amp;sig=a'));
  // Nenhum `&` pode ficar por escapar: basta um para o manifesto nao abrir.
  assert.equal(mpd.replace(/&amp;/g, '').includes('&'), false);
});

test('dash: sem audio nao ha manifesto', () => {
  // Um manifesto so com video abre e fica mudo, que e pior do que falhar.
  assert.equal(buildMpd({ durationSeconds: 100, video: [VIDEO], audio: [] }), null);
  assert.equal(buildMpd({ durationSeconds: 100, video: [], audio: [AUDIO] }), null);
  assert.equal(buildMpd(null), null);
});

test('dash: descarta formatos sem os intervalos ou com endereco de fora', () => {
  const semIndice = { ...VIDEO, indexRange: null };
  const deFora = { ...VIDEO, url: 'https://exemplo.pt/v.mp4' };

  assert.equal(buildMpd({ durationSeconds: 10, video: [semIndice], audio: [AUDIO] }), null);
  assert.equal(buildMpd({ durationSeconds: 10, video: [deFora], audio: [AUDIO] }), null);
});

test('dash: mp4 e webm ficam em conjuntos separados', () => {
  const vp9 = { ...VIDEO, itag: 248, codecs: 'vp9' };
  const mpd = buildMpd({ durationSeconds: 10, video: [VIDEO, vp9], audio: [AUDIO] });

  assert.ok(mpd.includes('<AdaptationSet mimeType="video/mp4"'));
  assert.ok(mpd.includes('<AdaptationSet mimeType="video/webm"'));
});

test('dash: a maior resolucao vem primeiro', () => {
  const baixo = { ...VIDEO, itag: 136, height: 720, width: 1280 };
  const mpd = buildMpd({ durationSeconds: 10, video: [baixo, VIDEO], audio: [AUDIO] });

  assert.ok(mpd.indexOf('id="137"') < mpd.indexOf('id="136"'));
});

test('dash: um id malformado nem chega a tocar na cache', async () => {
  let touched = false;
  const env = { SUBS: { get: async () => { touched = true; return 'x'; } } };

  assert.equal(await readMpd('../etc/passwd', env), null);
  assert.equal(await readMpd('ZZZ', env), null);
  assert.equal(touched, false);
});

test('plugin: o manifesto aponta para o ficheiro ao lado', () => {
  const manifest = buildPluginManifest();
  const scraper = manifest.scrapers[0];

  assert.equal(scraper.filename, 'turcas-pt.js');
  assert.deepEqual(scraper.supportedTypes, ['movie', 'tv']);
  assert.match(manifest.version, /^1\.0\.\d+$/);
});

test('plugin: a origem do Worker e injectada e nao sobra marcador', () => {
  const code = buildPluginSource('https://exemplo.workers.dev');

  assert.ok(code.includes("var WORKER_ORIGIN = 'https://exemplo.workers.dev'"));
  assert.ok(!code.includes('__WORKER_ORIGIN__'));
  // Sem isto o Nuvio carrega o codigo e nao encontra a funcao.
  assert.ok(code.includes('module.exports = { getStreams: getStreams }'));
});

test('dash: o mesmo itag nao entra duas vezes', () => {
  // O YouTube devolve cada itag a dobrar (a faixa e a variante com volume
  // normalizado). Dois ids iguais fazem um manifesto invalido.
  const gemeo = { ...AUDIO, bitrate: 138260 };
  const mpd = buildMpd({ durationSeconds: 10, video: [VIDEO], audio: [AUDIO, gemeo] });

  assert.equal((mpd.match(/id="140"/g) || []).length, 1);
  assert.match(mpd, /bandwidth="138272"/);
});
