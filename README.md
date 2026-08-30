# nuvio-subs-pt

Um Cloudflare Worker que serve **dois addons** para o Nuvio: legendas em
português para o catálogo todo, e duas coleções de séries turcas com streams de
áudio turco — *Kuruluş Osman*, *Diriliş Ertuğrul*, *Teşkilat*, *Payitaht*.

Fala o protocolo de addons que o Nuvio já entende (o mesmo do Stremio),
portanto instala-se colando um URL.

## Dois addons, um Worker

Até à versão 1.x isto era um addon só. Eram duas coisas de âmbitos diferentes
debaixo do mesmo manifesto: quem queria legendas levava duas coleções turcas ao
ecrã inicial sem as ter pedido, e quem queria as coleções levava um addon de
legendas que talvez já tivesse.

| | Legendas PT | Turcas PT |
|---|---|---|
| id | `com.nuvio.subs.pt` | `com.nuvio.turcas.pt` |
| manifesto | `/manifest.json` | `/turcas/manifest.json` |
| recursos | `subtitles` | `catalog`, `stream` |
| serve | o catálogo inteiro | só séries e filmes turcos |
| plugin do NuvioTV | — | `/plugin/manifest.json` |

Os ids **têm** de ser diferentes: o Nuvio guarda os addons por id de manifesto,
e dois com o mesmo id são o mesmo addon — instalar o segundo substituiria o
primeiro.

O prefixo `/turcas` também não é decoração. O Nuvio resolve os recursos a
partir da base do manifesto (o URL de instalação sem o `/manifest.json`) —
`catalogRepository.buildCatalogUrl` faz `${basePath}/catalog/...`, e o mesmo em
`streamRepository` e `subtitleRepository`. Um manifesto em `/turcas/` obriga
portanto o catálogo a viver em `/turcas/catalog/...`. As rotas antigas sem
prefixo continuam a responder, para quem instalou a versão de manifesto único.

**Migração.** Quem já tinha o addon instalado fica com **as legendas** e deixa
de ver as coleções turcas: o id mudou, e não há forma de acrescentar o segundo
addon por ele. Basta colar o segundo endereço.

## Legendas: o problema que resolve

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

## Legendas: o que faz

- **Agrega** SubDL e OpenSubtitles (este último só procura, quando corre na Cloudflare).
- **Traduz** para PT quando não há legenda na língua preferida, com o motor
  configurável e cache em KV — traduz-se uma vez por episódio, não por sessão.
- **Corrige a codificação.** As legendas turcas vêm quase sempre em
  windows-1254; lidas como UTF-8 ficam ilegíveis. O addon deteta e converte.
- **Limpa a publicidade** que as fontes colam na primeira e na última deixa.
- **Ordena por episódio.** Um nome de ficheiro que bata certo com `S01E05` pesa
  mais do que um ficheiro popular mas genérico.
- **Ignora anime.** É um addon para filmes e séries; o anime tem legendas PT em abundância e addons dedicados, e as entradas daqui só acrescentavam ruído. Reversível em `ANIME_POLICY`.
- **Assina os URLs** que serve, para o endpoint não poder ser usado como proxy
  aberto para hosts arbitrários.

## Legendas: como se comporta

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

## Turcas: as duas coleções

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

## Turcas: streams com áudio turco

O circuito de torrents não tem séries turcas em turco. Medido no `tt43351313`
(*Muhtemel Aşk*, Show TV, estreada em Junho de 2026):

| Fonte | Streams para o S01E01 | Áudio |
|---|---|---|
| Torrentio | 18 | dobragem russa, os 18, do Rutracker |
| MediaFusion | 0 | — |

Os 18 são a mesma série lançada por dois grupos russos (`AlisaDirilis`,
`DeziDenizi`), em `DVO` — dobragem a duas vozes por cima do turco. Não é um
problema de ordenação: não há nada em turco para pôr em primeiro.

A fonte que tem é o canal oficial. As estações turcas publicam os episódios
inteiros no YouTube, de graça e sem bloqueio por país. O addon procura lá e
devolve o que encontra:

```
/turcas/stream/series/tt11093718:2:1.json
→ Kuruluş Osman | 28. Bölüm (4K Ultra HD) · Canal: Kuruluş Osman · 2h22
→ Kuruluş Osman 28. Bölüm            · Canal: Kuruluş Osman · 2h22
→ Kuruluş Osman 28. Bölüm            · Canal: atv           · 2h22
```

Três coisas fazem isto funcionar, e sem qualquer delas a busca falha:

**A numeração é corrida.** A televisão turca não numera por temporada: o
primeiro episódio da segunda temporada do *Kuruluş Osman* chama-se *28. Bölüm*.
O IMDb e o TMDB numeram por temporada, portanto o addon soma as temporadas
anteriores antes de procurar. A numeração por temporada fica como segunda
tentativa, para as séries em que o TMDB conta de forma diferente.

**O fragman vem sempre primeiro.** Um trailer de 60 segundos tem mais
visualizações do que o episódio de duas horas, por isso é ele que a busca
devolve à cabeça. O filtro que resolve isto é a duração: abaixo de
`YOUTUBE_MIN_MINUTES` não pode ser o episódio. A lista de palavras
(*fragman*, *özet*, *30 dakikada*, …) é a segunda linha de defesa.

**O alfabeto turco não decompõe.** O `ı` sem ponto e o `ş` são letras próprias
e não passam por *latino + acento*, portanto `String.normalize` não chega e a
tradução é feita à mão. Sem isso, *Diriliş Ertuğrul* nunca casa com o que o
TMDB devolve.

O que se devolve é `externalUrl`, e não `url` nem `ytId`:

- `ytId` está na especificação do Stremio mas é letra morta nos clientes reais
  — o NuvioMobile não tem sequer o campo no modelo de stream, e o NuvioTV
  faz-lhe o *parse* sem que nenhum ecrã o reproduza. Vai na mesma no objeto,
  para clientes que o entendam.
- `url` faria o leitor tentar reproduzir uma página HTML.

**Onde isto toca, e onde não toca.** No NuvioMobile a entrada abre a aplicação
do YouTube (`shouldOpenExternally`), fora do Nuvio — vês o episódio, mas o
leitor é o do YouTube e as legendas deste addon não se aplicam. **No NuvioTV
não toca de todo:** o `Stream.kt` faz `getStreamUrl() = url ?: externalUrl` e
não existe nenhum caminho de abertura externa, portanto o endereço vai direto
ao leitor interno, que recebe HTML. Para a TV existe o plugin, abaixo.

O recurso só responde a obras com turco como língua original (é o TMDB que o
diz) e só aparece no manifesto quando há `TMDB_API_KEY`. Para tudo o resto
devolve lista vazia, para não acrescentar ruído a séries que já têm fontes.

## Turcas: o plugin do NuvioTV (é aqui que toca dentro da app)

O recurso `stream` acima não serve o NuvioTV. O que serve é um **plugin**: o
NuvioTV instala scrapers JS de um repositório e corre-os **no próprio
aparelho**, e o que eles devolvem é um `url` que passa pelo leitor interno — ou
seja, com as legendas PT deste addon por cima.

Correr no aparelho não é um detalhe de arrumação. Os endereços do `googlevideo`
respondem só ao IP que os pediu, e a extração a partir de um datacentro devolve
`UNPLAYABLE`. O Worker não conseguiria fazer isto nem que quisesse.

A divisão fica assim:

| | Onde corre | O que faz |
|---|---|---|
| Worker | Cloudflare | Sabe qual é o vídeo certo: título turco, numeração corrida, fragman a descartar. |
| Plugin | Televisão | Extrai os formatos a partir da tua rede e pede o manifesto. |
| Worker | Cloudflare | Escreve o manifesto DASH. Não serve vídeo nenhum — os segmentos vão do googlevideo direitos à televisão. |

### Instalar

No NuvioTV: **Definições → Plugins → adicionar repositório**, e cola

```
https://nuvio-subs-pt.<o-teu-subdominio>.workers.dev/plugin/manifest.json
```

Não tem configuração: o Worker injeta o seu próprio endereço no código quando o
serve.

### Porquê um manifesto DASH

O YouTube só junta vídeo e áudio no mesmo ficheiro até aos **360p** (itag 18).
Acima disso vêm separados, e o contrato dos plugins do Nuvio tem um `url`
único. Um manifesto é um ficheiro de texto que junta as duas faixas num só
endereço, e o leitor do NuvioTV traz `media3-exoplayer-dash`.

Vão dois codecs de vídeo de propósito, porque o `avc1` do YouTube não passa dos
1080p e o 4K só existe em `vp9`. Medido em produção:

| Série | Manifesto | Máximo |
|---|---|---|
| *Muhtemel Aşk* S01E01 | 13 representations | 1080p (não há mais) |
| *Kuruluş Osman* S02E01 | 13 representations | **4K** (itag 313, vp9) |

O `avc1` 1080p vai no mesmo manifesto: se a televisão não descodificar `vp9`, o
leitor cai lá sozinho. O `av01` fica de fora — dava o mesmo 4K e muitas
televisões ainda não o descodificam por hardware.

Fica ainda uma segunda entrada com o ficheiro único de 360p. Nunca é a
escolhida por gosto: só aparece sozinha quando o manifesto falha, e nesse caso
360p é melhor do que nada.

### O que o Worker aceita

O `POST /dash` recebe endereços vindos de fora, e por isso **só aceita
`*.googlevideo.com`** — sem isso o Worker passava a publicar, no próprio
domínio, um documento a apontar para onde quem chamasse quisesse. O XML é
escrito no Worker e nunca copiado da entrada. Os manifestos vivem 6 horas, que é
quando os endereços do googlevideo expiram.

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
mostra os três endereços e o estado da configuração.

No Nuvio, **Definições → Addons → Adicionar addon**, e cola um ou os dois:

```
https://nuvio-subs-pt.<o-teu-subdominio>.workers.dev/manifest.json         legendas
https://nuvio-subs-pt.<o-teu-subdominio>.workers.dev/turcas/manifest.json  coleções turcas
```

O plugin do NuvioTV é um terceiro endereço e entra noutro sítio — **Definições
→ Plugins**, não Addons. Ver a secção do plugin.

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
| `ANIME_POLICY` | `exclude` | `exclude` (nada para anime), `no-translation` (só legendas reais) ou `include`. |
| `STREAMS` | `1` | `0` desliga os streams turcos e retira o recurso do manifesto. |
| `YOUTUBE_MIN_MINUTES` | `40` | Duração mínima para um vídeo poder ser o episódio. Nos filmes o mínimo sobe para 60. |
| `STREAM_RESULTS` | `3` | Quantos vídeos oferecer por episódio. |

Segredos (`npx wrangler secret put NOME`):

| Segredo | Obrigatório | Para quê |
|---|---|---|
| `SIGNING_KEY` | sim | Assina os URLs `/sub/*.srt`. |
| `SUBDL_API_KEY` | na prática sim | Única fonte que descarrega a partir da Cloudflare (ver abaixo). |
| `DEEPL_API_KEY` | não | Só com `TRANSLATE_PROVIDER=deepl`. |
| `LIBRE_URL`, `LIBRE_API_KEY` | não | Instância LibreTranslate própria. |
| `TMDB_API_KEY` | para coleções e streams | Alimenta as coleções, resolve ids `tmdb:` para IMDb e diz se uma obra é turca. |
| `YOUTUBE_API_KEY` | não | Faz a busca pela API oficial em vez de ler a página de resultados. Só vale a pena se a busca sem chave começar a falhar. |

### Sobre a escolha do motor

`workersai` é a omissão por não precisar de chave nenhuma além da conta onde o
Worker já corre, e por não depender de endpoints públicos que limitam tráfego
vindo de gamas de IP partilhadas — o endpoint público do Google devolveu `429`
logo no primeiro teste feito durante o desenvolvimento, e um Worker sai
precisamente de IPs partilhados.

`deepl` dá o melhor português europeu, mas o plano gratuito são 500 mil
caracteres por mês, o que dá para uns 15 a 20 episódios destes.

## Desenvolvimento

```bash
npm test                       # 65 testes, sem rede
node scripts/smoke.mjs         # ponta-a-ponta contra as fontes reais
node scripts/smoke.mjs tt11093718:2:10
npm run build:plugin           # embute plugin/turcas-pt.js no Worker
npm run smoke:plugin           # corre o plugin como o aparelho o corre
npm run dev                    # wrangler dev, com .dev.vars
```

O `smoke.mjs` corre o Worker em Node com KV e Workers AI simulados, e percorre
o caminho todo: procura, assinatura do token, descarga, descompressão,
codificação, SRT final, cache e rejeição de token adulterado.

## Diagnóstico

- `/health` — motor de tradução ativo, KV, chave de assinatura, fontes.
- `/manifest.json` e `/turcas/manifest.json` — os dois manifestos, para confirmar que os ids são mesmo diferentes.
- `/subtitles/series/tt11093718:1:1.json` — o que existe para um episódio.
- Cabeçalhos em `/sub/*.srt`: `X-Cache`, `X-Translate-Engine` e
  `X-Translate-Stats` (deixas traduzidas / total) e `X-Translate-Error`.
- `/turcas/catalog/series/turcas-em-alta.json` — a coleção crua, com `?skip=20` para paginar.
- `/turcas/stream/series/tt11093718:2:1.json` — o episódio no canal oficial. Devolver
  lista vazia aqui e não vazia numa série da primeira temporada é o sintoma de
  o TMDB contar as temporadas de forma diferente da emissão.
- `/plugin/manifest.json` — o repositório de plugins que o NuvioTV instala.
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
- No NuvioMobile os streams do YouTube abrem fora da app, e por isso sem as
  legendas deste addon. No NuvioTV não tocam sequer — usa-se o plugin.
- O plugin foi verificado ponta-a-ponta fora do NuvioTV (`npm run smoke:plugin`:
  manifesto gerado, segmentos a responder `206`). Falta a confirmação numa
  televisão a sério, com o leitor do Nuvio.
- A busca sem `YOUTUBE_API_KEY` lê a página de resultados. Funciona a partir da
  Cloudflare — verificado em produção — mas é um formato que o YouTube pode
  mudar sem aviso. Quando isso acontecer, a chave resolve.
- Séries turcas antigas ou pouco vistas podem simplesmente não ter os episódios
  publicados; nesse caso o recurso devolve lista vazia, que é a resposta certa.

## Licença

MIT.
