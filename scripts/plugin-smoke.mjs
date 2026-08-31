/**
 * Ponta-a-ponta do plugin do NuvioTV, sem NuvioTV.
 *
 * Corre o codigo tal como o aparelho o corre — o ficheiro servido pelo Worker,
 * embrulhado num IIFE com `module.exports` e um `fetch` global — e depois
 * verifica o que saiu: descarrega o manifesto e pede o primeiro segmento.
 *
 * E' o mais perto que se chega de testar isto sem uma televisao a' frente.
 */
const ORIGIN = process.env.SMOKE_ORIGIN || 'https://nuvio-subs-pt.mitsukuri.workers.dev';

// `--local` corre o `plugin/turcas-pt.js` desta arvore em vez do que esta'
// publicado. Sem isto uma alteracao ao plugin so se consegue testar depois de
// a publicar, que e' exactamente a ordem errada.
const local = process.argv.includes('--local');
const code = local
  ? (await import('node:fs')).readFileSync(
      new URL('../plugin/turcas-pt.js', import.meta.url),
      'utf8',
    ).replace('__WORKER_ORIGIN__', ORIGIN)
  : await (await fetch(ORIGIN + '/plugin/turcas-pt.js')).text();

console.log(local ? `fonte: plugin/turcas-pt.js (local), Worker em ${ORIGIN}` : `fonte: ${ORIGIN}/plugin/turcas-pt.js (publicado)`);
const module_ = { exports: {} };
const wrapped = new Function('module', 'exports', 'console', 'fetch', code);
wrapped(module_, module_.exports, console, fetch);

const cases = [
  ['Muhtemel Ask S01E01 (tmdb 322499)', '322499', 'tv', 1, 1],
  ['Kurulus Osman S02E01 (tmdb 95603)', '95603', 'tv', 2, 1],
  ['Breaking Bad S01E01 (tmdb 1396)', '1396', 'tv', 1, 1],
];

for (const [label, id, type, season, episode] of cases) {
  const started = Date.now();
  const streams = await module_.exports.getStreams(id, type, season, episode);
  console.log(`\n### ${label} -> ${streams.length} streams (${Date.now() - started}ms)`);
  for (const s of streams) console.log(`    [${s.quality}] ${s.title}\n        ${s.url.slice(0, 78)}...`);

  // O que interessa no ficheiro unico nao e' tocar, e' saltar: pede-se um
  // intervalo la' para o fim. As faixas adaptativas devolvem `403` a partir dos
  // ~5,8 MB, e foi esse o defeito que se andou meses a perseguir.
  const single = streams.find((s) => !s.url.includes('/dash/'));
  if (single) {
    const head = await fetch(single.url, { headers: { ...(single.headers || {}), Range: 'bytes=0-1' } });
    const total = Number((head.headers.get('content-range') || '').split('/')[1] || 0);
    await head.arrayBuffer();
    const marks = [0.25, 0.5, 0.95];
    const out = [];
    for (const pct of marks) {
      const off = Math.floor(total * pct);
      const r = await fetch(single.url, { headers: { ...(single.headers || {}), Range: `bytes=${off}-${off + 200000}` } });
      await r.arrayBuffer();
      out.push(`${Math.round(pct * 100)}%:${r.status}`);
    }
    const ok = out.every((m) => m.endsWith(':206'));
    console.log(`    ficheiro unico: ${(total / 1048576).toFixed(0)} MB, saltos ${out.join(' ')} ${ok ? 'OK' : 'FALHOU'}`);
    if (!ok) process.exitCode = 1;
  }

  const dash = streams.find((s) => s.url.includes('/dash/'));
  if (!dash) continue;

  const mpd = await (await fetch(dash.url)).text();
  const reps = [...mpd.matchAll(/<Representation id="(\d+)"[^>]*?(?:height="(\d+)")?[^>]*bandwidth="(\d+)"/g)];
  console.log(`    manifesto: ${mpd.length} bytes, ${reps.length} representations`);
  console.log('    itags:', reps.map((r) => r[1] + (r[2] ? `/${r[2]}p` : '')).join(' '));

  const base = mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/)[1].replace(/&amp;/g, '&');
  const seg = await fetch(base, { headers: { Range: 'bytes=0-2047' } });
  console.log(`    segmento: HTTP ${seg.status} ${seg.headers.get('content-type')} bytes=${(await seg.arrayBuffer()).byteLength}`);
}
