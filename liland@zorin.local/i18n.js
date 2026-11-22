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
    'Volume and Brightness in the Island': 'Volume e brilho na ilha',
    'Notifications in the Island': 'Notificações na ilha',
    'Control Center': 'Central de Controle',
    'More Controls': 'Mais controles',
    'Do Not Disturb': 'Não perturbe',
    'Airplane Mode': 'Modo avião',
    'Wi-Fi': 'Wi-Fi',
    'Bluetooth': 'Bluetooth',
    'Night Light': 'Luz noturna',
    'Dark Mode': 'Modo escuro',
    'Screenshot': 'Captura de tela',
    'Brightness': 'Brilho',
    'Volume': 'Volume',
    'Lock': 'Bloquear',
    'Settings': 'Configurações',
    'Power Off': 'Desligar',
    'Previous': 'Anterior',
    'Play': 'Tocar',
    'Next': 'Próxima',
    'Replace the Top Bar': 'Substituir a barra superior',
};

const isPortuguese = GLib.get_language_names().some(l => l.startsWith('pt'));

export function _(text) {
    return isPortuguese ? PT[text] ?? text : text;
}
