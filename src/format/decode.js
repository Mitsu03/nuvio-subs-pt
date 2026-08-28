/**
 * Descodificacao de bytes de legendas para texto.
 *
 * As legendas de series turcas chegam quase sempre em windows-1254 e as
 * portuguesas antigas em windows-1252/latin-1. O TextDecoder dos Workers so
 * garante UTF-8, por isso as tabelas de byte unico estao aqui em codigo.
 */

// windows-1252, apenas as posicoes 0x80-0x9F que diferem de latin-1.
// As que faltam nesta tabela nao tem caracter atribuido e ficam com o proprio
// ponto de codigo, que e' o comportamento pratico dos descodificadores WHATWG.
const CP1252_HIGH = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
  0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

// windows-1254 = windows-1252 com as letras turcas nestas seis posicoes.
const CP1254_OVERRIDES = {
  0xd0: 'Ğ', // G maiusculo com breve
  0xdd: 'İ', // I maiusculo com ponto
  0xde: 'Ş', // S maiusculo cedilhado
  0xf0: 'ğ',
  0xfd: 'ı', // i minusculo sem ponto
  0xfe: 'ş',
};

function buildTable(overrides) {
  const table = new Array(256);
  for (let byte = 0; byte < 256; byte += 1) table[byte] = String.fromCharCode(byte);
  for (const [byte, char] of Object.entries(CP1252_HIGH)) table[Number(byte)] = char;
  for (const [byte, char] of Object.entries(overrides)) table[Number(byte)] = char;
  return table;
}

const TABLES = {
  'windows-1252': buildTable({}),
  'windows-1254': buildTable(CP1254_OVERRIDES),
};

function decodeSingleByte(bytes, encoding) {
  const table = TABLES[encoding] || TABLES['windows-1252'];
  let out = '';
  // Em blocos, para nao acumular concatenacoes caras em ficheiros grandes.
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    let piece = '';
    for (let j = 0; j < chunk.length; j += 1) piece += table[chunk[j]];
    out += piece;
  }
  return out;
}

/** Deteta BOM e devolve a codificacao que ele impoe, com o offset do corpo. */
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', offset: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', offset: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', offset: 2 };
  }
  return null;
}

/**
 * Converte bytes de legenda em texto.
 *
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {string} [options.sourceLang] codigo ISO da lingua da legenda; `tr`
 *   faz cair a heuristica para windows-1254 em vez de windows-1252.
 * @param {string} [options.declared] codificacao anunciada pela fonte.
 * @returns {{ text: string, encoding: string }}
 */
export function decodeSubtitleBytes(bytes, options = {}) {
  const bom = bomEncoding(bytes);
  if (bom) {
    const body = bytes.subarray(bom.offset);
    try {
      return { text: new TextDecoder(bom.encoding).decode(body), encoding: bom.encoding };
    } catch {
      // Runtime sem suporte para UTF-16: cai para a heuristica normal.
    }
  }

  // UTF-8 valido ganha sempre: e' o caso mais comum e a verificacao e' exacta.
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // Nao e' UTF-8; segue para as tabelas de byte unico.
  }

  const declared = String(options.declared || '').toLowerCase();
  const turkish = String(options.sourceLang || '').toLowerCase().startsWith('tr');
  const declaredTurkish = declared.includes('1254') || declared.includes('8859-9');

  const encoding = declaredTurkish || turkish ? 'windows-1254' : 'windows-1252';
  return { text: decodeSingleByte(bytes, encoding), encoding };
}
