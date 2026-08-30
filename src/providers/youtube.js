/**
 * Legendas do proprio video oficial no YouTube.
 *
 * E' a fonte mais barata que existe para as series turcas, e passou despercebida
 * durante todo o desenho do addon: o canal oficial publica o episodio inteiro,
 * e o YouTube traz-lhe legendas — umas escritas por gente, outras geradas
 * automaticamente. Nos dois casos e' texto turco com marcas de tempo, que e'
 * exactamente o que o tradutor deste addon precisa.
 *
 * Contra a alternativa (transcrever o audio com o Whisper, em `src/asr/`):
 *
 *   | | legendas do YouTube | transcrever o audio |
 *   |---|---|---|
 *   | pedidos por episodio | 2 | ~130 |
 *   | bytes | dezenas de KB | 128 MB |
 *   | estrangulamento por IP | nao | sim, ao segundo MB |
 *   | qualidade | humana, quando `manual` | sempre automatica |
 *
 * Medido: *Kurulus Osman* 1. Bolum tem faixa `manual` com 1277 deixas; as
 * versoes 4K trazem `asr` com ~3100. O *Muhtemel Ask* nao tem nenhuma — ha
 * videos sem, e para esses continua a nao haver legenda em lado nenhum.
 */

import { watchConfig, playerResponse } from '../youtube/player.js';

/** A faixa turca, preferindo a escrita por gente a` gerada pela maquina. */
export function pickTrack(tracks, lang = 'tr') {
  const doIdioma = (tracks || []).filter((track) => track.languageCode === lang);
  if (!doIdioma.length) return null;
  // `kind: 'asr'` marca a automatica; a ausencia do campo marca a humana.
  return doIdioma.find((track) => track.kind !== 'asr') || doIdioma[0];
}

/** O formato `json3` do YouTube -> deixas com tempos em milissegundos. */
export function json3ToCues(payload) {
  const eventos = (payload && payload.events) || [];

  return eventos
    .filter((evento) => Array.isArray(evento.segs))
    .map((evento) => {
      const texto = evento.segs
        .map((seg) => seg.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const inicio = Number(evento.tStartMs || 0);
      // Sem duracao declarada da'-se-lhe dois segundos: uma deixa sem duracao
      // nao chega a aparecer no leitor.
      const duracao = Number(evento.dDurationMs || 0) || 2000;
      return { start: inicio, end: inicio + duracao, text: texto };
    })
    .filter((cue) => cue.text);
}

/**
 * Arruma as deixas do ASR do YouTube.
 *
 * O reconhecimento automatico emite em janela deslizante: as deixas
 * sobrepoem-se no tempo e repetem texto ja mostrado. Medido no *Askin Gucu*:
 * 5759 deixas, com a primeira a acabar (5,160 s) depois de a segunda comecar
 * (2,879 s). Servir isto tal e qual dava legendas a piscar — e 5759 chamadas
 * ao tradutor, muito acima do tecto de `MAX_TRANSLATE_CALLS`.
 *
 * Duas correccoes, ambas conservadoras:
 *   - o fim de cada deixa e' cortado no inicio da seguinte;
 *   - deixas cujo texto ja aparece na seguinte sao descartadas, porque sao o
 *     mesmo texto a ser escrito aos poucos.
 */
export function tidyCues(cues, minMillis = 3500, maxChars = 110, maxMillis = 7000) {
  const ordenadas = cues.slice().sort((a, b) => a.start - b.start);
  const saida = [];

  for (let i = 0; i < ordenadas.length; i += 1) {
    const atual = { ...ordenadas[i] };
    const seguinte = ordenadas[i + 1];

    if (seguinte) {
      // O ASR escreve a frase por pedacos: cada deixa e' o inicio da proxima.
      // Fica a versao mais completa, que e' a ultima.
      if (seguinte.text.startsWith(atual.text)) continue;
      if (seguinte.start > atual.start && seguinte.start < atual.end) {
        atual.end = seguinte.start;
      }
    }

    // Uma deixa curta demais passa como um piscar; junta-se a` anterior. Isto
    // nao e' so cosmetica: o ASR parte a fala em pedacos de um segundo, e o
    // episodio inteiro sao milhares de deixas — muito acima do que o tecto de
    // `MAX_TRANSLATE_CALLS` deixa traduzir. Juntar reduz para ordem util.
    const anterior = saida[saida.length - 1];
    const curta = atual.end - atual.start < minMillis;
    // Juntar sem tecto produzia deixas de 34 segundos, que ninguem le: uma
    // legenda vive entre um e sete segundos no ecra.
    const cabeNoTempo = anterior && atual.end - anterior.start <= maxMillis;
    if (curta && anterior && cabeNoTempo && `${anterior.text} ${atual.text}`.length <= maxChars) {
      anterior.end = Math.max(anterior.end, atual.end);
      if (!anterior.text.endsWith(atual.text)) anterior.text = `${anterior.text} ${atual.text}`.trim();
      continue;
    }

    saida.push(atual);
  }

  return saida;
}

/**
 * Procura legendas para um video do YouTube.
 *
 * Devolve `{ cues, kind, lang }` quando encontra, e `{ motivo }` quando nao.
 * O motivo interessa: «este video nao tem legendas» e' definitivo, mas «o
 * YouTube recusou» e' passageiro — sao os IPs de datacentro a apanharem com a
 * defesa anti-bot, e uma tentativa daqui a uns minutos costuma passar.
 * Confundir os dois fazia o addon desistir de episodios que tinham legendas.
 */
export async function fetchYoutubeCaptions(videoId, env, lang = 'tr') {
  try {
    const config = await watchConfig(videoId);
    if (config.error) return { motivo: 'recusado' };

    const player = await playerResponse(videoId, config);
    if (player.status !== 'OK') return { motivo: 'recusado', status: player.status };

    const tracks = player.data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = pickTrack(tracks, lang);
    if (!track || !track.baseUrl) return { motivo: 'sem-faixa' };

    // O `baseUrl` ja traz um `fmt`; tem de ser substituido e nao acrescentado.
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');

    const response = await fetch(url.toString());
    if (!response.ok) return { motivo: 'recusado', status: response.status };

    const cruas = json3ToCues(await response.json());
    if (!cruas.length) return { motivo: 'sem-faixa' };

    // So o ASR precisa de ser arrumado; uma legenda escrita por gente ja vem
    // com os tempos certos e mexer nela so a estragava.
    const asr = track.kind === 'asr';
    const cues = asr ? tidyCues(cruas) : cruas;

    return { cues, kind: asr ? 'asr' : 'manual', lang, cruas: cruas.length };
  } catch {
    return { motivo: 'recusado' };
  }
}
