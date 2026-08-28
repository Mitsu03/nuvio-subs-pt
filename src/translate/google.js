/**
 * Endpoint publico do Google Translate. Nao precisa de chave, mas responde 429
 * com facilidade quando o trafego vem de gamas de IP partilhadas — que e'
 * exactamente o caso de um Worker. Fica como alternativa, nao como omissao.
 */

const LANG = { pt: 'pt-PT', 'pt-BR': 'pt-BR', en: 'en', tr: 'tr' };
const SEPARATOR = '\n';

export function isAvailable() {
  return true;
}

export async function translateBatch(lines, options) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: LANG[options.from] || 'auto',
    tl: LANG[options.to] || 'pt-PT',
    dt: 't',
    q: lines.join(SEPARATOR),
  });

  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`);
  if (!response.ok) throw new Error(`Google HTTP ${response.status}`);

  const data = await response.json();
  const joined = (data[0] || []).map((segment) => segment[0]).join('');
  const translations = joined.split(SEPARATOR);

  // O Google re-segmenta o texto e nem sempre respeita as mudancas de linha;
  // quem chama trata o desalinhamento, aqui so se sinaliza.
  if (translations.length !== lines.length) throw new Error('Google devolveu contagem diferente');
  return translations;
}
