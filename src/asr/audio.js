/**
 * O audio do episodio, aos bocados, a partir do YouTube.
 *
 * O Worker extrai os seus proprios enderecos do `googlevideo` — medido a
 * funcionar a partir da Cloudflare, ao contrario do que se supunha — e depois
 * so precisa de pedir intervalos de bytes. Os cortes vem da caixa `sidx`, que
 * o YouTube ja calculou: `init` + N fragmentos seguidos e' um MP4 valido.
 *
 * Nada disto guarda o audio: cada bloco e' descarregado, transcrito e
 * deitado fora. Sao 128 MB por episodio e o Worker nao tem onde os por.
 */

import { watchConfig, playerResponse, audioTrack, ANDROID } from '../youtube/player.js';
import { parseRange, parseSidx, chunkFragments } from '../youtube/sidx.js';

/** Segundos de audio por bloco. Ver `ASR_BLOCK_SECONDS` no wrangler.toml. */
export const DEFAULT_BLOCK_SECONDS = 480;

/**
 * Bytes por pedido ao googlevideo.
 *
 * Medido em producao: um `Range` de 1 MB no meio do ficheiro responde `206`,
 * um de 4 MB responde `403`. O limite nao esta documentado, e o `403` nao
 * distingue «grande demais» de «recusado» — foi preciso medir por tentativa.
 * Um bloco de 8 minutos sao ~7,7 MB, portanto tem mesmo de vir aos pedacos.
 */
export const MAX_RANGE_BYTES = 1024 * 1024;

/** Um `fetch` com `Range`, com as tentativas que o `403` intermitente exige. */
export async function fetchRange(url, from, to, attempts = 2) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { Range: `bytes=${from}-${to}`, 'User-Agent': ANDROID.userAgent },
    });
    if (response.status === 206) return { ok: true, buffer: await response.arrayBuffer() };
    last = response.status;
    // O 403 do googlevideo aparece e desaparece entre pedidos identicos —
    // medido em producao. Uma segunda tentativa resolve-o quase sempre.
    if (response.status !== 403) break;
  }
  return { ok: false, status: last };
}

/**
 * Prepara o episodio: extrai o endereco do audio e calcula os blocos.
 *
 * Devolve tambem o `init`, que vai a cabeca de cada bloco — sem ele o MP4 nao
 * tem cabecalho e o Whisper nao o le.
 */
export async function prepareAudio(videoId, env) {
  const config = await watchConfig(videoId);
  if (config.error) return { error: `configuracao do video: ${config.error}` };

  const player = await playerResponse(videoId, config);
  if (player.status !== 'OK') {
    return { error: `o YouTube recusou: ${player.status}${player.reason ? ` (${player.reason})` : ''}` };
  }

  const track = audioTrack(player.data);
  if (!track || !track.url || track.ciphered) return { error: 'sem faixa de audio utilizavel' };

  const index = parseRange(track.indexRange);
  const init = parseRange(track.initRange);
  if (!index || !init) return { error: 'o formato nao traz initRange/indexRange' };

  const head = await fetchRange(track.url, 0, index.end);
  if (!head.ok) return { error: `nao consegui ler o indice: ${head.status}` };

  const sidx = parseSidx(head.buffer, 0);
  if (sidx.error) return { error: sidx.error };

  const seconds = Number(env.ASR_BLOCK_SECONDS || DEFAULT_BLOCK_SECONDS);
  const blocks = chunkFragments(sidx.fragments, seconds);

  // O `init` esta no inicio do que ja se descarregou.
  const initBytes = head.buffer.slice(init.start, init.end + 1);

  return {
    url: track.url,
    initBytes,
    blocks,
    totalSeconds: sidx.totalSeconds,
    itag: track.itag,
  };
}

/** Descarrega um intervalo grande em pedacos que o googlevideo aceite. */
export async function fetchRangeChunked(url, from, to, maxBytes = MAX_RANGE_BYTES) {
  const partes = [];
  let total = 0;

  for (let at = from; at <= to; at += maxBytes) {
    const fim = Math.min(at + maxBytes - 1, to);
    const parte = await fetchRange(url, at, fim);
    if (!parte.ok) return { ok: false, status: parte.status, at };
    partes.push(new Uint8Array(parte.buffer));
    total += parte.buffer.byteLength;
  }

  const junto = new Uint8Array(total);
  let offset = 0;
  for (const parte of partes) {
    junto.set(parte, offset);
    offset += parte.length;
  }
  return { ok: true, bytes: junto };
}

/** Quantos subpedidos custa um bloco: os pedacos da descarga, mais o Whisper. */
export function blockCost(block, maxBytes = MAX_RANGE_BYTES) {
  return Math.ceil((block.to - block.from + 1) / maxBytes) + 1;
}

/** Um bloco pronto a mandar ao Whisper: `init` + os fragmentos do bloco. */
export async function fetchBlock(prepared, index) {
  const block = prepared.blocks[index];
  if (!block) return { error: `bloco ${index} nao existe` };

  const body = await fetchRangeChunked(prepared.url, block.from, block.to);
  if (!body.ok) return { error: `bloco ${index}: ${body.status} (byte ${body.at})` };

  const init = new Uint8Array(prepared.initBytes);
  const mp4 = new Uint8Array(init.length + body.bytes.length);
  mp4.set(init, 0);
  mp4.set(body.bytes, init.length);

  return { mp4, seconds: block.seconds };
}

/** Onde cada bloco comeca, em segundos, para deslocar as marcas de tempo. */
export function blockOffsets(blocks) {
  const offsets = [];
  let at = 0;
  for (const block of blocks) {
    offsets.push(Number(at.toFixed(3)));
    at += block.seconds;
  }
  return offsets;
}
