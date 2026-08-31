# Plano

Duas frentes decididas em 29-08-2026 e trabalhadas em 30-08-2026. A **2** está
feita e publicada; a **1** parou na experiência 0, com a resposta registada
abaixo. Os números aqui são medidos, não estimados — onde há dúvida está escrito
que há dúvida.

---

## 1. Legendas a partir do áudio — CONSTRUÍDO, bloqueado pelo acesso

### O problema, medido

*Muhtemel Aşk* (`tt43351313`, Show TV, estreou 18-06-2026) não tem legendas em
lado nenhum:

| Fonte | pt | inglês | turco |
|---|---|---|---|
| OpenSubtitles (`imdbid-43351313`) | 0 | 0 | 0 |
| Faixas no vídeo oficial do YouTube (`QvZHtdpkybc`) | 0 | 0 | 0 |

Nem legendas automáticas do YouTube. A tradução automática do addon precisa de
um texto de partida, e aqui não existe nenhum — por isso `/subtitles` devolve
lista vazia, que é a resposta certa.

Não é defeito do addon: para o *Kuruluş Osman* S01E01 o mesmo endpoint devolve
duas entradas, incluindo `Português (PT) (auto, de Inglês)`. O que falta é
matéria-prima, e falta porque a série é nova.

**A ideia:** transcrever o áudio turco do episódio (Whisper, via Workers AI, que
o Worker já tem ligado em `[ai]`) e meter o resultado no tradutor que já existe.
Resolve exatamente a classe de séries que este addon existe para servir — as que
estão a dar agora.

### O que trava tudo, e tem de ser respondido primeiro

Os endereços do `googlevideo` **estão presos ao IP que os pediu** — o parâmetro
`ip=` viaja no próprio URL (visível no registo do VLC). Por isso o Worker não
pode descarregar o áudio que *o plugin* extraiu na televisão: esse endereço está
preso ao IP da televisão.

> **Corrigido pela experiência 0 (30-08-2026):** isto não impede o Worker de
> extrair os *seus próprios* endereços, presos ao IP dele, e descarregar por
> eles — medido a funcionar repetidamente. Ver abaixo.

> **Experiência 0 — feita, remedida, e depois construída até bater no muro.
> Resultado: o código funciona; o acesso é que não escala.**

A sonda vive em `GET /probe/player/{videoId}` e a implementação em `src/asr/`.
Ambas ficam no repositório, com o `ASR` desligado no `wrangler.toml`.

### O que se mediu, por esta ordem

**Primeira passagem.** Os quatro episódios turcos responderam `LOGIN_REQUIRED`
nos cinco perfis de cliente. Conclusão registada na altura: barreira de
autenticação. **Errada.**

**Segunda passagem**, três corridas por vídeo, horas depois: 12 em 12 chamadas
deram `OK`, e o *Kuruluş Osman* descarregou (`206`, `ip=172.68.103.95` — um IP
da própria Cloudflare dentro do URL). Conclusão registada: viável. **Também
errada, mas por menos.**

**Terceira passagem**, já com o descarregador escrito e a pedir a sério:

| O que se pediu | Resposta |
|---|---|
| primeiro 1 MB, a meio do ficheiro | `206` |
| 4 MB de uma vez | `403` |
| 1 MB, depois outro 1 MB seguido | `206`, depois **`403`** |
| `youtubei/v1/player`, logo a seguir | **`LOGIN_REQUIRED`**, nos cinco clientes |
| o mesmo, quatro minutos depois | ainda `LOGIN_REQUIRED` |

### O que isto quer dizer

As três medições não se contradizem: descrevem um **estrangulamento por IP**. O
`403` na descarga e o `LOGIN_REQUIRED` no player são a mesma defesa, em dois
sítios. Os resultados «intermitentes» das duas primeiras passagens eram função
do que se tinha pedido antes — e não de sorte.

A premissa original do plano continua desmentida: o `ip=` no URL é o do Worker
quando é o Worker a extrair, e a descarga passa. **Extrair de um datacentro
funciona.** O que não funciona é fazê-lo **à escala necessária**: um episódio
são 128 MB, o googlevideo serve 1 MB de cada vez, e a defesa entra ao segundo
pedido. Não há aqui uma afinação que resolva — o volume é o problema.

**E tem um custo colateral.** O IP que o ASR queima é o mesmo que serve os
streams turcos. Ligar isto degrada uma funcionalidade que hoje funciona.

### O que ficou construído, e serve

O código está escrito, testado e correto — o que falha é o acesso, não ele:

| Módulo | O que faz |
|---|---|
| `src/youtube/sidx.js` | lê a caixa `sidx` e devolve as fronteiras dos fragmentos |
| `src/asr/audio.js` | extrai o endereço, corta em blocos, descarrega em pedaços de 1 MB |
| `src/asr/whisper.js` | transcreve um bloco, com modelos de reserva |
| `src/asr/index.js` | passagens incrementais com estado em KV e orçamento de subpedidos |
| `src/index.js` | oferece `Português (PT) (auto, do áudio)` quando não há mais nada |
| `GET /asr/{type}/{id}.json` | estado da transcrição; `?run=N` corre uma passagem |

Dez testes cobrem as chaves de KV, o corte em blocos, os deslocamentos de
tempo, a leitura da transcrição a partir de KV e as recusas (sem KV, desligado,
transcrição por fazer).

### O caminho que resta

**O plugin descarrega, o Worker transcreve.** O plugin já corre na televisão,
de um IP residencial, e já extrai estes endereços com sucesso — é o que faz
hoje para tocar. Com a `sidx` lida, pode descarregar um bloco e enviá-lo ao
Worker, que o transcreve e devolve. O `src/asr/` fica igual: só muda quem faz a
descarga.

A outra porta — **cookies de sessão no Worker** — não resolve isto. Destranca o
`LOGIN_REQUIRED` do player, mas o `403` da descarga é estrangulamento de
tráfego, e uma conta autenticada a puxar 128 MB de um IP de datacentro é um
candidato ainda melhor a ser marcada.

**Os cortes estão medidos e o parser existe.** Para o *Muhtemel Aşk* 1. Bölüm,
lido a partir do `indexRange` (`723-10774`), itag 140:

| | |
|---|---|
| fragmentos na `sidx` | 835 |
| duração somada | 8330,8 s (2h18m51s — bate certo) |
| primeiro fragmento | bytes 10779–172584, 9,985 s |
| blocos de 8 min | 18 |
| tamanho da faixa | 128,6 MB |

Ou seja, o passo «como partir o áudio» abaixo deixou de ser palpite: o
`parseSidx`/`chunkFragments` em `src/youtube/probe.js` já produz a lista de
cortes, e 18 chamadas ao Whisper cobrem o episódio. Falta só o áudio chegar lá.

### Como partir o áudio — já medido

O Whisper não engole 2h18 de áudio de uma vez, e o Worker não tem ffmpeg para
cortar. Mas **os cortes já estão calculados**: o `indexRange` que o
`src/dash.js` usa aponta para a caixa `sidx` do ficheiro, que lista as
fronteiras e as durações de cada fragmento.

Sequência, para cada bloco:

1. Descarregar o `initRange` (ex.: bytes `0-722` no itag 140) — uma vez por
   episódio.
2. Ler a `sidx` (`indexRange`, ex.: `723-10774`) e obter a lista de fragmentos.
3. Juntar `init` + N fragmentos seguidos → é um MP4 válido e autónomo.
4. Mandar ao Whisper e guardar o texto com o deslocamento temporal do bloco.

Blocos de 5 a 10 minutos parecem o compromisso certo entre número de chamadas e
contexto para o modelo. **Medido** para o *Muhtemel Aşk* 1. Bölüm: com blocos de
8 minutos são 18 chamadas ao Whisper por episódio. O `parseSidx` e o
`chunkFragments` que produzem esta lista estão escritos em
`src/youtube/probe.js`.

### Depois da transcrição

O texto sai em turco, com marcas de tempo, e entra no caminho que já existe:
`src/translate/` traduz de `tr` para `pt` e `src/format/srt.js` escreve o SRT.
Nada disto é código novo.

Guardar em KV com chave própria — sugestão `asr:v1:{imdb}:{s}:{e}` — e prazo
longo, porque um episódio transcrito nunca mais muda. Sem cache, isto é caro
demais para se repetir.

### Por decidir

- **Custo.** Quantos *neurons* de Workers AI custa transcrever 2h18. Sem este
  número não se sabe se a funcionalidade cabe no plano gratuito.
- **Tempo.** Uma transcrição destas não cabe na janela de um pedido. Tem de
  arrancar em segundo plano (como o `PREWARM` já faz) e a legenda só aparece
  quando estiver pronta — o que muda a experiência: o utilizador começa o
  episódio sem legendas e elas surgem depois.
- **Qualidade.** O Whisper em turco é decente, mas nomes próprios de dizi
  histórico vão sair mal. Marcar a entrada como `(auto, do áudio)` para o
  utilizador saber o que está a ler.
- **Só quando não há alternativa.** Isto corre apenas se não existir nenhuma
  legenda real em língua nenhuma. Uma legenda humana, mesmo em inglês, vale mais
  do que uma transcrição automática.

---

## 2. Separar o addon de legendas do addon de coleções — FEITO (30-08-2026)

### Porquê

Hoje é um manifesto só (`com.nuvio.subs.pt`) a anunciar duas coisas de âmbitos
diferentes:

| Recurso | Serve o quê |
|---|---|
| `subtitles` | **Tudo.** Verificado em produção com o *Blood Diamond* (2006). |
| `catalog` | Só séries turcas (`with_original_language=tr`). |

Quem quer legendas portuguesas para o catálogo inteiro leva duas coleções
turcas ao ecrã inicial sem as ter pedido. Quem quer as coleções turcas leva um
addon de legendas que talvez já tenha. E a descrição do manifesto tem de
explicar as duas coisas ao mesmo tempo, o que a torna confusa.

Há ainda um efeito prático: o `STREAMS`, o `META_SHAPE_VERSION` e o repositório
de plugins são todos assunto do lado turco, mas vivem no manifesto das legendas.

### Como

**Opção recomendada: dois manifestos, um Worker.** As rotas já estão separadas
por prefixo, o KV é o mesmo, os segredos são os mesmos, e não há um segundo
deploy para manter.

| | Addon de legendas | Addon turco |
|---|---|---|
| id | `com.nuvio.subs.pt` (fica) | `com.nuvio.turcas.pt` (novo) |
| manifesto | `/manifest.json` | `/turcas/manifest.json` |
| recursos | `subtitles` | `catalog` (e `stream`, se algum dia voltar) |
| plugin do NuvioTV | — | `/plugin/manifest.json` |

O id **tem de ser diferente**: o Nuvio guarda os addons por id de manifesto, e
dois com o mesmo id são o mesmo addon.

A alternativa — dois Workers, dois repositórios — dá separação verdadeira, mas
duplica o KV, os segredos e o código de tradução para nenhum ganho visível ao
utilizador. Só compensa se um dia tiverem donos diferentes.

### Trabalho

1. `src/manifest.js` passa a construir dois manifestos a partir de uma função
   parametrizada, em vez de um só com recursos condicionais.
2. Router: acrescentar `/turcas/manifest.json`. **Verificado na fonte do
   NuvioTVSmart, e a resposta é sim:** o `addonRepository.canonicalizeUrl()`
   corta o sufixo `/manifest.json`, e o `catalogRepository.buildCatalogUrl`
   constrói `${basePath}/catalog/...` (o mesmo em `streamRepository` e
   `subtitleRepository`). O catálogo passou portanto para
   `/turcas/catalog/...`; as rotas sem prefixo ficaram a responder para quem
   instalou a versão anterior.
3. Página inicial: três endereços em vez de dois, com o mesmo aviso que já lá
   está sobre não os trocar.
4. `README.md`: separar as secções, que hoje estão entrelaçadas.
5. Testes: o que hoje verifica «sem `TMDB_API_KEY` não há catálogos no
   manifesto» passa a ser sobre o manifesto turco.

### Migração

Quem já tem o addon instalado fica com o de legendas e **não recebe as
coleções** — tem de adicionar o segundo endereço à mão. Não há forma de o fazer
por ele, e é preciso dizê-lo na página inicial em vez de o deixar descobrir com
um ecrã inicial subitamente vazio.

---

## Ordem sugerida

**As duas foram feitas em 30-08-2026.**

A **2** está publicada. O ponto que estava por confirmar — onde o Nuvio vai
buscar os catálogos — não precisou de tentativa nenhuma: está na fonte do
NuvioTVSmart. O `addonRepository.canonicalizeUrl()` corta o `/manifest.json` e
o `catalogRepository.buildCatalogUrl` constrói `${basePath}/catalog/...`, tal
como o `streamRepository` e o `subtitleRepository` fazem para os deles. Logo o
catálogo do addon turco tem mesmo de viver em `/turcas/catalog/...`, e é onde
está.

A **1** está construída e desligada. Levou três vereditos até assentar, e os
dois primeiros estavam errados: «barreira de autenticação» veio de uma passagem
única; «viável» veio de repetir só a parte barata. Só ao pedir megabytes a
sério apareceu o que estava lá desde o início — um estrangulamento por IP, que
o volume de um episódio inteiro aciona sempre.

A lição para a próxima experiência: medir na escala do uso real, e não na de
uma sonda. Uma sonda que pede 11 KB não descobre um limite que só aparece ao
segundo megabyte.

---

## 3. `403` a reproduzir e a saltar no vídeo — CAUSA MEDIDA, correção por arranjar

Aberto em 31-08-2026 e medido no mesmo dia, do PC e da TV LG. A causa está
identificada e **não é nenhuma das duas que o plano tinha previsto**: os
endereços do `googlevideo` vêm sem *proof-of-origin token*, e sem ele o servidor
entrega só os primeiros ~50 s do ficheiro. O paliativo das faixas já entrou e
continua a valer, mas não resolve isto.

### O sintoma, medido na Shield

NVIDIA Shield (`mdarcy`), perfil *Mae*, *Doğanın Kanunu* T1E1, fonte
`Turcas PT — 1080p` (o manifesto DASH):

- **Reproduzir do início funciona.** Tocou em 1080p e encheu buffer sem falhar.
- **Saltar mata a reprodução**, em `position=54040`:

```
E/ExoPlayerImplInternal: Playback error
  androidx.media3.exoplayer.ExoPlaybackException: Source error
  Caused by: androidx.media3.datasource.HttpDataSource$InvalidResponseCodeException: Response code: 403
      at androidx.media3.datasource.okhttp.OkHttpDataSource.open(SourceFile:148)
```

Os dois sintomas que o utilizador relatou — «dá 403 a reproduzir» e «não dá para
andar para a frente ou trás» — são **o mesmo defeito**: encher o buffer e saltar
são ambos pedir bytes numa posição nova.

### O que já está eliminado

Nada disto explica o `403`:

| Hipótese | Como caiu |
|---|---|
| codec | falha igual em `vp9`, `av01` e `avc1` |
| *User-Agent* | o do leitor e o da app do YouTube dão o mesmo |
| cliente do player | `ANDROID` e `IOS` indistinguíveis |
| expiração do endereço | faltavam 6 h (`expire=`) |
| `n` / `pot` | os endereços não trazem esse parâmetro |
| manifesto do Worker | XML correto; o `403` vem do `googlevideo` |

### A armadilha que estragou a medição — ler antes de voltar a medir

As sondas saíam do PC, que **partilha o IP público com a Shield**
(`188.250.26.84`), e o `googlevideo` limita por IP. Ao fim de quatro séries de
pedidos os resultados começaram a contradizer-se: o mesmo caso que dera `206`
passou a dar `403`, e até `Range: bytes=0-` falhava depois de um pedido
bem-sucedido no mesmo endereço:

```
inicio, fechado      bytes=0-500000          -> 206 (488KB)
salto 20MB, fechado  bytes=20000000-20500000 -> 403
salto 20MB, aberto   bytes=20000000-         -> 403
inicio, aberto       bytes=0-                -> 403
```

A partir daí a sonda deixou de medir o defeito e passou a medir a sua própria
actividade — e pode ter agravado o sintoma para quem estava a ver televisão.

**Regra para amanhã:** descanso de ~1 h sem pedidos ao YouTube deste IP, e
depois **um único** pedido de controlo. Repetir o controlo no fim de cada série:
se mudou de resultado, a série inteira não conclui nada.

### O teste limpo — FEITO em 31-08-2026, e o veredito é `403`

IP frio (12 h desde a última sonda), endereço acabado de extrair, **um só**
pedido ao `googlevideo`. Corrido do PC, que partilha o IP público com a Shield:

| | |
|---|---|
| vídeo | `NWSeGEjeuFw` — *Doğanın Kanunu* 1. Bölüm |
| faixa | itag 248, 1080p, `vp9`, 961,0 MB |
| `ip=` no endereço | `188.250.26.84` — o IP de casa, o certo |
| `expire=` | faltavam 5 h |
| `n=` / `pot=` | **nenhum dos dois** |
| pedido | `Range: bytes=503824649-504873224` (1 MB, a meio) |
| resposta | **`403 Forbidden`**, 0 bytes, em 106 ms |

Pela regra de decisão escrita antes de medir, isto mandava executar o passo 2.
**A regra disparou bem e apontou para o sítio errado** — o passo 2 assentava
numa premissa que a regra nunca punha à prova. Ver abaixo.

### A TV LG como segundo aparelho — o que ela destrancou

A LG (`Quarto`, 192.168.1.85, webOS em modo de programador) tem `curl`, `wget` e
`node` no próprio sistema, alcançáveis por SSH na porta 9922. Isso permite
sondar **do aparelho**, e não de um script a fingir que é um aparelho.

O IP público que a TV vê é `188.250.26.84` — o mesmo do PC e da Shield. Portanto
a TV **não** é uma origem independente e não serve para separar o efeito do IP.
O que ela deu foi outra coisa, mais útil: pedidos suficientemente baratos para
correr um controlo a sério.

### O que se mediu, e desta vez com controlo nas duas pontas

Uma extracção, vários pedidos, e `bytes=0-1048575` na primeira e na última
linha da série. Se os dois controlos discordarem, a série não conclui nada.

```
inicio (controlo)          bytes=0            -> 206
5 MB  (~54 s, a Shield)    bytes=5242880      -> 206
20 MB                      bytes=20971520     -> 403
100 MB                     bytes=104857600    -> 403
meio do ficheiro           bytes=391843562    -> 403
inicio (controlo, fim)     bytes=0            -> 206
```

Os dois controlos concordam. **O IP não está castigado: a posição é a
variável.** Isto elimina a leitura que o registo anterior tinha deixado em
aberto — «o que nos mata é volume de pedidos» está errado.

### O passo 2 está morto: o `&range=` não salva nada

A premissa do passo 2 era que a app do YouTube evita o cabeçalho `Range` e
manda o intervalo no parâmetro `&range=` do endereço, e que esse caminho
passava. Testado directamente na TV, na mesma posição, com o `&range=` a ser o
**primeiro** pedido ao `googlevideo` de uma extracção fresca:

```
A) &range=391843562-392892137 no endereco, SEM cabecalho   -> 403
B) cabecalho Range: bytes=391843562-392892137              -> 403
```

Os dois recusam igual. O `200` que a nota de 31-08 registava veio de uma
medição com o IP a meio caminho de castigado, tal como essa nota já suspeitava.
**Escrever o `SegmentList` não resolve o defeito** — e teria custado um contrato
novo com o plugin, uma versão nova a descarregar por todos os clientes, e um
manifesto com centenas de `<SegmentURL>`.

### A fronteira, bisseccionada dentro de uma só extracção

itag 248, 783 687 124 bytes, 6814 s de duração (115 010 B/s):

| | |
|---|---|
| último `206` | 5 931 225 bytes — **5,66 MB — 51,6 s** |
| primeiro `403` | 6 122 555 bytes — **5,84 MB — 53,2 s** |
| fracção do ficheiro | 0,76 % |
| controlo final | `206` — a série vale |

**A Shield falhou em `position=54040`, ou seja 54,0 s.** O salto que o
utilizador fez aterrou dois segundos depois da fronteira. Não é coincidência
nenhuma: é o mesmo limite, visto de dois sítios.

### Nenhuma faixa escapa — varrimento de codecs e itags

Uma extracção, cada faixa com o seu próprio controlo `bytes=0` antes e depois:

```
itag  qual   codec              MB     ctl0  20MB  ctl0  veredito
137   1080p  avc1.640028        2423   206   206   206   *** SALTA ***
248   1080p  vp9                 961   206   403   206   limitado ao prefixo
136   720p   avc1.4d401f        1305   206   403   206   limitado ao prefixo
247   720p   vp9                 584   206   403   206   limitado ao prefixo
399   1080p  av01.0.08M.08       794   206   403   206   limitado ao prefixo
398   720p   av01.0.05M.08       482   206   403   206   limitado ao prefixo
```

O itag 137 parecia a resposta, e uma resposta barata: mandar só `avc1` e o
salto voltava. **Era falso.** O 137 tem 2423 MB contra 747–961 MB das outras, e
a 364 KB/s os `20 MB` da sonda são 55 s — **exactamente em cima da fronteira**.
Sondado mais fundo, na mesma extracção:

```
50 MB    141 s   206  403  206   limitado ao prefixo
100 MB   281 s   206  403  206   limitado ao prefixo
200 MB   562 s   206  403  206   limitado ao prefixo
500 MB  1406 s   206  403  206   limitado ao prefixo
1000 MB 2812 s   206  403  206   limitado ao prefixo
2000 MB 5624 s   206  403  206   limitado ao prefixo
```

A lição: uma posição de sonda fixa em bytes mede pontos diferentes do fenómeno
em faixas de débitos diferentes, e a faixa maior é sempre a que fica aquém da
fronteira. Um varrimento que produz **um único vencedor** deve sondá-lo mais
fundo antes de se acreditar nele.

### Nenhum cliente escapa

```
ANDROID       137 1080p  206 206 206   (falso positivo, ver acima)
IOS           137 1080p  206 206 206   (o mesmo)
ANDROID_VR    —   playabilityStatus LOGIN_REQUIRED
TVHTML5_SIMPLY_EMBEDDED_PLAYER  —  ERROR
WEB_EMBEDDED_PLAYER             —  ERROR
MWEB          —   playabilityStatus UNPLAYABLE
WEB           —   UNPLAYABLE, 0 formatos (nem cifrados)
TVHTML5       —   UNPLAYABLE, 0 formatos (nem cifrados)
```

Só o `ANDROID` e o `IOS` devolvem endereços directos, e ambos dão a mesma faixa
com o mesmo limite. Os restantes nem chegam a entregar formatos.

### A causa, e o que ela mata

Os endereços não trazem `n=` nem `pot=`. O que o `googlevideo` serve sem
*proof-of-origin token* é exactamente isto: um prefixo curto do ficheiro, e
`403` em tudo o resto. Tocar do início funciona porque os primeiros ~50 s cabem
no prefixo; encher buffer para além disso, ou saltar para qualquer sítio depois
disso, cai fora.

**Não é um defeito de `Range`, de codec, de segmentação, de cliente, nem de
volume de pedidos.** É falta de credencial no endereço. Isso mata os três
caminhos que este plano tinha previsto:

| Caminho previsto | Porque morreu |
|---|---|
| passo 2 — `SegmentList` com `&range=` | o `&range=` dá `403` na mesma posição que o cabeçalho |
| passo 3 — reserva em 360p | a faixa 360p é limitada na mesma (itag 243: 20–27 s, *pior*) |
| paliativo — menos faixas | a fronteira é idêntica com um pedido ou com doze |

### O que resta, e é uma coisa só

**Arranjar um `pot`.** É o único caminho que ataca a causa medida. O que se sabe
já, e limita as opções:

- O Worker não serve para o mintar: a Cloudflare proíbe `eval`, e o BotGuard
  precisa de executar código dinâmico.
- O plugin corre em QuickJS sem DOM, que também não chega para o BotGuard.
- O `pot` prende-se ao `visitorData`, não ao IP — portanto quem o minta não tem
  de ser quem descarrega. Isso abre a porta a mintá-lo noutro sítio e entregá-lo,
  mas obriga a ter esse «outro sítio» algures.

Por decidir antes de escrever código: onde é que o BotGuard corre.

### Fica por medir, e já não bloqueia nada

Se a fronteira é em tempo, em bytes ou em fracção do ficheiro. As três leituras
dão números próximos e nenhuma delas muda a correcção — todas as faixas ficam
inutilizáveis para saltar. Registado por honestidade, não por ser preciso.

### Paliativo aplicado em 31-08-2026 — uma faixa por codec

O manifesto levava **13 Representations**. O ExoPlayer troca de qualidade
sozinho, e cada troca abre pedidos novos ao `googlevideo`.

- `plugin/turcas-pt.js`: `MAX_PER_CODEC` 6 → 1, `MAX_AUDIO` 2 → 1
- `src/dash.js`: `MAX_REPRESENTATIONS` 12 → 2

Custo: perde-se a adaptação à largura de banda. **Ainda não está publicado.**
Fica, porque menos pedidos não faz mal — mas já se sabe que **não é isto que
destranca o salto**: a fronteira é a mesma com um pedido ou com doze.

### Protocolo para a próxima sonda — o que se aprendeu a medir

O controlo **tem de estar dentro do script**, na primeira e na última linha, e o
script deve recusar-se a apresentar resultados se os dois discordarem. Nesta
sessão, todas as séries com o controlo embutido produziram resultados
interpretáveis; a única que o tinha de fora (itag 278) gastou oito pedidos para
nada, e só se soube depois de os gastar.

### Também por fazer, e não é deste assunto

O português europeu (regras no *prompt* + `src/translate/pt-pt.js`) está escrito,
testado e **por publicar**. O `wrangler deploy` ficou travado pela permissão na
sessão de 30-08-2026. Publicar e comparar o `tt43644041:1:1` antes e depois.
