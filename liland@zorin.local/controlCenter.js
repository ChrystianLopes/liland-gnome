// An iOS-style Control Center for the quick settings menu, shown inside the
// island while it replaces the top bar.
//
// It lives in GNOME's own quick settings menu (so opening, closing, keyboard
// focus and "click outside closes" are GNOME's), above GNOME's grid of quick
// settings, which is hidden meanwhile. Every control mirrors one of GNOME's
// quick settings items (from Main.panel.statusArea.quickSettings, GNOME 46
// ui/panel.js) and drives it, so the real logic stays GNOME's:
// - toggles: QuickToggle / QuickMenuToggle 'checked'; activating one is
//   'clicked' (or flipping 'checked' for toggleMode ones, e.g. night light).
// - sliders: QuickSlider.slider ('value', 'maximum-value').
// "More controls" shows GNOME's grid again (network lists, other extensions'
// toggles...). Items are looked up each time the menu opens, as they come
// and go (e.g. Bluetooth adapters).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {_} from './i18n.js';

const UNIT = 66;
const GAP = 12;
const SCROLL_STEP = 0.05;

const clamp01 = v => Math.min(Math.max(v, 0), 1);

function activateItem(item) {
    if (item.toggle_mode)
        item.checked = !item.checked;
    else
        item.emit('clicked', Clutter.BUTTON_PRIMARY);
}

// Press feedback like iOS: the control shrinks a little while pressed.
function addPressEffect(actor) {
    actor.set_pivot_point(0.5, 0.5);
    actor.connect('button-press-event', () => {
        actor.ease({scale_x: 0.94, scale_y: 0.94, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return Clutter.EVENT_PROPAGATE;
    });
    const release = () => {
        actor.ease({scale_x: 1, scale_y: 1, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        return Clutter.EVENT_PROPAGATE;
    };
    actor.connect('button-release-event', release);
    actor.connect('leave-event', release);
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
        return ['checked', 'visible', 'reactive'];
    }
}

// Round button of the connectivity module (airplane, Wi-Fi, Bluetooth...).
class RoundToggle extends Mirror {
    constructor(find, {iconName, color, label}) {
        super(find);
        this._iconName = iconName;
        this._color = color;
        this.actor = new St.Button({
            style_class: 'liland-cc-round',
            can_focus: true,
            accessible_name: label,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 22}),
        });
        addPressEffect(this.actor);
        this.actor.connect('clicked', () => {
            if (this.available)
                activateItem(this.item);
        });
    }

    _sync() {
        const on = this.available && this.item.checked;
        this.actor.style_class = `liland-cc-round${on ? ` liland-cc-on-${this._color}` : ''}`;
        this.actor.reactive = this.available;
        this.actor.opacity = this.available ? 255 : 90;
    }
}

// Square tile with an icon (dark mode...): white with a dark icon when on.
class SquareToggle extends Mirror {
    constructor(find, {iconName, label}) {
        super(find);
        this.actor = new St.Button({
            style_class: 'liland-cc-tile liland-cc-square',
            can_focus: true,
            accessible_name: label,
            x_expand: true,
            y_expand: true,
            child: new St.Icon({icon_name: iconName, icon_size: 24}),
        });
        addPressEffect(this.actor);
        this.actor.connect('clicked', () => {
            if (this.available)
                activateItem(this.item);
        });
    }

    _sync() {
        const on = this.available && this.item.checked;
        this.actor.style_class = `liland-cc-tile liland-cc-square${on ? ' liland-cc-square-on' : ''}`;
        this.actor.reactive = this.available;
        this.actor.opacity = this.available ? 255 : 90;
    }
}

// Tall tile that fills from the bottom (brightness, volume), like iOS.
class VerticalSlider extends Mirror {
    constructor(find, {iconName, label}) {
        super(find);
        this._iconName = iconName;
        this._sliderIds = [];
        this.actor = new St.Widget({
            style_class: 'liland-cc-tile liland-cc-vslider',
            reactive: true,
            can_focus: true,
            accessible_name: label,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({
            style_class: 'liland-cc-vslider-fill',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._icon = new St.Icon({
            icon_name: iconName,
            icon_size: 22,
            style_class: 'liland-cc-vslider-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this.actor.add_child(this._fill);
        this.actor.add_child(this._icon);
        this.actor.connect('notify::height', () => this._sync());
        this.actor.connect('button-press-event', (_a, event) => this._beginDrag(event));
        this.actor.connect('motion-event', (_a, event) => this._drag(event));
        this.actor.connect('button-release-event', (_a, event) => this._release(event));
        this.actor.connect('scroll-event', (_a, event) => this._scroll(event));
        this.actor.connect('key-press-event', (_a, event) => this._key(event));
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
        this._sync();
    }

    unbind() {
        this._endDrag();
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

    get _fraction() {
        const slider = this._slider;
        if (!slider)
            return 0;
        return clamp01(slider.value / Math.max(slider.maximum_value, 1e-6));
    }

    _setFraction(fraction) {
        const slider = this._slider;
        if (slider)
            slider.value = clamp01(fraction) * slider.maximum_value;
    }

    _sync() {
        const available = Boolean(this._slider) && Boolean(this.item?.visible);
        this.actor.reactive = available;
        this.actor.opacity = available ? 255 : 90;
        if (this.item?.gicon)
            this._icon.gicon = this.item.gicon;
        else
            this._icon.icon_name = this.item?.icon_name || this._iconName;
        const fraction = available ? this._fraction : 0;
        this._fill.height = Math.round(this.actor.height * fraction);
        // The icon sits at the bottom: dark once the white fill covers it.
        this._icon.style_class = `liland-cc-vslider-icon${fraction > 0.2 ? ' liland-cc-vslider-icon-dark' : ''}`;
    }

    _fractionAt(y) {
        const [, top] = this.actor.get_transformed_position();
        return 1 - (y - top) / Math.max(1, this.actor.height);
    }

    // Dragging works like GNOME's own Slider: a grab on the tile (the menu
    // already holds a modal grab, so the stage doesn't see these events),
    // and drag-begin/drag-end on GNOME's slider so it behaves as when its own
    // knob is dragged (e.g. the volume plays its feedback sound once, at the
    // end).
    _beginDrag(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._grab || !this.actor.reactive)
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this.actor);
        this._dragSlider = this._slider;
        this._dragSlider?.emit('drag-begin');
        this._setFraction(this._fractionAt(event.get_coords()[1]));
        return Clutter.EVENT_STOP;
    }

    _drag(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        // The release went somewhere else: stop without changing the value.
        if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
            this._endDrag();
            return Clutter.EVENT_PROPAGATE;
        }
        this._setFraction(this._fractionAt(event.get_coords()[1]));
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
        this._dragSlider?.emit('drag-end');
        this._dragSlider = null;
    }

    _key(event) {
        const key = event.get_key_symbol();
        let delta = 0;
        // Left/Right stay for moving between the tiles.
        if ([Clutter.KEY_Up, Clutter.KEY_Page_Up].includes(key))
            delta = SCROLL_STEP;
        else if ([Clutter.KEY_Down, Clutter.KEY_Page_Down].includes(key))
            delta = -SCROLL_STEP;
        if (!delta || !this.actor.reactive)
            return Clutter.EVENT_PROPAGATE;
        this._setFraction(this._fraction + delta);
        return Clutter.EVENT_STOP;
    }

    _scroll(event) {
        const direction = event.get_scroll_direction();
        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP)
            delta = SCROLL_STEP;
        else if (direction === Clutter.ScrollDirection.DOWN)
            delta = -SCROLL_STEP;
        else if (direction === Clutter.ScrollDirection.SMOOTH)
            delta = -event.get_scroll_delta()[1] * SCROLL_STEP;
        if (delta)
            this._setFraction(this._fraction + delta);
        return Clutter.EVENT_STOP;
    }
}

// Now-playing module (2x2), from the island's MPRIS state.
class MediaTile {
    constructor(nowPlaying) {
        this._np = nowPlaying;
        this.actor = new St.BoxLayout({
            style_class: 'liland-cc-tile liland-cc-media',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        const top = new St.BoxLayout({style_class: 'liland-cc-media-top', y_expand: true});
        this._art = new St.Bin({style_class: 'liland-cc-media-art', width: 38, height: 38, y_align: Clutter.ActorAlign.START});
        const texts = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'liland-cc-media-texts'});
        this._title = new St.Label({style_class: 'liland-cc-media-title'});
        this._artist = new St.Label({style_class: 'liland-cc-media-artist'});
        for (const label of [this._title, this._artist])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(this._title);
        texts.add_child(this._artist);
        top.add_child(this._art);
        top.add_child(texts);
        this.actor.add_child(top);

        const controls = new St.BoxLayout({style_class: 'liland-cc-media-controls', x_align: Clutter.ActorAlign.CENTER});
        const button = (iconName, label, fn) => {
            const b = new St.Button({
                style_class: 'liland-cc-media-button',
                can_focus: true,
                accessible_name: label,
                child: new St.Icon({icon_name: iconName, icon_size: 20}),
            });
            addPressEffect(b);
            b.connect('clicked', fn);
            controls.add_child(b);
            return b;
        };
        this._prev = button('media-skip-backward-symbolic', _('Previous'), () => this._np.previous());
        this._play = button('media-playback-start-symbolic', _('Play'), () => this._np.playPause());
        this._next = button('media-skip-forward-symbolic', _('Next'), () => this._np.next());
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
        const icon = this._np.isPlaying ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._play.child.icon_name = icon;
        for (const b of [this._prev, this._play, this._next]) {
            b.reactive = track !== null;
            b.opacity = track !== null ? 255 : 110;
        }
    }
}

// "Do not disturb" (iOS Focus) wide tile: GNOME's show-banners setting.
class FocusTile {
    constructor() {
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._circle = new St.Bin({
            style_class: 'liland-cc-focus-circle',
            child: new St.Icon({icon_name: 'weather-clear-night-symbolic', icon_size: 18}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({text: _('Do Not Disturb'), style_class: 'liland-cc-focus-label', y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const box = new St.BoxLayout({style_class: 'liland-cc-focus-box'});
        box.add_child(this._circle);
        box.add_child(label);
        this.actor = new St.Button({
            style_class: 'liland-cc-tile liland-cc-focus',
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
        this._circle.style_class = `liland-cc-focus-circle${on ? ' liland-cc-on-purple' : ''}`;
    }

    destroy() {
        this._settings.disconnect(this._id);
    }
}

// Plain action button (lock, settings, power, screenshot...).
function actionButton(styleClass, iconName, label, fn) {
    const button = new St.Button({
        style_class: styleClass,
        can_focus: true,
        accessible_name: label,
        x_expand: true,
        y_expand: true,
        child: new St.Icon({icon_name: iconName, icon_size: 22}),
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
            width: 4 * UNIT + 3 * GAP,
            height: 5 * UNIT + 4 * GAP,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const at = (actor, col, row, w = 1, h = 1) => grid.layout_manager.attach(actor, col, row, w, h);

        // Connectivity module (2x2).
        const connectivity = new St.Widget({
            style_class: 'liland-cc-tile liland-cc-connectivity',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true}),
            x_expand: true,
            y_expand: true,
        });
        const round = [
            new RoundToggle(item('_rfkill'), {iconName: 'airplane-mode-symbolic', color: 'orange', label: _('Airplane Mode')}),
            new RoundToggle(item('_network', named('NMWirelessToggle')), {iconName: 'network-wireless-symbolic', color: 'blue', label: _('Wi-Fi')}),
            new RoundToggle(item('_bluetooth'), {iconName: 'bluetooth-active-symbolic', color: 'blue', label: _('Bluetooth')}),
            new RoundToggle(item('_nightLight'), {iconName: 'night-light-symbolic', color: 'orange', label: _('Night Light')}),
        ];
        round.forEach((r, i) => connectivity.layout_manager.attach(mirror(r), i % 2, Math.floor(i / 2), 1, 1));
        at(connectivity, 0, 0, 2, 2);

        // Media module (2x2).
        this._media = new MediaTile(nowPlaying);
        at(this._media.actor, 2, 0, 2, 2);

        // Focus (2x1), dark mode and screenshot (1x1), brightness and volume (1x2).
        this._focus = new FocusTile();
        at(this._focus.actor, 0, 2, 2, 1);
        at(mirror(new SquareToggle(item('_darkMode'), {iconName: 'dark-mode-symbolic', label: _('Dark Mode')})), 0, 3);
        at(actionButton('liland-cc-tile liland-cc-square', 'camera-photo-symbolic', _('Screenshot'),
            () => this._run(() => SystemActions.getDefault().activateScreenshotUI())), 1, 3);
        at(mirror(new VerticalSlider(item('_brightness'), {iconName: 'display-brightness-symbolic', label: _('Brightness')})), 2, 2, 1, 2);
        at(mirror(new VerticalSlider(item('_volumeOutput'), {iconName: 'audio-volume-high-symbolic', label: _('Volume')})), 3, 2, 1, 2);

        // Bottom row: round shortcuts.
        const bottom = [
            ['system-lock-screen-symbolic', _('Lock'), () => this._run(() => SystemActions.getDefault().activateLockScreen())],
            ['org.gnome.Settings-symbolic', _('Settings'), () => this._run(() =>
                Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate())],
            ['system-shutdown-symbolic', _('Power Off'), () => this._run(() => SystemActions.getDefault().activatePowerOff())],
            ['view-more-horizontal-symbolic', _('More Controls'), () => this._showNative(true)],
        ];
        const buttons = bottom.map(([icon, label, fn], i) => {
            const button = actionButton('liland-cc-tile liland-cc-circle', icon, label, fn);
            at(button, i, 4);
            return button;
        });
        // Lock and power off follow GNOME's own availability (lockdown
        // settings, polkit), like GNOME's buttons do.
        const actions = SystemActions.getDefault();
        this._actions = actions;
        this._actionIds = [['can-lock-screen', buttons[0]], ['can-power-off', buttons[2]]].map(([prop, button]) => {
            const sync = () => {
                const allowed = actions[prop.replaceAll('-', '_')];
                button.reactive = allowed;
                button.opacity = allowed ? 255 : 90;
            };
            sync();
            return actions.connect(`notify::${prop}`, sync);
        });

        this._grid = grid;
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
        this._menu.box.insert_child_at_index(this.actor, 0);
        this._showNative(false);

        this._openId = this._menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                for (const m of [...this._mirrors, this._media])
                    m.bind();
            } else {
                for (const m of [...this._mirrors, this._media])
                    m.unbind();
                this._showNative(false);
            }
        });
    }

    // Close the menu (and the island), then do something.
    _run(fn) {
        this._menu.close();
        fn();
    }

    _showNative(native) {
        this._menu._grid.visible = native;
        this._grid.visible = !native;
        this._back.visible = native;
    }

    destroy() {
        if (!this.actor)
            return;
        this._menu.disconnect(this._openId);
        for (const id of this._actionIds)
            this._actions.disconnect(id);
        for (const m of [...this._mirrors, this._media])
            m.unbind();
        this._focus.destroy();
        this._menu._grid.visible = true;
        this.actor.destroy();
        this.actor = null;
    }
}
