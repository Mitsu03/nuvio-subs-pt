/**
 * A caixa `sidx` de um MP4 fragmentado: onde cada fragmento comeca e acaba.
 *
 * E' isto que torna possivel cortar o audio sem ffmpeg. O YouTube ja calculou
 * as fronteiras, e o `indexRange` do formato diz onde a caixa vive. Juntar o
 * `init` com N fragmentos seguidos da' um MP4 valido e autonomo — que e'
 * exactamente o que o Whisper aceita.
 */

/** `"723-10774"` -> `{ start: 723, end: 10774 }`. */
export function parseRange(range) {
  if (!range) return null;
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/**
 * Le a caixa `sidx` e devolve as fronteiras dos fragmentos.
 *
 * E' isto que torna o corte possivel sem ffmpeg: o YouTube ja calculou onde
 * cada fragmento comeca e acaba, e juntar `init` + N fragmentos seguidos da um
 * MP4 valido e autonomo.
 */
export function parseSidx(buffer, indexStart = 0) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // A caixa pode nao comecar no byte 0 do que se descarregou.
  let at = -1;
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (bytes[i] === 0x73 && bytes[i + 1] === 0x69 && bytes[i + 2] === 0x64 && bytes[i + 3] === 0x78) {
      at = i + 4; // logo a seguir ao nome da caixa
      break;
    }
  }
  if (at < 0) return { error: 'nao encontrei a caixa sidx' };

  const version = view.getUint8(at);
  let p = at + 4; // versao (1) + flags (3)
  p += 4; // reference_ID
  const timescale = view.getUint32(p);
  p += 4;

  // O tamanho destes dois campos depende da versao da caixa.
  p += version === 0 ? 8 : 16;
  const firstOffset = version === 0 ? view.getUint32(p - 4) : Number(view.getBigUint64(p - 8));

  p += 2; // reserved
  const count = view.getUint16(p);
  p += 2;

  // O primeiro fragmento comeca logo a seguir a caixa sidx.
  const sidxEnd = indexStart + (at - 4) + view.getUint32(at - 8);
  let offset = sidxEnd + firstOffset;

  const fragments = [];
  for (let i = 0; i < count && p + 12 <= bytes.length; i += 1) {
    const size = view.getUint32(p) & 0x7fffffff;
    const duration = view.getUint32(p + 4);
    fragments.push({
      start: offset,
      end: offset + size - 1,
      seconds: Number((duration / timescale).toFixed(3)),
    });
    offset += size;
    p += 12;
  }

  const total = fragments.reduce((sum, fragment) => sum + fragment.seconds, 0);
  return { timescale, count, fragments, totalSeconds: Number(total.toFixed(1)) };
}

/** Agrupa fragmentos em blocos de ~`seconds`, que e' o que o Whisper engole. */
export function chunkFragments(fragments, seconds = 480) {
  const chunks = [];
  let current = null;

  for (const fragment of fragments) {
    if (!current || current.seconds >= seconds) {
      current = { from: fragment.start, to: fragment.end, seconds: 0, fragments: 0 };
      chunks.push(current);
    }
    current.to = fragment.end;
    current.seconds = Number((current.seconds + fragment.seconds).toFixed(3));
    current.fragments += 1;
  }
  return chunks;
}
