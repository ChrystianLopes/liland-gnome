// The island replaces GNOME's top bar: the top bar is hidden (windows get its
// space) and its buttons (quick settings, calendar, tray icons, other
// extensions' indicators...) move into the island's "tray" tab, where their
// menus keep working. Everything goes back where it was when this ends.
//
// From GNOME 46's ui/layout.js and ui/panel.js:
// - panelBox is chrome with affectsStruts (its strut stays even while hidden)
//   and trackFullscreen (which would show it again): it is tracked again
//   without them while hidden.
// - The buttons live in Main.panel._leftBox/_centerBox/_rightBox. Those three
//   boxes move into the tray as they are, so buttons added or removed later
//   (addToStatusArea, with its positions) just work. The top bar stays hidden
//   meanwhile, so it never lays them out.
// - Each button's menu is anchored to the button and registered in
//   Main.panel.menuManager: nothing to change there.
// - Keyboard shortcuts (quick settings, calendar) go through
//   Main.panel._toggleMenu(), which ignores unmapped buttons: replaced on the
//   instance to open the island first.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ControlCenter} from './controlCenter.js';

export class TopBarTakeover {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._tray = null;
        this._settingsId = settings.connect('changed::replace-top-bar', () => this._sync());
        this._sync();
    }

    get active() {
        return this._tray !== null;
    }

    _sync() {
        const want = this._settings.get_boolean('replace-top-bar');
        if (want && !this.active)
            this._takeOver();
        else if (!want && this.active)
            this._giveBack();
    }

    _takeOver() {
        const panel = Main.panel;
        const layout = Main.layoutManager;
        const barHeight = panel.height;

        // Close menus anchored to the top bar before their buttons move.
        panel.menuManager?.activeMenu?.close(false);

        this._tray = new St.BoxLayout({style_class: 'liland-tray-items'});
        this._boxes = [panel._leftBox, panel._centerBox, panel._rightBox].filter(Boolean);
        this._boxSlots = this._boxes.map(box => ({box, index: panel.get_children().indexOf(box)}));
        this._boxSignals = [];
        for (const box of this._boxes) {
            panel.remove_child(box);
            this._tray.add_child(box);
            this._boxSignals.push([box, box.connect('child-added', () => this._watchMenus())]);
            this._boxSignals.push([box, box.connect('child-removed', () => this._island.trayChanged())]);
        }
        this._menus = new Map();
        this._watchMenus();

        // Hide the top bar and drop its strut.
        layout.untrackChrome(layout.panelBox);
        layout.trackChrome(layout.panelBox, {affectsStruts: false, affectsInputRegion: false, trackFullscreen: false});
        layout.panelBox.hide();
        this._panelVisibleId = layout.panelBox.connect('notify::visible', () => {
            if (layout.panelBox.visible)
                this._queue('_hidePanelId', () => layout.panelBox.hide());
        });

        // Shortcuts: open the island on the tray, then the menu.
        this._hadOwnToggle = Object.hasOwn(panel, '_toggleMenu');
        this._originalToggle = panel._toggleMenu;
        const original = this._originalToggle;
        panel._toggleMenu = indicator => {
            if (this._hiddenInTray(indicator)) {
                this._island.openTab('tray', false);
                this._afterLayout('_toggleId', () => original.call(panel, indicator));
                return;
            }
            original.call(panel, indicator);
        };

        this._island.setTopBarReplaced(this._tray, barHeight);
        // The quick settings menu becomes an iOS-style Control Center.
        this._controlCenter = new ControlCenter(this._island.nowPlaying);

        // Without the top bar, GNOME's own banners (critical notifications,
        // the ones that come while the island is open) would start at the
        // very top: keep them below the island's top part.
        Main.messageTray.translation_y = this._island.notchHeight;

        // Keep the island's strip reserved at the top, like the top bar (and
        // the Mac menu bar) did. Without it, maximized windows reach the top
        // of the screen; an undecorated one (a browser) then covers the whole
        // monitor and counts as fullscreen, which hides the island and the
        // dock, which resizes the window, which isn't fullscreen anymore...
        // (struts count even for hidden chrome, see GNOME 46 ui/layout.js).
        this._strut = new Clutter.Actor({reactive: false, opacity: 0});
        layout.addChrome(this._strut, {affectsStruts: true, affectsInputRegion: false, trackFullscreen: true});
        this._syncStrut();
        this._monitorsId = layout.connect('monitors-changed', () => this._syncStrut());

        this._islandHeightId = this._island.connect('notify::height', () => {
            Main.messageTray.translation_y = this._island.notchHeight;
            this._syncStrut();
        });
    }

    _syncStrut() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._strut || !monitor)
            return;
        const height = this._island.notchHeight;
        if (this._strut.x !== monitor.x || this._strut.y !== monitor.y ||
            this._strut.width !== monitor.width || this._strut.height !== height) {
            this._strut.set_position(monitor.x, monitor.y);
            this._strut.set_size(monitor.width, height);
        }
    }

    _inTray(indicator) {
        return Boolean(this._tray?.contains(indicator.container));
    }

    // In the tray, meant to be seen, but unmapped because the island is
    // closed (not hidden on purpose by GNOME or its owner).
    _hiddenInTray(indicator) {
        return Boolean(indicator) && this._inTray(indicator) && !indicator.mapped &&
            indicator.container.visible && indicator.reactive;
    }

    // Run fn once the stage has been laid out again (e.g. after the island
    // opened, so the tray's buttons have their final place), if the top bar
    // is still replaced then.
    _afterLayout(name, fn) {
        if (this[name])
            return;
        const stage = global.stage;
        const entry = {updateId: 0, timeoutId: 0};
        this[name] = entry;
        const finish = () => {
            this._cancelAfterLayout(name);
            if (this.active)
                fn();
        };
        entry.updateId = stage.connect('after-update', () => {
            stage.disconnect(entry.updateId);
            entry.updateId = 0;
            // Outside of the stage update.
            GLib.source_remove(entry.timeoutId);
            entry.timeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                entry.timeoutId = 0;
                finish();
                return GLib.SOURCE_REMOVE;
            });
        });
        // In case no frame comes.
        entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            entry.timeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelAfterLayout(name) {
        const entry = this[name];
        if (!entry)
            return;
        if (entry.updateId)
            global.stage.disconnect(entry.updateId);
        if (entry.timeoutId)
            GLib.source_remove(entry.timeoutId);
        this[name] = null;
    }

    // Run fn once from the main loop (outside of signal emissions), if the
    // top bar is still replaced then.
    _queue(name, fn) {
        this[name] ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this[name] = 0;
            if (this.active)
                fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    // While a tray button's menu is open, the island stays open under it.
    // Buttons (and their menus) come and go: look at all of them again.
    _watchMenus() {
        for (const indicator of Object.values(Main.panel.statusArea)) {
            if (!indicator || this._menus.has(indicator))
                continue;
            const record = {menu: null, menuId: 0, ids: []};
            record.ids.push(indicator.connect('menu-set', () => this._watchMenu(indicator, record)));
            record.ids.push(indicator.connect('destroy', () => this._unwatch(indicator)));
            this._menus.set(indicator, record);
            this._watchMenu(indicator, record);
        }
        this._island.trayChanged();
    }

    _watchMenu(indicator, record) {
        if (record.menu) {
            record.menu.disconnect(record.menuId);
            this._island.hold(record.menu, false);
        }
        record.menu = null;
        const menu = indicator.menu;
        if (!menu?.connect)
            return;
        record.menu = menu;
        record.menuId = menu.connect('open-state-changed', (_m, open) => {
            this._island.hold(menu, open);
            if (!open) {
                this._island.hideMenu(menu);
                return;
            }
            // Only menus of the tray's buttons, shown at their button; not
            // menus shown somewhere else on purpose (e.g. the clipboard's
            // "open at the pointer").
            if (menu.sourceActor !== indicator || !this._inTray(indicator) || !menu._boxPointer) {
                // Shown elsewhere: with its own look, even if it was in the
                // island a moment ago.
                this._island.dropMenuStyle(menu);
                return;
            }
            // Opened while the island isn't showing the tray (a shortcut,
            // the island closed or on another tab): show the tray first,
            // right away, so the island's card is there behind the menu.
            if (this._island.mode !== 'tray')
                this._island.openTab('tray', false);
            // The menu becomes part of the island.
            this._island.showMenu(menu);
        });
    }

    _unwatch(indicator) {
        const record = this._menus?.get(indicator);
        if (!record)
            return;
        for (const id of record.ids)
            indicator.disconnect(id);
        if (record.menu) {
            record.menu.disconnect(record.menuId);
            this._island.hold(record.menu, false);
            this._island.hideMenu(record.menu);
        }
        this._menus.delete(indicator);
    }

    _giveBack() {
        const panel = Main.panel;
        const layout = Main.layoutManager;
        if (this._hidePanelId)
            GLib.source_remove(this._hidePanelId);
        this._hidePanelId = 0;
        this._cancelAfterLayout('_toggleId');

        if (this._hadOwnToggle)
            panel._toggleMenu = this._originalToggle;
        else
            delete panel._toggleMenu;
        this._originalToggle = null;

        // Close the menus anchored to the tray before their buttons move.
        panel.menuManager?.activeMenu?.close(false);
        this._controlCenter?.destroy();
        this._controlCenter = null;
        for (const indicator of [...this._menus.keys()])
            this._unwatch(indicator);
        this._menus = null;

        for (const [obj, id] of this._boxSignals)
            obj.disconnect(id);
        this._boxSignals = [];
        // Back into the top bar, where they were.
        for (const {box, index} of this._boxSlots) {
            this._tray.remove_child(box);
            panel.insert_child_at_index(box, Math.max(0, Math.min(index, panel.get_n_children())));
        }
        this._boxes = this._boxSlots = null;

        layout.panelBox.disconnect(this._panelVisibleId);
        this._island.disconnect(this._islandHeightId);
        layout.disconnect(this._monitorsId);
        layout.removeChrome(this._strut);
        this._strut.destroy();
        this._strut = null;
        // Shown first: tracking it again with trackFullscreen hides it if a
        // fullscreen window is up.
        layout.panelBox.show();
        layout.untrackChrome(layout.panelBox);
        layout.trackChrome(layout.panelBox, {affectsStruts: true, affectsInputRegion: true, trackFullscreen: true});
        Main.messageTray.translation_y = 0;

        this._island.setTopBarReplaced(null);
        this._tray.destroy();
        this._tray = null;
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        if (this.active)
            this._giveBack();
    }
}
