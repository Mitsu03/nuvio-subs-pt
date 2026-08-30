/**
 * Worker do addon de legendas PT para o Nuvio.
 *
 * Serve dois addons a partir do mesmo Worker. O Nuvio resolve os recursos a
 * partir da base do manifesto (o URL de instalacao sem o `/manifest.json`), por
 * isso o addon turco tem as rotas dele todas debaixo de `/turcas`.
 *
 * Addon de legendas (`com.nuvio.subs.pt`):
 *   GET /                                     pagina com os enderecos
 *   GET /manifest.json                        manifesto
 *   GET /subtitles/{type}/{id}.json           lista de legendas
 *   GET /subtitles/{type}/{id}/{extra}.json   idem, com extras do Stremio
 *   GET /sub/{token}.srt                      o ficheiro, ja tratado
 *
 * Addon turco (`com.nuvio.turcas.pt`):
 *   GET /turcas/manifest.json                 manifesto
 *   GET /turcas/catalog/{type}/{id}.json      coleccoes turcas
 *   GET /turcas/stream/{type}/{id}.json       streams com audio turco
 *
 * Plugin do NuvioTV (repositorio a parte, endereco proprio):
 *   GET /plugin/manifest.json                 repositorio de plugins
 *   GET /plugin/video/{type}/{id}.json        qual e' o video oficial (so o plugin)
 *   GET /plugin/turcas-pt.js                  o plugin, com a origem injectada
 *   POST /dash                                guarda um manifesto DASH
 *   GET /dash/{id}.mpd                        serve-o ao leitor
 *
 * As rotas antigas sem prefixo (`/catalog/...`, `/stream/...`) continuam a
 * responder: quem instalou a versao de manifesto unico ainda as pede.
 */

import { buildSubsManifest, buildTurcasManifest, TURCAS_BASE } from './manifest.js';
import { parseVideoId, resolveTmdbToImdb, episodeHint } from './ids.js';
import { fetchJson } from './http.js';
import { searchAllProviders, rankCandidates, PT_LANGS } from './providers/index.js';
import { signToken, verifyToken } from './token.js';
import { cacheKey, readCache, writeCache, cacheTtlFor } from './cache.js';
import { buildSubtitle } from './subtitles.js';
import { resolveEngineName } from './translate/index.js';
import { renderLandingPage } from './landing.js';
import { runProbes } from './probe.js';
import { probePlayer } from './youtube/probe.js';
import { isEnabled as asrEnabled, readTranscript, readState, asrKey, runPass } from './asr/index.js';
import { ensureCaptions, captionsKey } from './captions.js';
import { watchConfig, playerResponse } from './youtube/player.js';
import { buildCatalog, parseSkip } from './catalogs.js';
import { isAnime } from './anime.js';
import { buildStreams } from './streams/index.js';
import { storeMpd, readMpd, MAX_BODY_BYTES } from './dash.js';
import { buildPluginManifest, buildPluginSource, PLUGIN_FILENAME } from './plugin/index.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      ...CORS,
      ...extraHeaders,
    },
  });
}

const LANG_LABEL = {
  pt: 'Portugues (PT)',
  'pt-BR': 'Portugues (BR)',
  en: 'Ingles',
  tr: 'Turco',
};

/** Linguas de partida aceites para traducao, por ordem de preferencia. */
function translateFromLangs(env) {
  return String(env.TRANSLATE_FROM || 'en,tr')
    .split(',')
    .map((lang) => lang.trim())
    .filter(Boolean);
}

/** Ordena as linguas PT pondo a preferida primeiro. */
function orderedPtLangs(env) {
  const preferred = env.PREFERRED_PT === 'pt-BR' ? 'pt-BR' : 'pt';
  return [preferred, ...PT_LANGS.filter((lang) => lang !== preferred)];
}

async function entryFor(candidate, video, env, request, options = {}) {
  // Alem da origem escolhida seguem algumas reservas. Uma fonte pode responder
  // a busca e recusar a descarga, e sem reservas isso dava um erro seco ao
  // utilizador em vez de simplesmente passar a proxima.
  const urls = [candidate.url, ...(options.fallbacks || []).map((item) => item.url)]
    .filter((url, index, all) => url && all.indexOf(url) === index)
    .slice(0, 5);

  const payload = {
    // Uma legenda vinda da transcricao nao tem origem para descarregar: leva a
    // chave de KV onde o texto turco ficou.
    ...(candidate.asr ? { asr: candidate.asr } : {}),
    urls,
    lang: options.targetLang || candidate.lang,
    src: options.translate ? candidate.lang : '',
    enc: candidate.encoding || '',
    hint: episodeHint(video),
    tr: options.translate ? 1 : 0,
  };

  const token = await signToken(payload, env.SIGNING_KEY);
  const origin = new URL(request.url).origin;

  // O utilizador tem de saber o que esta a ler: uma transcricao automatica de
  // audio turco erra nomes proprios de dizi historico, e uma legenda humana,
  // mesmo em ingles, vale mais.
  const label = candidate.origem
    ? `${LANG_LABEL[payload.lang] || payload.lang} (${candidate.origem})`
    : options.translate
      ? `${LANG_LABEL[payload.lang] || payload.lang} (auto, de ${LANG_LABEL[candidate.lang] || candidate.lang})`
      : `${LANG_LABEL[payload.lang] || payload.lang} - ${candidate.provider}`;

  return {
    entry: {
      id: `${candidate.id}${options.translate ? '-auto' : ''}`,
      url: `${origin}/sub/${token}.srt`,
      lang: payload.lang,
      // Campo nao normativo, mas varios clientes mostram-no na lista.
      name: label,
    },
    payload,
  };
}

async function handleSubtitles(request, env, ctx, type, rawId) {
  if (!env.SIGNING_KEY) {
    return json({ subtitles: [], error: 'SIGNING_KEY nao esta definida no Worker' }, 500);
  }

  const video = parseVideoId(rawId, type);
  if (!video) return json({ subtitles: [] });

  if (!video.imdbId && video.tmdbId) {
    video.imdbId = await resolveTmdbToImdb(video, env, fetchJson);
    if (!video.imdbId) return json({ subtitles: [] });
  }

  // Este addon e para filmes e series. O anime tem legendas portuguesas em
  // abundancia e addons dedicados, e as entradas daqui so acrescentavam ruido
  // a lista. `ANIME_POLICY` permite voltar atras sem mexer no codigo:
  //   exclude (omissao) — nada para anime
  //   no-translation    — serve as legendas reais, mas nao traduz
  //   include           — trata anime como tudo o resto
  const animePolicy = env.ANIME_POLICY || 'exclude';
  const anime = animePolicy === 'include' ? false : await isAnime(video, env).catch(() => false);

  // Sai antes de interrogar as fontes: nao vale a pena gastar os pedidos.
  if (anime && animePolicy === 'exclude') return json({ subtitles: [] });

  const skipTranslation = anime;

  const ptLangs = orderedPtLangs(env);
  const sourceLangs = translateFromLangs(env);
  const canTranslate = resolveEngineName(env) !== null;

  const searchLangs = canTranslate ? [...ptLangs, ...sourceLangs] : ptLangs;
  const candidates = rankCandidates(await searchAllProviders(video, searchLangs, env), video);

  const subtitles = [];

  // 1. Legendas portuguesas reais, na ordem de preferencia configurada. Cada
  //    entrada leva as outras da mesma lingua como reserva.
  for (const lang of ptLangs) {
    const forLang = candidates.filter((candidate) => candidate.lang === lang).slice(0, 5);
    for (const candidate of forLang) {
      const fallbacks = forLang.filter((item) => item !== candidate);
      const { entry } = await entryFor(candidate, video, env, request, { fallbacks });
      subtitles.push(entry);
    }
  }

  // 2. Se nao ha legenda na lingua preferida, traduz a melhor fonte disponivel.
  const preferred = ptLangs[0];
  const hasPreferred = subtitles.some((entry) => entry.lang === preferred);
  let prewarm = null;

  // A traducao automatica e sempre oferecida, mesmo quando ja ha legenda
  // portuguesa: a legenda humana pode estar dessincronizada ou vir marcada como
  // pt-PT sendo pt-BR, e nesses casos o utilizador quer poder trocar. Fica em
  // primeiro quando nao ha alternativa, e no fim quando ha.
  if (canTranslate && !skipTranslation) {
    // Reservas da mesma lingua de origem e, a seguir, das outras linguas
    // aceites: para traduzir serve qualquer uma, o que conta e ter texto.
    const bySourceLang = sourceLangs.map((lang) => candidates.filter((item) => item.lang === lang));

    for (const [index, forLang] of bySourceLang.entries()) {
      const source = forLang[0];
      if (!source) continue;

      const fallbacks = [...forLang.slice(1), ...bySourceLang.slice(index + 1).flat()];
      const { entry, payload } = await entryFor(source, video, env, request, {
        translate: true,
        targetLang: preferred,
        fallbacks,
      });

      if (hasPreferred) {
        subtitles.push(entry);
        // Sem aquecimento neste caso: so se traduz se o utilizador escolher,
        // para nao gastar o tradutor por uma entrada que talvez ninguem abra.
      } else {
        subtitles.unshift(entry);
        prewarm = payload;
      }
      break;
    }
  }

  // Ultimo recurso: transcrever o audio do proprio episodio.
  //
  // So corre quando nao existe legenda real em lingua nenhuma — nem portuguesa,
  // nem inglesa, nem turca. Uma legenda humana, mesmo em ingles, vale sempre
  // mais do que uma transcricao automatica, e por isso esta entrada nunca
  // compete com as outras: ou nao ha nada, ou nao aparece.
  //
  // E' o caso do *Muhtemel Ask*: zero ficheiros no OpenSubtitles, zero faixas
  // no video oficial, nem legendas automaticas do YouTube. Sem isto, o addon
  // devolve lista vazia — que era a resposta certa, mas nao ajudava ninguem.
  // Antes de pensar em transcrever: o video oficial costuma trazer legendas
  // turcas — umas escritas por gente, outras geradas pelo YouTube. Sao dois
  // pedidos e dezenas de KB, contra os 128 MB e ~130 pedidos da transcricao,
  // que nem sequer passa o estrangulamento por IP. Verificado no Kurulus
  // Osman: faixa `manual` com 1277 deixas.
  let resolvido = null;
  const resolveVideoId = async () => {
    if (resolvido !== null) return resolvido;
    try {
      const streams = await buildStreams(video, env);
      resolvido = (streams.streams || []).map((item) => item.ytId).filter(Boolean)[0] || '';
    } catch {
      resolvido = '';
    }
    return resolvido;
  };

  if (candidates.length === 0 && !anime) {
    const legendaYoutube = await ensureCaptions(video, env, resolveVideoId);
    if (legendaYoutube) {
      const { entry } = await entryFor(
        {
          id: `yt-${legendaYoutube.kind}`,
          lang: env.ASR_LANGUAGE || 'tr',
          asr: legendaYoutube.chave,
          origem: legendaYoutube.kind === 'asr' ? 'auto, do YouTube' : 'do YouTube',
          provider: 'youtube',
        },
        video,
        env,
        request,
        { translate: true, targetLang: preferred },
      );
      subtitles.unshift(entry);
    }
  }

  let arrancarAsr = false;

  if (asrEnabled(env) && subtitles.length === 0 && candidates.length === 0 && !anime) {
    const pronta = await readTranscript(video, env);

    if (pronta) {
      const { entry } = await entryFor(
        { id: 'asr-audio', lang: 'tr', asr: asrKey(video), origem: 'auto, do audio', provider: 'audio' },
        video,
        env,
        request,
        { translate: true, targetLang: preferred },
      );
      subtitles.unshift(entry);
    } else {
      // Ainda nao ha nada para servir. A transcricao arranca em segundo plano e
      // a legenda aparece num pedido seguinte — sao 18 blocos por episodio e
      // nao cabem todos na janela de um pedido.
      arrancarAsr = true;
    }
  }

  // A traducao demora; aquece-se a cache em segundo plano para o leitor nao
  // ficar a espera quando o utilizador escolher a entrada.
  if (prewarm && env.PREWARM !== '0' && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      (async () => {
        const key = await cacheKey(prewarm, env);
        if (await readCache(key, env)) return;
        try {
          const built = await buildSubtitle(prewarm, env, { progressKey: `${key}:tr` });
          const ttl = cacheTtlFor(prewarm, built);
          if (ttl !== 0) await writeCache(key, built.srt, env, ttl);
        } catch (error) {
          // O aquecimento e oportunista e nunca afecta a resposta, mas engolir
          // o erro em silencio ja custou dois diagnosticos as cegas.
          console.error('prewarm falhou:', error && error.message);
        }
      })(),
    );
  }

  // Uma passagem de transcricao por pedido. O estado fica em KV, por isso cada
  // visita ao episodio avanca mais um pedaco ate estar completo.
  if (arrancarAsr && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      (async () => {
        try {
          // Sem video oficial nao ha audio para transcrever, e a obra
          // provavelmente nem e' turca.
          const ytId = await resolveVideoId();
          if (!ytId) return;

          const resultado = await runPass(video, ytId, env);
          console.log('asr', asrKey(video), JSON.stringify(resultado));
        } catch (error) {
          console.error('asr falhou:', error && error.message);
        }
      })(),
    );
  }

  return json({ subtitles });
}

/**
 * Streams para um video.
 *
 * `fromPlugin` distingue quem pergunta, e nao e' zelo a mais: medido em
 * producao, o Nuvio continua a pedir `/stream` ao addon mesmo depois de o
 * manifesto deixar de anunciar o recurso. Fechar a rota a toda a gente era a
 * correccao obvia, mas calava o plugin — que pergunta por aqui qual e' o
 * video. Por isso o plugin tem porta propria e esta respeita o interruptor.
 */
async function handleStream(env, type, rawId, fromPlugin = false) {
  if (!fromPlugin && env.STREAMS === '0') return json({ streams: [] });

  const video = parseVideoId(rawId, type);
  if (!video) return json({ streams: [] });

  if (!video.imdbId && video.tmdbId) {
    video.imdbId = await resolveTmdbToImdb(video, env, fetchJson);
    if (!video.imdbId) return json({ streams: [] });
  }

  return json(await buildStreams(video, env));
}

/**
 * Recebe do plugin os formatos que ele extraiu e devolve o endereco do
 * manifesto. O corpo vem de fora, por isso ha um tecto de tamanho antes de
 * sequer se tentar interpretar.
 */
async function handleDashCreate(request, env) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return json({ error: 'corpo demasiado grande' }, 413);

  let body = null;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'corpo nao e JSON' }, 400);
  }

  const result = await storeMpd(body, env, new URL(request.url).origin);
  if (result.error) return json({ error: result.error }, result.status);

  return json(result, 200, { 'Cache-Control': 'no-store' });
}

async function handleSubFile(request, env, token) {
  if (!env.SIGNING_KEY) return new Response('SIGNING_KEY em falta', { status: 500, headers: CORS });

  const payload = await verifyToken(token, env.SIGNING_KEY);
  if (!payload) return new Response('Token invalido', { status: 403, headers: CORS });

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'inline; filename="legenda.srt"',
    'Cache-Control': 'public, max-age=86400',
    ...CORS,
  };

  const key = await cacheKey(payload, env);
  const cached = await readCache(key, env);
  if (cached) return new Response(cached, { headers: { ...headers, 'X-Cache': 'hit' } });

  try {
    const built = await buildSubtitle(payload, env, { progressKey: `${key}:tr` });
    const ttl = cacheTtlFor(payload, built);
    if (ttl !== 0) await writeCache(key, built.srt, env, ttl);

    return new Response(built.srt, {
      headers: {
        ...headers,
        'X-Cache': ttl === 0 ? 'skip' : 'miss',
        'X-Translate-Engine': built.engine || 'none',
        'X-Translate-Stats': `${built.translated}/${built.translated + built.failed}`,
        // Sem isto, uma traducao que falha por inteiro chega ao utilizador como
        // um ficheiro na lingua de partida, sem indicacao nenhuma do porque.
        ...(built.error ? { 'X-Translate-Error': String(built.error).slice(0, 180) } : {}),
      },
    });
  } catch (error) {
    return new Response(`Falhou a preparacao da legenda: ${error.message}`, {
      status: 502,
      headers: CORS,
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    if (path === '/' || path === '/configure') {
      return new Response(renderLandingPage(url.origin, env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
      });
    }

    if (path === '/manifest.json') return json(buildSubsManifest(env));
    if (path === `${TURCAS_BASE}/manifest.json`) return json(buildTurcasManifest(env));

    // Os recursos do addon turco chegam com o prefixo, os das instalacoes
    // antigas sem ele. Uma so normalizacao evita duplicar cada rota.
    const routePath = path.startsWith(`${TURCAS_BASE}/`)
      ? path.slice(TURCAS_BASE.length)
      : path;

    if (path === '/health') {
      return json({
        ok: true,
        translateEngine: resolveEngineName(env),
        kv: Boolean(env.SUBS),
        signingKey: Boolean(env.SIGNING_KEY),
        subdl: Boolean(env.SUBDL_API_KEY),
        streams: Boolean(env.TMDB_API_KEY) && env.STREAMS !== '0',
        youtubeApiKey: Boolean(env.YOUTUBE_API_KEY),
        plugin: buildPluginManifest().version,
      });
    }

    if (path === '/probe') return json(await runProbes(env));

    // Porque e' que um episodio nao tem legenda do YouTube: nao ha video
    // oficial, o YouTube recusou, ou o video nao tem faixas. Sem isto, «vazio»
    // era indistinguivel de «avariado».
    const capStatus = path.match(/^\/captions\/([^/]+)\/(.+?)\.json$/);
    if (capStatus) {
      const alvo = parseVideoId(capStatus[2], capStatus[1]);
      if (!alvo) return json({ error: 'id nao reconhecido' }, 400);
      if (!alvo.imdbId && alvo.tmdbId) alvo.imdbId = await resolveTmdbToImdb(alvo, env, fetchJson);
      if (!alvo.imdbId) return json({ error: 'sem id IMDb' }, 400);

      const chave = captionsKey(alvo);
      const guardado = env.SUBS ? await env.SUBS.get(chave).catch(() => null) : null;
      const marcado = env.SUBS ? await env.SUBS.get(`${chave}:miss`).catch(() => null) : null;

      const streams = await buildStreams(alvo, env).catch(() => ({ streams: [] }));
      const ytId = (streams.streams || []).map((item) => item.ytId).filter(Boolean)[0] || null;

      let faixas = null;
      if (ytId) {
        const config = await watchConfig(ytId);
        if (config.error) {
          faixas = { erro: config.error };
        } else {
          const player = await playerResponse(ytId, config);
          faixas =
            player.status === 'OK'
              ? {
                  lista: (
                    player.data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
                  ).map((t) => `${t.languageCode}/${t.kind || 'manual'}`),
                }
              : { player: player.status, motivo: player.reason || '' };
        }
      }

      return json(
        {
          chave,
          guardadas: Boolean(guardado),
          deixas: guardado ? (guardado.match(/-->/g) || []).length : 0,
          buscaFalhadaMarcada: Boolean(marcado),
          videoOficial: ytId,
          faixas,
        },
        200,
        { 'Cache-Control': 'no-store' },
      );
    }

    // Estado da transcricao de um episodio: pronto, a meio, ou por comecar.
    // Sem isto, um trabalho que corre em segundo plano durante varios pedidos
    // e' invisivel a quem espera pela legenda.
    const asrStatus = path.match(/^\/asr\/([^/]+)\/(.+?)\.json$/);
    if (asrStatus) {
      const alvo = parseVideoId(asrStatus[2], asrStatus[1]);
      if (!alvo) return json({ error: 'id nao reconhecido' }, 400);
      if (!alvo.imdbId && alvo.tmdbId) alvo.imdbId = await resolveTmdbToImdb(alvo, env, fetchJson);
      if (!alvo.imdbId) return json({ error: 'sem id IMDb' }, 400);

      // `?run=N` corre uma passagem a serio e devolve o resultado. Uma
      // transcricao que corre em segundo plano e falha e' invisivel; com isto
      // o erro vem no corpo da resposta em vez de se perder nos registos.
      let corrida = null;
      const pedidos = Number(url.searchParams.get('run') || 0);
      if (pedidos > 0) {
        const streams = await buildStreams(alvo, env);
        const ytId = (streams.streams || []).map((item) => item.ytId).filter(Boolean)[0];
        if (!ytId) {
          corrida = { error: 'sem video oficial para este episodio', streams: (streams.streams || []).length };
        } else {
          try {
            corrida = await runPass(alvo, ytId, { ...env, ASR_BLOCKS_PER_PASS: String(pedidos) });
          } catch (error) {
            // O erro tem de chegar a quem pediu: uma excepcao aqui derrubava o
            // Worker inteiro com `1101` e nao dizia nada sobre a causa.
            corrida = { error: String((error && error.message) || error), pilha: String((error && error.stack) || '').slice(0, 400) };
          }
          corrida.videoId = ytId;
        }
      }

      const pronta = await readTranscript(alvo, env);
      const estado = await readState(alvo, env);
      return json(
        {
          ligado: asrEnabled(env),
          chave: asrKey(alvo),
          pronta: Boolean(pronta),
          deixas: pronta ? (pronta.match(/-->/g) || []).length : 0,
          progresso: estado
            ? { feitos: Object.keys(estado.feitos || {}).length, total: estado.totalBlocos, falhas: estado.falhas, modelo: estado.modelo }
            : null,
          ...(corrida ? { corrida } : {}),
        },
        200,
        { 'Cache-Control': 'no-store' },
      );
    }

    // Experiencia 0 do plano: a extracao do audio funciona a partir de um IP de
    // datacentro? Sonda temporaria — sai quando a resposta estiver arrumada.
    const probeVideo = path.match(/^\/probe\/player\/([A-Za-z0-9_-]{11})$/);
    if (probeVideo) {
      return json(await probePlayer(probeVideo[1]), 200, { 'Cache-Control': 'no-store' });
    }

    // /catalog/series/{id}.json e /catalog/series/{id}/skip=40.json
    const catalog = routePath.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+?))?\.json$/);
    if (catalog) {
      const [, catalogType, catalogId, extra] = catalog;
      if (catalogType !== 'series') return json({ metas: [] });
      return json(await buildCatalog(catalogId, parseSkip(extra, url), env));
    }

    if (path === '/plugin/manifest.json') return json(buildPluginManifest());

    if (path === `/plugin/${PLUGIN_FILENAME}`) {
      return new Response(buildPluginSource(url.origin), {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          ...CORS,
        },
      });
    }

    const pluginVideo = path.match(/^\/plugin\/video\/([^/]+)\/(.+?)\.json$/);
    if (pluginVideo) return handleStream(env, pluginVideo[1], pluginVideo[2], true);

    if (path === '/dash' && request.method === 'POST') return handleDashCreate(request, env);

    const dashFile = path.match(/^\/dash\/([0-9a-f]{32})\.mpd$/);
    if (dashFile) {
      const mpd = await readMpd(dashFile[1], env);
      if (!mpd) return new Response('Manifesto expirado', { status: 404, headers: CORS });
      return new Response(mpd, {
        headers: {
          'Content-Type': 'application/dash+xml; charset=utf-8',
          // Curto de proposito: os enderecos la dentro expiram, e um manifesto
          // guardado pelo leitor depois de expirarem so da erro de rede.
          'Cache-Control': 'public, max-age=300',
          ...CORS,
        },
      });
    }

    const subFile = path.match(/^\/sub\/(.+)\.srt$/);
    if (subFile) return handleSubFile(request, env, subFile[1]);

    // Aceita a forma simples e a forma com extras do Stremio.
    const stream = routePath.match(/^\/stream\/([^/]+)\/(.+?)(?:\/[^/]*)?\.json$/);
    if (stream) return handleStream(env, stream[1], stream[2]);

    const subtitles = path.match(/^\/subtitles\/([^/]+)\/(.+?)(?:\/[^/]*)?\.json$/);
    if (subtitles) {
      return handleSubtitles(request, env, ctx, subtitles[1], subtitles[2]);
    }

    return new Response('Nao encontrado', { status: 404, headers: CORS });
  },
};
