/**
 * LibreTranslate. Aceita um array em `q` e devolve outro pela mesma ordem.
 * Util sobretudo para quem tenha uma instancia propria.
 */

const LANG = { pt: 'pt', 'pt-BR': 'pt', en: 'en', tr: 'tr' };

export function isAvailable(env) {
  return Boolean(env.LIBRE_URL);
}

export async function translateBatch(lines, options, env) {
  const response = await fetch(env.LIBRE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: lines,
      source: LANG[options.from] || 'auto',
      target: LANG[options.to] || 'pt',
      format: 'text',
      ...(env.LIBRE_API_KEY ? { api_key: env.LIBRE_API_KEY } : {}),
    }),
  });

  if (!response.ok) throw new Error(`LibreTranslate HTTP ${response.status}`);
  const data = await response.json();
  const translations = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText];
  if (translations.length !== lines.length) throw new Error('LibreTranslate devolveu contagem diferente');
  return translations;
}
