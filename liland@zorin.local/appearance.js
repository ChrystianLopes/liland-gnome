// Light / dark style for the whole desktop, like the macOS "Appearance".
//
// GNOME (and Zorin's dark style toggle) only change the color scheme, and
// Zorin's toggle swaps only themes named "Zorin*": with other theme pairs
// (e.g. WhiteSur-Dark / WhiteSur-Light) nothing visible changes. Here the
// color scheme changes and so do the GTK theme, the shell theme (User
// Themes extension) and the icon theme, when they have a -Dark/-Light
// (-dark/-light) counterpart installed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const USER_THEME_SCHEMA = 'org.gnome.shell.extensions.user-theme';

let interfaceSettings = null;

function getInterfaceSettings() {
    interfaceSettings ??= new Gio.Settings({schema_id: INTERFACE_SCHEMA});
    return interfaceSettings;
}

export function isDarkStyle() {
    return getInterfaceSettings().get_string('color-scheme') === 'prefer-dark';
}

function dataDirs() {
    return [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
}

function themeDirs() {
    return [GLib.build_filenamev([GLib.get_home_dir(), '.themes']),
        ...dataDirs().map(d => GLib.build_filenamev([d, 'themes']))];
}

function iconDirs() {
    return [GLib.build_filenamev([GLib.get_home_dir(), '.icons']),
        ...dataDirs().map(d => GLib.build_filenamev([d, 'icons']))];
}

// "Foo-Dark" -> "Foo-Light" (keeping the case of the suffix), if a theme
// with that name exists (with `subdir` in it, e.g. "gnome-shell"); else null.
function counterpart(name, dark, dirs, subdir = '') {
    const match = /^(.+)-(dark|light)$/i.exec(name ?? '');
    if (!match)
        return null;
    const word = dark ? 'dark' : 'light';
    const suffix = match[2][0] === match[2][0].toUpperCase()
        ? word[0].toUpperCase() + word.slice(1)
        : word;
    const candidate = `${match[1]}-${suffix}`;
    if (candidate === name)
        return null;
    const exists = dirs.some(dir =>
        GLib.file_test(GLib.build_filenamev([dir, candidate, subdir]), GLib.FileTest.IS_DIR));
    return exists ? candidate : null;
}

function userThemeSettings() {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source?.lookup(USER_THEME_SCHEMA, true))
        return null;
    return new Gio.Settings({schema_id: USER_THEME_SCHEMA});
}

export function toggleStyle() {
    const settings = getInterfaceSettings();
    const dark = !isDarkStyle();
    Main.layoutManager.screenTransition?.run();

    const gtk = counterpart(settings.get_string('gtk-theme'), dark, themeDirs(), 'gtk-3.0');
    if (gtk)
        settings.set_string('gtk-theme', gtk);
    const icons = counterpart(settings.get_string('icon-theme'), dark, iconDirs());
    if (icons)
        settings.set_string('icon-theme', icons);
    const shell = userThemeSettings();
    const shellTheme = shell && counterpart(shell.get_string('name'), dark, themeDirs(), 'gnome-shell');
    if (shellTheme)
        shell.set_string('name', shellTheme);

    settings.set_string('color-scheme', dark ? 'prefer-dark' : 'default');
}
