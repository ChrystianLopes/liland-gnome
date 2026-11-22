// A macOS-style Control Center for the quick settings menu, shown inside the
// island while it replaces the top bar.
//
// It lives in GNOME's own quick settings menu (so opening, closing, keyboard
// focus and "click outside closes" are GNOME's), above GNOME's grid of quick
// settings, which is hidden meanwhile. Controls mirror GNOME's quick settings
// items (from Main.panel.statusArea.quickSettings, GNOME 46 ui/panel.js) and
// drive them, so the real logic stays GNOME's:
// - toggles: QuickToggle / QuickMenuToggle 'checked' (+ 'subtitle', e.g. the
//   Wi-Fi network); activating one is 'clicked' (or flipping 'checked' for
//   toggleMode ones, e.g. night light); their lists (networks, devices) are
//   their own submenus (QuickMenuToggle.menu).
// - sliders: QuickSlider.slider ('value', 'maximum-value').
// "More controls" shows GNOME's grid again. Items are looked up each time
// the menu opens, as they come and go (e.g. Bluetooth adapters).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {_} from './i18n.js';
import {isDarkStyle, toggleStyle} from './appearance.js';

const COLUMN = 80;
const ROW = 62;
const GAP = 10;
const SCROLL_STEP = 0.05;
// Sliders: at most one level sent to GNOME per interval while dragging, its
// echo ignored for a while after the last change, and the fill's animation.
const SLIDER_WRITE_INTERVAL = 70;
const SLIDER_SETTLE_MS = 600;
const SLIDER_ANIM_MS = 180;
const SLIDER_HEIGHT = 24;
// Holding a connectivity row's button this long shows its list too.
const LONG_PRESS_MS = 450;

const clamp01 = v => Math.min(Math.max(v, 0), 1);

function activateItem(item) {
    if (item.toggle_mode)
        item.checked = !item.checked;
    else
        item.emit('clicked', Clutter.BUTTON_PRIMARY);
}

// Press feedback: the control shrinks a little while pressed.
function addPressEffect(actor) {
    actor.set_pivot_point(0.5, 0.5);
    actor.connect('button-press-event', () => {
        actor.ease({scale_x: 0.95, scale_y: 0.95, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return Clutter.EVENT_PROPAGATE;
    });
    const release = () => {
        actor.ease({scale_x: 1, scale_y: 1, duration: 240, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        return Clutter.EVENT_PROPAGATE;
    };
    actor.connect('button-release-event', release);
    actor.connect('leave-event', release);
}

// Whether the actor is shown in the island's light style (the island puts
// 'liland-light' on the menus it shows).
function inLightStyle(actor) {
    for (let a = actor; a; a = a.get_parent()) {
        if (a.has_style_class_name?.('liland-light'))
            return true;
    }
    return false;
}

function label(text, styleClass) {
    const l = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

// A control bound to one of GNOME's quick settings items while the menu is
// open. Subclasses build `actor` and implement _sync().
class Mirror {
    constructor(find) {
        this._find = find;
        this.item = null;
        this._ids = [];
    }

    bind() {
        this.unbind();
        this.item = this._find() ?? null;
        if (this.item) {
            for (const prop of this._watched())
                this._ids.push(this.item.connect(`notify::${prop}`, () => this._sync()));
        }
        this._sync();
    }

    unbind() {
        for (const id of this._ids)
            this.item?.disconnect(id);
        this._ids = [];
        this.item = null;
    }

    get available() {
        return Boolean(this.item?.visible) && this.item.reactive !== false;
    }

    _watched() {
        return ['checked', 'visible', 'reactive', 'subtitle'];
    }
}

// A row of the connectivity module, like macOS: a round button that turns it
// on and off, and its name and state; clicking the name shows its list
// (networks, devices) when it has one (onDetails). Holding the button or
// right clicking it shows the list too.
class ConnectivityRow extends Mirror {
    constructor(find, {iconName, title, onDetails = null}) {
        super(find);
        this._title = title;
        this._onDetails = onDetails;
        this._longPressId = 0;

        this._button = new St.Button({
            style_class: 'liland-cc-circle',
            can_focus: true,
            accessible_name: title,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        addPressEffect(this._button);
        this._button.connect('button-press-event', (_a, event) => {
            this._longPressed = false;
            this._cancelLongPress();
            if (this._onDetails && event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._longPressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
                    this._longPressId = 0;
                    this._longPressed = true;
                    this._details();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_PROPAGATE;
        });
        for (const signal of ['button-release-event', 'leave-event']) {
            this._button.connect(signal, () => {
                this._cancelLongPress();
                return Clutter.EVENT_PROPAGATE;
            });
        }
        this._button.connect('clicked', (_b, button) => {
            if (this._longPressed) {
                this._longPressed = false;
                return;
            }
            if (button === Clutter.BUTTON_SECONDARY)
                this._details();
            else if (this.available)
                activateItem(this.item);
        });
        this._button.connect('destroy', () => this._cancelLongPress());

        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._titleLabel = label(title, 'liland-cc-row-title');
        this._subtitleLabel = label('', 'liland-cc-row-subtitle');
        texts.add_child(this._titleLabel);
        texts.add_child(this._subtitleLabel);
        this._texts = new St.Button({
            style_class: 'liland-cc-row-texts',
            can_focus: true,
            x_expand: true,
            child: texts,
        });
        this._texts.connect('clicked', () => {
            if (this._onDetails)
                this._details();
            else if (this.available)
                activateItem(this.item);
        });
        this._texts.connect('popup-menu', () => this._details());

        this.actor = new St.BoxLayout({style_class: 'liland-cc-row', x_expand: true});
        this.actor.add_child(this._button);
        this.actor.add_child(this._texts);
    }

    _cancelLongPress() {
        if (this._longPressId)
            GLib.source_remove(this._longPressId);
        this._longPressId = 0;
    }

    _details() {
        if (this._onDetails && this.available && this.item.menu)
            this._onDetails(this.item);
    }

    unbind() {
        this._cancelLongPress();
        super.unbind();
    }

    _sync() {
        const available = this.available;
        const on = available && this.item.checked;
        this._button.style_class = `liland-cc-circle${on ? ' liland-cc-on' : ''}`;
        this._button.reactive = available;
        this._texts.reactive = available;
        this.actor.opacity = available ? 255 : 110;
        let subtitle = _('Off');
        if (!available)
            subtitle = _('Unavailable');
        else if (on)
            subtitle = this.item.subtitle || _('On');
        this._subtitleLabel.text = subtitle;
    }
}

// Small square module (night light...): round icon over its name, like the
// macOS Control Center's small modules.
class SmallToggle extends Mirror {
    constructor(find, {iconName, title}) {
        super(find);
        this._circle = new St.Bin({
            style_class: 'liland-cc-circle',
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
            x_align: Clutter.ActorAlign.CENTER,
        });
        const box = new St.BoxLayout({vertical: true, style_class: 'liland-cc-small-box', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._circle);
        box.add_child(label(title, 'liland-cc-small-title'));
        this.actor = new St.Button({
            style_class: 'liland-cc-module liland-cc-small',
            can_focus: true,
            accessible_name: title,
            x_expand: true,
            y_expand: true,
            child: box,
        });
        addPressEffect(this.actor);
        this.actor.connect('clicked', () => {
            if (this.available)
                activateItem(this.item);
        });
    }

    _sync() {
        const on = this.available && this.item.checked;
        this._circle.style_class = `liland-cc-circle${on ? ' liland-cc-on' : ''}`;
        this.actor.reactive = this.available;
        this.actor.opacity = this.available ? 255 : 110;
    }
}

// "Appearance": light / dark style, for the whole desktop (see appearance.js).
class AppearanceToggle {
    constructor() {
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._circle = new St.Bin({
            style_class: 'liland-cc-circle',
            child: new St.Icon({icon_name: 'dark-mode-symbolic', icon_size: 16}),
            x_align: Clutter.ActorAlign.CENTER,
        });
        const box = new St.BoxLayout({vertical: true, style_class: 'liland-cc-small-box', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._circle);
        box.add_child(label(_('Appearance'), 'liland-cc-small-title'));
        this.actor = new St.Button({
            style_class: 'liland-cc-module liland-cc-small',
            can_focus: true,
            accessible_name: _('Appearance'),
            x_expand: true,
            y_expand: true,
            child: box,
        });
        addPressEffect(this.actor);
        this.actor.connect('clicked', () => toggleStyle());
        this._id = this._settings.connect('changed::color-scheme', () => this._sync());
        this._sync();
    }

    bind() {}

    unbind() {}

    _sync() {
        this._circle.style_class = `liland-cc-circle${isDarkStyle() ? ' liland-cc-on' : ''}`;
    }

    destroy() {
        this._settings.disconnect(this._id);
    }
}

// "Do not disturb" module: GNOME's show-banners setting.
class FocusModule {
    constructor() {
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._circle = new St.Bin({
            style_class: 'liland-cc-circle',
            child: new St.Icon({icon_name: 'weather-clear-night-symbolic', icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        texts.add_child(label(_('Do Not Disturb'), 'liland-cc-row-title'));
        this._state = label('', 'liland-cc-row-subtitle');
        texts.add_child(this._state);
        const box = new St.BoxLayout({style_class: 'liland-cc-row'});
        box.add_child(this._circle);
        box.add_child(texts);
        this.actor = new St.Button({
            style_class: 'liland-cc-module liland-cc-focus',
            can_focus: true,
            x_expand: true,
            y_expand: true,
            child: box,
        });
        addPressEffect(this.actor);
        this.actor.connect('clicked', () =>
            this._settings.set_boolean('show-banners', !this._settings.get_boolean('show-banners')));
        this._id = this._settings.connect('changed::show-banners', () => this._sync());
        this._sync();
    }

    bind() {}

    unbind() {}

    _sync() {
        const on = !this._settings.get_boolean('show-banners');
        this._circle.style_class = `liland-cc-circle${on ? ' liland-cc-on-focus' : ''}`;
        this._state.text = on ? _('On') : _('Off');
    }

    destroy() {
        this._settings.disconnect(this._id);
    }
}

// A wide module with a title and a horizontal slider (display, sound), like
// macOS.
//
// The slider is drawn with cairo: a pill track, its fill and a round knob.
// While the user changes it, it shows the user's value and GNOME's echo is
// ignored: brightness, for one, is applied by gnome-settings-daemon
// asynchronously and its updates come back late, which would make the fill
// (and the screen) jump back and forth. Writes to GNOME are coalesced (at
// most one per SLIDER_WRITE_INTERVAL, the last one always sent), so the
// screen brightness changes smoothly. Changes coming from elsewhere (volume
// keys...) are animated.
class SliderModule extends Mirror {
    constructor(find, {iconName, title}) {
        super(find);
        this._iconName = iconName;
        this._sliderIds = [];
        this._shown = 0;
        this._written = null;
        this._pending = null;
        this._writeId = 0;
        this._settleId = 0;
        this._animId = 0;

        this._track = new St.Widget({
            style_class: 'liland-cc-slider',
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: title,
            x_expand: true,
            height: SLIDER_HEIGHT,
            layout_manager: new Clutter.BinLayout(),
        });
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', area => this._draw(area));
        this._icon = new St.Icon({
            icon_name: iconName,
            icon_size: 13,
            style_class: 'liland-cc-slider-icon',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._track.add_child(this._area);
        this._track.add_child(this._icon);
        this._track.connect('notify::width', () => this._repaint());
        this._track.connect('notify::hover', () => this._repaint());
        this._track.connect('button-press-event', (_a, event) => this._beginDrag(event));
        this._track.connect('motion-event', (_a, event) => this._drag(event));
        this._track.connect('button-release-event', (_a, event) => this._release(event));
        this._track.connect('scroll-event', (_a, event) => this._scroll(event));
        this._track.connect('key-press-event', (_a, event) => this._key(event));
        this._track.connect('destroy', () => this._stopAnimation());
        this._track.connect('style-changed', () => this._area.queue_repaint());

        this.actor = new St.BoxLayout({
            style_class: 'liland-cc-module liland-cc-slider-module',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(label(title, 'liland-cc-module-title'));
        this.actor.add_child(this._track);
    }

    get _slider() {
        return this.item?.slider ?? null;
    }

    bind() {
        super.bind();
        this._unbindSlider();
        const slider = this._slider;
        if (slider) {
            this._sliderIds = ['value', 'maximum-value'].map(p =>
                slider.connect(`notify::${p}`, () => this._sync()));
        }
        // Opening the menu: show the current level right away.
        this._stopAnimation();
        this._shown = this._fraction;
        this._sync();
    }

    unbind() {
        this._endDrag();
        this._flush();
        this._clearTimers();
        this._unbindSlider();
        super.unbind();
    }

    _unbindSlider() {
        for (const id of this._sliderIds)
            this._sliderSource?.disconnect(id);
        this._sliderIds = [];
        this._sliderSource = this._slider;
    }

    _watched() {
        return ['visible', 'reactive', 'icon-name', 'gicon'];
    }

    get _available() {
        return Boolean(this._slider) && Boolean(this.item?.visible);
    }

    // GNOME's level, 0..1.
    get _fraction() {
        const slider = this._slider;
        if (!slider)
            return 0;
        return clamp01(slider.value / Math.max(slider.maximum_value, 1e-6));
    }

    // The user is changing it (or just did): GNOME's echo is ignored.
    get _userActive() {
        return Boolean(this._grab) || this._settleId !== 0;
    }

    _sync() {
        const available = this._available;
        this._track.reactive = available;
        this.actor.opacity = available ? 255 : 110;
        if (this.item?.gicon)
            this._icon.gicon = this.item.gicon;
        else
            this._icon.icon_name = this.item?.icon_name || this._iconName;
        if (!available)
            this._animateTo(0);
        else if (!this._userActive)
            this._animateTo(this._fraction);
    }

    // ---------- drawing ----------

    _repaint() {
        this._area.queue_repaint();
        // The icon sits at the start: dark once the white fill covers it.
        const covered = this._fillWidth(this._track.width) > 30;
        this._icon.style_class = `liland-cc-slider-icon${covered ? ' liland-cc-slider-icon-covered' : ''}`;
    }

    // The fill always holds the knob (a full circle at its end).
    _fillWidth(width) {
        const d = SLIDER_HEIGHT;
        return d + Math.max(0, width - d) * clamp01(this._shown);
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const r = h / 2;
        const pill = (x, width) => {
            cr.newSubPath();
            cr.arc(x + width - r, r, r, -Math.PI / 2, Math.PI / 2);
            cr.arc(x + r, r, r, Math.PI / 2, 3 * Math.PI / 2);
            cr.closePath();
        };
        const dark = !inLightStyle(this._track);
        const hover = this._track.hover && this._track.reactive;
        // Track.
        pill(0, w);
        if (dark)
            cr.setSourceRGBA(1, 1, 1, hover ? 0.2 : 0.14);
        else
            cr.setSourceRGBA(0, 0, 0, hover ? 0.12 : 0.08);
        cr.fill();
        // Fill.
        const fill = this._fillWidth(w);
        pill(0, fill);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.fill();
        // Knob: a white disc with a soft edge, at the end of the fill.
        cr.arc(fill - r, r, r - 0.5, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.fillPreserve();
        cr.setSourceRGBA(0, 0, 0, dark ? 0.25 : 0.15);
        cr.setLineWidth(1);
        cr.stroke();
        cr.$dispose();
    }

    _show(fraction) {
        this._stopAnimation();
        this._shown = clamp01(fraction);
        this._repaint();
    }

    _animateTo(fraction) {
        fraction = clamp01(fraction);
        if (Math.abs(fraction - this._shown) < 0.002 || !this._track.mapped) {
            this._show(fraction);
            return;
        }
        this._stopAnimation();
        const from = this._shown;
        const start = GLib.get_monotonic_time();
        this._animId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const t = clamp01((GLib.get_monotonic_time() - start) / (SLIDER_ANIM_MS * 1000));
            const eased = 1 - Math.pow(1 - t, 3);
            this._shown = from + (fraction - from) * eased;
            this._repaint();
            if (t < 1)
                return GLib.SOURCE_CONTINUE;
            this._animId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopAnimation() {
        if (this._animId)
            GLib.source_remove(this._animId);
        this._animId = 0;
    }

    // ---------- changing the level ----------

    // The user picked a level: show it now, send it to GNOME (coalesced).
    _set(fraction, {animate = false} = {}) {
        fraction = clamp01(fraction);
        if (animate)
            this._animateTo(fraction);
        else
            this._show(fraction);
        this._pending = fraction;
        if (!this._writeId) {
            this._flush();
            this._writeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_WRITE_INTERVAL, () => {
                if (this._pending === null) {
                    this._writeId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._flush();
                return GLib.SOURCE_CONTINUE;
            });
        }
        // Ignore GNOME's (late) echo until things settle, then show its level.
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_SETTLE_MS, () => {
            this._settleId = 0;
            if (!this._grab)
                this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        const slider = this._slider;
        if (!slider) {
            // The item went away: nothing to send anymore.
            this._pending = null;
            return;
        }
        if (this._pending === null)
            return;
        // Against GNOME's current level, not the last one sent: it may have
        // changed meanwhile (volume keys...).
        const value = this._pending * slider.maximum_value;
        if (Math.abs(slider.value - value) > 1e-6)
            slider.value = value;
        this._written = this._pending;
        this._pending = null;
    }

    _clearTimers() {
        for (const name of ['_writeId', '_settleId']) {
            if (this[name])
                GLib.source_remove(this[name]);
            this[name] = 0;
        }
        this._pending = null;
        this._written = null;
    }

    _fractionAt(x) {
        const [left] = this._track.get_transformed_position();
        const d = SLIDER_HEIGHT;
        // The pointer drags the knob's center.
        return (x - left - d / 2) / Math.max(1, this._track.width - d);
    }

    // Dragging works like GNOME's own Slider: a grab on the track (the menu
    // already holds a modal grab, so the stage doesn't see these events),
    // and drag-begin/drag-end on GNOME's slider so it behaves as when its own
    // knob is dragged (e.g. the volume plays its feedback sound once, at the
    // end).
    _beginDrag(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._grab || !this._track.reactive)
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this._track);
        this._dragSlider = this._slider;
        this._dragSlider?.emit('drag-begin');
        this._set(this._fractionAt(event.get_coords()[0]), {animate: true});
        return Clutter.EVENT_STOP;
    }

    _drag(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        // The release went somewhere else: stop.
        if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
            this._endDrag();
            return Clutter.EVENT_PROPAGATE;
        }
        this._set(this._fractionAt(event.get_coords()[0]));
        return Clutter.EVENT_STOP;
    }

    _release(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        if (!this._grab)
            return;
        this._grab.dismiss();
        this._grab = null;
        // The last level goes out before GNOME hears the drag ended.
        this._flush();
        this._dragSlider?.emit('drag-end');
        this._dragSlider = null;
    }

    _key(event) {
        const key = event.get_key_symbol();
        let delta = 0;
        // Up/Down stay for moving between the modules.
        if ([Clutter.KEY_Right, Clutter.KEY_Page_Up].includes(key))
            delta = SCROLL_STEP;
        else if ([Clutter.KEY_Left, Clutter.KEY_Page_Down].includes(key))
            delta = -SCROLL_STEP;
        if (!delta || !this._track.reactive)
            return Clutter.EVENT_PROPAGATE;
        this._set(this._target + delta, {animate: true});
        return Clutter.EVENT_STOP;
    }

    _scroll(event) {
        if (!this._track.reactive)
            return Clutter.EVENT_PROPAGATE;
        const direction = event.get_scroll_direction();
        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.RIGHT)
            delta = SCROLL_STEP;
        else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.LEFT)
            delta = -SCROLL_STEP;
        else if (direction === Clutter.ScrollDirection.SMOOTH)
            delta = -event.get_scroll_delta()[1] * SCROLL_STEP;
        if (delta)
            this._set(this._target + delta, {animate: true});
        return Clutter.EVENT_STOP;
    }

    // Where steps (scroll, keys) start from: the user's last level while
    // they're at it, GNOME's otherwise.
    get _target() {
        if (this._userActive)
            return this._pending ?? this._written ?? this._shown;
        return this._fraction;
    }
}

// Now Playing module, from the island's MPRIS state.
class MediaModule {
    constructor(nowPlaying) {
        this._np = nowPlaying;
        this._art = new St.Bin({style_class: 'liland-cc-media-art', width: 40, height: 40, y_align: Clutter.ActorAlign.CENTER});
        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'liland-cc-media-texts'});
        this._title = label('', 'liland-cc-row-title');
        this._artist = label('', 'liland-cc-row-subtitle');
        texts.add_child(this._title);
        texts.add_child(this._artist);
        const controls = new St.BoxLayout({style_class: 'liland-cc-media-controls', y_align: Clutter.ActorAlign.CENTER});
        const button = (iconName, text, fn) => {
            const b = new St.Button({
                style_class: 'liland-cc-media-button',
                can_focus: true,
                accessible_name: text,
                child: new St.Icon({icon_name: iconName, icon_size: 16}),
            });
            addPressEffect(b);
            b.connect('clicked', fn);
            controls.add_child(b);
            return b;
        };
        this._prev = button('media-skip-backward-symbolic', _('Previous'), () => this._np.previous());
        this._play = button('media-playback-start-symbolic', _('Play'), () => this._np.playPause());
        this._next = button('media-skip-forward-symbolic', _('Next'), () => this._np.next());
        this.actor = new St.BoxLayout({
            style_class: 'liland-cc-module liland-cc-media',
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this._art);
        this.actor.add_child(texts);
        this.actor.add_child(controls);
        this._npId = 0;
    }

    bind() {
        this.unbind();
        this._npId = this._np.connect('changed', () => this._sync());
        this._sync();
    }

    unbind() {
        if (this._npId)
            this._np.disconnect(this._npId);
        this._npId = 0;
    }

    _sync() {
        const track = this._np.track;
        this._title.text = track?.title || _('Nothing playing');
        this._artist.text = track?.artist ?? '';
        this._artist.visible = Boolean(track?.artist);
        const path = this._np.artworkPath;
        this._art.style = path
            ? `background-image: url("${Gio.File.new_for_path(path).get_uri()}"); background-size: cover;`
            : '';
        this._art.set_child(path ? null : new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 18}));
        this._play.child.icon_name = this._np.isPlaying ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        for (const b of [this._prev, this._play, this._next]) {
            b.reactive = track !== null;
            b.opacity = track !== null ? 255 : 110;
        }
    }
}

// Small round button of the footer (lock, settings, power...).
function footerButton(iconName, text, fn) {
    const button = new St.Button({
        style_class: 'liland-cc-footer-button',
        can_focus: true,
        accessible_name: text,
        child: new St.Icon({icon_name: iconName, icon_size: 15}),
    });
    addPressEffect(button);
    button.connect('clicked', fn);
    return button;
}

export class ControlCenter {
    constructor(nowPlaying) {
        this._quickSettings = Main.panel.statusArea.quickSettings;
        this._menu = this._quickSettings?.menu ?? null;
        if (!this._menu?.box || !this._menu._grid)
            return;
        const qs = this._quickSettings;
        const item = (indicator, pred = () => true) => () =>
            qs[indicator]?.quickSettingsItems?.find(pred) ?? null;
        const named = name => i => i.constructor.name === name;
        const details = toggle => this._openDetails(toggle);

        this._mirrors = [];
        const mirror = m => {
            this._mirrors.push(m);
            return m.actor;
        };

        const grid = new St.Widget({
            style_class: 'liland-cc-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: GAP,
                row_spacing: GAP,
                column_homogeneous: true,
                row_homogeneous: true,
            }),
            width: 4 * COLUMN + 3 * GAP,
            height: 5 * ROW + 4 * GAP,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const at = (actor, col, row, w = 1, h = 1) => grid.layout_manager.attach(actor, col, row, w, h);

        // Connectivity (2x2): Wi-Fi, Bluetooth, airplane mode.
        const connectivity = new St.BoxLayout({
            style_class: 'liland-cc-module liland-cc-connectivity',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        for (const row of [
            new ConnectivityRow(item('_network', named('NMWirelessToggle')), {iconName: 'network-wireless-symbolic', title: _('Wi-Fi'), onDetails: details}),
            new ConnectivityRow(item('_bluetooth'), {iconName: 'bluetooth-active-symbolic', title: _('Bluetooth'), onDetails: details}),
            new ConnectivityRow(item('_rfkill'), {iconName: 'airplane-mode-symbolic', title: _('Airplane Mode')}),
        ])
            connectivity.add_child(mirror(row));
        at(connectivity, 0, 0, 2, 2);

        // Right: do not disturb (2x1), appearance and night light (1x1).
        this._focus = new FocusModule();
        at(this._focus.actor, 2, 0, 2, 1);
        this._appearance = new AppearanceToggle();
        at(this._appearance.actor, 2, 1);
        at(mirror(new SmallToggle(item('_nightLight'), {iconName: 'night-light-symbolic', title: _('Night Light')})), 3, 1);

        // Display and sound (4x1 each), now playing (4x1).
        at(mirror(new SliderModule(item('_brightness'), {iconName: 'display-brightness-symbolic', title: _('Display')})), 0, 2, 4, 1);
        at(mirror(new SliderModule(item('_volumeOutput'), {iconName: 'audio-volume-high-symbolic', title: _('Sound')})), 0, 3, 4, 1);
        this._media = new MediaModule(nowPlaying);
        at(this._media.actor, 0, 4, 4, 1);

        // Footer: small round shortcuts.
        const actions = SystemActions.getDefault();
        this._actions = actions;
        const lock = footerButton('system-lock-screen-symbolic', _('Lock'), () => this._run(() => actions.activateLockScreen()));
        const power = footerButton('system-shutdown-symbolic', _('Power Off'), () => this._run(() => actions.activatePowerOff()));
        const footer = new St.BoxLayout({style_class: 'liland-cc-footer', x_align: Clutter.ActorAlign.CENTER});
        footer.add_child(footerButton('camera-photo-symbolic', _('Screenshot'), () => this._run(() => actions.activateScreenshotUI())));
        footer.add_child(lock);
        footer.add_child(footerButton('emblem-system-symbolic', _('Settings'), () => this._run(() =>
            Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate())));
        footer.add_child(power);
        footer.add_child(footerButton('view-more-horizontal-symbolic', _('More Controls'), () => this._showNative(true)));
        // Lock and power off follow GNOME's own availability (lockdown
        // settings, polkit), like GNOME's buttons do.
        this._actionIds = [['can-lock-screen', lock], ['can-power-off', power]].map(([prop, button]) => {
            const sync = () => {
                const allowed = actions[prop.replaceAll('-', '_')];
                button.reactive = allowed;
                button.opacity = allowed ? 255 : 90;
            };
            sync();
            return actions.connect(`notify::${prop}`, sync);
        });

        this._grid = grid;
        this._footer = footer;
        // Shown with GNOME's grid ("more controls"): back to this view.
        this._back = new St.Button({
            style_class: 'liland-cc-back',
            can_focus: true,
            label: `‹  ${_('Control Center')}`,
            x_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._back.connect('clicked', () => this._showNative(false));

        this.actor = new St.BoxLayout({style_class: 'liland-cc', vertical: true});
        this.actor.add_child(this._back);
        this.actor.add_child(grid);
        this.actor.add_child(footer);
        this._menu.box.insert_child_at_index(this.actor, 0);
        this._showNative(false);

        this._openId = this._menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                for (const m of this._parts)
                    m.bind();
            } else {
                this._cancelDetails();
                for (const m of this._parts)
                    m.unbind();
                this._showNative(false);
            }
        });
    }

    get _parts() {
        return [...this._mirrors, this._media, this._focus, this._appearance];
    }

    // Close the menu (and the island), then do something.
    _run(fn) {
        this._menu.close();
        fn();
    }

    // A connectivity row's list (Wi-Fi networks, Bluetooth devices): GNOME's
    // own, shown over GNOME's grid inside the island ("‹ Control Center"
    // comes back). Turned on first if it's off. If no list shows up (e.g.
    // nothing to list), GNOME's grid is shown, with that toggle in it.
    _openDetails(toggle) {
        this._cancelDetails();
        const open = () => {
            this._showNative(true);
            toggle.menu.open(true);
        };
        if (!toggle.checked)
            activateItem(toggle);
        if (toggle.menuEnabled) {
            open();
            return;
        }
        // Its list becomes available once it's on (and has found something).
        const id = toggle.connect('notify::menu-enabled', () => {
            if (!toggle.menuEnabled)
                return;
            this._cancelDetails();
            if (this._menu.isOpen)
                open();
        });
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._detailsWait = null;
            toggle.disconnect(id);
            if (this._menu.isOpen)
                this._showNative(true);
            return GLib.SOURCE_REMOVE;
        });
        this._detailsWait = {toggle, id, timeoutId};
    }

    _cancelDetails() {
        if (!this._detailsWait)
            return;
        const {toggle, id, timeoutId} = this._detailsWait;
        this._detailsWait = null;
        toggle.disconnect(id);
        GLib.source_remove(timeoutId);
    }

    _showNative(native) {
        if (!native) {
            // Back from a list: close it with GNOME's grid.
            this._menu._activeMenu?.close(false);
        }
        this._menu._grid.visible = native;
        this._grid.visible = !native;
        this._footer.visible = !native;
        this._back.visible = native;
    }

    destroy() {
        if (!this.actor)
            return;
        this._menu.disconnect(this._openId);
        this._cancelDetails();
        for (const id of this._actionIds)
            this._actions.disconnect(id);
        for (const m of this._parts)
            m.unbind();
        this._focus.destroy();
        this._appearance.destroy();
        this._menu._grid.visible = true;
        this.actor.destroy();
        this.actor = null;
    }
}
