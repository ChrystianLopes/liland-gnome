// Liland for GNOME: a dynamic island at the top of the screen to see and
// control the music that's playing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {NowPlaying} from './mpris.js';
import {LiveLevels} from './levels.js';
import {Island} from './island.js';
import {releaseAppearance} from './appearance.js';
import {ClipboardService} from './clipboard.js';
import {OsdActivity} from './activities/osd.js';
import {NotificationActivity} from './activities/notifications.js';
import {TopBarTakeover} from './topbar.js';
import {_} from './i18n.js';

export default class LilandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._nowPlaying = new NowPlaying();
        this._levels = new LiveLevels(this.path, this._settings);
        this._island = new Island(this._nowPlaying, this._settings, this._levels);
        Main.layoutManager.addTopChrome(this._island, {affectsInputRegion: true, trackFullscreen: true});
        this._osd = new OsdActivity(this._island, this._settings);
        this._notifications = new NotificationActivity(this._island, this._settings);
        this._topBar = new TopBarTakeover(this._island, this._settings);
        this._clipboard = new ClipboardService(this._settings);

        this._indicatorId = this._settings.connect('changed::show-indicator', () => this._syncIndicator());
        this._syncIndicator();
    }

    _syncIndicator() {
        const want = this._settings.get_boolean('show-indicator');
        if (want && !this._indicator) {
            this._indicator = this._buildIndicator();
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _buildIndicator() {
        const button = new PanelMenu.Button(0.5, 'Liland');
        button.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${this.path}/icons/liland-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
        const menu = button.menu;
        const s = this._settings;

        menu.addMenuItem(this._switch(_('Replace the Top Bar'), 'replace-top-bar'));
        menu.addMenuItem(this._switch(_('Show When the Song Changes'), 'peek-on-track-change'));
        const clickItem = new PopupMenu.PopupMenuItem('');
        const syncClick = () => {
            clickItem.label.text = s.get_boolean('open-on-click') ? _('Open on Hover') : _('Open Only on Click');
        };
        syncClick();
        clickItem.connect('activate', () => s.set_boolean('open-on-click', !s.get_boolean('open-on-click')));
        const clickId = s.connect('changed::open-on-click', syncClick);
        clickItem.connect('destroy', () => s.disconnect(clickId));
        menu.addMenuItem(clickItem);
        menu.addMenuItem(this._switch(_('Equalizer Follows the Music'), 'equalizer-follows-music'));
        menu.addMenuItem(this._switch(_('Volume and Brightness in the Island'), 'osd-in-island'));
        menu.addMenuItem(this._switch(_('Notifications in the Island'), 'notifications-in-island'));
        menu.addMenuItem(this._switch(_('Glass Effect'), 'glass-effect'));
        menu.addMenuItem(this._switch(_('Clipboard in the Island'), 'clipboard-in-island'));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const quit = new PopupMenu.PopupMenuItem(_('Quit Liland'));
        quit.connect('activate', () => {
            // Disable from the main loop, not inside this menu item's own
            // 'activate' handler: disabling destroys the menu.
            this._quitId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._quitId = 0;
                Main.extensionManager.disableExtension(this.uuid);
                return GLib.SOURCE_REMOVE;
            });
        });
        menu.addMenuItem(quit);
        return button;
    }

    _switch(label, key) {
        const item = new PopupMenu.PopupSwitchMenuItem(label, this._settings.get_boolean(key));
        item.connect('toggled', (_i, state) => this._settings.set_boolean(key, state));
        const id = this._settings.connect(`changed::${key}`, () => item.setToggleState(this._settings.get_boolean(key)));
        item.connect('destroy', () => this._settings.disconnect(id));
        return item;
    }

    disable() {
        releaseAppearance();
        if (this._quitId)
            GLib.source_remove(this._quitId);
        this._quitId = 0;
        this._settings.disconnect(this._indicatorId);
        this._clipboard.destroy();
        this._clipboard = null;
        // The top bar comes back (with its buttons) before anything else goes.
        this._topBar.destroy();
        this._topBar = null;
        this._indicator?.destroy();
        this._indicator = null;
        // Activities first: they give GNOME its OSD and banners back.
        this._notifications.destroy();
        this._notifications = null;
        this._osd.destroy();
        this._osd = null;
        Main.layoutManager.removeChrome(this._island);
        this._island.destroy();
        this._island = null;
        this._levels.destroy();
        this._levels = null;
        this._nowPlaying.destroy();
        this._nowPlaying = null;
        this._settings = null;
    }
}
