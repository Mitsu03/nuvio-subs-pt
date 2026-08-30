/**
 * Os dois manifestos que este Worker serve, no formato que o Nuvio le em
 * AddonManifestParser.
 *
 * Sao dois addons e nao um: as legendas servem o catalogo inteiro, as
 * coleccoes so servem series turcas. Juntos, quem queria legendas levava duas
 * coleccoes turcas ao ecra inicial sem as pedir, e quem queria as coleccoes
 * levava um addon de legendas que talvez ja tivesse.
 *
 * O id tem de ser diferente em cada um: o Nuvio guarda os addons por id de
 * manifesto, e dois com o mesmo id sao o mesmo addon.
 *
 * Os recursos sao resolvidos a partir da base do manifesto — verificado em
 * `catalogRepository.buildCatalogUrl`, que faz `${basePath}/catalog/...` sobre
 * o URL de instalacao sem o `/manifest.json`. Por isso o addon turco vive em
 * `/turcas/manifest.json` e o catalogo dele em `/turcas/catalog/...`.
 */

import { CATALOG_TRENDING, CATALOG_POPULAR } from './catalogs.js';

export const MANIFEST_VERSION = '2.0.0';

export const SUBS_ADDON_ID = 'com.nuvio.subs.pt';
export const TURCAS_ADDON_ID = 'com.nuvio.turcas.pt';

/** Prefixo das rotas do addon turco, sem barra no fim. */
export const TURCAS_BASE = '/turcas';

const BASE = {
  version: MANIFEST_VERSION,
  logo: 'https://dl.strem.io/addon-logo.png',
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

/** Manifesto do addon de legendas. Serve todo o catalogo, nao so o turco. */
export function buildSubsManifest(env) {
  const preferred = env.PREFERRED_PT === 'pt-BR' ? 'portugues do Brasil' : 'portugues europeu';

  return {
    ...BASE,
    id: SUBS_ADDON_ID,
    name: 'Legendas PT',
    description: [
      `Legendas em ${preferred} para filmes e series, o catalogo todo e nao so`,
      'as turcas. Agrega as fontes publicas, corrige a codificacao de caracteres',
      'turcos e, quando nao existe legenda portuguesa para o episodio, traduz',
      'automaticamente a partir do ingles ou do turco.',
    ].join(' '),
    types: ['series', 'movie'],
    resources: [
      {
        name: 'subtitles',
        types: ['series', 'movie'],
        idPrefixes: ['tt', 'tmdb'],
      },
    ],
    catalogs: [],
  };
}

/** Manifesto do addon turco: coleccoes e, quando ligado, streams. */
export function buildTurcasManifest(env) {
  // Os catalogos so aparecem quando ha chave para os alimentar: uma coleccao
  // sempre vazia no ecra inicial e pior do que coleccao nenhuma.
  const catalogs = env.TMDB_API_KEY
    ? [
        { type: 'series', id: CATALOG_TRENDING, name: 'Turcas em Alta', extra: [{ name: 'skip' }] },
        { type: 'series', id: CATALOG_POPULAR, name: 'Turcas Populares', extra: [{ name: 'skip' }] },
      ]
    : [];

  const resources = [];
  if (catalogs.length > 0) resources.push({ name: 'catalog', types: ['series'] });

  // Streams com audio turco. Depende da mesma chave dos catalogos, porque e' o
  // TMDB que diz se a obra e' turca — sem isso o recurso responderia a tudo
  // para nao encontrar nada.
  //
  // `STREAMS=0` retira o recurso do manifesto mas nao fecha a rota: quem tem o
  // plugin do NuvioTV nao quer estas entradas (abrem o YouTube fora da app e
  // duplicam o que o plugin ja da a tocar por dentro), mas o proprio plugin
  // continua a precisar do endpoint para saber qual e' o video.
  if (env.TMDB_API_KEY && env.STREAMS !== '0') {
    resources.push({
      name: 'stream',
      types: ['series', 'movie'],
      idPrefixes: ['tt', 'tmdb'],
    });
  }

  return {
    ...BASE,
    id: TURCAS_ADDON_ID,
    name: 'Turcas PT',
    description: [
      'Duas coleccoes de series turcas — Em Alta e Populares — tiradas do TMDB',
      'por lingua original, com as fichas em portugues. Para as series e filmes',
      'turcos acrescenta ainda os episodios completos publicados pelos canais',
      'oficiais, que sao a unica fonte com audio turco de verdade. As legendas',
      'sao um addon a parte.',
    ].join(' '),
    types: ['series'],
    resources,
    catalogs,
  };
}
