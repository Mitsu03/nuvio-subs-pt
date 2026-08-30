/** Pagina simples com os enderecos de instalacao e o estado da configuracao. */

import { buildSubsManifest, buildTurcasManifest, TURCAS_BASE } from './manifest.js';
import { resolveEngineName } from './translate/index.js';

export function renderLandingPage(origin, env) {
  const subs = buildSubsManifest(env);
  const turcas = buildTurcasManifest(env);
  const engine = resolveEngineName(env) || 'desligado';

  const checks = [
    ['Chave de assinatura', Boolean(env.SIGNING_KEY)],
    ['Cache KV', Boolean(env.SUBS)],
    ['Fonte SubDL', Boolean(env.SUBDL_API_KEY)],
    ['Resolucao de ids TMDB', Boolean(env.TMDB_API_KEY)],
    ['Coleccoes turcas', turcas.catalogs.length > 0],
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
<title>Turcas PT &amp; Legendas PT</title>
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
<h1>Legendas PT &amp; Turcas PT</h1>
<p>Dois addons independentes servidos do mesmo sitio. Instala so o que queres:
as legendas servem o catalogo inteiro, as coleccoes so servem series turcas.</p>
${blocked}

<h2>Instalar</h2>
<p>Sao tres enderecos e dois sitios diferentes nas definicoes. Meter um endereco
de addon no ecra dos plugins da o erro <code>manifest missing id</code>: o parser
de addons exige um campo <code>id</code> que o formato de plugins nao tem.</p>

<h3>1. Legendas PT &mdash; legendas para tudo</h3>
<p>${subs.description}</p>
<p>Definicoes &rarr; <strong>Addons</strong> &rarr; Adicionar addon:</p>
<p><code>${origin}/manifest.json</code></p>

<h3>2. Turcas PT &mdash; coleccoes de series turcas</h3>
<p>${turcas.description}</p>
<p>Definicoes &rarr; <strong>Addons</strong> &rarr; Adicionar addon:</p>
<p><code>${origin}${TURCAS_BASE}/manifest.json</code></p>
<p class="hint">Endereco diferente e <em>id</em> diferente
(<code>${turcas.id}</code>), por isso os dois convivem sem se substituirem.</p>

<h3>3. Plugin &mdash; video turco na TV</h3>
<p>So no NuvioTV, e so faz sentido com o addon 2. Definicoes &rarr;
<strong>Plugins</strong> (&laquo;Manage local scrapers and providers&raquo;) &rarr;
<strong>Add repository</strong>:</p>
<p><code>${origin}/plugin/manifest.json</code></p>
<p class="hint">Confirma que <em>Enable plugin providers globally</em> esta ligado,
ou o Nuvio instala o plugin e nunca o chama.</p>

<h2>Ja tinhas a versao antiga?</h2>
<p>Ate a versao 1.x isto era um addon so, com as legendas e as coleccoes juntas.
Quem o tem instalado fica com <strong>as legendas</strong> e deixa de ver as
coleccoes turcas: para as ter de volta, acrescenta o endereco 2 a mao. Nao ha
maneira de o fazer automaticamente &mdash; o Nuvio guarda os addons por
<code>id</code> de manifesto, e o addon turco tem agora um id proprio.</p>

<h2>Estado</h2>
<ul>${checks}</ul>
<p class="hint">Motor de traducao activo: <code>${engine}</code>. Lingua preferida: <code>${env.PREFERRED_PT === 'pt-BR' ? 'pt-BR' : 'pt'}</code>.</p>

<h2>Diagnostico</h2>
<p class="hint">
  <a href="/health">/health</a> mostra a configuracao em JSON.<br>
  <code>${origin}/subtitles/series/tt11093718:1:1.json</code> lista o que existe para o primeiro episodio do Kurulus Osman.<br>
  <code>${origin}${TURCAS_BASE}/stream/series/tt11093718:1:1.json</code> mostra o mesmo episodio no canal oficial.<br>
  <code>${origin}${TURCAS_BASE}/catalog/series/turcas-em-alta.json</code> mostra a coleccao Em Alta.
</p>
</body>
</html>`;
}
