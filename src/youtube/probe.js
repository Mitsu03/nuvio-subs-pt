/**
 * Experiencia 0: a extracao do audio funciona a partir da Cloudflare?
 *
 * O resultado decide se a transcricao do audio (Whisper) e' projecto ou nao. Se
 * o `youtubei/v1/player` responder `OK` e o Worker conseguir descarregar um
 * bocado do `googlevideo`, o caminho esta aberto; se responder `UNPLAYABLE`,
 * nao ha maneira limpa e a ideia morre ali.
 *
 * Nao chega ver o `status`: o veredito e' o `206` do pedido com `Range` ao
 * googlevideo, porque e' esse endereco que leva o `ip=` la dentro. Por isso a
 * sonda vai ate ao fim e ainda le a caixa `sidx`, que e' onde estao os cortes
 * que o Whisper vai precisar.
 */

import { watchConfig, playerResponse, audioTrack, AUDIO_ITAG, ANDROID, CLIENTS } from './player.js';

/** `"723-10774"` -> `{ start: 723, end: 10774 }`. */
function parseRange(range) {
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

/**
 * A sonda toda. `videoId` e' o do episodio; sem ele nao ha experiencia.
 *
 * Devolve o veredito em `verdict`: `OK` significa que o Worker extraiu os seus
 * proprios enderecos e conseguiu descarregar por eles.
 */
export async function probePlayer(videoId, options = {}) {
  const steps = {};

  const config = await watchConfig(videoId);
  steps.watchPage = config.error
    ? { ok: false, error: config.error, bytes: config.bytes }
    : { ok: true, bytes: config.bytes, apiKey: `${config.apiKey.slice(0, 8)}…`, visitorData: `${config.visitorData.slice(0, 12)}…` };
  if (config.error) return { videoId, verdict: 'SEM_CONFIG', steps };

  // Percorre os perfis por ordem e fica com o primeiro que responda `OK`. Os
  // que falham ficam registados: saber *como* cada um falha e' metade da
  // resposta a experiencia.
  const attempts = [];
  let player = null;
  let usedClient = null;

  for (const profile of CLIENTS) {
    const result = await playerResponse(videoId, config, profile);
    attempts.push({
      client: profile.id,
      status: result.status || null,
      reason: result.reason || undefined,
      error: result.error || undefined,
    });
    if (result.status === 'OK') {
      player = result;
      usedClient = profile.id;
      break;
    }
  }

  steps.player = { ok: Boolean(player), client: usedClient, attempts };
  if (!player) {
    // Todos falharam: o veredito e' o do primeiro, que e' o cliente de
    // referencia do plugin.
    return { videoId, verdict: attempts[0].status || 'ERRO', steps };
  }

  const track = audioTrack(player.data, AUDIO_ITAG);
  steps.audio = track
    ? {
        ok: Boolean(track.url) && !track.ciphered,
        itag: track.itag,
        mimeType: track.mimeType,
        megabytes: Number((track.contentLength / 1048576).toFixed(1)),
        minutes: Number((track.approxDurationMs / 60000).toFixed(1)),
        initRange: track.initRange,
        indexRange: track.indexRange,
        ciphered: track.ciphered,
      }
    : { ok: false, error: 'nenhuma faixa de audio nos adaptiveFormats' };
  if (!track || !track.url || track.ciphered) return { videoId, verdict: 'SEM_AUDIO', steps };

  // O veredito. Este endereco leva o `ip=` de quem o pediu; se o Worker o
  // extraiu, o `ip=` e' o do Worker e o pedido tem de passar.
  const index = parseRange(track.indexRange);
  const wanted = index ? `bytes=0-${index.end}` : 'bytes=0-65535';
  const download = await fetch(track.url, {
    headers: { Range: wanted, 'User-Agent': ANDROID.userAgent },
  });
  const buffer = download.ok ? await download.arrayBuffer() : null;

  steps.download = {
    ok: download.status === 206,
    status: download.status,
    range: wanted,
    got: buffer ? buffer.byteLength : 0,
    // A prova de que o endereco esta preso ao IP: o parametro viaja no URL.
    ipInUrl: new URL(track.url).searchParams.get('ip') || null,
  };
  if (download.status !== 206 || !buffer) return { videoId, verdict: 'SEM_DESCARGA', steps };

  // Os cortes. Se isto der, o passo seguinte do plano — partir o audio sem
  // ffmpeg — deixa de ser palpite.
  if (index) {
    const sidx = parseSidx(buffer, 0);
    steps.sidx = sidx.error
      ? { ok: false, error: sidx.error }
      : {
          ok: true,
          fragmentos: sidx.count,
          duracaoTotalSegundos: sidx.totalSeconds,
          // Blocos de 8 minutos: o compromisso que o plano dizia ter de ser
          // medido. Aqui fica o numero real para esta faixa.
          blocosDe8min: chunkFragments(sidx.fragments, options.chunkSeconds || 480).length,
          primeiroFragmento: sidx.fragments[0] || null,
        };
  }

  return { videoId, verdict: 'OK', steps };
}
