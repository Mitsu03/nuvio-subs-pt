/** Manifesto do addon, no formato que o Nuvio le em AddonManifestParser. */

import { CATALOG_TRENDING, CATALOG_POPULAR } from './catalogs.js';

export const MANIFEST_VERSION = '1.1.0';

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

  return {
    id: 'com.nuvio.subs.pt',
    version: MANIFEST_VERSION,
    name: 'Turcas PT',
    description: [
      'Duas coleccoes de series turcas — Em Alta e Populares — e legendas em',
      `${preferred}. As legendas servem todo o catalogo e nao so as turcas:`,
      'agregam as fontes publicas, corrigem a codificacao de caracteres turcos',
      'e, quando nao existe legenda portuguesa para o episodio, traduzem',
      'automaticamente a partir do ingles ou do turco.',
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
