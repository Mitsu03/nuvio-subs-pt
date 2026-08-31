/**
 * Legendas turcas vindas do video oficial, quando nao ha mais nada.
 *
 * Corre depois de as fontes normais (SubDL, OpenSubtitles) nao terem devolvido
 * nada em lingua nenhuma. Sao dois pedidos e algumas dezenas de KB — barato o
 * suficiente para se fazer no proprio pedido, ao contrario da transcricao do
 * audio, que sao 128 MB e nao passa o estrangulamento do YouTube.
 *
 * O texto fica em KV para nao se repetir a busca, e a entrada devolvida ao
 * Nuvio traduz do turco pelo caminho que ja existe.
 */

import { fetchYoutubeCaptions } from './providers/youtube.js';
import { serializeSrt } from './format/srt.js';

export const CAPTIONS_VERSION = 'v1';

/** Chave do texto turco guardado. */
export function captionsKey(video) {
  const episodio = video.season != null ? `:${video.season}:${video.episode}` : '';
  return `yt:${CAPTIONS_VERSION}:${video.imdbId}${episodio}`;
}

/** Marca de que ja se procurou e nao havia — evita repetir dois pedidos. */
function missKey(video) {
  return `${captionsKey(video)}:miss`;
}

export function isEnabled(env) {
  return env.YOUTUBE_CAPTIONS !== '0';
}

/**
 * Devolve `{ chave, kind }` quando ha legenda turca guardada ou acabada de
 * obter, e `null` quando nao ha. `resolveVideoId` e' injectado para nao trazer
 * o modulo dos streams para aqui.
 */
export async function ensureCaptions(video, env, resolveVideoId) {
  if (!isEnabled(env) || !env.SUBS) return null;

  const chave = captionsKey(video);

  const guardado = await env.SUBS.get(chave).catch(() => null);
  if (guardado) return { chave, kind: 'guardado' };

  // Ja se procurou ha pouco e nao havia. Sem esta marca, cada visita a um
  // episodio sem legendas gastava dois pedidos ao YouTube para nada.
  const falhou = await env.SUBS.get(missKey(video)).catch(() => null);
  if (falhou) return null;

  const videoId = await resolveVideoId();
  if (!videoId) return null;

  const encontrado = await fetchYoutubeCaptions(videoId, env, env.ASR_LANGUAGE || 'tr');

  if (!encontrado || encontrado.motivo) {
    // Quanto tempo esperar depende do porque. «Nao tem legendas» aguenta horas
    // — mas nao para sempre, porque um canal pode acrescenta-las e o YouTube
    // gera as automaticas nas primeiras horas de um episodio novo. «O YouTube
    // recusou» sao minutos: e' a defesa anti-bot a apanhar o IP do datacentro,
    // e marcar isso por horas fazia perder episodios que tinham legendas.
    const passageiro = !encontrado || encontrado.motivo === 'recusado';
    const segundos = passageiro
      ? Number(env.CAPTIONS_RETRY_MINUTES || 15) * 60
      : Number(env.CAPTIONS_MISS_HOURS || 12) * 3600;

    await env.SUBS.put(missKey(video), encontrado?.motivo || 'recusado', {
      expirationTtl: segundos,
    }).catch(() => {});
    return null;
  }

  const dias = Number(env.CAPTIONS_CACHE_DAYS || 180);
  await env.SUBS.put(chave, serializeSrt(encontrado.cues), {
    expirationTtl: dias * 86400,
  }).catch(() => {});

  return { chave, kind: encontrado.kind, deixas: encontrado.cues.length };
}

/**
 * Guarda legendas que vieram de fora — do plugin, que corre no aparelho do
 * utilizador e por isso fala com o YouTube pelo IP de casa.
 *
 * O Worker sozinho ja nao consegue: os IPs da Cloudflare apanham `429` na
 * pagina do video. Sem este caminho, um episodio com legendas turcas no canal
 * oficial ficava sem legenda nenhuma so por causa de onde o addon esta alojado.
 */
export async function storeCaptions(video, cues, env) {
  if (!env.SUBS || !Array.isArray(cues) || cues.length === 0) return null;

  const chave = captionsKey(video);
  const dias = Number(env.CAPTIONS_CACHE_DAYS || 180);
  await env.SUBS.put(chave, serializeSrt(cues), { expirationTtl: dias * 86400 }).catch(() => {});
  // A marca de «ja procurei e nao havia» tem de sair, senao o pedido seguinte
  // desiste antes de olhar para o que acabamos de guardar.
  await env.SUBS.delete(missKey(video)).catch(() => {});

  return { chave, deixas: cues.length };
}
