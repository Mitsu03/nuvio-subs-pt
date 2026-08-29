/**
 * Manifesto DASH para os formatos que o plugin extrai no aparelho.
 *
 * Porque e' preciso: o YouTube so serve video e audio juntos num ficheiro ate'
 * aos 360p (itag 18). O 1080p existe, mas separado — video de um lado, audio
 * do outro. O contrato dos plugins do Nuvio tem um `url` unico, portanto sem
 * manifesto o tecto e' 360p.
 *
 * O leitor do NuvioTV traz `media3-exoplayer-dash`, e um manifesto e' um
 * ficheiro de texto: junta as duas faixas num so endereco.
 *
 * O Worker nao serve video nenhum. Recebe a lista de formatos que o aparelho
 * extraiu, escreve o XML e serve so o XML; os segmentos vao do googlevideo
 * direitos ao aparelho. E' isso que faz a coisa funcionar de todo — os
 * enderecos do googlevideo estao presos ao IP que os pediu, e quem os pediu
 * foi o aparelho.
 */

const HOST_SUFFIX = '.googlevideo.com';

/** Ao fim disto os enderecos do googlevideo ja expiraram. */
const TTL_SECONDS = 6 * 3600;

const MAX_REPRESENTATIONS = 12;
const MAX_BODY_BYTES = 96 * 1024;

/**
 * Aceita apenas enderecos do googlevideo.
 *
 * Este endpoint recebe URLs de fora, e sem esta verificacao o Worker passava a
 * publicar, no seu proprio dominio, um documento que aponta para onde quem
 * chamasse quisesse. O resto do XML e' escrito aqui e nunca copiado da entrada.
 */
export function isGoogleVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith(HOST_SUFFIX);
  } catch {
    return false;
  }
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `{start, end}` -> `"742-20297"`, ou vazio quando nao da' para usar. */
function range(value) {
  if (!value) return '';
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return '';
  return `${start}-${end}`;
}

/** Fica so com os formatos utilizaveis, ja normalizados. */
function usableFormats(list, kind) {
  const out = [];

  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !isGoogleVideoUrl(item.url)) continue;

    const init = range(item.initRange);
    const index = range(item.indexRange);
    // Sem os dois intervalos o leitor nao sabe onde acaba o cabecalho nem onde
    // esta o indice, e uma Representation assim nunca chega a tocar.
    if (init === '' || index === '') continue;

    const codecs = typeof item.codecs === 'string' ? item.codecs.slice(0, 64) : '';
    const bitrate = Math.round(Number(item.bitrate));
    if (codecs === '' || !Number.isFinite(bitrate) || bitrate <= 0) continue;

    const common = {
      url: item.url,
      codecs,
      bitrate,
      init,
      index,
      itag: Math.round(Number(item.itag)) || 0,
    };

    if (kind === 'video') {
      const width = Math.round(Number(item.width));
      const height = Math.round(Number(item.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) continue;
      const fps = Math.round(Number(item.fps));
      out.push({ ...common, width, height, fps: Number.isFinite(fps) && fps > 0 ? fps : 25 });
    } else {
      const rate = Math.round(Number(item.audioSampleRate));
      const channels = Math.round(Number(item.channels));
      out.push({
        ...common,
        audioSampleRate: Number.isFinite(rate) && rate > 0 ? rate : 44100,
        channels: Number.isFinite(channels) && channels > 0 ? channels : 2,
      });
    }
  }

  const weight = kind === 'video' ? (item) => item.height : (item) => item.bitrate;
  out.sort((a, b) => weight(b) - weight(a));

  // O YouTube devolve cada itag duas vezes — a mesma faixa e a variante com
  // volume normalizado, com bitrates quase iguais. Duas Representation com o
  // mesmo id fazem um manifesto invalido, por isso fica a melhor de cada.
  const seen = new Set();
  const unique = [];
  for (const format of out) {
    if (seen.has(format.itag)) continue;
    seen.add(format.itag);
    unique.push(format);
  }

  return unique.slice(0, MAX_REPRESENTATIONS);
}

function representation(format, kind) {
  const attributes =
    kind === 'video'
      ? `width="${format.width}" height="${format.height}" frameRate="${format.fps}"`
      : `audioSamplingRate="${format.audioSampleRate}"`;

  const channels =
    kind === 'audio'
      ? '\n        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011"' +
        ` value="${format.channels}"/>`
      : '';

  return (
    `      <Representation id="${format.itag}" codecs="${escapeXml(format.codecs)}" ${attributes}` +
    ` bandwidth="${format.bitrate}" startWithSAP="1">` +
    channels +
    `\n        <BaseURL>${escapeXml(format.url)}</BaseURL>` +
    `\n        <SegmentBase indexRange="${format.index}">` +
    `\n          <Initialization range="${format.init}"/>` +
    '\n        </SegmentBase>' +
    '\n      </Representation>'
  );
}

/** `8331` -> `PT8331.0S`, que e' a forma que o esquema do DASH quer. */
function isoDuration(seconds) {
  return `PT${Math.max(1, Math.round(Number(seconds) || 0))}.0S`;
}

/** Contentor da faixa. O leitor nao troca entre mp4 e webm no mesmo conjunto. */
function containerOf(format, kind) {
  if (kind === 'audio') return /^opus/i.test(format.codecs) ? 'audio/webm' : 'audio/mp4';
  return /^(av01|vp0?9)/i.test(format.codecs) ? 'video/webm' : 'video/mp4';
}

/**
 * Escreve o manifesto. Devolve `null` quando falta video ou audio: um
 * manifesto a meio e' pior do que manifesto nenhum, porque o leitor abre e
 * fica mudo em vez de dar erro.
 *
 * @param {{durationSeconds:number, video:Array, audio:Array}} input
 * @returns {string|null}
 */
export function buildMpd(input) {
  const video = usableFormats(input && input.video, 'video');
  const audio = usableFormats(input && input.audio, 'audio');
  if (video.length === 0 || audio.length === 0) return null;

  const groups = [];
  for (const kind of ['video', 'audio']) {
    const byContainer = new Map();
    for (const format of kind === 'video' ? video : audio) {
      const mime = containerOf(format, kind);
      if (!byContainer.has(mime)) byContainer.set(mime, []);
      byContainer.get(mime).push(format);
    }
    for (const [mime, list] of byContainer) {
      groups.push(
        `    <AdaptationSet mimeType="${mime}" lang="tr" segmentAlignment="true"` +
          ' subsegmentAlignment="true" startWithSAP="1">\n' +
          list.map((format) => representation(format, kind)).join('\n') +
          '\n    </AdaptationSet>',
      );
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"',
    `  type="static" mediaPresentationDuration="${isoDuration(input.durationSeconds)}" minBufferTime="PT1.5S">`,
    '  <Period>',
    groups.join('\n'),
    '  </Period>',
    '</MPD>',
    '',
  ].join('\n');
}

/**
 * Guarda o manifesto e devolve o endereco por onde o leitor o vai buscar.
 *
 * @returns {Promise<{url:string}|{error:string, status:number}>}
 */
export async function storeMpd(input, env, origin) {
  if (!env.SUBS) return { error: 'cache KV nao esta configurada', status: 503 };

  const mpd = buildMpd(input);
  if (!mpd) return { error: 'sem faixas de video e audio utilizaveis', status: 400 };

  // Identificador de 128 bits. E' o unico segredo que protege o manifesto, e
  // adivinha-lo nao daria nada de util: os enderecos la dentro so respondem ao
  // IP que os pediu, que e' o do aparelho de quem extraiu.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  await env.SUBS.put(`dash:${id}`, mpd, { expirationTtl: TTL_SECONDS });
  return { url: `${origin}/dash/${id}.mpd` };
}

/** Le o manifesto guardado. */
export async function readMpd(id, env) {
  if (!env.SUBS || !/^[0-9a-f]{32}$/.test(String(id || ''))) return null;
  return env.SUBS.get(`dash:${id}`).catch(() => null);
}

export { MAX_BODY_BYTES, TTL_SECONDS };
