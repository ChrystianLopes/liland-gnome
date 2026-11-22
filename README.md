# liland para gnome ♡

uma dynamic island no topo da tela do linux, pra ver e controlar a música que está tocando.
feita para o **zorin os 18 / gnome 46 (wayland ou x11)**, inspirada no [liland](https://github.com/sacis/Liland) para macOS.

quando tem música tocando, o centro da barra superior vira uma ilha preta com a capa do álbum e um equalizador.
passando o mouse por cima, ela abre um player com a música, o artista, a barra de progresso (dá pra arrastar) e os controles,
incluindo aleatório e repetir quando o app informa esses modos.

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

## opções

ficam no ícone de cápsula da barra superior:

- **mostrar ao trocar de música** abre a ilha por alguns segundos quando a faixa muda.
- **abrir só ao clicar** / **abrir ao passar o mouse**.
- **equalizador acompanha a música** faz as barrinhas seguirem o som de verdade. o `levels.py` escuta a saída de áudio
  (monitor do pipewire) via gstreamer, só mede na hora e não grava nada. ele só roda enquanto tem música tocando.
- **sair do liland** desativa a extensão (reative com `gnome-extensions enable liland@zorin.local`).

pra esconder o ícone da barra: `gsettings --schemadir ~/.local/share/gnome-shell/extensions/liland@zorin.local/schemas set org.gnome.shell.extensions.liland show-indicator false`

## como funciona

| arquivo | o que faz |
| --- | --- |
| `extension.js` | liga tudo e monta o menu da cápsula |
| `island.js` | a ilha: forma de notch, modos idle/compacto/aberto/mensagem, animações, hover e clique |
| `mpris.js` | lê todos os players MPRIS pelo D-Bus, escolhe o ativo, baixa a capa e tira a cor de destaque |
| `levels.js` + `levels.py` | equalizador real: espectro do áudio em 6 faixas com faixa dinâmica adaptativa |

## o que ficou de fora (por enquanto)

o modo **avançado** do liland original (isolar voz/guitarra/baixo/bateria com a rede neural htdemucs, equalizador de 5 faixas e mudar o tom)
não foi portado. a separação por rede neural não roda em tempo real numa cpu sem gpu dedicada; equalizador e tom dá pra fazer com pipewire
(o [easyeffects](https://github.com/wwmm/easyeffects) já faz isso muito bem).

## créditos

ideia, comportamento, medidas da ilha, o algoritmo do equalizador e o da cor de destaque vêm do [liland](https://github.com/sacis/Liland), de sacis.
esta é uma reimplementação independente para gnome shell.
