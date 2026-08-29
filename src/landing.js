/** Pagina simples com o URL de instalacao e o estado da configuracao. */

import { buildManifest } from './manifest.js';
import { resolveEngineName } from './translate/index.js';

export function renderLandingPage(origin, env) {
  const manifest = buildManifest(env);
  const manifestUrl = `${origin}/manifest.json`;
  const engine = resolveEngineName(env) || 'desligado';

  const checks = [
    ['Chave de assinatura', Boolean(env.SIGNING_KEY)],
    ['Cache KV', Boolean(env.SUBS)],
    ['Fonte SubDL', Boolean(env.SUBDL_API_KEY)],
    ['Resolucao de ids TMDB', Boolean(env.TMDB_API_KEY)],
    ['Streams turcos (YouTube oficial)', Boolean(env.TMDB_API_KEY) && env.STREAMS !== '0'],
  ]
    .map(([label, ok]) => `<li>${ok ? 'ok' : 'em falta'} &mdash; ${label}</li>`)
    .join('');

  // Sem o SubDL nao ha nenhuma fonte que sirva ficheiros a partir daqui: o
  // OpenSubtitles deixa procurar mas recusa a descarga a IPs de datacentro.
  // Vale mais dize-lo em cima do que deixar o utilizador descobrir com um erro.
  const blocked = env.SUBDL_API_KEY
    ? ''
    : `<p class="aviso"><strong>Falta a chave do SubDL.</strong> A correr na Cloudflare,
       o <code>dl.opensubtitles.org</code> responde <code>401</code> a descarga (a busca
       funciona, o ficheiro nao), por isso sem <code>SUBDL_API_KEY</code> as legendas
       aparecem na lista mas nao chegam a abrir. A chave e gratuita em
       <code>subdl.com</code>; depois corre
       <code>npx wrangler secret put SUBDL_API_KEY</code>.</p>`;

  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${manifest.name}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.6; }
  code { background: rgba(127,127,127,.18); padding: .15rem .4rem; border-radius: .3rem; word-break: break-all; }
  ul { padding-left: 1.2rem; }
  .hint { opacity: .75; font-size: .92rem; }
  .aviso { border-left: .25rem solid #d08700; padding: .5rem 0 .5rem .9rem; background: rgba(208,135,0,.1); }
</style>
</head>
<body>
<h1>${manifest.name}</h1>
<p>${manifest.description}</p>
${blocked}
<h2>Instalar</h2>
<p>Sao dois enderecos e dois sitios diferentes. Trocar os dois da o erro
<code>manifest missing id</code>: o parser de addons exige um campo <code>id</code>
que o formato de plugins nao tem.</p>

<h3>1. Addon &mdash; legendas e coleccoes</h3>
<p>Definicoes &rarr; <strong>Addons</strong> &rarr; Adicionar addon:</p>
<p><code>${manifestUrl}</code></p>

<h3>2. Plugin &mdash; video turco na TV</h3>
<p>So no NuvioTV. Definicoes &rarr; <strong>Plugins</strong> (&laquo;Manage local
scrapers and providers&raquo;) &rarr; <strong>Add repository</strong>:</p>
<p><code>${origin}/plugin/manifest.json</code></p>
<p class="hint">Confirma que <em>Enable plugin providers globally</em> esta ligado,
ou o Nuvio instala o plugin e nunca o chama.</p>

<h2>Estado</h2>
<ul>${checks}</ul>
<p class="hint">Motor de traducao activo: <code>${engine}</code>. Lingua preferida: <code>${env.PREFERRED_PT === 'pt-BR' ? 'pt-BR' : 'pt'}</code>.</p>

<h2>Diagnostico</h2>
<p class="hint">
  <a href="/health">/health</a> mostra a configuracao em JSON.<br>
  <code>${origin}/subtitles/series/tt11093718:1:1.json</code> lista o que existe para o primeiro episodio do Kurulus Osman.<br>
  <code>${origin}/stream/series/tt11093718:1:1.json</code> mostra o mesmo episodio no canal oficial.
</p>
</body>
</html>`;
}
