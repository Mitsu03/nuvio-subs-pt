/**
 * Corre o Worker em Node, com KV e Workers AI simulados, contra as fontes reais.
 * Valida o caminho completo: procura -> token -> descarga -> descompressao ->
 * codificacao -> SRT final.
 *
 *   node scripts/smoke.mjs [tt11093718:1:1]
 */

import worker from '../src/index.js';

const videoId = process.argv[2] || 'tt11093718:1:1';
const ORIGIN = 'https://smoke.local';

const store = new Map();
const kv = {
  get: async (key) => store.get(key) ?? null,
  put: async (key, value) => void store.set(key, value),
};

// Tradutor simulado: marca cada deixa para se ver que passou pelo caminho certo.
const ai = {
  run: async (model, input) => {
    const lines = input.messages.at(-1).content.split('\n');
    return { response: lines.map((line) => line.replace(/^(\s*\d+\.\s*)/, '$1[PT] ')).join('\n') };
  },
};

const env = {
  SIGNING_KEY: 'chave-de-teste',
  SUBS: kv,
  AI: ai,
  PREFERRED_PT: 'pt',
  TRANSLATE_PROVIDER: 'workersai',
  TRANSLATE_FROM: 'en,tr',
  MAX_TRANSLATE_CALLS: '3',
  PREWARM: '0',
};

const ctx = { waitUntil: () => {} };
const call = (path) => worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section('manifest');
const manifest = await (await call('/manifest.json')).json();
console.log(manifest.name, manifest.version, JSON.stringify(manifest.resources));

section('health');
console.log(JSON.stringify(await (await call('/health')).json()));

section(`lista de legendas para ${videoId}`);
const listResponse = await call(`/subtitles/series/${encodeURIComponent(videoId)}.json`);
const list = await listResponse.json();
console.log(`${list.subtitles.length} entradas`);
for (const entry of list.subtitles) {
  console.log(` - [${entry.lang}] ${entry.name}`);
}

if (list.subtitles.length === 0) {
  console.log('\nSem legendas para este episodio; nada mais a testar.');
  process.exit(0);
}

section('descarga da primeira entrada');
const first = list.subtitles[0];
const path = new URL(first.url).pathname;
const fileResponse = await call(path);

console.log('HTTP', fileResponse.status);
console.log('motor:', fileResponse.headers.get('x-translate-engine'));
console.log('traduzidas:', fileResponse.headers.get('x-translate-stats'));
console.log('cache:', fileResponse.headers.get('x-cache'));

const srt = await fileResponse.text();
const cueCount = (srt.match(/-->/g) || []).length;
console.log(`deixas: ${cueCount}, bytes: ${srt.length}`);
console.log('--- inicio do ficheiro ---');
console.log(srt.split('\n').slice(0, 9).join('\n'));

section('segunda descarga (deve vir da cache)');
const cached = await call(path);
console.log('cache:', cached.headers.get('x-cache'), '| iguais:', (await cached.text()) === srt);

section('token adulterado');
const tampered = await call(`${path.slice(0, -4).slice(0, -3)}aaa.srt`);
console.log('HTTP', tampered.status, '->', (await tampered.text()).slice(0, 40));
