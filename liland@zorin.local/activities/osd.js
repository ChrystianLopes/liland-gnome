// Volume / brightness / keyboard light levels in the island instead of
// GNOME's OSD at the center of the screen.
//
// Every level OSD goes through Main.osdWindowManager.show() (media keys via
// gnome-settings-daemon, the volume slider's scroll...). It is replaced on the
// instance while this module lives; anything the island can't show (OSDs
// without a level, other monitors, fullscreen...) goes to the original.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {COMPACT_WIDTH} from '../island.js';

const HIDE_DELAY = 1500;

export class OsdActivity {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._fraction = 0;
        this._hideId = 0;

        this._icon = new St.Icon({style_class: 'liland-osd-icon', icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({
            style_class: 'liland-osd-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'liland-osd-fill'});
        this._track.add_child(this._fill);
        this._track.connect('notify::width', () => this._syncFill());
        this._label = new St.Label({style_class: 'liland-osd-label', y_align: Clutter.ActorAlign.CENTER});
        // Optional text that comes with a level, e.g. the output device name.
        this._name = new St.Label({style_class: 'liland-osd-name', y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const box = new St.BoxLayout({style_class: 'liland-osd', width: COMPACT_WIDTH});
        box.add_child(this._icon);
        box.add_child(this._name);
        box.add_child(this._track);
        box.add_child(this._label);
        this._activity = {actor: box, width: COMPACT_WIDTH, contentHeight: 0};

        const manager = Main.osdWindowManager;
        this._manager = manager;
        this._hadOwnShow = Object.hasOwn(manager, 'show');
        this._originalShow = manager.show;
        const original = this._originalShow;
        manager.show = (monitorIndex, icon, label, level, maxLevel) => {
            if (this._take(monitorIndex, level)) {
                // Like the original: no other OSD stays up with an old level.
                manager.hideAll();
                this._show(icon, label, level, maxLevel);
                return undefined;
            }
            return original.call(manager, monitorIndex, icon, label, level, maxLevel);
        };
    }

    _take(monitorIndex, level) {
        if (!this._settings.get_boolean('osd-in-island'))
            return false;
        // OSDs without a level (e.g. "caps lock", touchpad on/off) stay native.
        if (level === null || level === undefined)
            return false;
        if (monitorIndex !== -1 && monitorIndex !== Main.layoutManager.primaryIndex)
            return false;
        return this._island.canShowActivity();
    }

    _show(icon, label, level, maxLevel) {
        const max = maxLevel > 0 ? maxLevel : 1;
        this._icon.gicon = icon;
        this._fraction = Math.min(Math.max(level / max, 0), 1);
        this._label.text = `${Math.round(Math.max(level, 0) * 100)}%`;
        this._name.text = label ?? '';
        this._name.visible = Boolean(label);
        this._island.showActivity(this._activity);
        this._activity.actor.height = this._island.notchHeight;
        this._syncFill();

        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
            this._hideId = 0;
            this._island.hideActivity(this._activity);
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncFill() {
        if (!this._track.get_stage())
            return;
        const width = this._track.width;
        this._fill.set_size(Math.round(width * this._fraction), this._track.height);
    }

    destroy() {
        if (this._hadOwnShow)
            this._manager.show = this._originalShow;
        else
            delete this._manager.show;
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
        this._island.hideActivity(this._activity);
        this._activity.actor.destroy();
    }
}
