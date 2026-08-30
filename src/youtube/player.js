/**
 * Extracao dos formatos de um video do YouTube, do lado do Worker.
 *
 * O plugin do NuvioTV ja faz isto no aparelho, e por uma razao: os enderecos do
 * `googlevideo` levam o `ip=` de quem os pediu dentro do proprio URL, e so
 * respondem a esse IP. A duvida que trava a transcricao do audio e' se a mesma
 * receita funciona a partir de um datacentro da Cloudflare — se funcionar, o
 * Worker extrai os seus proprios enderecos, ligados ao IP dele, e descarrega o
 * audio sozinho.
 *
 * A tentativa que falhou com `UNPLAYABLE` foi feita sem `visitorData`. Aqui vai
 * a receita completa, igual a do plugin: raspar a pagina, tirar
 * `INNERTUBE_API_KEY` + `visitorData`, e chamar `youtubei/v1/player` com o
 * cliente ANDROID e o cabecalho `x-goog-visitor-id`.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSER_UA_LATE = BROWSER_UA;

const ANDROID = {
  name: 'ANDROID',
  version: '20.10.35',
  userAgent: 'com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip',
};

/**
 * Perfis de cliente a experimentar. Nao e' zelo a mais: o YouTube trata cada um
 * de maneira diferente conforme a origem do pedido, e a diferenca entre uns e
 * outros e' precisamente o que a experiencia 0 tem de medir.
 */
export const CLIENTS = [
  { id: 'ANDROID', client: { clientName: 'ANDROID', clientVersion: ANDROID.version }, userAgent: ANDROID.userAgent },
  {
    id: 'IOS',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2' },
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  },
  {
    id: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    client: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      clientScreen: 'EMBED',
    },
    embed: true,
    userAgent:
      'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15',
  },
  {
    id: 'WEB_EMBEDDED_PLAYER',
    client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00', clientScreen: 'EMBED' },
    embed: true,
    userAgent: BROWSER_UA_LATE,
  },
  { id: 'MWEB', client: { clientName: 'MWEB', clientVersion: '2.20250310.01.00' },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
];



/** Itag do audio m4a de 128 kbps — o que serve para transcrever. */
export const AUDIO_ITAG = 140;

export { ANDROID, BROWSER_UA };

/** Tira da pagina do video a chave da API e o `visitorData`. */
export async function watchConfig(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'tr-TR,tr;q=0.9', Cookie: 'SOCS=CAI' },
  });
  if (!response.ok) return { error: `pagina do video: ${response.status}` };

  const html = await response.text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const visitor = html.match(/"visitorData":"([^"]+)"/);
  if (!key || !visitor) {
    return { error: 'nao encontrei INNERTUBE_API_KEY / visitorData na pagina', bytes: html.length };
  }

  // O valor vem escapado como texto de JSON.
  let visitorData;
  try {
    visitorData = JSON.parse(`"${visitor[1]}"`);
  } catch {
    visitorData = visitor[1];
  }

  return { apiKey: key[1], visitorData, bytes: html.length };
}

/** Pede os formatos ao YouTube com um dos perfis de cliente. */
export async function playerResponse(videoId, config, profile = CLIENTS[0]) {
  const body = {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: { ...profile.client, hl: 'tr', gl: 'TR', visitorData: config.visitorData },
      ...(profile.embed
        ? { thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` } }
        : {}),
    },
  };

  const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${config.apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': profile.userAgent,
      'x-goog-visitor-id': config.visitorData,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { error: `youtubei/v1/player: ${response.status}` };

  const data = await response.json();
  const status = data?.playabilityStatus?.status || 'sem status';
  if (status !== 'OK') {
    return { status, reason: data?.playabilityStatus?.reason || '' };
  }
  return { status, data };
}

/** A faixa de audio que interessa, com os cortes ja calculados pelo YouTube. */
export function audioTrack(playerData, itag = AUDIO_ITAG) {
  const formats = playerData?.streamingData?.adaptiveFormats || [];
  const exact = formats.find((format) => format.itag === itag);
  // Se o itag preferido nao vier, serve qualquer audio — o que conta e' ter
  // `initRange`/`indexRange`, que sao os cortes que o Whisper vai precisar.
  const track =
    exact || formats.filter((format) => String(format.mimeType || '').startsWith('audio/'))[0];
  if (!track) return null;

  return {
    itag: track.itag,
    mimeType: track.mimeType,
    bitrate: track.bitrate,
    contentLength: Number(track.contentLength || 0),
    approxDurationMs: Number(track.approxDurationMs || 0),
    initRange: track.initRange || null,
    indexRange: track.indexRange || null,
    hasUrl: Boolean(track.url),
    // `signatureCipher` em vez de `url` significa que o endereco vem cifrado e
    // precisa do descodificador do player — o cliente ANDROID costuma evitar
    // isso, e se aparecer e' sinal de que a receita deixou de servir.
    ciphered: Boolean(track.signatureCipher || track.cipher),
    url: track.url || null,
  };
}
