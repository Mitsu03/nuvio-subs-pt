/**
 * DeepL API Free/Pro. E' o motor com melhor portugues europeu, mas exige chave
 * e tem um tecto mensal de caracteres (500k no plano gratuito).
 *
 * O `text` repetido devolve as traducoes pela mesma ordem, por isso a
 * correspondencia linha-a-linha e' garantida pelo protocolo da propria API.
 */

const LANG = { pt: 'PT-PT', 'pt-BR': 'PT-BR', en: 'EN', tr: 'TR' };

export function isAvailable(env) {
  return Boolean(env.DEEPL_API_KEY);
}

export async function translateBatch(lines, options, env) {
  const endpoint = env.DEEPL_API_KEY.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  const body = new URLSearchParams();
  for (const line of lines) body.append('text', line);
  body.set('target_lang', LANG[options.to] || 'PT-PT');
  if (LANG[options.from]) body.set('source_lang', LANG[options.from]);
  body.set('preserve_formatting', '1');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) throw new Error(`DeepL HTTP ${response.status}`);
  const data = await response.json();
  const translations = (data.translations || []).map((item) => item.text);
  if (translations.length !== lines.length) throw new Error('DeepL devolveu contagem diferente');
  return translations;
}
