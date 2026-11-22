// The island: a black "notch" at the top center. It shows the music player
// (activities/music.js), temporary activities (volume, notifications...) and,
// when it replaces the top bar (topbar.js), the time and the top bar's buttons.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import GnomeDesktop from 'gi://GnomeDesktop';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MusicPlayer, OPEN_CONTENT_HEIGHT, MESSAGE_CONTENT_HEIGHT} from './activities/music.js';

// Liquid Glass: what's behind the island (wallpaper, windows) is blurred by
// Shell.BlurEffect (the lock screen's). It only blurs rectangles and can't be
// cut to a shape afterwards (an offscreen effect around it makes it blur an
// empty buffer), and blurring several pieces leaves seams. So: one blurred
// rectangle between the island's side walls, and in the two bottom corners,
// where that rectangle goes past the round edge, the sharp scene is painted
// back over the outside of the curve: a clone of the windows and wallpaper
// (global.window_group), masked by CornerMask. The ears at the top (outside
// the walls) aren't blurred at all; the tint (_drawShape) covers the rest.
const CornerMask = GObject.registerClass(
class LilandCornerMask extends Clutter.ShaderEffect {
    // left: the corner's curve is centered on its top-right point (the
    // island's bottom-left corner); else on its top-left one.
    _init(left) {
        super._init();
        this._left = left;
    }

    vfunc_get_static_shader_source() {
        return `uniform sampler2D tex;
uniform float size;
uniform float left;
void main() {
    vec2 uv = cogl_tex_coord_in[0].st;
    vec2 p = uv * vec2(size, size);
    vec2 c = left > 0.5 ? vec2(size, 0.0) : vec2(0.0, 0.0);
    // Keep what's outside the curve (the island's shape is inside it).
    float a = clamp(length(p - c) - size + 0.5, 0.0, 1.0);
    cogl_color_out = texture2D(tex, uv) * a;
}`;
    }

    vfunc_paint_target(node, paintContext) {
        // Non-integer values: GJS hands floats (not ints) to the shader.
        this.set_uniform_value('tex', 0);
        this.set_uniform_value('size', this.get_actor().width + 1e-4);
        this.set_uniform_value('left', this._left ? 1.0001 : 0.0001);
        super.vfunc_paint_target(node, paintContext);
    }
});

class GlassBackdrop {
    constructor(radius) {
        this.actor = new Clutter.Actor({x_expand: true, y_expand: true, reactive: false});
        this._blur = new Clutter.Actor({reactive: false});
        this._blur.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius, brightness: 1.0}));
        this.actor.add_child(this._blur);
        this._corners = [true, false].map(left => {
            const corner = new Clutter.Actor({reactive: false, clip_to_allocation: true});
            corner.add_effect(new CornerMask(left));
            const clone = new Clutter.Clone({source: global.window_group, reactive: false});
            corner.add_child(clone);
            this.actor.add_child(corner);
            return {corner, clone, left};
        });
        this._key = '';
    }

    // The island is w x h at (x, y) on the stage, its side walls `ear` in from
    // the edges, its bottom corners `bottom` round.
    update(x, y, w, h, ear, bottom) {
        const key = [x, y, w, h, ear, bottom].map(Math.round).join(',');
        if (key === this._key)
            return;
        this._key = key;
        this._blur.set_position(Math.round(ear), 0);
        this._blur.set_size(Math.max(0, Math.round(w - 2 * ear)), Math.max(0, Math.round(h)));
        const size = Math.round(bottom);
        for (const {corner, clone, left} of this._corners) {
            const cx = Math.round(left ? ear : w - ear - bottom);
            const cy = Math.round(h - bottom);
            corner.visible = size >= 1;
            corner.set_position(cx, cy);
            corner.set_size(size, size);
            // The clone shows the scene where it is on the stage.
            clone.set_position(-Math.round(x) - cx, -Math.round(y) - cy);
            clone.set_size(global.stage.width, global.stage.height);
        }
    }
}

// Glass tints (dark / light style).
const GLASS = {
    dark: {tint: [0.09, 0.09, 0.11, 0.52], solid: [0, 0, 0, 1], rim: [1, 1, 1, 0.16], shine: 0.07},
    light: {tint: [0.97, 0.97, 0.98, 0.58], solid: [0.96, 0.96, 0.97, 1], rim: [0, 0, 0, 0.12], shine: 0.35},
};
const GLASS_BLUR_RADIUS = 36;

// Same numbers as Liland's NotchGeometry / NotchMode.
const NOTCH_WIDTH = 190;
const COMPACT_WING = 42;
export const COMPACT_WIDTH = NOTCH_WIDTH + COMPACT_WING * 2;
export const OPEN_WIDTH = 480;
const TRAY_CONTENT_HEIGHT = 48;
// Room between the tray's buttons and the island's side walls.
const TRAY_SIDE_PADDING = 14;
// Free space kept on each side of the screen by a very wide tray.
const SCREEN_MARGIN = 24;
const RADII = {
    idle: [6, 10],
    compact: [6, 12],
    open: [18, 28],
    message: [16, 24],
    tray: [16, 24],
    collapsed: [3, 3],
    // A top bar menu shown inside the island: rounder, like iOS cards.
    menu: [16, 40],
    activity: [16, 24],
};
// Room around a menu shown inside the island (sides and bottom).
const MENU_SIDE_PADDING = 10;
const MENU_BOTTOM_PADDING = 14;
// Over a window that reaches the top (e.g. a maximized browser), the closed
// island shrinks to a small handle and grows back on hover (like the macOS
// menu bar that hides): no space is reserved at the top for it.
const COLLAPSED_WIDTH = 140;
const COLLAPSED_HEIGHT = 8;
const OPEN_DELAY = 100;
const CLOSE_DELAY = 150;
const PEEK_DURATION = 3500;
const ANIM_MS = 380;
// Space kept free between the island and the top bar items next to it.
const PANEL_GAP_MARGIN = 8;
// Width of the tab buttons at the top right of the open island.
const TAB_BAR_WIDTH = 64;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.min(Math.max(v, 0), 1);

// Quadratic curve helper for cairo (which only has cubic curves).
function quadTo(cr, [x0, y0], [qx, qy], [x, y]) {
    cr.curveTo(x0 + 2 / 3 * (qx - x0), y0 + 2 / 3 * (qy - y0),
        x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
}

export const Island = GObject.registerClass({
    Signals: {
        // The activity on top changed (shown, replaced or hidden).
        'activity-changed': {},
    },
}, class LilandIsland extends St.Widget {
    _init(nowPlaying, settings, levels) {
        super._init({
            name: 'liland-island',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this.nowPlaying = nowPlaying;
        this._settings = settings;
        this.status = 'closed';
        this.mode = 'idle';
        this._isPeeking = false;
        this._timeouts = {};
        this._panelGap = Infinity;
        // Temporary content (volume/brightness, notifications...) shown
        // instead of the music views; see showActivity(). The last one shown
        // is on top; when it ends, the one below shows again.
        this._activities = [];
        this._shownContent = null;
        // Set while the island replaces the top bar (see setTopBarReplaced).
        this._tray = null;
        this._barHeight = 0;
        // Tab shown while open: 'music' or 'tray'.
        this._tab = 'music';
        // Things that keep the open island open (e.g. a tray button's menu).
        this._holds = new Set();

        this._bg = new St.DrawingArea({x_expand: true, y_expand: true});
        this._bg.connect('repaint', area => this._drawShape(area));
        this.add_child(this._bg);

        // Liquid Glass (see GlassBackdrop), under the tint, and light / dark
        // style.
        this._glass = new GlassBackdrop(GLASS_BLUR_RADIUS);
        this._glass.actor.visible = false;
        this.insert_child_below(this._glass.actor, this._bg);
        for (const prop of ['x', 'y', 'width', 'height'])
            this.connect(`notify::${prop}`, () => this._syncGlass());
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._styleIds = [
            [this._interfaceSettings, this._interfaceSettings.connect('changed::color-scheme', () => this._syncStyle())],
            [settings, settings.connect('changed::glass-effect', () => this._syncStyle())],
        ];
        // The shell theme (User Themes extension), if any: menus shown in the
        // island are drawn by it, so the island is light only with a light one.
        const source = Gio.SettingsSchemaSource.get_default();
        if (source?.lookup('org.gnome.shell.extensions.user-theme', true)) {
            this._userTheme = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.user-theme'});
            this._styleIds.push([this._userTheme, this._userTheme.connect('changed::name', () => this._syncStyle())]);
        }
        this._syncStyle();

        this._music = new MusicPlayer(nowPlaying, levels, {
            openWidth: OPEN_WIDTH - RADII.open[0] * 2,
            emptyWidth: OPEN_WIDTH - RADII.message[0] * 2,
        });
        this.add_child(this._music.compactActor);
        this.add_child(this._music.openActor);
        this.add_child(this._music.emptyActor);
        this._musicSignals = [
            this._music.connect('interaction-ended', () => this._handleHover()),
            this._music.connect('app-launched', () => this._close()),
        ];

        this._buildTrayView();
        // Invisible point under the tray's buttons: menus shown inside the
        // island are positioned from it (see showMenu).
        // It is placed in absolute coordinates (the island is always centered
        // on the monitor), outside the island's layout.
        this._menu = null;
        this._pendingStyles = new Map();
        this._menuAnchor = new Clutter.Actor({width: 1, height: 1, reactive: false});
        Main.uiGroup.add_child(this._menuAnchor);
        this._buildClock();
        this._buildTabBar();

        this.connect('notify::hover', () => this._handleHover());
        this.connect('button-press-event', () => {
            if (this.status === 'closed' && this._settings.get_boolean('open-on-click')) {
                this._open();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('notify::height', () => this._bg.queue_repaint());
        this.connect('notify::width', () => this._bg.queue_repaint());

        this._npChangedId = nowPlaying.connect('changed', () => this._sync());
        this._npTrackId = nowPlaying.connect('track-changed', () => this._peek());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._applyGeometry(false);
            this._remeasurePanel();
        });
        // Top bar items can appear, disappear or move (indicators, other
        // extensions), and the top bar itself can move or be shown/hidden:
        // measure again (after the relayout) so the island never covers them.
        const remeasure = () => this._remeasurePanel();
        const theme = St.ThemeContext.get_for_stage(global.stage);
        this._panelSignals = [
            [theme, theme.connect('changed', remeasure)],
            ...this._panelBoxes().map(box => [box, box.connect('notify::allocation', remeasure)]),
            [Main.layoutManager.panelBox, Main.layoutManager.panelBox.connect('notify::allocation', remeasure)],
            [Main.panel, Main.panel.connect('notify::mapped', remeasure)],
        ];

        this._measurePanel();
        this._sync(true);
    }

    // ---------- geometry ----------

    get _notchHeight() {
        // Replacing the top bar, keep its height (live: the theme or the
        // scale can change it while it's hidden).
        if (this._tray) {
            const [, height] = Main.panel.get_preferred_height(-1);
            return Math.max(height > 0 ? height : this._barHeight, 32);
        }
        // Like Liland on Macs without a notch: as tall as the menu bar (the
        // top bar here), when the top bar is actually at the top.
        return this._panelAtTop() ? Math.max(Main.panel.height, 24) : 32;
    }

    _sizeFor(mode) {
        const h = this._notchHeight;
        switch (mode) {
        case 'compact': return [NOTCH_WIDTH + COMPACT_WING * 2, h];
        case 'open': return [OPEN_WIDTH, h + OPEN_CONTENT_HEIGHT];
        case 'message': return [OPEN_WIDTH, h + MESSAGE_CONTENT_HEIGHT];
        case 'tray': return this._traySize(h);
        case 'activity': return [this._activity?.width ?? COMPACT_WIDTH, h + (this._activity?.contentHeight ?? 0)];
        case 'collapsed': return [COLLAPSED_WIDTH, COLLAPSED_HEIGHT];
        default: return [NOTCH_WIDTH, h];
        }
    }

    // The tray tab, grown around the menu shown inside it, if any.
    _traySize(h) {
        const width = this._trayWidth();
        const height = h + TRAY_CONTENT_HEIGHT;
        if (!this._menu)
            return [width, height];
        const monitor = Main.layoutManager.primaryMonitor;
        const [, , menuW, menuH] = this._menu._boxPointer.get_preferred_size();
        const maxW = monitor ? monitor.width - 2 * SCREEN_MARGIN : Infinity;
        const maxH = monitor ? monitor.height - SCREEN_MARGIN : Infinity;
        return [
            Math.round(Math.min(maxW, Math.max(width, menuW + 2 * (RADII.menu[0] + MENU_SIDE_PADDING)))),
            Math.round(Math.min(maxH, height + menuH + MENU_BOTTOM_PADDING)),
        ];
    }

    _trayWidth() {
        const monitor = Main.layoutManager.primaryMonitor;
        const [, natural] = this._trayRow.get_preferred_width(-1);
        const wanted = natural + 2 * (RADII.tray[0] + TRAY_SIDE_PADDING);
        const max = monitor ? monitor.width - 2 * SCREEN_MARGIN : wanted;
        return Math.round(Math.max(OPEN_WIDTH, Math.min(wanted, max)));
    }

    _remeasurePanel() {
        this._later('panel', 50, () => this._measurePanel());
    }

    _panelBoxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox].filter(Boolean);
    }

    _panelAtTop() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        // Without the top bar, the island itself is the top bar.
        if (this._tray)
            return true;
        if (!Main.panel.mapped)
            return false;
        const [, panelY] = Main.panel.get_transformed_position();
        return Math.abs(panelY - monitor.y) < 2;
    }

    // Width of the free space at the center of the top bar, i.e. how wide the
    // island can be at the top bar's height without covering any of its items
    // (workspace indicator, clock, tray icons...). 0 if something sits at the
    // very center (e.g. GNOME's default clock). No limit without a top bar.
    _measurePanel() {
        // The top bar's height can change after the island was laid out (a
        // shell theme loading, scaling...): lay the current mode out again.
        const notchH = this._notchHeight;
        if (this._laidOutNotchH !== undefined && notchH !== this._laidOutNotchH)
            this._transition(this.mode, this.mode, false);

        const monitor = Main.layoutManager.primaryMonitor;
        let gap = Infinity;
        if (monitor && !this._tray && this._panelAtTop()) {
            const cx = monitor.x + monitor.width / 2;
            let left = monitor.x;
            let right = monitor.x + monitor.width;
            for (const box of this._panelBoxes()) {
                for (const child of box.get_children()) {
                    if (!child.visible || child.width <= 0)
                        continue;
                    const rect = child.get_transformed_extents();
                    const x1 = rect.get_x(), x2 = x1 + rect.get_width();
                    if (x2 <= cx)
                        left = Math.max(left, x2);
                    else if (x1 >= cx)
                        right = Math.min(right, x1);
                    else
                        left = right = cx;
                }
            }
            gap = Math.max(0, 2 * (Math.min(cx - left, right - cx) - PANEL_GAP_MARGIN));
        }
        if (gap === this._panelGap)
            return;
        this._panelGap = gap;
        this._syncHeaderInsets();
        this._bg.queue_repaint();
    }

    // Keep the player's header (which sits at the top bar's height) inside
    // the top part, and clear of the tab buttons.
    _syncHeaderInsets() {
        const inset = (OPEN_WIDTH - this._neckWidth(OPEN_WIDTH)) / 2;
        this._music.setHeaderInsets(inset, this._tray ? Math.max(inset, TAB_BAR_WIDTH) : inset);
    }

    // Width of the island's top part (the part at the top bar's height). The
    // open player only grows wider below the top bar.
    _neckWidth(w) {
        return Math.min(w, Math.max(this._panelGap, COMPACT_WIDTH));
    }

    // Rectangles (local coordinates) that take the pointer for a w x h island.
    // Outside them, clicks go through to the top bar.
    _hitBoxes(w, h, mode) {
        const notchH = this._notchHeight;
        if (mode === 'idle' && !this._tray) {
            // Invisible: only reacts where the top bar has nothing.
            const neck = Math.min(w, this._panelGap);
            return neck > 0 ? [[(w - neck) / 2, 0, (w + neck) / 2, h]] : [];
        }
        const neck = this._neckWidth(w);
        if (neck >= w || h <= notchH)
            return [[(w - neck) / 2, 0, (w + neck) / 2, h]];
        // The body is drawn between the side walls (see _drawShape), not
        // over the whole width: leave the transparent strips to the windows.
        const wall = Math.min((RADII[mode] ?? RADII.open)[0], neck / 4);
        return [[(w - neck) / 2, 0, (w + neck) / 2, notchH], [wall, notchH, w - wall, h]];
    }

    vfunc_pick(context) {
        if (this.reactive) {
            for (const [x1, y1, x2, y2] of this._hitBoxes(this.width, this.height, this.mode))
                this.pick_box(context, Clutter.ActorBox.new(x1, y1, x2, y2));
        }
        for (const child of this.get_children())
            child.pick(context);
    }

    _applyGeometry(animate) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [w, h] = this._sizeFor(this.mode);
        this._targetWidth = w;
        this._targetHeight = h;
        // The top bar's height or the monitor may have changed: keep a menu
        // shown inside the island under the buttons.
        if (this._menu) {
            this._placeMenuAnchor();
            this._menu._boxPointer.queue_relayout();
        }
        const x = Math.round(monitor.x + (monitor.width - w) / 2);
        const y = monitor.y;
        this.remove_transition('width');
        this.remove_transition('height');
        this.remove_transition('x');
        if (animate) {
            this.ease({
                x, y, width: w, height: h,
                duration: ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            });
        } else {
            this.set_position(x, y);
            this.set_size(w, h);
        }
    }

    // The island's shape for a w x h size: f (how much the body sticks out on
    // each side of the top part), ear / top radius, shoulders, bottom radius.
    _shape(w, h) {
        const notchH = this._notchHeight;
        const tall = ['message', 'tray', 'activity'].includes(this.mode) ? this.mode : 'open';
        const [, fullH] = this._sizeFor(tall);
        const t = clamp01((h - notchH) / Math.max(1, fullH - notchH));
        const base = tall === 'tray' && this._menu ? RADII.menu : RADII[tall];
        const small = this.mode === 'idle' ? RADII.idle : RADII.compact;
        const neck = this._neckWidth(w);
        // f: how much the body sticks out on each side of the top part.
        const f = Math.max(0, (w - neck) / 2);
        const bodyH = Math.max(0, h - notchH);
        const topR = Math.max(0, Math.min(lerp(small[0], base[0], t), neck / 4, h / 2));
        // s: radius of the curve where the top part flares out into the body.
        const s = f > 0 ? Math.max(0, Math.min(10, f / 2, notchH - topR, bodyH / 2)) : 0;
        const botR = Math.max(0, Math.min(lerp(small[1], base[1], t), (w - topR * 2) / 2,
            f > 0 ? bodyH - s : h - topR));
        return {notchH, f, topR, s, botR};
    }

    _drawShape(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const {notchH, f, topR, s, botR} = this._shape(w, h);
        const style = this._light ? GLASS.light : GLASS.dark;
        const glass = this._settings.get_boolean('glass-effect') && f === 0;
        if (f === 0) {
            // The island's own shape: concave ears at the top corners, round
            // bottom corners.
            cr.moveTo(0, 0);
            cr.arc(0, topR, topR, -Math.PI / 2, 0);
            cr.lineTo(topR, h - botR);
            cr.arcNegative(topR + botR, h - botR, botR, Math.PI, Math.PI / 2);
            cr.lineTo(w - topR - botR, h);
            cr.arcNegative(w - topR - botR, h - botR, botR, Math.PI / 2, 0);
            cr.lineTo(w - topR, topR);
            cr.arc(w, topR, topR, Math.PI, 1.5 * Math.PI);
            cr.closePath();
        } else {
            // With a narrower top part (the top bar is there): the notch shape
            // with shoulders. Clockwise from the top-left corner.
            cr.moveTo(f, 0);
            quadTo(cr, [f, 0], [f + topR, 0], [f + topR, topR]);
            cr.lineTo(f + topR, notchH - s);
            quadTo(cr, [f + topR, notchH - s], [f + topR, notchH], [f + topR - s, notchH]);
            cr.lineTo(topR + s, notchH);
            quadTo(cr, [topR + s, notchH], [topR, notchH], [topR, notchH + s]);
            cr.lineTo(topR, h - botR);
            quadTo(cr, [topR, h - botR], [topR, h], [topR + botR, h]);
            cr.lineTo(w - topR - botR, h);
            quadTo(cr, [w - topR - botR, h], [w - topR, h], [w - topR, h - botR]);
            cr.lineTo(w - topR, notchH + s);
            quadTo(cr, [w - topR, notchH + s], [w - topR, notchH], [w - topR - s, notchH]);
            cr.lineTo(w - f - topR + s, notchH);
            quadTo(cr, [w - f - topR + s, notchH], [w - f - topR, notchH], [w - f - topR, notchH - s]);
            cr.lineTo(w - f - topR, topR);
            quadTo(cr, [w - f - topR, topR], [w - f - topR, 0], [w - f, 0]);
            cr.closePath();
        }

        if (glass) {
            // Tint over the blur, a soft shine from the top, a thin bright rim.
            cr.setSourceRGBA(...style.tint);
            cr.fillPreserve();
            const shine = new Cairo.LinearGradient(0, 0, 0, Math.max(1, h));
            shine.addColorStopRGBA(0, 1, 1, 1, style.shine);
            shine.addColorStopRGBA(Math.min(1, 60 / Math.max(1, h)), 1, 1, 1, 0);
            cr.setSource(shine);
            cr.fillPreserve();
            cr.setSourceRGBA(...style.rim);
            cr.setLineWidth(1.5);
            cr.stroke();
        } else {
            cr.setSourceRGBA(...style.solid);
            cr.fill();
        }
        cr.$dispose();
    }

    // The glass follows the island's size, place and shape (outside of the
    // paint cycle): only with glass on, the plain shape (no narrower top
    // part) and while the island is drawn (not the invisible idle one).
    _syncGlass() {
        const {f, topR, botR} = this._shape(this.width, this.height);
        const shown = this._settings.get_boolean('glass-effect') && f === 0 &&
            this._bg.opacity > 0 && !(this.mode === 'idle' && !this._tray);
        if (shown) {
            const [x, y] = this.get_transformed_position();
            this._glass.update(x, y, this.width, this.height, topR, botR);
        }
        if (this._glass.actor.visible !== shown)
            this._glass.actor.visible = shown;
    }

    // Light / dark style and glass on / off: restyle everything. Light only
    // when it all is: the color scheme, the shell theme (GNOME 46's own one
    // is dark; menus shown in the island use it) and the island being the
    // top bar (else it's a black notch).
    _syncStyle() {
        const lightScheme = this._interfaceSettings.get_string('color-scheme') !== 'prefer-dark';
        const lightShell = /light/i.test(this._userTheme?.get_string('name') ?? '');
        this._light = lightScheme && lightShell && Boolean(this._tray);
        if (this._light)
            this.add_style_class_name('liland-light');
        else
            this.remove_style_class_name('liland-light');
        if (this._menu)
            this._styleMenu(this._menu._boxPointer);
        this._bg.queue_repaint();
        this._syncGlass();
    }

    _styleMenu(pointer) {
        pointer.add_style_class_name('liland-menu');
        if (this._light)
            pointer.add_style_class_name('liland-light');
        else
            pointer.remove_style_class_name('liland-light');
    }

    // ---------- activities (public API) ----------

    get notchHeight() {
        return this._notchHeight;
    }

    // Width of the part of a w-wide island that sits at the top bar's height.
    neckWidth(w) {
        return this._neckWidth(w);
    }

    // Whether an activity shown now would actually be seen; if not, the
    // caller should fall back to GNOME's own UI.
    canShowActivity() {
        const monitor = Main.layoutManager.primaryMonitor;
        return Boolean(monitor) && !monitor.inFullscreen && this._panelAtTop() &&
            this.status === 'closed' && this.visible;
    }

    // activity: {actor, width, contentHeight}. The actor is laid out at the
    // top center of the island; its first notchHeight pixels are at the top
    // bar's height (keep that part within neckWidth(width)).
    showActivity(activity) {
        if (activity.actor.get_parent() !== this) {
            activity.actor.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START, opacity: 0});
            activity.actor.hide();
            this.add_child(activity.actor);
        }
        if (this._activity === activity) {
            this.updateActivity(activity);
            return;
        }
        this._activities = this._activities.filter(a => a !== activity);
        this._activities.push(activity);
        this._sync();
        this.emit('activity-changed');
    }

    // Call after changing an activity's size while it is shown.
    updateActivity(activity) {
        if (this._activity === activity && this.mode === 'activity')
            this._applyGeometry(true);
    }

    hideActivity(activity) {
        const wasOnTop = this._activity === activity;
        this._activities = this._activities.filter(a => a !== activity);
        if (wasOnTop) {
            this._sync();
            this.emit('activity-changed');
            // The pointer may have stayed over the island the whole time:
            // it can open the player now.
            if (this.mode !== 'activity' && this.hover)
                this._handleHover();
        }
    }

    // The activity on top (the one the island shows), or null.
    get activity() {
        return this._activity;
    }

    get _activity() {
        return this._activities.at(-1) ?? null;
    }

    // ---------- top bar replacement (public API, used by topbar.js) ----------

    // tray: the actor holding the top bar's buttons, shown in the "tray" tab,
    // or null when the top bar is back. barHeight: the top bar's height, which
    // the island keeps as its own.
    setTopBarReplaced(tray, barHeight = 0) {
        if (tray === this._tray)
            return;
        if (this._tray)
            this._trayRow.remove_child(this._tray);
        this._tray = tray;
        this._barHeight = barHeight;
        if (tray)
            this._trayRow.add_child(tray);
        if (!tray && this._tab === 'tray')
            this._tab = 'music';
        this._holds.clear();
        this._syncStyle();
        if (tray)
            this._watchWindows();
        else
            this._unwatchWindows();
        this._panelGap = undefined;
        this._measurePanel();
        this._syncHeaderInsets();
        this._sync(true);
    }

    // Lay the tray tab out again if its buttons need another width (a
    // button added, removed, shown, hidden or grown).
    trayChanged() {
        this._later('tray', 0, () => {
            if (this.mode !== 'tray')
                return;
            const [w, h] = this._sizeFor('tray');
            if (w !== Math.round(this._targetWidth ?? this.width) || h !== Math.round(this._targetHeight ?? this.height))
                this._applyGeometry(true);
        });
    }

    // Open the island on a tab ('music' or 'tray'). Without animation, the
    // island is at its final place and size right away (e.g. to open a menu
    // anchored to one of its buttons).
    openTab(tab, animate = true) {
        if (tab === 'tray' && !this._tray)
            return;
        this._tab = tab;
        if (this.status === 'closed') {
            this._tabChosen = true;
            this._open(animate);
        } else {
            this._sync(false, animate);
        }
    }

    // Show a top bar menu (a PopupMenu of one of the tray's buttons) inside
    // the island, like one card that grows out of it: the island grows around
    // it, the menu is centered under the buttons, drawn above the island, and
    // loses its own background/arrow (the 'liland-menu' style class). Call it
    // once the menu is open; another menu shown replaces this one.
    showMenu(menu) {
        if (this._menu === menu)
            return;
        if (this._menu)
            this._releaseMenu();
        this._menu = menu;
        const pending = this._pendingStyles.get(menu);
        if (pending) {
            pending[0].disconnect(pending[1]);
            this._pendingStyles.delete(menu);
        }
        // menu.actor is the BoxPointer, or (quick settings) an actor holding
        // it: size, style and position are the BoxPointer's.
        const pointer = menu._boxPointer;
        this._styleMenu(pointer);
        this._placeMenuAnchor();
        pointer.setPosition(this._menuAnchor, 0.5);
        if (menu.actor.get_parent() === this.get_parent())
            menu.actor.get_parent().set_child_above_sibling(menu.actor, this);
        // Follow the menu's size (submenus, notifications coming and going).
        const resize = () => this._later('menu', 0, () => {
            if (this.mode === 'tray')
                this._applyGeometry(true);
        });
        this._menuSignals = [
            pointer.connect('notify::width', resize),
            pointer.connect('notify::height', resize),
        ];
        if (this.mode === 'tray')
            this._applyGeometry(true);
    }

    // Centered on the monitor, right under the tray's buttons.
    _placeMenuAnchor() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._menuAnchor.set_position(
            Math.round(monitor.x + monitor.width / 2),
            monitor.y + this._notchHeight + TRAY_CONTENT_HEIGHT - 1);
    }

    // The menu closed (or went elsewhere): back to the plain tray.
    hideMenu(menu) {
        if (this._menu !== menu)
            return;
        this._releaseMenu();
        if (this.mode === 'tray')
            this._applyGeometry(true);
    }

    _releaseMenu() {
        const menu = this._menu;
        const actor = menu._boxPointer;
        for (const id of this._menuSignals)
            actor.disconnect(id);
        this._menuSignals = [];
        this._menu = null;
        // Keep its island look while it fades out.
        if (actor.visible && !menu.isOpen) {
            const id = actor.connect('notify::visible', () => this.dropMenuStyle(menu));
            this._pendingStyles.set(menu, [actor, id]);
        } else {
            this.dropMenuStyle(menu);
        }
    }

    // Give a menu its own look back (now), unless it's shown in the island.
    // Also for a menu that reopens elsewhere before its fade-out ended.
    dropMenuStyle(menu) {
        const pending = this._pendingStyles.get(menu);
        if (pending) {
            pending[0].disconnect(pending[1]);
            this._pendingStyles.delete(menu);
        }
        if (this._menu !== menu) {
            menu._boxPointer?.remove_style_class_name('liland-menu');
            menu._boxPointer?.remove_style_class_name('liland-light');
        }
    }

    get menu() {
        return this._menu;
    }

    // ---------- collapsing over windows ----------

    // Windows that reach the top under the island make it collapse (when
    // closed): watch whatever can move a window there.
    _watchWindows() {
        if (this._windowSignals)
            return;
        const check = () => this._later('collapse', 60, () => this._updateCollapse());
        const display = global.display;
        const wm = global.window_manager;
        const workspaces = global.workspace_manager;
        this._windowSignals = [
            ...['restacked', 'window-created', 'grab-op-end', 'window-entered-monitor', 'window-left-monitor']
                .map(signal => [display, display.connect(signal, check)]),
            ...['size-changed', 'minimize', 'unminimize', 'map', 'destroy', 'switch-workspace']
                .map(signal => [wm, wm.connect(signal, check)]),
            [workspaces, workspaces.connect('active-workspace-changed', check)],
        ];
        this._updateCollapse();
    }

    _unwatchWindows() {
        for (const [obj, id] of this._windowSignals ?? [])
            obj.disconnect(id);
        this._windowSignals = null;
        this._cancel('collapse');
        this._setCollapsed(false);
    }

    _updateCollapse() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._tray) {
            this._setCollapsed(false);
            return;
        }
        // The island's closed area (as wide as the music pill, the widest).
        const width = COMPACT_WIDTH;
        const x1 = monitor.x + (monitor.width - width) / 2;
        const x2 = x1 + width;
        const y2 = monitor.y + this._notchHeight;
        const workspace = global.workspace_manager.get_active_workspace();
        const covered = global.get_window_actors().some(actor => {
            const win = actor.meta_window;
            if (!win || win.minimized || !win.showing_on_its_workspace() ||
                !win.located_on_workspace(workspace) ||
                win.get_window_type() !== Meta.WindowType.NORMAL ||
                win.get_monitor() !== Main.layoutManager.primaryIndex)
                return false;
            const r = win.get_frame_rect();
            return r.x < x2 && r.x + r.width > x1 && r.y < y2 && r.y + r.height > monitor.y;
        });
        this._setCollapsed(covered);
    }

    _setCollapsed(collapsed) {
        if (this._collapsed === collapsed)
            return;
        this._collapsed = collapsed;
        this._sync();
    }

    // While held (e.g. a menu of a tray button is open), the open island
    // doesn't close. Released, it closes if the pointer is away.
    hold(key, held) {
        if (held)
            this._holds.add(key);
        else if (this._holds.delete(key))
            this._handleHover();
    }

    // ---------- views ----------

    _buildTrayView() {
        this._trayView = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._trayView.set_pivot_point(0.5, 0);
        this._traySpacer = new St.Widget();
        this._trayView.add_child(this._traySpacer);
        this._trayRow = new St.BoxLayout({
            style_class: 'liland-tray',
            x_align: Clutter.ActorAlign.CENTER,
            height: TRAY_CONTENT_HEIGHT - 8,
        });
        this._trayView.add_child(this._trayRow);
        this._trayRow.connect('queue-relayout', () => this.trayChanged());
        this.add_child(this._trayView);
    }

    _buildClock() {
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._clock = new St.Label({
            style_class: 'liland-clock',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._clock.clutter_text.y_align = Clutter.ActorAlign.CENTER;
        const syncClock = () => {
            this._clock.text = this._wallClock.clock.trim();
        };
        this._wallClockId = this._wallClock.connect('notify::clock', syncClock);
        syncClock();
        this.add_child(this._clock);
    }

    _buildTabBar() {
        this._tabBar = new St.BoxLayout({
            style_class: 'liland-tabs',
            // BinLayout only honors the alignment of expanding children.
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._tabButtons = {};
        for (const [tab, icon] of [['music', 'audio-x-generic-symbolic'], ['tray', 'view-app-grid-symbolic']]) {
            const button = new St.Button({
                style_class: 'liland-tab',
                child: new St.Icon({icon_name: icon, icon_size: 14}),
                y_align: Clutter.ActorAlign.CENTER,
                can_focus: false,
            });
            button.connect('clicked', () => this.openTab(tab));
            this._tabButtons[tab] = button;
            this._tabBar.add_child(button);
        }
        this.add_child(this._tabBar);
    }

    // ---------- state ----------

    _computeMode() {
        const hasTrack = this.nowPlaying.track !== null;
        if (this.status === 'open') {
            if (this._tab === 'tray' && this._tray)
                return 'tray';
            return hasTrack ? 'open' : 'message';
        }
        if (this._activity)
            return 'activity';
        if (this._collapsed)
            return 'collapsed';
        return hasTrack && this.nowPlaying.isPlaying ? 'compact' : 'idle';
    }

    _contentFor(mode) {
        if (mode === 'activity')
            return this._activity?.actor ?? null;
        return {
            compact: this._music.compactActor,
            open: this._music.openActor,
            message: this._music.emptyActor,
            tray: this._trayView,
        }[mode] ?? null;
    }

    _sync(initial = false, animate = !initial) {
        this._music.sync();
        const mode = this._computeMode();
        // Also when one activity replaces another (the mode stays 'activity').
        if (mode !== this.mode || initial || this._contentFor(mode) !== this._shownContent) {
            const previous = this.mode;
            this.mode = mode;
            this._transition(previous, mode, animate);
        }
        this._music.setMode(this.mode);
        this._syncTabs();
    }

    _syncTabs() {
        for (const [tab, button] of Object.entries(this._tabButtons)) {
            if (tab === this._tab)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
    }

    _transition(from, to, animate) {
        const oldContent = this._shownContent;
        const newContent = this._contentFor(to);
        this._shownContent = newContent;
        const notchH = this._notchHeight;
        this._laidOutNotchH = notchH;
        this._music.setNotchHeight(notchH);
        this._traySpacer.height = notchH;
        this._clock.height = notchH;
        this._tabBar.height = notchH;
        const topR = (RADII[to] ?? RADII.idle)[0];
        this._music.setCompactPadding(10 + topR);

        if (oldContent && oldContent !== newContent) {
            oldContent.remove_all_transitions();
            if (animate) {
                oldContent.ease({
                    opacity: 0,
                    scale_x: from === 'compact' ? 1 : 0.85,
                    scale_y: from === 'compact' ? 1 : 0.85,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._shownContent !== oldContent)
                            oldContent.hide();
                    },
                });
            } else {
                oldContent.opacity = 0;
                oldContent.hide();
            }
        }
        if (newContent) {
            newContent.remove_all_transitions();
            newContent.show();
            if (animate) {
                if (to !== 'compact')
                    newContent.scale_x = newContent.scale_y = 0.85;
                newContent.ease({
                    opacity: 255, scale_x: 1, scale_y: 1,
                    delay: 50,
                    duration: ANIM_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            } else {
                newContent.opacity = 255;
                newContent.scale_x = newContent.scale_y = 1;
            }
        }

        // Replacing the top bar, the island always shows the time (alone
        // when idle, between the artwork and the equalizer when compact) and,
        // open, the tab buttons.
        const replaced = Boolean(this._tray);
        this._setShown(this._clock, replaced && (to === 'idle' || to === 'compact'), animate);
        this._setShown(this._tabBar, replaced && ['open', 'message', 'tray'].includes(to), animate);

        // Without a physical notch (and with the top bar there), the idle
        // island is invisible (like Liland on Macs without a notch).
        this._bg.remove_all_transitions();
        this._bg.ease({
            opacity: to === 'idle' && !replaced ? 0 : 255,
            duration: animate ? 250 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._bg.queue_repaint();
                this._syncGlass();
            },
        });
        this._bg.queue_repaint();
        this._syncGlass();
        this._applyGeometry(animate);
    }

    _setShown(actor, shown, animate) {
        if (actor._lilandShown === shown)
            return;
        actor._lilandShown = shown;
        actor.remove_transition('opacity');
        if (shown) {
            actor.show();
            if (animate)
                actor.ease({opacity: 255, delay: 80, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                actor.opacity = 255;
        } else if (animate) {
            actor.ease({
                opacity: 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!actor._lilandShown)
                        actor.hide();
                },
            });
        } else {
            actor.opacity = 0;
            actor.hide();
        }
    }

    // ---------- hover / open / close (same logic as NotchWindowController) ----------

    _later(name, ms, fn) {
        this._cancel(name);
        this._timeouts[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            delete this._timeouts[name];
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel(name) {
        if (this._timeouts[name]) {
            GLib.source_remove(this._timeouts[name]);
            delete this._timeouts[name];
        }
    }

    _pointerNear(margin) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const [px, py] = global.get_pointer();
        const [w, h] = this._sizeFor(this.mode);
        const ox = monitor.x + (monitor.width - w) / 2;
        const oy = monitor.y;
        return this._hitBoxes(w, h, this.mode).some(([x1, y1, x2, y2]) =>
            px >= ox + x1 - margin && px <= ox + x2 + margin &&
            py >= oy + y1 - margin && py <= oy + y2 + margin);
    }

    get _isHeld() {
        return this._music.isInteracting || this._isPeeking || this._holds.size > 0;
    }

    _handleHover() {
        const hover = this.hover;
        if (this.status === 'closed' && this.mode === 'activity') {
            // Hovering an activity keeps it (the activity pauses its own
            // timer); it doesn't open the player.
            this._cancel('open');
            return;
        }
        if (this.status === 'closed') {
            if (!this._settings.get_boolean('open-on-click') && hover)
                this._later('open', OPEN_DELAY, () => {
                    if (this.hover)
                        this._open();
                });
            else
                this._cancel('open');
            return;
        }
        if (hover) {
            this._cancel('close');
            this._endPeek();
        } else if (!this._isHeld) {
            this._scheduleClose();
        }
    }

    _scheduleClose() {
        this._later('close', CLOSE_DELAY, () => {
            if (this.hover || this._isHeld)
                return;
            if (this._pointerNear(10)) {
                this._scheduleClose();
                return;
            }
            this._close();
        });
    }

    _open(animate = true) {
        this._cancel('close');
        if (this.status !== 'closed')
            return;
        this.status = 'open';
        // Without music, the top bar's buttons are what the island has to offer.
        if (!this._tabChosen)
            this._tab = this.nowPlaying.track === null && this._tray ? 'tray' : 'music';
        this._tabChosen = false;
        this.nowPlaying.refresh();
        this._sync(false, animate);
        // Activities under the player aren't visible anymore.
        this.emit('activity-changed');
        this._handleHover();
    }

    _close() {
        this._cancel('open');
        this._endPeek();
        this._tabChosen = false;
        if (this.status === 'closed')
            return;
        this.status = 'closed';
        this._sync();
        this.emit('activity-changed');
    }

    _peek() {
        if (!this._settings.get_boolean('peek-on-track-change') || this.status !== 'closed' || this._activity)
            return;
        this._isPeeking = true;
        this._tab = 'music';
        this._tabChosen = true;
        this._open();
        this._later('peek', PEEK_DURATION, () => {
            if (!this._isPeeking)
                return;
            this._isPeeking = false;
            this._handleHover();
        });
    }

    _endPeek() {
        this._isPeeking = false;
        this._cancel('peek');
    }

    destroy() {
        if (this._menu) {
            const menu = this._menu;
            this._releaseMenu();
            this.dropMenuStyle(menu);
        }
        for (const menu of [...this._pendingStyles.keys()])
            this.dropMenuStyle(menu);
        for (const [obj, id] of this._windowSignals ?? [])
            obj.disconnect(id);
        this._windowSignals = null;
        for (const name of Object.keys(this._timeouts))
            this._cancel(name);
        this._menuAnchor.destroy();
        for (const [obj, id] of this._panelSignals)
            obj.disconnect(id);
        for (const id of this._musicSignals)
            this._music.disconnect(id);
        this._music.destroy();
        this._wallClock.disconnect(this._wallClockId);
        this._wallClock.run_dispose();
        this._wallClock = null;
        this.nowPlaying.disconnect(this._npChangedId);
        this.nowPlaying.disconnect(this._npTrackId);
        Main.layoutManager.disconnect(this._monitorsId);
        for (const [obj, id] of this._styleIds)
            obj.disconnect(id);
        // The tray's buttons are the top bar's: topbar.js takes them back
        // before the island goes; don't destroy them with it.
        if (this._tray)
            this._trayRow.remove_child(this._tray);
        this._tray = null;
        super.destroy();
    }
});
