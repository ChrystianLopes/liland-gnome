# liland para gnome ♡

uma dynamic island no topo da tela do linux, pra ver e controlar a música que está tocando.
feita para o **zorin os 18 / gnome 46 (wayland ou x11)**, inspirada no [liland](https://github.com/sacis/Liland) para macOS.

quando tem música tocando, o centro da barra superior vira uma ilha preta com a capa do álbum e um equalizador.
passando o mouse por cima, ela abre um player com a música, o artista, a barra de progresso (dá pra arrastar) e os controles,
incluindo aleatório e repetir quando o app informa esses modos.

a ilha **substitui a barra superior**: a barra do gnome some (as janelas ganham o espaço) e a ilha fica sempre lá,
mostrando a hora (e, com música, a capa e o equalizador ao lado dela). passando o mouse, ela abre com duas abas:

- **música**: o player (ou "nada tocando", com um botão para abrir o spotify ou o último player usado).
- **bandeja**: todos os botões que ficavam na barra (configurações rápidas, calendário e notificações, menu do zorin,
  ícones de apps, clipboard, impressoras, outras extensões...). os menus deles abrem logo abaixo da ilha, que fica
  aberta enquanto um menu estiver aberto. os atalhos de teclado (ex.: super+v para o calendário) abrem a ilha na bandeja.

sem música tocando, a ilha abre direto na bandeja. desligando a opção **substituir a barra superior** (ou a extensão),
a barra volta exatamente como estava.

a ilha também mostra **atividades ao vivo**, como no iphone:

- **volume e brilho**: ao mudar o volume ou o brilho (teclas, rolagem no ícone de som), o nível aparece numa pílula
  na ilha em vez do aviso no meio da tela.
- **notificações**: chegam na ilha (app, título, texto e até 2 botões de ação). passar o mouse por cima segura a
  notificação na tela; clicar abre o app. se chegarem várias, aparecem uma de cada vez.

o "não perturbe", a tela cheia e as preferências de notificação de cada app continuam valendo. o que a ilha não mostra
fica com o gnome: notificações **críticas** (ex.: bateria fraca), avisos sem nível (ex.: caps lock) e qualquer coisa
quando a ilha não está visível (tela cheia, outro monitor).

funciona com qualquer player que fale **MPRIS**: spotify, firefox, chrome/chromium, youtube, deezer web, tidal, vlc, rhythmbox, etc.
não precisa de login nem de permissão extra.

## instalação

```bash
git clone <este repo> ~/liland-gnome
cd ~/liland-gnome
./install.sh
```

no wayland, o gnome só enxerga extensões novas depois de **encerrar a sessão e entrar de novo**. depois disso:

```bash
gnome-extensions enable liland@zorin.local
```

pra atualizar: `git pull && ./install.sh` e encerre/entre na sessão de novo.

com a barra substituída, a pílula da hora fica no centro do topo da tela, por cima das janelas maximizadas
(como o notch de um macbook): esse pedacinho da barra de título delas fica coberto.

com a opção **substituir a barra superior** desligada, a ilha mede o espaço livre no centro da barra superior e, quando abre, só fica mais larga **abaixo** da barra,
sem cobrir os itens ao lado (áreas de trabalho, ícones, relógio). se algum item estiver bem no centro
(como o relógio no gnome padrão), a ilha invisível não reage ao mouse ali e o item continua clicável;
com música tocando, a pílula compacta fica por cima dele.

## opções

ficam no ícone de cápsula (na aba bandeja da ilha, ou na barra superior se ela não for substituída):

- **substituir a barra superior** esconde a barra do gnome e leva tudo para a ilha (ligado por padrão).
- **mostrar ao trocar de música** abre a ilha por alguns segundos quando a faixa muda.
- **abrir só ao clicar** / **abrir ao passar o mouse**.
- **equalizador acompanha a música** faz as barrinhas seguirem o som de verdade. o `levels.py` escuta a saída de áudio
  (monitor do pipewire) via gstreamer, só mede na hora e não grava nada. ele só roda enquanto tem música tocando.
  como ele escuta a **saída** de áudio (não o microfone), o stream se identifica como medidor de volume
  (`org.gnome.VolumeControl`) para o gnome não mostrar o ícone de "microfone em uso". se preferir ver o ícone,
  é só deixar essa opção desligada (é o padrão).
- **volume e brilho na ilha** / **notificações na ilha** ligam e desligam cada atividade (desligado, volta o aviso
  normal do gnome).
- **sair do liland** desativa a extensão (reative com `gnome-extensions enable liland@zorin.local`).

pra esconder o ícone da barra: `gsettings --schemadir ~/.local/share/gnome-shell/extensions/liland@zorin.local/schemas set org.gnome.shell.extensions.liland show-indicator false`

## como funciona

| arquivo | o que faz |
| --- | --- |
| `extension.js` | liga tudo e monta o menu da cápsula |
| `island.js` | a ilha: forma de notch, hora, abas, modos idle/compacto/aberto/mensagem/bandeja/atividade, animações, hover e clique |
| `topbar.js` | substitui a barra: esconde a barra (sem reservar espaço), leva as caixas de botões dela para a aba bandeja e devolve tudo ao desligar |
| `activities/music.js` | o player de música: pílula compacta, player aberto, "nada tocando", barra de progresso e equalizador |
| `activities/osd.js` | volume/brilho na ilha (assume o `Main.osdWindowManager.show` do gnome) |
| `activities/notifications.js` | notificações na ilha (assume o `MessageTray._showNotification` do gnome) |
| `mpris.js` | lê todos os players MPRIS pelo D-Bus, escolhe o ativo, baixa a capa e tira a cor de destaque |
| `levels.js` + `levels.py` | equalizador real: espectro do áudio em 6 faixas com faixa dinâmica adaptativa |

## o que ficou de fora (por enquanto)

o modo **avançado** do liland original (isolar voz/guitarra/baixo/bateria com a rede neural htdemucs, equalizador de 5 faixas e mudar o tom)
não foi portado. a separação por rede neural não roda em tempo real numa cpu sem gpu dedicada; equalizador e tom dá pra fazer com pipewire
(o [easyeffects](https://github.com/wwmm/easyeffects) já faz isso muito bem).

## créditos

ideia, comportamento, medidas da ilha, o algoritmo do equalizador e o da cor de destaque vêm do [liland](https://github.com/sacis/Liland), de sacis.
esta é uma reimplementação independente para gnome shell.
