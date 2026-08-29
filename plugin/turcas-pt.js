/**
 * Plugin do NuvioTV: episodios turcos dos canais oficiais, em 1080p.
 *
 * Corre no aparelho, em QuickJS, com o `fetch` que o Nuvio injecta. Isso nao e'
 * arrumacao: os enderecos do googlevideo so respondem ao IP que os pediu, e a
 * extracao a partir de um datacentro devolve `UNPLAYABLE`. Correr aqui e' a
 * diferenca entre tocar e nao tocar.
 *
 * Divisao de trabalho:
 *   Worker  — sabe qual e' o video certo (titulo turco, numeracao corrida,
 *             fragman a descartar). Ja publicado e testado.
 *   Plugin  — extrai os formatos a partir da rede do utilizador e pede ao
 *             Worker o manifesto que junta video e audio.
 *
 * Limites do runtime que moldaram isto:
 *   - O `fetch` corta a resposta ao fim de 1 MB. A pagina do YouTube tem
 *     1,37 MB, mas a chave e o `visitorData` aparecem por volta do byte 55 000.
 *   - O codigo e' embrulhado num IIFE, portanto a funcao tem de sair por
 *     `module.exports`; uma funcao de topo aqui nao fica global.
 */

var WORKER_ORIGIN = '__WORKER_ORIGIN__';

var ANDROID = {
  name: 'ANDROID',
  version: '20.10.35',
  userAgent: 'com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip',
};

var BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Quantas faixas de cada codec enviar. Chega para o leitor adaptar a largura. */
var MAX_PER_CODEC = 6;
var MAX_AUDIO = 2;

function log(message) {
  try {
    console.log('[TurcasPT] ' + message);
  } catch (error) {
    /* o Plugin Tester nem sempre tem consola */
  }
}

/** O id que o addon percebe: `tmdb:322499:1:1`, sem sufixo nos filmes. */
function addonId(tmdbId, isSeries, season, episode) {
  return isSeries ? 'tmdb:' + tmdbId + ':' + season + ':' + episode : 'tmdb:' + tmdbId;
}

/**
 * Pergunta ao Worker qual e' o video oficial deste episodio. Devolve lista
 * vazia para tudo o que nao seja turco, que e' a resposta certa.
 */
async function findVideos(tmdbId, isSeries, season, episode) {
  var type = isSeries ? 'series' : 'movie';
  // Porta propria, e nao `/stream`: essa respeita o interruptor que esconde as
  // entradas do addon, e o plugin nao pode ficar refem dele.
  var url =
    WORKER_ORIGIN +
    '/plugin/video/' +
    type +
    '/' +
    encodeURIComponent(addonId(tmdbId, isSeries, season, episode)) +
    '.json';

  var response = await fetch(url);
  if (!response.ok) {
    log('o addon respondeu ' + response.status);
    return [];
  }

  var data = await response.json();
  var streams = (data && data.streams) || [];
  var out = [];

  for (var i = 0; i < streams.length; i += 1) {
    if (streams[i].ytId) {
      out.push({ id: streams[i].ytId, title: String(streams[i].title || '').split('\n')[0] });
    }
  }
  return out;
}

/**
 * Tira da pagina do video a chave da API e o `visitorData`.
 *
 * O `visitorData` e' o que faltava numa primeira tentativa sem ele: sem sessao,
 * o `youtubei/v1/player` responde `UNPLAYABLE`.
 */
async function watchConfig(videoId) {
  var response = await fetch('https://www.youtube.com/watch?v=' + videoId, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'tr-TR,tr;q=0.9', Cookie: 'SOCS=CAI' },
  });
  if (!response.ok) return null;

  var html = await response.text();
  var key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  var visitor = html.match(/"visitorData":"([^"]+)"/);
  if (!key || !visitor) {
    log('nao encontrei a configuracao na pagina do video');
    return null;
  }

  // O valor vem escapado como texto de JSON.
  var visitorData;
  try {
    visitorData = JSON.parse('"' + visitor[1] + '"');
  } catch (error) {
    visitorData = visitor[1];
  }

  return { apiKey: key[1], visitorData: visitorData };
}

/** Pede os formatos ao YouTube, com o cliente que ainda os entrega. */
async function playerResponse(videoId, config) {
  var body = {
    videoId: videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: ANDROID.name,
        clientVersion: ANDROID.version,
        hl: 'tr',
        gl: 'TR',
        visitorData: config.visitorData,
      },
    },
  };

  var response = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + config.apiKey, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ANDROID.userAgent,
      'x-goog-visitor-id': config.visitorData,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;

  var data = await response.json();
  var status = data && data.playabilityStatus && data.playabilityStatus.status;
  if (status !== 'OK') {
    log('o YouTube recusou: ' + status);
    return null;
  }
  return data;
}

function codecsOf(format) {
  var match = String(format.mimeType || '').match(/codecs="([^"]+)"/);
  return match ? match[1] : '';
}

/**
 * Separa as faixas.
 *
 * Vao dois codecs de video, e de proposito: o `avc1` do YouTube nao passa dos
 * 1080p, e o 4K so existe em `vp9` (e `av01`, que muitas televisoes ainda nao
 * descodificam por hardware). O manifesto leva os dois em conjuntos separados e
 * e' o leitor que escolhe o melhor que o aparelho aguenta — cai no `avc1`
 * sozinho quando nao sabe ler `vp9`.
 *
 * O audio fica em `mp4a`, que toca em tudo.
 */
function splitFormats(data) {
  var streaming = data.streamingData || {};
  var adaptive = streaming.adaptiveFormats || [];
  var avc = [];
  var vp9 = [];
  var audio = [];

  for (var i = 0; i < adaptive.length; i += 1) {
    var format = adaptive[i];
    if (!format.url || !format.initRange || !format.indexRange) continue;

    var codecs = codecsOf(format);
    var mime = String(format.mimeType || '');

    var isAvc = mime.indexOf('video/mp4') === 0 && codecs.indexOf('avc1') === 0;
    var isVp9 = mime.indexOf('video/webm') === 0 && /^vp0?9/.test(codecs);

    if (isAvc || isVp9) {
      (isAvc ? avc : vp9).push({
        itag: format.itag,
        url: format.url,
        codecs: codecs,
        width: format.width,
        height: format.height,
        fps: format.fps,
        bitrate: format.bitrate,
        initRange: format.initRange,
        indexRange: format.indexRange,
      });
    } else if (mime.indexOf('audio/mp4') === 0 && codecs.indexOf('mp4a') === 0) {
      audio.push({
        itag: format.itag,
        url: format.url,
        codecs: codecs,
        bitrate: format.bitrate,
        audioSampleRate: Number(format.audioSampleRate),
        channels: format.audioChannels,
        initRange: format.initRange,
        indexRange: format.indexRange,
      });
    }
  }

  var byHeight = function (a, b) {
    return (b.height || 0) - (a.height || 0);
  };
  avc.sort(byHeight);
  vp9.sort(byHeight);
  audio.sort(function (a, b) {
    return (b.bitrate || 0) - (a.bitrate || 0);
  });

  // Ficheiro unico, video e audio juntos. Nunca passa dos 360p, mas nao depende
  // do manifesto nem do Worker: e' a rede de seguranca.
  var progressive = null;
  var plain = streaming.formats || [];
  for (var j = 0; j < plain.length; j += 1) {
    if (plain[j].url && String(plain[j].mimeType || '').indexOf('video/mp4') === 0) {
      progressive = plain[j];
      break;
    }
  }

  return {
    video: vp9.slice(0, MAX_PER_CODEC).concat(avc.slice(0, MAX_PER_CODEC)),
    audio: audio.slice(0, MAX_AUDIO),
    progressive: progressive,
  };
}

/** Pede ao Worker o manifesto que junta as duas faixas. */
async function manifestUrl(formats, durationSeconds) {
  var response = await fetch(WORKER_ORIGIN + '/dash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      durationSeconds: durationSeconds,
      video: formats.video,
      audio: formats.audio,
    }),
  });
  if (!response.ok) {
    log('o Worker recusou o manifesto: ' + response.status);
    return null;
  }

  var data = await response.json();
  return (data && data.url) || null;
}

/**
 * @param {string} tmdbId
 * @param {string} mediaType `movie` ou `tv`
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {Promise<Array>}
 */
async function getStreams(tmdbId, mediaType, season, episode) {
  var isSeries = mediaType !== 'movie';
  var results = [];

  try {
    var videos = await findVideos(tmdbId, isSeries, season, episode);
    if (videos.length === 0) {
      log('sem video oficial para tmdb:' + tmdbId);
      return [];
    }

    var video = videos[0];
    log('video escolhido: ' + video.id + ' (' + video.title + ')');

    var config = await watchConfig(video.id);
    if (!config) return [];

    var data = await playerResponse(video.id, config);
    if (!data) return [];

    var duration = Number((data.videoDetails && data.videoDetails.lengthSeconds) || 0);
    var formats = splitFormats(data);

    if (formats.video.length > 0 && formats.audio.length > 0) {
      var url = await manifestUrl(formats, duration);
      if (url) {
        var height = 0;
        for (var k = 0; k < formats.video.length; k += 1) {
          if ((formats.video[k].height || 0) > height) height = formats.video[k].height;
        }
        results.push({
          name: 'Turcas PT',
          title: video.title + ' - audio turco original',
          url: url,
          quality: height >= 2160 ? '4K' : height + 'p',
        });
      }
    }

    // A reserva vai sempre atras. So fica sozinha quando o manifesto falha, e
    // nesse caso 360p e' melhor do que nada.
    if (formats.progressive) {
      results.push({
        name: 'Turcas PT',
        title: video.title + ' - audio turco original (ficheiro unico)',
        url: formats.progressive.url,
        quality: (formats.progressive.height || 360) + 'p',
        headers: { 'User-Agent': ANDROID.userAgent },
      });
    }

    log('devolvi ' + results.length + ' streams');
    return results;
  } catch (error) {
    log('falhou: ' + (error && error.message ? error.message : error));
    return results;
  }
}

module.exports = { getStreams: getStreams };
