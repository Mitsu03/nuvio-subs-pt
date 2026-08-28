/**
 * Descompressao dos formatos em que as fontes entregam as legendas:
 * o OpenSubtitles serve `.gz` e o SubDL serve `.zip`.
 *
 * Usa apenas DecompressionStream, disponivel tanto nos Workers como no Node,
 * para o modulo ser testavel fora do runtime da Cloudflare.
 */

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** True se os bytes comecarem pela assinatura gzip. */
export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** True se os bytes comecarem pela assinatura de um arquivo ZIP local. */
export function isZip(bytes) {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

export function gunzip(bytes) {
  return inflate(bytes, 'gzip');
}

const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa', '.sub'];

function readUint16(view, offset) {
  return view.getUint16(offset, true);
}

function readUint32(view, offset) {
  return view.getUint32(offset, true);
}

/**
 * Le um ZIP e devolve a entrada de legenda mais promissora.
 *
 * Implementacao minima do formato: localiza o End Of Central Directory, percorre
 * o directorio central e descomprime so a entrada escolhida. Suporta os dois
 * metodos que interessam, `store` (0) e `deflate` (8).
 *
 * @param {Uint8Array} bytes
 * @param {string} [preferHint] pedaco de nome a preferir (ex.: "S01E05")
 * @returns {Promise<{ name: string, bytes: Uint8Array } | null>}
 */
export async function extractSubtitleFromZip(bytes, preferHint = '') {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // O EOCD tem 22 bytes mais um comentario de ate 65535; procura-se de tras para a frente.
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= lowest; i -= 1) {
    if (readUint32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = readUint16(view, eocd + 10);
  let offset = readUint32(view, eocd + 16);

  const entries = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || readUint32(view, offset) !== 0x02014b50) break;

    const method = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const localOffset = readUint32(view, offset + 42);
    const name = new TextDecoder('utf-8').decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );

    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const candidates = entries.filter((entry) => {
    const lower = entry.name.toLowerCase();
    return (
      !lower.endsWith('/') &&
      !lower.startsWith('__macosx/') &&
      SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
    );
  });
  if (candidates.length === 0) return null;

  const hint = preferHint.toLowerCase();
  const score = (entry) => {
    const lower = entry.name.toLowerCase();
    let value = 0;
    if (hint && lower.includes(hint)) value += 100;
    if (lower.endsWith('.srt')) value += 10;
    if (lower.endsWith('.vtt')) value += 8;
    return value;
  };
  candidates.sort((a, b) => score(b) - score(a));

  const chosen = candidates[0];

  // O tamanho dos campos variaveis do cabecalho local difere do central.
  const localNameLength = readUint16(view, chosen.localOffset + 26);
  const localExtraLength = readUint16(view, chosen.localOffset + 28);
  const dataStart = chosen.localOffset + 30 + localNameLength + localExtraLength;
  const data = bytes.subarray(dataStart, dataStart + chosen.compressedSize);

  if (chosen.method === 0) return { name: chosen.name, bytes: data };
  if (chosen.method === 8) {
    return { name: chosen.name, bytes: await inflate(data, 'deflate-raw') };
  }
  return null;
}

/**
 * Aceita bytes crus, gzip ou zip e devolve os bytes da legenda.
 *
 * @param {Uint8Array} bytes
 * @param {string} [preferHint]
 * @returns {Promise<{ bytes: Uint8Array, name: string } | null>}
 */
export async function unpackSubtitle(bytes, preferHint = '') {
  if (isGzip(bytes)) return { bytes: await gunzip(bytes), name: '' };
  if (isZip(bytes)) return extractSubtitleFromZip(bytes, preferHint);
  return { bytes, name: '' };
}
