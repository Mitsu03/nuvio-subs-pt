/**
 * Sonda de diagnostico: testa, a partir do proprio Worker, que fontes de
 * legendas aceitam pedidos vindos de IPs da Cloudflare.
 *
 * Lista de alvos fixa e sem parametros do exterior, para nao virar proxy.
 */

import { USER_AGENT } from './http.js';
import { modelList } from './translate/workersai.js';

async function probe(label, url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      redirect: 'follow',
    });
    const body = await response.arrayBuffer();
    return {
      label,
      status: response.status,
      bytes: body.byteLength,
      type: response.headers.get('content-type') || '',
      ms: Date.now() - started,
    };
  } catch (error) {
    return { label, status: 'erro', detail: error.message, ms: Date.now() - started };
  }
}

export async function runProbes(env) {
  const results = [];

  // 1. Busca no OpenSubtitles: sabemos que funciona, serve de controlo.
  const searchUrl = 'https://rest.opensubtitles.org/search/episode-1/imdbid-11093718/season-1/sublanguageid-eng';
  const search = await probe('opensubtitles:busca', searchUrl);
  results.push(search);

  // 2. Descarga de um link fresco obtido pelo proprio Worker. E o teste que
  //    interessa: mesmo IP a procurar e a descarregar, link acabado de gerar.
  try {
    const response = await fetch(searchUrl, { headers: { 'User-Agent': USER_AGENT } });
    const entries = await response.json();
    const link = Array.isArray(entries) && entries[0] ? entries[0].SubDownloadLink : null;
    results.push(
      link
        ? await probe('opensubtitles:descarga', link)
        : { label: 'opensubtitles:descarga', status: 'sem link' },
    );
  } catch (error) {
    results.push({ label: 'opensubtitles:descarga', status: 'erro', detail: error.message });
  }

  // 3. Alcançabilidade dos outros candidatos. Um 401/403 por falta de chave
  //    ainda mostra que o host aceita o pedido; um bloqueio de rede nao.
  results.push(await probe('opensubtitles.com:api', 'https://api.opensubtitles.com/api/v1/infos/formats'));
  results.push(await probe('subdl:api', 'https://api.subdl.com/api/v1/subtitles?imdb_id=tt11093718'));
  results.push(await probe('subdl:descarga', 'https://dl.subdl.com/subtitle/0000000-0000000.zip'));
  results.push(
    await probe('podnapisi:busca', 'https://www.podnapisi.net/subtitles/search/advanced?keywords=osman&language=pt'),
  );
  results.push(await probe('podnapisi:raiz', 'https://www.podnapisi.net/'));

  // 4. O tradutor. Uma legenda pode chegar inteira e na mesma sair por traduzir
  //    se o binding AI falhar, porque o erro fica engolido no tratamento por
  //    lote — por isso e preciso um sitio onde ele apareca por extenso.
  const traducao = await probeTranslator(env);

  return { origem: 'cloudflare-worker', resultados: results, traducao };
}

async function probeTranslator(env) {
  if (!env.AI) return [{ estado: 'binding AI ausente' }];

  // Testa a lista toda, e nao so o primeiro: assim ve-se de relance quais os
  // modelos que ainda existem e quais foram descontinuados.
  const results = [];

  for (const model of modelList(env)) {
    const started = Date.now();
    try {
      const response = await env.AI.run(model, {
        messages: [
          {
            role: 'system',
            content: 'Traduz de ingles para portugues europeu. Devolve so as linhas numeradas.',
          },
          { role: 'user', content: '1. Good morning.\n2. The gate is closed.' },
        ],
        max_tokens: 200,
        temperature: 0.2,
      });

      const output = typeof response === 'string' ? response : response.response || '';
      results.push({ model, estado: 'ok', ms: Date.now() - started, saida: output.slice(0, 160) });
    } catch (error) {
      results.push({ model, estado: 'erro', ms: Date.now() - started, detalhe: error.message.slice(0, 160) });
    }
  }

  return results;
}
