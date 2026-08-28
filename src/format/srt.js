/**
 * Leitura e escrita de legendas SRT/VTT.
 *
 * Tudo aqui e' puro (string -> string) para poder ser testado com `node --test`
 * sem precisar do runtime dos Workers.
 */

const TIMECODE = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** Converte um timecode SRT/VTT em milissegundos. */
function toMillis(h, m, s, ms) {
  return (
    Number(h) * 3600000 +
    Number(m) * 60000 +
    Number(s) * 1000 +
    Number(ms.padEnd(3, '0'))
  );
}

/** Formata milissegundos como `hh:mm:ss,mmm`. */
export function formatTimecode(millis) {
  const clamped = Math.max(0, Math.round(millis));
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const ms = clamped % 1000;
  const pad = (value, size) => String(value).padStart(size, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/**
 * Faz o parse de SRT ou WebVTT e devolve as deixas normalizadas.
 * Tolera numeracao em falta, timecodes com ponto decimal, definicoes de cue do
 * VTT a seguir ao timecode e blocos separados por mais de uma linha em branco.
 */
export function parseSubtitle(text) {
  const normalized = String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');

  const cues = [];
  const blocks = normalized.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    const timeIndex = lines.findIndex((line) => TIMECODE.test(line));
    if (timeIndex === -1) continue; // cabecalho WEBVTT, NOTE, STYLE, lixo

    const match = lines[timeIndex].match(TIMECODE);
    const body = lines.slice(timeIndex + 1).join('\n').trim();
    if (body === '') continue;

    cues.push({
      start: toMillis(match[1], match[2], match[3], match[4]),
      end: toMillis(match[5], match[6], match[7], match[8]),
      text: body,
    });
  }

  return cues;
}

/** Serializa deixas para SRT com numeracao sequencial. */
export function serializeSrt(cues) {
  return (
    cues
      .map((cue, i) => {
        const head = `${i + 1}\n${formatTimecode(cue.start)} --> ${formatTimecode(cue.end)}`;
        return `${head}\n${cue.text}`;
      })
      .join('\n\n') + '\n'
  );
}

const AD_PATTERNS = [
  /opensubtitles/i,
  /subscene/i,
  /addic7ed/i,
  /podnapisi/i,
  /subdl/i,
  /legendas\.?tv/i,
  /advertise your product/i,
  /anuncie o seu produto/i,
  /watch .{0,20}(online|free)/i,
  /for free/i,
  // Qualquer dominio, e nao so os TLD classicos: a publicidade destas fontes
  // usa muito .link, .info, .xyz e afins.
  /\b(www\.|https?:\/\/)[a-z0-9-]{2,}\.[a-z]{2,10}\b/i,
];

/**
 * Remove as deixas promocionais que as fontes colam no inicio e no fim.
 * So mexe nas tres primeiras e tres ultimas para nao apagar dialogo real que
 * por acaso mencione um site.
 */
export function stripPromoCues(cues) {
  if (cues.length === 0) return cues;

  const isAd = (cue) => AD_PATTERNS.some((pattern) => pattern.test(cue.text));
  const edge = Math.min(3, cues.length);

  let start = 0;
  while (start < edge && isAd(cues[start])) start += 1;

  let end = cues.length;
  while (end > cues.length - edge && end > start && isAd(cues[end - 1])) end -= 1;

  return cues.slice(start, end);
}

/**
 * Junta as linhas de uma deixa numa so, para o tradutor receber uma frase
 * inteira em vez de fragmentos partidos pela mudanca de linha.
 */
export function flattenCueText(text) {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Reparte uma linha traduzida em no maximo duas linhas equilibradas, ao estilo
 * do que se espera de uma legenda. Nao parte quando ja cabe.
 */
export function wrapCueText(text, maxChars = 42) {
  const flat = flattenCueText(text);
  if (flat.length <= maxChars) return flat;

  // Dialogo com dois interlocutores parte-se naturalmente nos travessoes.
  const dialogue = flat.match(/^(-\s?[^-]+?)\s+(-\s?.+)$/);
  if (dialogue) return `${dialogue[1].trim()}\n${dialogue[2].trim()}`;

  const words = flat.split(' ');
  const middle = flat.length / 2;
  let best = null;
  let width = 0;

  for (let i = 0; i < words.length - 1; i += 1) {
    width += words[i].length + 1;
    const distance = Math.abs(width - middle);
    if (best === null || distance < best.distance) {
      best = { index: i + 1, distance };
    }
  }

  if (!best) return flat;
  return `${words.slice(0, best.index).join(' ')}\n${words.slice(best.index).join(' ')}`;
}

/** Preserva a marcacao HTML simples que o SRT admite. */
export function hasMarkup(text) {
  return /<[/]?[a-z]/i.test(text) || text.includes(String.fromCharCode(123, 92));
}
