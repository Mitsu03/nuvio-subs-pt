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
import { parseRange, parseSidx, chunkFragments } from './sidx.js';

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

  // O `403` nao e' do tamanho: o primeiro MB passa e o segundo falha. Resta
  // saber se e' estrangulamento por pedidos seguidos, e se o `range=` na query
  // — a forma que o proprio leitor do YouTube usa — escapa a isso.
  if (options.ranges !== false && index) {
    const inicio = index.end + 1;
    const MB = 1024 * 1024;
    const parametros = new URL(track.url).searchParams;

    const seguidos = [];
    for (let i = 0; i < 4; i += 1) {
      const de = inicio + i * MB;
      const resposta = await fetch(track.url, {
        headers: { Range: `bytes=${de}-${de + MB - 1}`, 'User-Agent': ANDROID.userAgent },
      });
      seguidos.push(resposta.status);
      if (resposta.status !== 206) break;
    }

    // A mesma sequencia, mas com o intervalo na query em vez do cabecalho.
    const naQuery = [];
    for (let i = 0; i < 4; i += 1) {
      const de = inicio + i * MB;
      const alvo = new URL(track.url);
      alvo.searchParams.set('range', `${de}-${de + MB - 1}`);
      const resposta = await fetch(alvo.toString(), { headers: { 'User-Agent': ANDROID.userAgent } });
      naQuery.push(resposta.status);
      if (resposta.status !== 206 && resposta.status !== 200) break;
    }

    steps.ranges = {
      cabecalhoRange: seguidos,
      rangeNaQuery: naQuery,
      temRatebypass: parametros.has('ratebypass'),
      parametros: Array.from(parametros.keys()).join(','),
    };
  }

  return { videoId, verdict: 'OK', steps };
}
