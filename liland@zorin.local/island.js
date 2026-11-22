// The island: a black "notch" at the top center that grows into a player.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_} from './i18n.js';

// Same numbers as Liland's NotchGeometry / NotchMode.
const NOTCH_WIDTH = 190;
const COMPACT_WING = 42;
const COMPACT_WIDTH = NOTCH_WIDTH + COMPACT_WING * 2;
const OPEN_WIDTH = 480;
const OPEN_CONTENT_HEIGHT = 140;
const MESSAGE_CONTENT_HEIGHT = 70;
const RADII = {
    idle: [6, 10],
    compact: [6, 12],
    open: [18, 28],
    message: [16, 24],
};
const OPEN_DELAY = 100;
const CLOSE_DELAY = 150;
const PEEK_DURATION = 3500;
const ANIM_MS = 380;
// Space kept free between the island and the top bar items next to it.
const PANEL_GAP_MARGIN = 8;

const SPOTIFY_IDS = ['spotify.desktop', 'spotify_spotify.desktop', 'com.spotify.Client.desktop'];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.min(Math.max(v, 0), 1);
const rgbCss = ([r, g, b], a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Quadratic curve helper for cairo (which only has cubic curves).
function quadTo(cr, [x0, y0], [qx, qy], [x, y]) {
    cr.curveTo(x0 + 2 / 3 * (qx - x0), y0 + 2 / 3 * (qy - y0),
        x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
}

const EqualizerView = GObject.registerClass(
class LilandEqualizer extends St.DrawingArea {
    static RESTING = [0.69, 0.2, 0.56, 0.74, 0.75, 0.63];
    static SPEEDS = [5.1, 6.7, 4.3, 7.9, 5.6, 6.1];
    static PHASES = [0, 1.3, 2.6, 0.7, 2.1, 3.4];

    _init(width, height, island) {
        super._init({width, height, y_align: Clutter.ActorAlign.CENTER});
        this._island = island;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const island = this._island;
        const live = island.liveLevels;
        const time = GLib.get_monotonic_time() / 1e6;
        const playFactor = island.playFactor;
        const count = 6, gap = 0.65;
        const barW = w / (count + (count - 1) * gap);
        const [r, g, b] = island.nowPlaying.accentColor;
        cr.setSourceRGBA(r, g, b, 1);
        for (let i = 0; i < count; i++) {
            let level;
            if (live)
                level = live[i] ?? 0;
            else {
                const fast = Math.sin(time * EqualizerView.SPEEDS[i] + EqualizerView.PHASES[i]);
                const slow = Math.sin(time * EqualizerView.SPEEDS[i] * 0.53 + EqualizerView.PHASES[i] * 2);
                level = clamp01(EqualizerView.RESTING[i] + 0.22 * (fast * 0.6 + slow * 0.4));
            }
            level *= playFactor;
            const barH = barW + (h - barW) * level;
            const x = i * barW * (1 + gap);
            const y = (h - barH) / 2;
            const rad = barW / 2;
            cr.newSubPath();
            cr.arc(x + rad, y + rad, rad, Math.PI, 0);
            cr.arc(x + rad, y + barH - rad, rad, 0, Math.PI);
            cr.closePath();
            cr.fill();
        }
        cr.$dispose();
    }
});

const ArtworkView = GObject.registerClass(
class LilandArtwork extends St.Bin {
    _init(size, radius) {
        super._init({
            width: size, height: size,
            style_class: 'liland-artwork',
            style: `border-radius: ${radius}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._radius = radius;
        this._placeholder = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: Math.max(8, Math.round(radius * 1.6)),
            style_class: 'liland-artwork-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._path = undefined;
        this.setPath(null);
    }

    setPath(path) {
        if (path === this._path)
            return;
        this._path = path;
        if (path) {
            const uri = Gio.File.new_for_path(path).get_uri();
            this.style = `border-radius: ${this._radius}px; background-image: url("${uri}"); background-size: cover;`;
            this.set_child(null);
        } else {
            this.style = `border-radius: ${this._radius}px; background-color: rgba(255,255,255,0.12);`;
            this.set_child(this._placeholder);
        }
        this.opacity = 0;
        this.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
});

function controlButton(iconName, size, onClick) {
    const icon = new St.Icon({icon_name: iconName, icon_size: size});
    const button = new St.Button({
        style_class: 'liland-control',
        child: icon,
        width: 40, height: 30,
        can_focus: false,
    });
    button.set_pivot_point(0.5, 0.5);
    button.connect('clicked', onClick);
    button.connect('button-press-event', () => {
        button.ease({scale_x: 0.88, scale_y: 0.88, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return Clutter.EVENT_PROPAGATE;
    });
    button.connect('button-release-event', () => {
        button.ease({scale_x: 1, scale_y: 1, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        return Clutter.EVENT_PROPAGATE;
    });
    button.connect('notify::hover', () => {
        if (!button.hover)
            button.ease({scale_x: 1, scale_y: 1, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    });
    button.icon = icon;
    return button;
}

export const Island = GObject.registerClass(
class LilandIsland extends St.Widget {
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
        this._levels = levels;
        this.status = 'closed';
        this.mode = 'idle';
        this.playFactor = 0;
        this.liveLevels = null;
        this._isInteracting = false;
        this._isPeeking = false;
        this._timeouts = {};
        this._panelGap = Infinity;

        this._bg = new St.DrawingArea({x_expand: true, y_expand: true});
        this._bg.connect('repaint', area => this._drawShape(area));
        this.add_child(this._bg);

        this._buildCompact();
        this._buildOpen();
        this._buildMessage();

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
        this._levelsId = levels.connect('levels', (_l, values) => {
            this.liveLevels = values;
        });
        this._levelsStopId = levels.connect('stopped', () => {
            this.liveLevels = null;
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._applyGeometry(false);
            this._remeasurePanel();
        });
        // Top bar items can appear, disappear or move (indicators, other
        // extensions), and the top bar itself can move or be shown/hidden:
        // measure again (after the relayout) so the island never covers them.
        const remeasure = () => this._remeasurePanel();
        this._panelSignals = [
            ...this._panelBoxes().map(box => [box, box.connect('notify::allocation', remeasure)]),
            [Main.layoutManager.panelBox, Main.layoutManager.panelBox.connect('notify::allocation', remeasure)],
            [Main.panel, Main.panel.connect('notify::mapped', remeasure)],
        ];

        this._measurePanel();
        this._sync(true);
    }

    // ---------- geometry ----------

    get _notchHeight() {
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
        default: return [NOTCH_WIDTH, h];
        }
    }

    _remeasurePanel() {
        this._later('panel', 50, () => this._measurePanel());
    }

    _panelBoxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox].filter(Boolean);
    }

    _panelAtTop() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !Main.panel.mapped)
            return false;
        const [, panelY] = Main.panel.get_transformed_position();
        return Math.abs(panelY - monitor.y) < 2;
    }

    // Width of the free space at the center of the top bar, i.e. how wide the
    // island can be at the top bar's height without covering any of its items
    // (workspace indicator, clock, tray icons...). 0 if something sits at the
    // very center (e.g. GNOME's default clock).
    _measurePanel() {
        const monitor = Main.layoutManager.primaryMonitor;
        let gap = Infinity;
        if (monitor && this._panelAtTop()) {
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
        // Keep the header (which sits at the top bar's height) inside the top part.
        const inset = (OPEN_WIDTH - this._neckWidth(OPEN_WIDTH)) / 2;
        this._header.margin_left = this._header.margin_right = inset;
        this._bg.queue_repaint();
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
        if (mode === 'idle') {
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

    _drawShape(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const notchH = this._notchHeight;
        const [, fullH] = this._sizeFor(this.mode === 'message' ? 'message' : 'open');
        const t = clamp01((h - notchH) / Math.max(1, fullH - notchH));
        const base = this.mode === 'message' ? RADII.message : RADII.open;
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

        // Clockwise from the top-left corner. With f = 0 (and so s = 0) this is
        // the plain notch shape.
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
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fill();
        cr.$dispose();
    }

    // ---------- views ----------

    _buildCompact() {
        this._compact = new St.BoxLayout({
            style_class: 'liland-compact',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._compactArt = new ArtworkView(20, 5);
        this._compactEq = new EqualizerView(18, 14, this);
        this._compact.add_child(this._compactArt);
        this._compact.add_child(new St.Widget({x_expand: true}));
        this._compact.add_child(this._compactEq);
        this.add_child(this._compact);
    }

    _buildOpen() {
        const innerWidth = OPEN_WIDTH - RADII.open[0] * 2;
        this._openBox = new St.BoxLayout({
            vertical: true,
            width: innerWidth,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._openBox.set_pivot_point(0.5, 0);

        // Header: "Now Playing" + app icon.
        const header = new St.BoxLayout({style_class: 'liland-header'});
        this._statusLabel = new St.Label({style_class: 'liland-status', y_align: Clutter.ActorAlign.CENTER});
        this._appButton = new St.Button({style_class: 'liland-app-button', y_align: Clutter.ActorAlign.CENTER, can_focus: false});
        this._appButton.connect('clicked', () => this._raisePlayer());
        header.add_child(this._statusLabel);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._appButton);
        this._header = header;
        this._openBox.add_child(header);

        const body = new St.BoxLayout({vertical: true, style_class: 'liland-body'});
        this._openBox.add_child(body);

        // Track info.
        const info = new St.BoxLayout({style_class: 'liland-info'});
        const artButton = new St.Button({can_focus: false, y_align: Clutter.ActorAlign.CENTER});
        this._openArt = new ArtworkView(56, 10);
        artButton.set_child(this._openArt);
        artButton.connect('clicked', () => this._raisePlayer());
        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'liland-texts'});
        this._titleLabel = new St.Label({style_class: 'liland-title'});
        this._artistLabel = new St.Label({style_class: 'liland-artist'});
        for (const l of [this._titleLabel, this._artistLabel])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(this._titleLabel);
        texts.add_child(this._artistLabel);
        this._openEq = new EqualizerView(22, 24, this);
        info.add_child(artButton);
        info.add_child(texts);
        info.add_child(this._openEq);
        body.add_child(info);

        // Progress.
        const progress = new St.BoxLayout({style_class: 'liland-progress', height: 14});
        this._elapsedLabel = new St.Label({style_class: 'liland-time', y_align: Clutter.ActorAlign.CENTER});
        this._remainingLabel = new St.Label({style_class: 'liland-time', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({
            reactive: true, x_expand: true, height: 14,
            layout_manager: new Clutter.BinLayout(),
        });
        this._trackBg = new St.Widget({style_class: 'liland-track-bg', x_expand: true, height: 4, y_align: Clutter.ActorAlign.CENTER});
        this._trackFill = new St.Widget({style_class: 'liland-track-fill', height: 4});
        this._trackBg.add_child(this._trackFill);
        this._track.add_child(this._trackBg);
        this._track.connect('button-press-event', (_a, event) => this._beginDrag(event));
        this._liveLabel = new St.Label({text: _('Live'), style_class: 'liland-live', y_align: Clutter.ActorAlign.CENTER});
        progress.add_child(this._elapsedLabel);
        progress.add_child(this._track);
        progress.add_child(this._remainingLabel);
        progress.add_child(this._liveLabel);
        body.add_child(progress);

        // Controls.
        const controls = new St.BoxLayout({style_class: 'liland-controls', x_align: Clutter.ActorAlign.CENTER, height: 30});
        this._shuffleBtn = controlButton('media-playlist-shuffle-symbolic', 14, () => this.nowPlaying.toggleShuffle());
        this._prevBtn = controlButton('media-skip-backward-symbolic', 18, () => this.nowPlaying.previous());
        this._playBtn = controlButton('media-playback-start-symbolic', 26, () => this.nowPlaying.playPause());
        this._nextBtn = controlButton('media-skip-forward-symbolic', 18, () => this.nowPlaying.next());
        this._repeatBtn = controlButton('media-playlist-repeat-symbolic', 14, () => this.nowPlaying.cycleRepeat());
        for (const b of [this._shuffleBtn, this._prevBtn, this._playBtn, this._nextBtn, this._repeatBtn])
            controls.add_child(b);
        body.add_child(controls);

        this.add_child(this._openBox);
    }

    _buildMessage() {
        const innerWidth = OPEN_WIDTH - RADII.message[0] * 2;
        this._messageBox = new St.BoxLayout({
            vertical: true,
            width: innerWidth,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._messageBox.set_pivot_point(0.5, 0);
        this._messageSpacer = new St.Widget();
        this._messageBox.add_child(this._messageSpacer);
        const row = new St.BoxLayout({style_class: 'liland-message', height: MESSAGE_CONTENT_HEIGHT - 6});
        const iconBin = new St.Bin({
            style_class: 'liland-message-icon',
            child: new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 18}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'liland-texts'});
        texts.add_child(new St.Label({text: _('Nothing playing'), style_class: 'liland-message-title'}));
        texts.add_child(new St.Label({text: _('Play music in any app or browser'), style_class: 'liland-message-subtitle'}));
        this._messageAction = new St.Button({style_class: 'liland-message-button', y_align: Clutter.ActorAlign.CENTER, can_focus: false});
        this._messageAction.connect('clicked', () => {
            this._preferredApp?.activate();
            this._close();
        });
        row.add_child(iconBin);
        row.add_child(texts);
        row.add_child(this._messageAction);
        this._messageBox.add_child(row);
        this.add_child(this._messageBox);
    }

    // ---------- state ----------

    _computeMode() {
        const hasTrack = this.nowPlaying.track !== null;
        if (this.status === 'open')
            return hasTrack ? 'open' : 'message';
        return hasTrack && this.nowPlaying.isPlaying ? 'compact' : 'idle';
    }

    _contentFor(mode) {
        return {compact: this._compact, open: this._openBox, message: this._messageBox}[mode] ?? null;
    }

    _sync(initial = false) {
        const np = this.nowPlaying;
        const track = np.track;

        // Views' data.
        this._compactArt.setPath(np.artworkPath);
        this._openArt.setPath(np.artworkPath);
        this._titleLabel.text = track?.title ?? '';
        this._artistLabel.text = track?.artist ?? '';
        this._statusLabel.text = np.isPlaying ? _('Now Playing') : _('Paused');
        this._playBtn.icon.icon_name = np.isPlaying ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._setModeButton(this._shuffleBtn, np.isShuffling);
        const repeat = np.repeatMode;
        this._repeatBtn.icon.icon_name = repeat === 'one' ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._setModeButton(this._repeatBtn, repeat === null ? null : repeat !== 'off');
        this._trackFill.style = `background-color: ${rgbCss([1, 1, 1])};`;
        this._syncAppIcon();
        this._syncMessageAction();
        this._syncPlaying();

        const mode = this._computeMode();
        if (mode !== this.mode || initial) {
            const previous = this.mode;
            this.mode = mode;
            this._transition(previous, mode, !initial);
        }
        this._updateProgress();
        this._updateTicker();
    }

    _setModeButton(button, isOn) {
        button.reactive = isOn !== null;
        button.opacity = isOn === null ? 0 : 255;
        const color = isOn ? rgbCss(this.nowPlaying.accentColor) : 'rgba(255,255,255,0.5)';
        button.icon.style = `color: ${color};`;
    }

    _syncAppIcon() {
        const player = this.nowPlaying.activePlayer;
        const app = this._appFor(player);
        if (app) {
            this._appButton.set_child(app.create_icon_texture(16));
            this._appButton.visible = true;
        } else {
            this._appButton.visible = false;
        }
    }

    _appFor(player) {
        if (!player?.desktopEntry)
            return null;
        const sys = Shell.AppSystem.get_default();
        return sys.lookup_app(`${player.desktopEntry}.desktop`) ??
            sys.lookup_app(`${player.desktopEntry.toLowerCase()}.desktop`) ?? null;
    }

    _syncMessageAction() {
        const sys = Shell.AppSystem.get_default();
        let app = null;
        for (const id of SPOTIFY_IDS) {
            app = sys.lookup_app(id);
            if (app)
                break;
        }
        if (!app) {
            for (const p of this.nowPlaying.players.values()) {
                app = this._appFor(p);
                if (app)
                    break;
            }
        }
        this._preferredApp = app;
        this._messageAction.visible = Boolean(app);
        if (app)
            this._messageAction.label = _('Open %s').replace('%s', app.get_name());
    }

    _raisePlayer() {
        const player = this.nowPlaying.activePlayer;
        const app = this._appFor(player);
        if (app)
            app.activate();
        else
            player?.raise();
    }

    _syncPlaying() {
        const playing = this.nowPlaying.isPlaying;
        const target = playing ? 1 : 0;
        if (this._playTarget === target)
            return;
        this._playTarget = target;
        this._playFrom = this.playFactor;
        this._playStart = GLib.get_monotonic_time();
        this._levels.follow(playing);
    }

    _transition(from, to, animate) {
        if (from === 'open' && to !== 'open')
            this._endDrag(false);
        const oldContent = this._contentFor(from);
        const newContent = this._contentFor(to);
        const notchH = this._notchHeight;
        this._header.height = notchH;
        this._messageSpacer.height = notchH;
        this._compact.height = notchH;
        const topR = (RADII[to] ?? RADII.idle)[0];
        this._compact.style = `padding: 0 ${10 + topR}px;`;

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
                        if (this._contentFor(this.mode) !== oldContent)
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
                if (to !== 'compact') {
                    newContent.scale_x = newContent.scale_y = 0.85;
                }
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

        // Without a physical notch, the idle island is invisible (like Liland on Macs without a notch).
        this._bg.remove_all_transitions();
        this._bg.ease({
            opacity: to === 'idle' ? 0 : 255,
            duration: animate ? 250 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._applyGeometry(animate);
    }

    // ---------- progress ----------

    _updateProgress() {
        if (this.mode !== 'open')
            return;
        const np = this.nowPlaying;
        const duration = np.track?.duration ?? 0;
        const position = this._dragFraction !== undefined ? this._dragFraction * duration : np.elapsed();
        this._elapsedLabel.text = formatTime(position);
        const hasDuration = duration > 0;
        this._remainingLabel.visible = hasDuration;
        this._liveLabel.visible = !hasDuration;
        this._trackFill.visible = hasDuration;
        this._track.reactive = hasDuration && np.activePlayer?.snapshot?.canSeek !== false;
        if (!hasDuration)
            return;
        this._remainingLabel.text = `-${formatTime(duration - position)}`;
        const width = this._track.width;
        if (width > 0)
            this._trackFill.width = Math.max(0, Math.round(width * clamp01(position / duration)));
        const barH = this._dragFraction !== undefined ? 6 : 4;
        this._trackBg.height = barH;
        this._trackFill.height = barH;
    }

    _fractionAt(x) {
        const [tx] = this._track.get_transformed_position();
        return clamp01((x - tx) / Math.max(1, this._track.width));
    }

    _beginDrag(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._dragId)
            return Clutter.EVENT_PROPAGATE;
        const [x] = event.get_coords();
        this._isInteracting = true;
        this._dragFraction = this._fractionAt(x);
        this._updateProgress();
        this._dragId = global.stage.connect('captured-event', (_s, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                // The release went somewhere else (overview, lock screen,
                // another grab): drop the drag without seeking.
                if (!(ev.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                    this._endDrag();
                    return Clutter.EVENT_PROPAGATE;
                }
                this._dragFraction = this._fractionAt(ev.get_coords()[0]);
                this._updateProgress();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE && ev.get_button() === Clutter.BUTTON_PRIMARY) {
                const fraction = this._fractionAt(ev.get_coords()[0]);
                const duration = this.nowPlaying.track?.duration ?? 0;
                this.nowPlaying.seek(fraction * duration);
                this._endDrag();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._overviewId = Main.overview.connect('showing', () => this._endDrag());
        return Clutter.EVENT_STOP;
    }

    _endDrag(checkHover = true) {
        if (!this._dragId)
            return;
        global.stage.disconnect(this._dragId);
        this._dragId = 0;
        Main.overview.disconnect(this._overviewId);
        this._overviewId = 0;
        this._dragFraction = undefined;
        this._isInteracting = false;
        this._updateProgress();
        if (checkHover)
            this._handleHover();
    }

    // ---------- animation ticker (equalizers + progress) ----------

    _needsTicker() {
        return this.mode !== 'idle' && (this._playTarget === 1 || this.playFactor > 0.001 || this.mode === 'open');
    }

    _updateTicker() {
        const needs = this._needsTicker();
        if (needs && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._tick());
        } else if (!needs) {
            if (this._tickId)
                GLib.source_remove(this._tickId);
            this._tickId = 0;
            // Nothing animates the bars anymore: land on the target so the
            // next play/pause eases from the right place.
            this.playFactor = this._playTarget ?? 0;
        }
    }

    _tick() {
        const elapsed = (GLib.get_monotonic_time() - (this._playStart ?? 0)) / 1e6;
        const t = clamp01(elapsed / 0.5);
        const eased = 1 - Math.pow(1 - t, 3);
        this.playFactor = lerp(this._playFrom ?? 0, this._playTarget ?? 0, eased);
        if (this.mode === 'compact')
            this._compactEq.queue_repaint();
        if (this.mode === 'open') {
            this._openEq.queue_repaint();
            this._progressCounter = ((this._progressCounter ?? 0) + 1) % 15;
            if (this._progressCounter === 0 || this._dragFraction !== undefined)
                this._updateProgress();
        }
        if (this._needsTicker())
            return GLib.SOURCE_CONTINUE;
        this._tickId = 0;
        this.playFactor = this._playTarget ?? 0;
        return GLib.SOURCE_REMOVE;
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

    _handleHover() {
        const hover = this.hover;
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
        } else if (!this._isInteracting && !this._isPeeking) {
            this._scheduleClose();
        }
    }

    _scheduleClose() {
        this._later('close', CLOSE_DELAY, () => {
            if (this.hover || this._isInteracting || this._isPeeking)
                return;
            if (this._pointerNear(10)) {
                this._scheduleClose();
                return;
            }
            this._close();
        });
    }

    _open() {
        this._cancel('close');
        if (this.status !== 'closed')
            return;
        this.status = 'open';
        this.nowPlaying.refresh();
        this._sync();
        this._handleHover();
    }

    _close() {
        this._cancel('open');
        this._endPeek();
        if (this.status === 'closed')
            return;
        this.status = 'closed';
        this._sync();
    }

    _peek() {
        if (!this._settings.get_boolean('peek-on-track-change') || this.status !== 'closed')
            return;
        this._isPeeking = true;
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
        for (const name of Object.keys(this._timeouts))
            this._cancel(name);
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._endDrag(false);
        for (const [obj, id] of this._panelSignals)
            obj.disconnect(id);
        this.nowPlaying.disconnect(this._npChangedId);
        this.nowPlaying.disconnect(this._npTrackId);
        this._levels.disconnect(this._levelsId);
        this._levels.disconnect(this._levelsStopId);
        Main.layoutManager.disconnect(this._monitorsId);
        super.destroy();
    }
});
