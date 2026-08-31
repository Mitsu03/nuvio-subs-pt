/**
 * Endireita para portugues europeu o que o modelo escreveu em brasileiro.
 *
 * O prompt pede PT-PT, mas os modelos generalistas foram treinados sobretudo
 * com portugues do Brasil e derrapam — medido num episodio inteiro: gerundio
 * («nao vou me intrometer», «esta fazendo»), pronome no sitio errado e
 * vocabulario. Pedir com mais insistencia melhora, nao resolve.
 *
 * Por isso ha esta segunda passagem, deterministica. So mexe no que e' seguro
 * mexer sem perceber a frase:
 *
 *   - o gerundio com auxiliar, que em PT-PT e' «a» + infinitivo;
 *   - o pronome entalado entre auxiliar e infinitivo depois de um atractor;
 *   - o pronome no inicio da frase, que em PT-PT nunca acontece;
 *   - palavras e grafias que trocam uma a uma, sem depender do contexto.
 *
 * O que exige conjugar fica de fora — «voce fala» -> «tu falas» nao se faz com
 * uma expressao regular sem arriscar estragar a deixa. Isso e' trabalho do
 * prompt; aqui so se apanha o que passar.
 */

/** Auxiliares que em PT-PT pedem «a» + infinitivo em vez de gerundio. */
const AUXILIARES_GERUNDIO = [
  'estou', 'estás', 'estas', 'está', 'esta', 'estamos', 'estão', 'estao',
  'estava', 'estavas', 'estávamos', 'estavamos', 'estavam',
  'estive', 'esteve', 'estivemos', 'estiveram',
  'estarei', 'estará', 'estara', 'estaremos', 'estarão', 'estarao',
  'estaria', 'estariam', 'esteja', 'estejam', 'estivesse', 'estivessem',
  'continuo', 'continuas', 'continua', 'continuamos', 'continuam',
  'continuava', 'continuavam',
  'fico', 'ficas', 'fica', 'ficamos', 'ficam', 'ficou', 'ficaram',
  'ficava', 'ficavam',
  'ando', 'andas', 'anda', 'andamos', 'andam', 'andava', 'andavam',
];

/**
 * `-ando` -> `-ar`, `-endo` -> `-er`, `-indo` -> `-ir`.
 *
 * O `-ondo` de «pondo» fica de fora de proposito: dava «por» em vez de «pôr»,
 * e sao poucas as deixas que ganhavam com isso.
 */
const GERUNDIO = new RegExp(
  `\\b(${AUXILIARES_GERUNDIO.join('|')})\\s+(\\p{L}*)(ando|endo|indo)\\b`,
  'giu',
);

const INFINITIVO = { ando: 'ar', endo: 'er', indo: 'ir' };

/** Palavras que puxam o pronome para antes do verbo. */
const ATRACTORES = [
  'não', 'nao', 'nunca', 'nada', 'ninguém', 'ninguem', 'também', 'tambem',
  'já', 'ja', 'só', 'so', 'ainda', 'talvez', 'sempre',
  'que', 'quem', 'quando', 'onde', 'porque', 'se',
];

/** Auxiliares que levam infinitivo a seguir. */
const AUXILIARES_INFINITIVO = [
  'vou', 'vais', 'vai', 'vamos', 'vão', 'vao',
  'posso', 'podes', 'pode', 'podemos', 'podem',
  'quero', 'queres', 'quer', 'queremos', 'querem',
  'devo', 'deves', 'deve', 'devemos', 'devem',
  'consigo', 'consegues', 'consegue', 'conseguimos', 'conseguem',
  'tenho', 'tens', 'tem', 'temos', 'têm',
  'preciso', 'precisas', 'precisa', 'precisamos', 'precisam',
  'costumo', 'costumas', 'costuma', 'costumamos', 'costumam',
  'volto', 'voltas', 'volta', 'voltamos', 'voltam',
  // Passado e imperfeito. Sem estes, «nunca quis te magoar» ficava como estava.
  'quis', 'quiseste', 'quisemos', 'quiseram', 'queria', 'querias', 'queriam',
  'pude', 'pôde', 'pode', 'pudemos', 'puderam', 'podia', 'podias', 'podiam',
  'devia', 'devias', 'devíamos', 'deviam',
  'tive', 'teve', 'tivemos', 'tiveram', 'tinha', 'tinhas', 'tínhamos', 'tinham',
  'ia', 'ias', 'íamos', 'iam',
  'consegui', 'conseguiu', 'conseguimos', 'conseguiram',
];

const CLITICOS = ['me', 'te', 'se', 'nos', 'vos', 'lhe', 'lhes'];

/**
 * «nao vou me intrometer» -> «nao me vou intrometer».
 *
 * O atractor e' obrigatorio: sem ele a ordem brasileira e a portuguesa
 * coincidem, e mexer so trocava uma frase certa por outra.
 */
const CLITICO_ENTALADO = new RegExp(
  `\\b(${ATRACTORES.join('|')})\\s+(${AUXILIARES_INFINITIVO.join('|')})\\s+(${CLITICOS.join('|')})\\s+(\\p{L}+[aei]r|embora)\\b`,
  'giu',
);

/**
 * «Me desculpe» -> «Desculpe-me».
 *
 * So no principio da frase, e so `me` e `te`: em PT-PT nenhuma frase comeca por
 * pronome, portanto nao ha ambiguidade. O `nos` fica de fora porque tambem e' a
 * contraccao de «em os» — «Nos anos 90» viraria «anos-nos».
 */
const CLITICO_INICIAL = /(^|[.!?…]\s+|["'“”«»—-]\s*)(Me|Te)\s+(\p{L}+)/gu;

/**
 * Trocas de uma palavra por outra, sem depender do contexto.
 *
 * Nao entra aqui nada que possa querer dizer duas coisas: «legal» tambem e'
 * «conforme a lei», «fato» no Brasil e' o «facto» daqui, «cara» pode ser o
 * rosto. Trocar essas dava frases erradas em troca de soarem menos brasileiras.
 *
 * Tambem nao entra nada que mude de genero. Medido: «a geladeira» dava «A
 * frigorifico», «o time» dava «o equipa», «do banheiro» dava «do casa de
 * banho». Endireitar o artigo era possivel, mas o adjectivo a seguir ficava a
 * discordar na mesma («a tela branca» -> «o ecra branca»), e uma deixa em
 * portugues estragado e' pior do que uma deixa em brasileiro correcto. Ficam
 * de fora, portanto: tela, geladeira, banheiro, calcada, time. E «grama», que
 * tanto e' a relva como a unidade de peso.
 */
const VOCABULARIO = [
  // Objectos e lugares do dia a dia, so os que mantem o genero.
  ['ônibus', 'autocarro'],
  ['trem', 'comboio'], ['trens', 'comboios'],
  ['celular', 'telemóvel'], ['celulares', 'telemóveis'],
  ['café da manhã', 'pequeno-almoço'],
  ['xícara', 'chávena'], ['xícaras', 'chávenas'],
  ['sorvete', 'gelado'], ['sorvetes', 'gelados'],
  ['suco', 'sumo'], ['sucos', 'sumos'],
  ['caminhão', 'camião'], ['caminhões', 'camiões'],
  ['açougue', 'talho'], ['açougues', 'talhos'],
  ['delegacia', 'esquadra'], ['delegacias', 'esquadras'],
  ['aeromoça', 'hospedeira'], ['aeromoças', 'hospedeiras'],
  ['garçom', 'empregado de mesa'], ['garçons', 'empregados de mesa'],
  ['esporte', 'desporto'], ['esportes', 'desportos'],
  ['esportivo', 'desportivo'], ['esportiva', 'desportiva'],

  // Grafias que o Brasil escreve com circunflexo e Portugal com agudo. E' uma
  // lista, e nao uma regra: «estômago» e «fôlego» escrevem-se igual nos dois.
  ['econômico', 'económico'], ['econômica', 'económica'],
  ['econômicos', 'económicos'], ['econômicas', 'económicas'],
  ['gênero', 'género'], ['gêneros', 'géneros'],
  ['fenômeno', 'fenómeno'], ['fenômenos', 'fenómenos'],
  ['tênis', 'ténis'],
  ['cômico', 'cómico'], ['cômica', 'cómica'],
  ['gêmeo', 'gémeo'], ['gêmeos', 'gémeos'], ['gêmea', 'gémea'], ['gêmeas', 'gémeas'],
  ['polêmico', 'polémico'], ['polêmica', 'polémica'],
  ['acadêmico', 'académico'], ['acadêmica', 'académica'],
  ['bebê', 'bebé'], ['bebês', 'bebés'],
  ['quilômetro', 'quilómetro'], ['quilômetros', 'quilómetros'],
  ['Antônio', 'António'],
  ['registro', 'registo'], ['registros', 'registos'],
  ['registrar', 'registar'], ['registrado', 'registado'],

  // «voce» so se troca depois de preposicao, onde nao e' preciso conjugar nada.
  ['com você', 'contigo'],
  ['para você', 'para ti'],
  ['pra você', 'para ti'],
  ['por você', 'por ti'],
  ['de você', 'de ti'],
  ['em você', 'em ti'],
  ['a você', 'a ti'],
];

/** Devolve `substituto` com a mesma capitalizacao inicial do `original`. */
function comAMesmaCaixa(original, substituto) {
  const primeira = original[0];
  if (!primeira || primeira !== primeira.toUpperCase() || primeira === primeira.toLowerCase()) {
    return substituto;
  }
  return substituto[0].toUpperCase() + substituto.slice(1);
}

function escapaRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VOCABULARIO_REGEX = VOCABULARIO.map(([de, para]) => [
  new RegExp(`(?<!\\p{L})${escapaRegex(de)}(?!\\p{L})`, 'giu'),
  para,
]);

/**
 * Passa uma deixa traduzida a portugues europeu.
 *
 * Nunca rebenta e nunca devolve vazio: em caso de duvida devolve o texto tal
 * como veio. Uma deixa em portugues do Brasil e' pior do que uma em portugues
 * de Portugal, mas e' muito melhor do que uma deixa estragada.
 */
export function toEuropeanPortuguese(texto) {
  if (typeof texto !== 'string' || texto === '') return texto;

  let saida = texto;

  saida = saida.replace(GERUNDIO, (todo, auxiliar, raiz, terminacao) => {
    const infinitivo = raiz + INFINITIVO[terminacao.toLowerCase()];
    return `${auxiliar} a ${infinitivo}`;
  });

  saida = saida.replace(
    CLITICO_ENTALADO,
    (todo, atractor, auxiliar, clitico, infinitivo) =>
      `${atractor} ${clitico} ${auxiliar} ${infinitivo}`,
  );

  saida = saida.replace(CLITICO_INICIAL, (todo, antes, pronome, verbo) => {
    const verboMaiuscula = verbo[0].toUpperCase() + verbo.slice(1);
    return `${antes}${verboMaiuscula}-${pronome.toLowerCase()}`;
  });

  for (const [regex, para] of VOCABULARIO_REGEX) {
    saida = saida.replace(regex, (encontrado) => comAMesmaCaixa(encontrado, para));
  }

  return saida;
}

/** A mesma coisa para um lote inteiro. */
export function linesToEuropeanPortuguese(lines) {
  return lines.map((line) => toEuropeanPortuguese(line));
}

/**
 * Muda quando as regras daqui mudam, para entrar na chave da cache: sem isto,
 * uma legenda ja traduzida continuava a ser servida em brasileiro ate a cache
 * expirar.
 */
export const PT_STYLE_VERSION = 'ptpt-1';
