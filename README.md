# nuvio-subs-pt

Addon para o Nuvio com duas coleções de séries turcas e legendas em português —
*Kuruluş Osman*, *Diriliş Ertuğrul*, *Teşkilat*, *Payitaht*.

Corre como Cloudflare Worker e fala o protocolo de addons que o Nuvio já
entende (o mesmo do Stremio), portanto instala-se colando um URL.

## O problema que resolve

Estas séries têm legendas portuguesas a conta-gotas. Medido no `tt11093718`
(*Kuruluş Osman*, ~180 episódios) no momento em que este addon foi escrito:

| Língua | Ficheiros no OpenSubtitles |
|---|---|
| pt-PT | 34 |
| pt-BR | 87 |
| inglês | 100+ |
| turco | 52 |

O primeiro episódio, por exemplo, não tem uma única legenda pt-PT. Por isso o
addon não se limita a agregar: quando não existe legenda na língua preferida,
vai buscar a melhor legenda inglesa (ou turca) e traduz, mantendo o *timing*
intacto.

## As duas coleções

`Turcas em Alta` e `Turcas Populares`, ambas do TMDB via
`with_original_language=tr` — o filtro certo, porque por país apanharia
coproduções e dobragens, e não existe género "turco".

A diferença entre elas é deliberada: **Populares** é o ranking de sempre, com um
mínimo de votos para travar séries obscuras; **Em Alta** só mostra séries com
episódios emitidos nas últimas seis semanas. Sem essa janela de datas as duas
listas sairiam quase iguais e uma delas não valia a pena existir.

Os ids devolvidos são IMDb (`tt…`) sempre que existem, e não `tmdb:`. Custa uma
tradução de id por série — guardada um ano, porque nunca muda — mas em troca as
fichas abrem com o Cinemeta, que toda a gente tem, e o addon de legendas deste
mesmo Worker reconhece-as sem precisar de chave.

**Nem todas as séries têm IMDb.** Medido em produção: 20 em 20 nas Populares,
mas só 14 em 20 nas Em Alta, porque as estreias recentes ainda lá não estão.
Essas caem para `tmdb:` e só abrem se tiveres um addon de metadata TMDB
instalado. Não as filtro: são séries genuinamente em alta, e escondê-las seria
pior.

As coleções só aparecem quando `TMDB_API_KEY` está definida — sem ela o
manifesto nem declara o recurso `catalog`. Uma coleção sempre vazia no ecrã
inicial é pior do que coleção nenhuma.

Ao mexer no que `toMeta` produz, incrementa `META_SHAPE_VERSION` em
`src/catalogs.js`: essa constante entra na chave da cache, e sem isso a
correção só chega aos utilizadores quando a cache expirar.

## O que faz

- **Agrega** SubDL e OpenSubtitles (este último só procura, quando corre na Cloudflare).
- **Traduz** para PT quando não há legenda na língua preferida, com o motor
  configurável e cache em KV — traduz-se uma vez por episódio, não por sessão.
- **Corrige a codificação.** As legendas turcas vêm quase sempre em
  windows-1254; lidas como UTF-8 ficam ilegíveis. O addon deteta e converte.
- **Limpa a publicidade** que as fontes colam na primeira e na última deixa.
- **Ordena por episódio.** Um nome de ficheiro que bata certo com `S01E05` pesa
  mais do que um ficheiro popular mas genérico.
- **Assina os URLs** que serve, para o endpoint não poder ser usado como proxy
  aberto para hosts arbitrários.

## Instalar

Precisas de uma conta Cloudflare (o plano gratuito chega).

```bash
npm install

# 1. cria o espaço de cache e cola o id devolvido em wrangler.toml
npx wrangler kv namespace create SUBS

# 2. gera e guarda a chave que assina os URLs das legendas
npx wrangler secret put SIGNING_KEY

# 3. chave do SubDL — gratuita em subdl.com. Na Cloudflare não é opcional:
#    ver "O OpenSubtitles não descarrega a partir de datacentros", abaixo.
npx wrangler secret put SUBDL_API_KEY

# 4. chave TMDB (v3 auth, a curta de 32 caracteres) — sem ela as coleções
#    não aparecem. Gratuita em themoviedb.org → Definições → API.
npx wrangler secret put TMDB_API_KEY

# 5. publica
npx wrangler deploy
```

Depois abre `https://nuvio-subs-pt.<o-teu-subdominio>.workers.dev/` — a página
mostra o URL de instalação e o estado da configuração.

No Nuvio: **Definições → Addons → Adicionar addon**, e cola o
`.../manifest.json`.

## Configuração

Em `wrangler.toml`, secção `[vars]`:

| Variável | Omissão | Para quê |
|---|---|---|
| `PREFERRED_PT` | `pt` | `pt` (Portugal) ou `pt-BR` (Brasil). Decide o que aparece primeiro e o que se traduz. |
| `TRANSLATE_PROVIDER` | `workersai` | `workersai`, `workersai-m2m`, `deepl`, `google`, `libre` ou `none`. |
| `WORKERSAI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Aceita lista separada por vírgulas; há modelos de reserva sempre atrás. |
| `TRANSLATE_FROM` | `en,tr` | Línguas de partida aceites, por ordem de preferência. |
| `MAX_TRANSLATE_CALLS` | `40` | Tecto de chamadas ao tradutor por pedido. |
| `TRANSLATE_CONCURRENCY` | `12` | Lotes traduzidos em paralelo. Baixar isto quebra o `PREWARM`. |
| `PREWARM` | `1` | Traduz em segundo plano assim que o Nuvio pede a lista. |
| `CACHE_DAYS` | `30` | Validade da cache KV. |

Segredos (`npx wrangler secret put NOME`):

| Segredo | Obrigatório | Para quê |
|---|---|---|
| `SIGNING_KEY` | sim | Assina os URLs `/sub/*.srt`. |
| `SUBDL_API_KEY` | na prática sim | Única fonte que descarrega a partir da Cloudflare (ver abaixo). |
| `DEEPL_API_KEY` | não | Só com `TRANSLATE_PROVIDER=deepl`. |
| `LIBRE_URL`, `LIBRE_API_KEY` | não | Instância LibreTranslate própria. |
| `TMDB_API_KEY` | para as coleções | Alimenta as duas coleções e resolve ids `tmdb:` para IMDb. |

### Sobre a escolha do motor

`workersai` é a omissão por não precisar de chave nenhuma além da conta onde o
Worker já corre, e por não depender de endpoints públicos que limitam tráfego
vindo de gamas de IP partilhadas — o endpoint público do Google devolveu `429`
logo no primeiro teste feito durante o desenvolvimento, e um Worker sai
precisamente de IPs partilhados.

`deepl` dá o melhor português europeu, mas o plano gratuito são 500 mil
caracteres por mês, o que dá para uns 15 a 20 episódios destes.

## Como se comporta

A lista devolvida ao Nuvio traz, por esta ordem:

1. `Português (PT) (auto, de Inglês)` — só aparece quando não há legenda real na
   língua preferida;
2. as legendas portuguesas reais encontradas, PT-PT antes de PT-BR;
3. nada mais: o addon não devolve inglês nem turco como opção final.

A tradução de um episódio típico (800 a 1200 deixas) são 25 a 30 chamadas ao
tradutor, em paralelo. Medido em produção, num episódio de 1110 deixas:

| | |
|---|---|
| lista de legendas | ~0,2 s |
| tradução completa, sem cache | ~30 s |
| com cache | ~0,06 s |

O `PREWARM` arranca a tradução mal o Nuvio peça a lista, portanto quando
escolhes a legenda ela já costuma estar pronta. Isto depende de a tradução
caber na janela que a Cloudflare dá ao `waitUntil`: com `TRANSLATE_CONCURRENCY`
a 6 o episódio levava 41 s e o prewarm não chegava a tempo; a 12 leva ~30 s e
chega. Se baixares a concorrência, o prewarm deixa de cumprir.

Se uma parte da tradução falhar — quota, tempo, modelo a portar-se mal — essas
deixas ficam no texto de origem em vez de desaparecerem. A legenda continua
sincronizada e utilizável; nunca se devolve um ficheiro desalinhado.

## Desenvolvimento

```bash
npm test                       # 33 testes, sem rede
node scripts/smoke.mjs         # ponta-a-ponta contra as fontes reais
node scripts/smoke.mjs tt11093718:2:10
npm run dev                    # wrangler dev, com .dev.vars
```

O `smoke.mjs` corre o Worker em Node com KV e Workers AI simulados, e percorre
o caminho todo: procura, assinatura do token, descarga, descompressão,
codificação, SRT final, cache e rejeição de token adulterado.

## Diagnóstico

- `/health` — motor de tradução ativo, KV, chave de assinatura, fontes.
- `/subtitles/series/tt11093718:1:1.json` — o que existe para um episódio.
- Cabeçalhos em `/sub/*.srt`: `X-Cache`, `X-Translate-Engine` e
  `X-Translate-Stats` (deixas traduzidas / total) e `X-Translate-Error`.
- `/catalog/series/turcas-em-alta.json` — a coleção crua, com `?skip=20` para paginar.
- `/probe` — que fontes respondem a partir do Worker e que modelos de tradução
  ainda existem. É por aqui que se apanha um modelo descontinuado.

## O OpenSubtitles não descarrega a partir de datacentros

Medido a partir do Worker publicado, com um link acabado de gerar pelo próprio
Worker no mesmo pedido:

| Alvo | Resposta |
|---|---|
| `rest.opensubtitles.org` (busca) | `200` |
| `dl.opensubtitles.org` (descarga) | `401` |
| `api.subdl.com` | `403` (sem chave — o host responde) |
| `dl.subdl.com` (descarga) | `404` (id falso — o host responde) |
| `podnapisi.net` | `530` |

O mesmo URL de descarga que devolve `401` ao Worker devolve `200` a partir de
um IP residencial, o que exclui link expirado ou de uso único: o que está a ser
recusado é a origem do pedido.

Consequência prática: na Cloudflare o OpenSubtitles serve para **procurar** mas
não para **descarregar**, e o SubDL passa a ser a fonte que sustenta o addon.
Por isso é que cada entrada leva várias origens de reserva — uma descarga que
falhe faz seguir para a próxima em vez de dar erro.

Se preferires não depender de chave nenhuma, a alternativa é correr isto num
computador em casa em vez da Cloudflare: de um IP residencial o OpenSubtitles
descarrega sem problema. Perde-se o "sempre disponível", ganha-se zero registos.

O endpoint `/probe` refaz esta medição a qualquer momento — lista de alvos
fixa, sem parâmetros do exterior, para não servir de proxy.

## Limites conhecidos

- O Nuvio não envia `videoHash` nem o nome do ficheiro no pedido, por isso a
  correspondência é por IMDb + temporada + episódio, e não por *release*. Se o
  teu vídeo for uma versão com cortes diferentes, o sincronismo pode fugir.
- O `rest.opensubtitles.org` é um endpoint antigo e, na Cloudflare, só serve
  para procurar. Se desaparecer de vez, o addon fica inteiramente dependente
  do SubDL.
- Tradução automática é tradução automática: serve para acompanhar, não
  substitui uma legenda feita por gente.
- Séries turcas com numeração de episódios diferente entre o IMDb e a fonte da
  legenda (os *bölüm* longos partidos em dois) podem não casar.

## Licença

MIT.
