/**
 * Embute o plugin no Worker.
 *
 * O Worker nao le' o disco em tempo de execucao, por isso o codigo do plugin
 * tem de viajar como texto dentro do bundle. Uma so fonte de verdade
 * (`plugin/turcas-pt.js`, que corre tal e qual em Node para os testes) e um
 * ficheiro gerado a partir dela.
 *
 * Correr depois de mexer no plugin:  npm run build:plugin
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'plugin', 'turcas-pt.js'), 'utf8');

// A versao vem do conteudo: o Nuvio so volta a descarregar o plugin quando o
// numero muda, e uma versao fixada a mao esquece-se sempre.
const digest = createHash('sha256').update(source).digest('hex').slice(0, 8);

const out = [
  '/** Gerado por `npm run build:plugin`. Nao editar: mexe-se em plugin/turcas-pt.js. */',
  '',
  "export const PLUGIN_VERSION = '1.0." + parseInt(digest.slice(0, 4), 16) + "';",
  "export const PLUGIN_DIGEST = '" + digest + "';",
  'export const PLUGIN_SOURCE = ' + JSON.stringify(source) + ';',
  '',
].join('\n');

mkdirSync(join(root, 'src', 'plugin'), { recursive: true });
writeFileSync(join(root, 'src', 'plugin', 'source.js'), out);

console.log('plugin embutido: ' + source.length + ' bytes, digest ' + digest);
