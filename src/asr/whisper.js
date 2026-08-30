/**
 * Transcricao do audio turco, com o Whisper do Workers AI.
 *
 * O `whisper-large-v3-turbo` recebe o audio em base64 e devolve segmentos com
 * marcas de tempo, que e' precisamente o que uma legenda precisa. O modelo
 * antigo (`@cf/openai/whisper`) recebe bytes crus e devolve `vtt`; fica como
 * reserva, porque um modelo descontinuado ja partiu este addon uma vez.
 */

const MODELS = ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper'];

export function isAvailable(env) {
  return Boolean(env.AI);
}

/** Bytes -> base64, aos bocados: um `apply` sobre 8 MB rebenta a pilha. */
function toBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

/** Segmentos normalizados a partir do que cada modelo devolve. */
function readSegments(response) {
  if (!response) return null;

  // whisper-large-v3-turbo: { segments: [{ start, end, text }], text }
  if (Array.isArray(response.segments) && response.segments.length) {
    return response.segments
      .map((segment) => ({
        start: Number(segment.start),
        end: Number(segment.end),
        text: String(segment.text || '').trim(),
      }))
      .filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
  }

  // whisper antigo: { text, words: [{ word, start, end }] } — sem segmentos
  // aproveitaveis, e um bloco inteiro numa deixa so nao serve como legenda.
  return null;
}

/**
 * Transcreve um bloco. `offsetSeconds` desloca as marcas para a posicao do
 * bloco dentro do episodio.
 */
export async function transcribeBlock(mp4, offsetSeconds, env) {
  if (!env.AI) return { error: 'Workers AI nao esta ligado' };

  const audio = toBase64(mp4);
  const models = String(env.WHISPER_MODEL || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const candidates = models.length ? [...models, ...MODELS] : MODELS;

  let last = null;
  for (const model of candidates) {
    try {
      const response = await env.AI.run(model, {
        audio,
        language: env.ASR_LANGUAGE || 'tr',
        task: 'transcribe',
      });

      const segments = readSegments(response);
      if (!segments || !segments.length) {
        last = `${model}: resposta sem segmentos`;
        continue;
      }

      return {
        model,
        segments: segments.map((segment) => ({
          start: Number((segment.start + offsetSeconds).toFixed(3)),
          end: Number((segment.end + offsetSeconds).toFixed(3)),
          text: segment.text,
        })),
      };
    } catch (error) {
      // Um modelo descontinuado ou uma quota esgotada nao devem matar o
      // episodio inteiro: passa-se ao seguinte da lista.
      last = `${model}: ${error && error.message}`;
    }
  }

  return { error: last || 'nenhum modelo respondeu' };
}
