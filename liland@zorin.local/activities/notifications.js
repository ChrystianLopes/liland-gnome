// Notification banners in the island instead of GNOME's banner.
//
// MessageTray._updateState() applies all of GNOME's rules (do not disturb,
// fullscreen, lock screen, per-app "show banners", queue) and then calls
// _showNotification() for the next queued notification. That method is
// replaced on the instance while this module lives: notifications the island
// can show are taken from GNOME's queue and shown here; the rest (critical
// ones, or when the island can't be seen) go to the original banner.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {OPEN_WIDTH} from '../island.js';

const SHOW_TIME = 5000;
const SHOW_TIME_AFTER_HOVER = 2000;
const SIDE_WALL = 16; // RADII.activity[0] in island.js
const BODY_HEIGHT = 66;
const ACTIONS_HEIGHT = 40;
const MAX_ACTIONS = 2;
// Same as GNOME: a user idle for longer than this isn't reading the screen.
const IDLE_TIME = 1000;

// Plain text of a notification body that may contain markup. Labels below
// never interpret markup, so this is only about not showing the tags.
function plainBody(notification) {
    const body = notification.body ?? '';
    if (!notification.useBodyMarkup)
        return body;
    try {
        const [, , text] = Pango.parse_markup(body, -1, 0);
        return text;
    } catch (_e) {
        return body;
    }
}

export class NotificationActivity {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._queue = [];
        this._current = null;
        this._timeoutId = 0;
        this._signals = new Map();

        this._buildUi();

        // Anything that changes whether the notification can be seen.
        const sync = () => this._syncTimeout();
        this._islandSignals = ['notify::hover', 'notify::visible', 'activity-changed']
            .map(signal => island.connect(signal, sync));

        const tray = Main.messageTray;
        this._tray = tray;
        this._hadOwnShow = Object.hasOwn(tray, '_showNotification');
        this._originalShow = tray._showNotification;
        const original = this._originalShow;
        tray._showNotification = () => {
            const next = tray._notificationQueue[0];
            if (!next || !this._take(next))
                return original.call(tray);
            // Same bookkeeping as GNOME does when it shows a banner.
            tray._notificationQueue.shift();
            tray.emit('queue-changed');
            next.acknowledged = true;
            next.playSound();
            this._enqueue(next);
            // GNOME's banner state stays HIDDEN, but _updateState() only takes
            // one notification per run: run it again so the rest of its queue
            // (still filtered by GNOME's rules) reaches the island too.
            this._drainId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._drainId = 0;
                tray._updateState();
                return GLib.SOURCE_REMOVE;
            });
            return undefined;
        };
    }

    _buildUi() {
        const box = new St.BoxLayout({vertical: true, width: OPEN_WIDTH - SIDE_WALL * 2});

        this._header = new St.BoxLayout({style_class: 'liland-notif-header'});
        this._appIcon = new St.Icon({icon_size: 14, style_class: 'liland-notif-app-icon', y_align: Clutter.ActorAlign.CENTER});
        this._appName = new St.Label({style_class: 'liland-notif-app', y_align: Clutter.ActorAlign.CENTER});
        this._appName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._header.add_child(this._appIcon);
        this._header.add_child(this._appName);
        box.add_child(this._header);

        const row = new St.BoxLayout({style_class: 'liland-notif-row', x_expand: true});
        this._icon = new St.Icon({icon_size: 32, style_class: 'liland-notif-icon', y_align: Clutter.ActorAlign.CENTER});
        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'liland-texts'});
        this._title = new St.Label({style_class: 'liland-notif-title'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._body = new St.Label({style_class: 'liland-notif-body'});
        this._body.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.END});
        texts.add_child(this._title);
        texts.add_child(this._body);
        row.add_child(this._icon);
        row.add_child(texts);
        this._bodyButton = new St.Button({
            style_class: 'liland-notif-main',
            child: row,
            can_focus: false,
            x_expand: true,
            height: BODY_HEIGHT,
        });
        this._bodyButton.connect('clicked', () => this._activate());
        box.add_child(this._bodyButton);

        this._actions = new St.BoxLayout({style_class: 'liland-notif-actions', height: ACTIONS_HEIGHT, x_expand: true});
        box.add_child(this._actions);

        this._activity = {actor: box, width: OPEN_WIDTH, contentHeight: BODY_HEIGHT};
    }

    _take(notification) {
        if (!this._settings.get_boolean('notifications-in-island'))
            return false;
        // Critical notifications expand and need attention: GNOME's banner.
        if (notification.urgency === MessageTray.Urgency.CRITICAL)
            return false;
        return this._island.canShowActivity();
    }

    _enqueue(notification) {
        if (this._current === notification || this._queue.includes(notification))
            return;
        const refill = () => {
            if (this._current === notification)
                this._fill(notification);
        };
        this._signals.set(notification, [
            notification.connect('destroy', () => this._onDestroyed(notification)),
            ...['title', 'body', 'gicon'].map(p => notification.connect(`notify::${p}`, refill)),
        ]);
        this._queue.push(notification);
        if (!this._current)
            this._next();
    }

    _forget(notification) {
        for (const id of this._signals.get(notification) ?? [])
            notification.disconnect(id);
        this._signals.delete(notification);
    }

    _onDestroyed(notification) {
        this._forget(notification);
        this._queue = this._queue.filter(n => n !== notification);
        if (this._current === notification) {
            this._current = null;
            this._next();
        }
    }

    _next() {
        this._clearTimeout();
        this._current = this._queue.shift() ?? null;
        if (!this._current) {
            this._island.hideActivity(this._activity);
            return;
        }
        // A new notification gets the full time once it starts counting down,
        // and (like GNOME) waits for an away user to come back.
        this._fullTime = true;
        this._watchUserActive();
        this._fill(this._current);
        this._island.showActivity(this._activity);
        this._syncTimeout();
    }

    _watchUserActive() {
        this._unwatchUserActive();
        const monitor = this._tray.idleMonitor;
        if (monitor.get_idletime() <= IDLE_TIME)
            return;
        this._idleWatchId = monitor.add_user_active_watch(() => {
            this._idleWatchId = 0;
            this._syncTimeout();
        });
    }

    _unwatchUserActive() {
        if (this._idleWatchId)
            this._tray.idleMonitor.remove_watch(this._idleWatchId);
        this._idleWatchId = 0;
    }

    _fill(notification) {
        const source = notification.source;
        this._appIcon.gicon = source?.icon ?? null;
        this._appIcon.visible = Boolean(source?.icon);
        this._appName.text = source?.title ?? '';
        this._icon.gicon = notification.gicon ?? source?.icon ?? null;
        this._title.text = notification.title ?? '';
        this._body.text = plainBody(notification);
        this._body.visible = this._body.text !== '';

        // The header sits at the top bar's height: keep it in the island's top part.
        const inset = (OPEN_WIDTH - this._island.neckWidth(OPEN_WIDTH)) / 2;
        this._header.margin_left = this._header.margin_right = inset;
        this._header.height = this._island.notchHeight;

        this._actions.destroy_all_children();
        const actions = notification.actions.slice(0, MAX_ACTIONS);
        for (const action of actions) {
            const button = new St.Button({
                style_class: 'liland-notif-action',
                label: action.label,
                can_focus: false,
                x_expand: true,
            });
            button.connect('clicked', () => this._run(notification, () => action.activate()));
            this._actions.add_child(button);
        }
        this._actions.visible = actions.length > 0;
        const contentHeight = BODY_HEIGHT + (actions.length > 0 ? ACTIONS_HEIGHT : 0);
        if (contentHeight !== this._activity.contentHeight) {
            this._activity.contentHeight = contentHeight;
            this._island.updateActivity(this._activity);
        }
    }

    _activate() {
        const notification = this._current;
        if (!notification)
            return;
        Main.overview.hide();
        Main.panel.closeCalendar();
        this._run(notification, () => notification.activate());
    }

    // Runs an action of the shown notification, then moves on (activating a
    // notification usually destroys it, which also moves on).
    _run(notification, fn) {
        fn();
        if (this._current === notification)
            this._finish();
    }

    _finish() {
        const notification = this._current;
        this._current = null;
        if (notification) {
            this._forget(notification);
            // Same as GNOME's banner: transient notifications go away once shown.
            if (notification.isTransient)
                notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
        }
        this._next();
    }

    _clearTimeout() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    // Counts down only while it is on screen (on top of the island, which is
    // closed and visible) and the user is around but not reading it (the
    // pointer isn't over it). Otherwise it waits.
    _syncTimeout() {
        if (!this._current)
            return;
        const island = this._island;
        const onScreen = island.activity === this._activity && island.status === 'closed' && island.visible;
        if (!onScreen || island.hover || this._idleWatchId) {
            this._clearTimeout();
        } else if (!this._timeoutId) {
            const ms = this._fullTime ? SHOW_TIME : SHOW_TIME_AFTER_HOVER;
            this._fullTime = false;
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timeoutId = 0;
                this._finish();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    destroy() {
        if (this._hadOwnShow)
            this._tray._showNotification = this._originalShow;
        else
            delete this._tray._showNotification;
        if (this._drainId)
            GLib.source_remove(this._drainId);
        this._drainId = 0;
        this._clearTimeout();
        this._unwatchUserActive();
        for (const id of this._islandSignals)
            this._island.disconnect(id);
        // Hand what wasn't fully shown back to GNOME: un-acknowledging makes
        // the source ask for a banner again, now through GNOME's own banner.
        const pending = [this._current, ...this._queue].filter(Boolean);
        for (const notification of [...this._signals.keys()])
            this._forget(notification);
        this._queue = [];
        this._current = null;
        for (const notification of pending)
            notification.acknowledged = false;
        this._island.hideActivity(this._activity);
        this._activity.actor.destroy();
    }
}
