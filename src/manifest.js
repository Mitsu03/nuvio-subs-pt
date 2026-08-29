/** Manifesto do addon, no formato que o Nuvio le em AddonManifestParser. */

import { CATALOG_TRENDING, CATALOG_POPULAR } from './catalogs.js';

export const MANIFEST_VERSION = '1.2.0';

export function buildManifest(env) {
  const preferred = env.PREFERRED_PT === 'pt-BR' ? 'portugues do Brasil' : 'portugues europeu';

  // Os catalogos so aparecem quando ha chave para os alimentar: uma coleccao
  // sempre vazia no ecra inicial e pior do que coleccao nenhuma.
  const catalogs = env.TMDB_API_KEY
    ? [
        { type: 'series', id: CATALOG_TRENDING, name: 'Turcas em Alta', extra: [{ name: 'skip' }] },
        { type: 'series', id: CATALOG_POPULAR, name: 'Turcas Populares', extra: [{ name: 'skip' }] },
      ]
    : [];

  const resources = [
    {
      name: 'subtitles',
      types: ['series', 'movie'],
      idPrefixes: ['tt', 'tmdb'],
    },
  ];

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
    id: 'com.nuvio.subs.pt',
    version: MANIFEST_VERSION,
    name: 'Turcas PT',
    description: [
      'Duas coleccoes de series turcas — Em Alta e Populares — e legendas em',
      `${preferred}. As legendas servem todo o catalogo e nao so as turcas:`,
      'agregam as fontes publicas, corrigem a codificacao de caracteres turcos',
      'e, quando nao existe legenda portuguesa para o episodio, traduzem',
      'automaticamente a partir do ingles ou do turco. Para series e filmes',
      'turcos acrescenta ainda os episodios completos publicados pelos canais',
      'oficiais, que sao a unica fonte com audio turco de verdade.',
    ].join(' '),
    logo: 'https://dl.strem.io/addon-logo.png',
    types: ['series', 'movie'],
    resources,
    catalogs,
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  };
}
