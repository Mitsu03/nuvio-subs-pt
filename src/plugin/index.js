/**
 * O Worker serve tambem o repositorio de plugins do NuvioTV.
 *
 * O NuvioTV instala plugins a partir de um `manifest.json` e vai buscar cada
 * ficheiro ao lado dele (`baseUrl/filename`). Servir os dois daqui poupa ao
 * utilizador ter de alojar seja o que for: cola-se um endereco e esta feito.
 *
 * O endereco do proprio Worker e' injectado no codigo no momento de servir, e
 * por isso o plugin nao tem configuracao nenhuma.
 */

import { PLUGIN_SOURCE, PLUGIN_VERSION, PLUGIN_DIGEST } from './source.js';

export const PLUGIN_FILENAME = 'turcas-pt.js';
export const PLUGIN_ID = 'turcas-pt';

/** O manifesto que o NuvioTV le em `PluginManifest`. */
export function buildPluginManifest() {
  return {
    name: 'Turcas PT',
    version: PLUGIN_VERSION,
    description: 'Episodios turcos dos canais oficiais, em qualidade maxima.',
    author: 'nuvio-subs-pt',
    scrapers: [
      {
        id: PLUGIN_ID,
        name: 'Turcas PT',
        description:
          'Series e filmes turcos a partir dos canais oficiais no YouTube, com audio turco original.',
        version: PLUGIN_VERSION,
        filename: PLUGIN_FILENAME,
        supportedTypes: ['movie', 'tv'],
        enabled: true,
        contentLanguage: ['tr'],
      },
    ],
  };
}

/** O codigo, ja a saber de onde falar com o Worker. */
export function buildPluginSource(origin) {
  return PLUGIN_SOURCE.split('__WORKER_ORIGIN__').join(origin);
}

export { PLUGIN_VERSION, PLUGIN_DIGEST };
