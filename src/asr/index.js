/**
 * Legenda a partir do audio do proprio episodio.
 *
 * Existe para uma classe concreta de series: as que estao a dar agora e nao
 * tem legenda em lingua nenhuma. O *Muhtemel Ask* e' o caso que motivou isto —
 * zero ficheiros no OpenSubtitles, zero faixas no video oficial, nem legendas
 * automaticas do YouTube. Sem texto de partida, o tradutor nao tem o que
 * traduzir; com a transcricao, passa a ter.
 *
 * Corre por passagens, e nao de uma vez. Duas razoes, ambas medidas:
 *   - um episodio sao ~2h20, o que da 18 blocos de 8 minutos, e cada bloco
 *     custa dois subpedidos (descarga + Whisper). O plano gratuito da
 *     Cloudflare limita a 50 subpedidos por pedido;
 *   - a transcricao inteira nao cabe na janela de um pedido.
 *
 * Por isso ha estado em KV: cada passagem faz os blocos que couberem, guarda o
 * que fez, e a passagem seguinte continua de onde ficou. Quando o ultimo bloco
 * entra, escreve-se o SRT final e o estado deixa de ser preciso.
 */

import { prepareAudio, fetchBlock, blockOffsets, blockCost } from './audio.js';
import { transcribeBlock } from './whisper.js';
import { serializeSrt } from '../format/srt.js';

export const ASR_VERSION = 'v1';

/** Chave do SRT pronto. */
export function asrKey(video) {
  const episode = video.season != null ? `:${video.season}:${video.episode}` : '';
  return `asr:${ASR_VERSION}:${video.imdbId}${episode}`;
}

/** Chave do trabalho a meio. */
export function asrStateKey(video) {
  return `${asrKey(video)}:state`;
}

export function isEnabled(env) {
  return env.ASR === '1' && Boolean(env.AI);
}

/** O SRT ja pronto, se existir. */
export async function readTranscript(video, env) {
  if (!env.SUBS) return null;
  return env.SUBS.get(asrKey(video)).catch(() => null);
}

/** O progresso, se houver trabalho a meio. */
export async function readState(video, env) {
  if (!env.SUBS) return null;
  return env.SUBS.get(asrStateKey(video), 'json').catch(() => null);
}

function segmentsToCues(segments) {
  return segments
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((segment) => ({
      start: Math.round(segment.start * 1000),
      end: Math.round(segment.end * 1000),
      text: segment.text,
    }))
    // Uma deixa sem duracao nao aparece no leitor; da'-se-lhe um segundo.
    .map((cue) => (cue.end > cue.start ? cue : { ...cue, end: cue.start + 1000 }));
}

/**
 * Faz uma passagem de transcricao.
 *
 * Devolve `{ done, blocosFeitos, totalBlocos }`. Quando `done` e' verdadeiro, o
 * SRT em turco esta guardado e pronto a ser traduzido pelo caminho normal.
 */
export async function runPass(video, videoId, env) {
  if (!isEnabled(env)) return { error: 'ASR desligado' };
  if (!env.SUBS) return { error: 'sem KV para guardar o progresso' };

  const pronto = await readTranscript(video, env);
  if (pronto) return { done: true, jaEstava: true };

  // Uma so extraccao por passagem. Chamar `prepareAudio` duas vezes — uma para
  // contar os blocos, outra para os descarregar — custava ~9 subpedidos a mais
  // e estourava o tecto de 50 antes do primeiro bloco chegar ao Whisper.
  //
  // O endereco do googlevideo expira, por isso extrai-se sempre de novo em vez
  // de o guardar no estado; o que o estado guarda sao os blocos ja transcritos.
  const prepared = await prepareAudio(videoId, env);
  if (prepared.error) return { error: prepared.error };

  let state = await readState(video, env);
  if (!state) {
    state = { videoId, totalBlocos: prepared.blocks.length, totalSeconds: prepared.totalSeconds, feitos: {}, falhas: 0 };
  }

  const offsets = blockOffsets(prepared.blocks);

  const porPassagem = Number(env.ASR_BLOCKS_PER_PASS || 8);
  // O tecto verdadeiro nao e' o numero de blocos, e' o de subpedidos: a
  // Cloudflare corta aos 50 por invocacao, e um bloco de 8 minutos custa nove
  // (oito pedacos de 1 MB mais o Whisper). Contar blocos escondia isto.
  const orcamento = Number(env.ASR_SUBREQUEST_BUDGET || 30);
  let gasto = 0;
  // Falhar N blocos seguidos e' sinal de que o problema nao e' do bloco: mais
  // tentativas so gastam o orcamento de subpedidos. Sem este travao, um `403`
  // do googlevideo fazia percorrer os 18 blocos todos para nada.
  const desistirApos = Number(env.ASR_MAX_FAILURES || 3);

  let feitosAgora = 0;
  let falhasSeguidas = 0;
  const erros = [];

  for (let index = 0; index < prepared.blocks.length; index += 1) {
    if (feitosAgora >= porPassagem) break;
    if (falhasSeguidas >= desistirApos) break;
    if (state.feitos[index]) continue;

    const custo = blockCost(prepared.blocks[index]);
    // Parar antes de estourar vale mais do que uma excepcao `1101` a meio, que
    // perde tambem os blocos ja transcritos nesta passagem.
    if (gasto + custo > orcamento) break;
    gasto += custo;

    const bloco = await fetchBlock(prepared, index);
    if (bloco.error) {
      state.falhas += 1;
      falhasSeguidas += 1;
      if (erros.length < 3) erros.push(`descarga ${bloco.error}`);
      continue;
    }

    const transcrito = await transcribeBlock(bloco.mp4, offsets[index], env);
    if (transcrito.error) {
      state.falhas += 1;
      falhasSeguidas += 1;
      if (erros.length < 3) erros.push(`whisper ${transcrito.error}`);
      continue;
    }

    state.feitos[index] = transcrito.segments;
    state.modelo = transcrito.model;
    feitosAgora += 1;
    falhasSeguidas = 0;
  }

  const feitos = Object.keys(state.feitos).length;
  const done = feitos >= prepared.blocks.length;

  if (!done) {
    await env.SUBS.put(asrStateKey(video), JSON.stringify(state), {
      expirationTtl: 7 * 86400,
    }).catch(() => {});
    return {
      done: false,
      blocosFeitos: feitos,
      totalBlocos: prepared.blocks.length,
      feitosAgora,
      subpedidos: gasto,
      ...(erros.length ? { erros } : {}),
    };
  }

  const segments = Object.keys(state.feitos)
    .sort((a, b) => Number(a) - Number(b))
    .flatMap((index) => state.feitos[index]);

  const srt = serializeSrt(segmentsToCues(segments));

  // Um episodio transcrito nunca muda: guarda-se por muito tempo.
  const dias = Number(env.ASR_CACHE_DAYS || 365);
  await env.SUBS.put(asrKey(video), srt, { expirationTtl: dias * 86400 }).catch(() => {});
  await env.SUBS.delete(asrStateKey(video)).catch(() => {});

  return { done: true, blocosFeitos: feitos, totalBlocos: prepared.blocks.length, deixas: segments.length };
}
