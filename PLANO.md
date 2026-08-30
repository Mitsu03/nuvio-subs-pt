# Plano

Duas frentes decididas em 29-08-2026 e trabalhadas em 30-08-2026. A **2** está
feita e publicada; a **1** parou na experiência 0, com a resposta registada
abaixo. Os números aqui são medidos, não estimados — onde há dúvida está escrito
que há dúvida.

---

## 1. Legendas a partir do áudio do próprio episódio — EM SUSPENSO

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
> eles — foi medido a funcionar. O que trava é outra coisa. Ver abaixo.

> **Experiência 0 — feita em 30-08-2026. Resultado: não passa, mas não pela
> razão que se esperava.**

A sonda vive em `GET /probe/player/{videoId}` (`src/youtube/probe.js`): raspa a
página, tira `INNERTUBE_API_KEY` + `visitorData`, chama `youtubei/v1/player`
por cinco perfis de cliente e, se algum responder `OK`, tenta mesmo descarregar
um bocado do `googlevideo` com `Range`. O veredito é o `206`, não o `status`.

Medido, com o Worker publicado:

| Vídeo | Do IP residencial | Da Cloudflare |
|---|---|---|
| `dQw4w9WgXcQ` (vídeo comum, 3 min) | — | **`OK`**, descarga `206`, `ip=172.68.103.95` |
| `QvZHtdpkybc` — *Muhtemel Aşk* 1. Bölüm | `OK`, descarga `206` | `LOGIN_REQUIRED` |
| `53Q7ulvGdkU` — *Kuruluş Osman* 1. Bölüm 4K | — | `LOGIN_REQUIRED` |
| `0fTJyCTwznM` — *Kuruluş Osman* 1. Bölüm | — | `LOGIN_REQUIRED` |
| `1AuB0f2B56Q` — *Kuruluş Osman* 28. Bölüm 4K | — | `LOGIN_REQUIRED` |

Os cinco clientes (`ANDROID`, `IOS`, `TVHTML5_SIMPLY_EMBEDDED_PLAYER`,
`WEB_EMBEDDED_PLAYER`, `MWEB`) foram todos recusados nos episódios turcos. A
razão que o YouTube devolve é literal: *«Bot olmadığınızı doğrulamak için oturum
açın»* — «inicie sessão para confirmar que não é um bot».

**O que isto corrige na premissa do plano.** Estava escrito que os endereços do
`googlevideo` estão presos ao IP e que o Worker por isso nunca poderia
descarregar. Está errado: o vídeo comum passou o circuito completo a partir da
Cloudflare, com `ip=172.68.103.95` — um IP da própria Cloudflare — dentro do
URL. Quando é o Worker a extrair, o endereço fica preso ao *Worker*, e a
descarga passa. **A extração a partir de um datacentro funciona.**

O que não funciona é a extração **destes** vídeos. O bloqueio é por vídeo e não
por origem: os episódios dos canais de televisão turcos exigem sessão a partir
de um IP não-residencial, e um vídeo qualquer não exige. A falha anterior com
`UNPLAYABLE` era o sintoma antigo da mesma política; o `visitorData` que
faltava não era a explicação toda.

**Consequência.** A transcrição do áudio no Worker fica em suspenso, mas não
por impossibilidade técnica — por uma barreira de autenticação. Duas portas
ficaram abertas, e nenhuma delas foi tentada:

1. **Cookies de sessão no Worker.** Se o pedido é «inicie sessão», uma cookie de
   uma conta YouTube guardada como segredo pode destrancá-lo. É a via directa e
   é também a arriscada: a conta pode ser marcada, e passa a haver uma
   credencial pessoal dentro do Worker. Decisão do dono do projeto, não técnica.
2. **O plugin extrai, o Worker transcreve.** O plugin já corre na televisão e já
   obtém estes endereços com sucesso — é o que faz hoje para tocar. Não precisa
   de mandar os 135 MB: com a `sidx` lida (ver abaixo, já medida), pode
   descarregar um bloco de ~8 min (~7,7 MB) e mandar só esse. Continua a ser
   ~128 MB para o episódio inteiro, mas espalhados e em segundo plano, e nada
   disso atravessa o Worker duas vezes.

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

A **1** parou na experiência 0, com um «não» que vale mais do que um «não»
seco: a extração a partir da Cloudflare funciona, os cortes do áudio estão
medidos e o parser está escrito. Falta destrancar o acesso a estes vídeos
concretos, e isso é uma decisão sobre credenciais, não um problema por
resolver. Está tudo em «Consequência», acima.
