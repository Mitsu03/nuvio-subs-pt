/**
 * Camada de traducao: escolhe o motor, parte o trabalho em lotes e garante que
 * o numero de deixas a' saida e' igual ao numero a' entrada.
 *
 * Um episodio tipico destas series tem 500 a 900 deixas. O plano gratuito da
 * Cloudflare limita os subpedidos por request, por isso os lotes sao grandes e
 * o total de chamadas e' limitado por `MAX_TRANSLATE_CALLS`.
 */

import { mapLimit } from '../http.js';
import * as workersai from './workersai.js';
import * as deepl from './deepl.js';
import * as google from './google.js';
import * as libre from './libre.js';

const ENGINES = { workersai, 'workersai-m2m': workersai, deepl, google, libre };

const BATCH_MAX_LINES = 40;
const BATCH_MAX_CHARS = 2400;

/** Nome do motor efectivamente utilizavel, ou null se nenhum estiver pronto. */
export function resolveEngineName(env) {
  const configured = String(env.TRANSLATE_PROVIDER || 'workersai').toLowerCase();
  if (configured === 'none') return null;

  const engine = ENGINES[configured];
  if (engine && engine.isAvailable(env)) return configured;

  // O que estiver configurado manda; se nao der, tenta-se o que houver.
  for (const [name, candidate] of Object.entries(ENGINES)) {
    if (candidate.isAvailable(env)) return name;
  }
  return null;
}

/** Parte as linhas em lotes limitados por numero de linhas e por caracteres. */
export function buildBatches(lines, maxLines = BATCH_MAX_LINES, maxChars = BATCH_MAX_CHARS) {
  const batches = [];
  let current = [];
  let chars = 0;

  for (const line of lines) {
    const wouldOverflow = current.length >= maxLines || chars + line.length > maxChars;
    if (current.length > 0 && wouldOverflow) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(line);
    chars += line.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Traduz um conjunto de linhas.
 *
 * Nunca rebenta nem devolve um array de tamanho diferente: um lote que falhe
 * fica com o texto original, para a legenda continuar sincronizada e utilizavel
 * mesmo com uma parte por traduzir.
 *
 * @returns {Promise<{ lines: string[], engine: string|null, translated: number, failed: number }>}
 */
export async function translateLines(lines, options, env) {
  const engineName = resolveEngineName(env);
  if (!engineName) return { lines, engine: null, translated: 0, failed: lines.length };

  const engine = ENGINES[engineName];
  const engineOptions = { ...options, mode: engineName === 'workersai-m2m' ? 'm2m' : 'instruct' };

  const maxCalls = Number(env.MAX_TRANSLATE_CALLS) || 40;
  // 12 e o valor medido: a 6, um episodio de 1100 deixas levava 41s e o
  // prewarm nao chegava a tempo da janela do waitUntil; a 12 leva cerca de 30s.
  const concurrency = Math.max(1, Number(env.TRANSLATE_CONCURRENCY) || 12);
  const batches = buildBatches(lines);

  // Um episodio destes tem 800 a 1200 deixas, ou seja 20 a 30 lotes. Em fila
  // seriam mais de um minuto de espera antes de o leitor receber o ficheiro;
  // em paralelo ficam poucos segundos. A ordem e preservada pelo mapLimit.
  const attempted = batches.slice(0, maxCalls);
  const skipped = batches.slice(maxCalls);

  // A razao da primeira falha e guardada: um lote que falha em silencio ja
  // custou um diagnostico as cegas (um modelo descontinuado aparecia so como
  // "zero linhas traduzidas"), por isso o motivo tem de chegar a superficie.
  let firstError = null;

  const results = await mapLimit(attempted, concurrency, async (batch) => {
    try {
      const result = await engine.translateBatch(batch, engineOptions, env);
      if (!Array.isArray(result) || result.length !== batch.length) {
        throw new Error('contagem de linhas desalinhada');
      }
      return result.map((line, index) => (line && line.trim() !== '' ? line : batch[index]));
    } catch (error) {
      if (!firstError) firstError = error.message;
      return null;
    }
  });

  const output = [];
  let translated = 0;
  let failed = 0;

  results.forEach((result, index) => {
    const batch = attempted[index];
    if (result) {
      output.push(...result);
      translated += batch.length;
    } else {
      // Um lote que falhe fica com o original: a legenda continua sincronizada.
      output.push(...batch);
      failed += batch.length;
    }
  });

  for (const batch of skipped) {
    output.push(...batch);
    failed += batch.length;
  }

  return { lines: output, engine: engineName, translated, failed, error: firstError };
}
