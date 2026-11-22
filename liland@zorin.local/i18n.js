// Tiny translation table: follows the system language (pt / en).
import GLib from 'gi://GLib';

const PT = {
    'Now Playing': 'Tocando agora',
    'Paused': 'Pausado',
    'Live': 'Ao vivo',
    'Nothing playing': 'Nada tocando',
    'Play music in any app or browser': 'Toque música em qualquer app ou navegador',
    'Open %s': 'Abrir %s',
    'Show When the Song Changes': 'Mostrar ao trocar de música',
    'Open Only on Click': 'Abrir só ao clicar',
    'Open on Hover': 'Abrir ao passar o mouse',
    'Equalizer Follows the Music': 'Equalizador acompanha a música',
    'Show Icon in Top Bar': 'Mostrar ícone na barra superior',
    'Quit Liland': 'Sair do Liland',
};

const isPortuguese = GLib.get_language_names().some(l => l.startsWith('pt'));

export function _(text) {
    return isPortuguese ? PT[text] ?? text : text;
}
