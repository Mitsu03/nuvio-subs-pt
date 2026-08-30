/**
 * Passo de preparacao de uma legenda: descarregar, descomprimir, corrigir a
 * codificacao, limpar a publicidade e, se for caso disso, traduzir.
 */

import { fetchBytes } from './http.js';
import { unpackSubtitle } from './format/archive.js';
import { decodeSubtitleBytes } from './format/decode.js';
import {
  parseSubtitle,
  serializeSrt,
  stripPromoCues,
  flattenCueText,
  wrapCueText,
} from './format/srt.js';
import { translateLines } from './translate/index.js';
import { payloadUrls } from './token.js';

/**
 * Descarrega e normaliza uma legenda para SRT em UTF-8.
 *
 * @param {object} payload  conteudo do token assinado
 * @returns {Promise<{ cues: Array, encoding: string }>}
 */
export async function loadCues(payload, env) {
  // Legenda vinda da transcricao do audio: o texto ja esta em KV, escrito pelo
  // `src/asr/`. Nao ha nada para descarregar nem codificacao para adivinhar.
  if (payload.asr) {
    const text = env && env.SUBS ? await env.SUBS.get(payload.asr).catch(() => null) : null;
    if (!text) throw new Error('a transcricao ainda nao esta pronta');
    const cues = parseSubtitle(text);
    if (cues.length === 0) throw new Error('transcricao vazia');
    return { cues, encoding: 'utf-8', url: payload.asr };
  }

  // As origens sao tentadas por ordem. Uma fonte pode responder bem a busca e
  // recusar a descarga — o dl.opensubtitles.org devolve 401 a pedidos vindos de
  // IPs de datacentro, por exemplo — por isso uma falha faz seguir para a
  // seguinte em vez de deitar o pedido todo abaixo.
  const urls = payloadUrls(payload);
  const failures = [];

  for (const url of urls) {
    try {
      const { bytes } = await fetchBytes(url);
      const unpacked = await unpackSubtitle(bytes, payload.hint || '');
      if (!unpacked) throw new Error('nenhuma legenda dentro do ficheiro');

      const { text, encoding } = decodeSubtitleBytes(unpacked.bytes, {
        sourceLang: payload.src || payload.lang,
        declared: payload.enc || '',
      });

      const cues = stripPromoCues(parseSubtitle(text));
      if (cues.length === 0) throw new Error('legenda vazia ou em formato nao reconhecido');

      return { cues, encoding, url };
    } catch (error) {
      failures.push(`${new URL(url).hostname}: ${error.message}`);
    }
  }

  throw new Error(`nenhuma origem serviu a legenda (${failures.join('; ')})`);
}

/**
 * Produz o SRT final para um token. Traduz quando `payload.tr` esta activo.
 *
 * @returns {Promise<{ srt: string, engine: string|null, translated: number, failed: number }>}
 */
export async function buildSubtitle(payload, env) {
  const { cues } = await loadCues(payload, env);

  if (!payload.tr) {
    return { srt: serializeSrt(cues), engine: null, translated: 0, failed: 0 };
  }

  // O tradutor trabalha melhor com a deixa numa linha so; a quebra de linha de
  // uma legenda e' cosmetica e e' reposta a seguir, ja com o texto traduzido.
  const source = cues.map((cue) => flattenCueText(cue.text));
  const result = await translateLines(source, { from: payload.src || 'en', to: payload.lang }, env);

  const translatedCues = cues.map((cue, index) => ({
    ...cue,
    text: wrapCueText(result.lines[index] || cue.text),
  }));

  return {
    srt: serializeSrt(translatedCues),
    engine: result.engine,
    translated: result.translated,
    failed: result.failed,
    error: result.error,
  };
}
