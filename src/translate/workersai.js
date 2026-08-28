/**
 * Workers AI — o motor por defeito.
 *
 * Escolhido por nao precisar de chave nenhuma alem da conta Cloudflare onde o
 * addon ja corre, e por nao depender de endpoints publicos que limitam trafego
 * vindo de gamas de IP partilhadas.
 *
 * Sao dois modos:
 *   - `workersai`     um modelo instruct, que traduz varias deixas de uma vez
 *                     com contexto e da' portugues mais natural;
 *   - `workersai-m2m` o modelo de traducao dedicado, mais barato e mais seco.
 */

const LANG_NAME = {
  pt: 'portugues europeu (de Portugal)',
  'pt-BR': 'portugues do Brasil',
  en: 'ingles',
  tr: 'turco',
};

const M2M_LANG = { pt: 'portuguese', 'pt-BR': 'portuguese', en: 'english', tr: 'turkish' };

export function isAvailable(env) {
  return Boolean(env.AI);
}

function buildPrompt(lines, options) {
  const from = LANG_NAME[options.from] || options.from;
  const to = LANG_NAME[options.to] || 'portugues europeu (de Portugal)';

  const numbered = lines.map((line, index) => `${index + 1}. ${line}`).join('\n');

  return [
    {
      role: 'system',
      content: [
        `Es um tradutor de legendas de ${from} para ${to}.`,
        'O material e uma serie historica turca: mantem os nomes proprios, os titulos',
        '(Bey, Sultao, Xeque, Hatun, Alp) e as expressoes religiosas tal como estao.',
        'Traduz cada linha numerada de forma independente e devolve exactamente o mesmo',
        'numero de linhas, com a mesma numeracao e pela mesma ordem.',
        'Nao juntes linhas, nao dividas linhas, nao acrescentes comentarios nem explicacoes.',
        'Escreve so a traducao a seguir ao numero e ao ponto.',
      ].join(' '),
    },
    { role: 'user', content: numbered },
  ];
}

function parseNumbered(output, expected) {
  const result = new Array(expected).fill(null);

  for (const rawLine of String(output).split('\n')) {
    const match = rawLine.match(/^\s*(\d{1,4})\s*[.)\-:]\s*(.*)$/);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= expected) continue;
    if (result[index] === null) result[index] = match[2].trim();
  }

  return result;
}

// Varios modelos, tentados por ordem. A Cloudflare descontinua modelos com
// aviso curto, e um catalogo desactualizado aqui aparecia como "traduziu zero
// linhas" sem qualquer pista do motivo — por isso a lista de reserva existe.
const DEFAULT_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-3b-instruct',
];

/** Modelos a tentar: o configurado primeiro, os de reserva a seguir. */
export function modelList(env) {
  const raw = String(env.WORKERSAI_MODEL || '').trim();
  const configured = raw ? raw.split(',').map((model) => model.trim()).filter(Boolean) : [];
  return [...configured, ...DEFAULT_MODELS.filter((model) => !configured.includes(model))];
}

/** Distingue "este modelo nao existe" de uma falha passageira. */
function isModelUnavailable(error) {
  const message = String(error && error.message).toLowerCase();
  return (
    message.includes('deprecat') ||
    message.includes('not found') ||
    message.includes('no such model') ||
    message.includes('5028') ||
    message.includes('invalid model')
  );
}

// Modelo que se sabe estar a responder neste isolate, para nao repetir a
// procura em cada lote.
let workingModel = null;

async function runInstruct(model, lines, options, env) {
  const response = await env.AI.run(model, {
    messages: buildPrompt(lines, options),
    max_tokens: Math.min(4096, 120 + lines.length * 60),
    temperature: 0.2,
  });

  const output = typeof response === 'string' ? response : response.response || '';
  const parsed = parseNumbered(output, lines.length);

  // Uma linha que o modelo tenha saltado fica com o original, que e' melhor do
  // que descartar a deixa ou desalinhar todas as que vem a seguir.
  return parsed.map((line, index) => (line === null || line === '' ? lines[index] : line));
}

async function translateInstruct(lines, options, env) {
  if (workingModel) {
    try {
      return await runInstruct(workingModel, lines, options, env);
    } catch (error) {
      if (!isModelUnavailable(error)) throw error;
      workingModel = null; // descontinuado entretanto: volta a percorrer a lista
    }
  }

  const failures = [];
  for (const model of modelList(env)) {
    try {
      const result = await runInstruct(model, lines, options, env);
      workingModel = model;
      return result;
    } catch (error) {
      failures.push(`${model}: ${error.message}`);
      if (!isModelUnavailable(error)) throw error;
    }
  }

  throw new Error(`nenhum modelo disponivel (${failures.join('; ')})`);
}

async function translateM2M(lines, options, env) {
  const response = await env.AI.run('@cf/meta/m2m100-1.2b', {
    text: lines.join('\n'),
    source_lang: M2M_LANG[options.from] || 'english',
    target_lang: M2M_LANG[options.to] || 'portuguese',
  });

  const output = String(response.translated_text || '').split('\n');
  if (output.length !== lines.length) throw new Error('m2m100 devolveu contagem diferente');
  return output;
}

export async function translateBatch(lines, options, env) {
  if (!env.AI) throw new Error('Binding AI nao configurado');
  return options.mode === 'm2m'
    ? translateM2M(lines, options, env)
    : translateInstruct(lines, options, env);
}
