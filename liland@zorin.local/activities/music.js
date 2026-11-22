// The music player shown by the island: the compact pill (artwork +
// equalizer), the open player and the "nothing playing" message. The island
// decides which one is shown and where; this class owns their contents.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_} from '../i18n.js';

export const OPEN_CONTENT_HEIGHT = 140;
export const MESSAGE_CONTENT_HEIGHT = 70;

const SPOTIFY_IDS = ['spotify.desktop', 'spotify_spotify.desktop', 'com.spotify.Client.desktop'];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.min(Math.max(v, 0), 1);
const rgbCss = ([r, g, b], a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const EqualizerView = GObject.registerClass(
class LilandEqualizer extends St.DrawingArea {
    static RESTING = [0.69, 0.2, 0.56, 0.74, 0.75, 0.63];
    static SPEEDS = [5.1, 6.7, 4.3, 7.9, 5.6, 6.1];
    static PHASES = [0, 1.3, 2.6, 0.7, 2.1, 3.4];

    _init(width, height, player) {
        super._init({width, height, y_align: Clutter.ActorAlign.CENTER});
        this._player = player;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const player = this._player;
        const live = player.liveLevels;
        const time = GLib.get_monotonic_time() / 1e6;
        const playFactor = player.playFactor;
        const count = 6, gap = 0.65;
        const barW = w / (count + (count - 1) * gap);
        const [r, g, b] = player.nowPlaying.accentColor;
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

export function controlButton(iconName, size, onClick) {
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

export const MusicPlayer = GObject.registerClass({
    Signals: {
        // A seek drag ended: the island checks the pointer again.
        'interaction-ended': {},
        // The "Open <app>" button of the empty message was used.
        'app-launched': {},
    },
}, class LilandMusicPlayer extends GObject.Object {
    // openWidth / emptyWidth: inner widths of the open player and the
    // "nothing playing" message.
    _init(nowPlaying, levels, {openWidth, emptyWidth}) {
        super._init();
        this.nowPlaying = nowPlaying;
        this._levels = levels;
        this.playFactor = 0;
        this.liveLevels = null;
        this.isInteracting = false;
        this._mode = null;

        this._buildCompact();
        this._buildOpen(openWidth);
        this._buildEmpty(emptyWidth);

        this._levelsId = levels.connect('levels', (_l, values) => {
            this.liveLevels = values;
        });
        this._levelsStopId = levels.connect('stopped', () => {
            this.liveLevels = null;
        });
    }

    // ---------- views ----------

    _buildCompact() {
        this.compactActor = new St.BoxLayout({
            style_class: 'liland-compact',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._compactArt = new ArtworkView(20, 5);
        this._compactEq = new EqualizerView(18, 14, this);
        this.compactActor.add_child(this._compactArt);
        this.compactActor.add_child(new St.Widget({x_expand: true}));
        this.compactActor.add_child(this._compactEq);
    }

    _buildOpen(innerWidth) {
        this.openActor = new St.BoxLayout({
            vertical: true,
            width: innerWidth,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this.openActor.set_pivot_point(0.5, 0);

        // Header: "Now Playing" + app icon.
        const header = new St.BoxLayout({style_class: 'liland-header'});
        this._statusLabel = new St.Label({style_class: 'liland-status', y_align: Clutter.ActorAlign.CENTER});
        this._appButton = new St.Button({style_class: 'liland-app-button', y_align: Clutter.ActorAlign.CENTER, can_focus: false});
        this._appButton.connect('clicked', () => this._raisePlayer());
        header.add_child(this._statusLabel);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._appButton);
        this._header = header;
        this.openActor.add_child(header);

        const body = new St.BoxLayout({vertical: true, style_class: 'liland-body'});
        this.openActor.add_child(body);

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
    }

    _buildEmpty(innerWidth) {
        this.emptyActor = new St.BoxLayout({
            vertical: true,
            width: innerWidth,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this.emptyActor.set_pivot_point(0.5, 0);
        this._emptySpacer = new St.Widget();
        this.emptyActor.add_child(this._emptySpacer);
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
            this.emit('app-launched');
        });
        row.add_child(iconBin);
        row.add_child(texts);
        row.add_child(this._messageAction);
        this.emptyActor.add_child(row);
    }

    // ---------- layout (set by the island) ----------

    // The first `height` pixels of each view sit at the top bar's height.
    setNotchHeight(height) {
        this._header.height = height;
        this._emptySpacer.height = height;
        this.compactActor.height = height;
    }

    // Keep the open player's header inside the top part of the island and,
    // on the right, clear of whatever the island puts there (tab buttons).
    setHeaderInsets(left, right) {
        this._header.margin_left = left;
        this._header.margin_right = right;
    }

    setCompactPadding(px) {
        this.compactActor.style = `padding: 0 ${px}px;`;
    }

    // The island's mode changed ('compact', 'open', 'message', or anything
    // else when no music view is shown).
    setMode(mode) {
        if (this._mode === 'open' && mode !== 'open')
            this._endDrag(false);
        this._mode = mode;
        this._updateProgress();
        this._updateTicker();
    }

    // ---------- data ----------

    sync() {
        const np = this.nowPlaying;
        const track = np.track;
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

    // ---------- progress ----------

    _updateProgress() {
        if (this._mode !== 'open')
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
        this.isInteracting = true;
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

    _endDrag(notify = true) {
        if (!this._dragId)
            return;
        global.stage.disconnect(this._dragId);
        this._dragId = 0;
        Main.overview.disconnect(this._overviewId);
        this._overviewId = 0;
        this._dragFraction = undefined;
        this.isInteracting = false;
        this._updateProgress();
        if (notify)
            this.emit('interaction-ended');
    }

    // ---------- animation ticker (equalizers + progress) ----------

    _needsTicker() {
        const shown = this._mode === 'compact' || this._mode === 'open';
        return shown && (this._playTarget === 1 || this.playFactor > 0.001 || this._mode === 'open');
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
        if (this._mode === 'compact')
            this._compactEq.queue_repaint();
        if (this._mode === 'open') {
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

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._endDrag(false);
        this._levels.disconnect(this._levelsId);
        this._levels.disconnect(this._levelsStopId);
        // The actors belong to the island, which destroys them.
    }
});
