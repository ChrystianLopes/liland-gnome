// Reads "now playing" from every MPRIS player on the session bus
// (Spotify, Firefox, Chrome, VLC, Rhythmbox, Deezer web, YouTube...).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';

const nowSeconds = () => GLib.get_monotonic_time() / 1e6;

function unpack(variant) {
    return variant ? variant.recursiveUnpack() : undefined;
}

class Player extends EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        this.id = busName;
        this.snapshot = null;
        this.identity = busName.slice(MPRIS_PREFIX.length).split('.')[0];
        this.desktopEntry = null;
        this._position = 0;
        this._positionTime = nowSeconds();
        this._cancellable = new Gio.Cancellable();
        this._init();
    }

    async _init() {
        try {
            this._root = await this._makeProxy(ROOT_IFACE);
            this._proxy = await this._makeProxy(PLAYER_IFACE);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Liland: could not connect to ${this.busName}: ${e.message}`);
            return;
        }
        this.identity = unpack(this._root.get_cached_property('Identity')) ?? this.identity;
        this.desktopEntry = unpack(this._root.get_cached_property('DesktopEntry')) ?? null;
        this._propsId = this._proxy.connect('g-properties-changed', (_p, changed) => {
            const keys = Object.keys(unpack(changed) ?? {});
            const trackChanged = keys.includes('Metadata');
            const statusChanged = keys.includes('PlaybackStatus') || keys.includes('Rate');
            this._rebuild();
            if (trackChanged || statusChanged)
                this.refreshPosition();
        });
        this._signalId = this._proxy.connect('g-signal', (_p, _sender, name, params) => {
            if (name === 'Seeked') {
                this._setPosition(Number(unpack(params)[0]) / 1e6);
                this.emit('changed');
            }
        });
        this._rebuild();
        this.refreshPosition();
    }

    _makeProxy(iface) {
        return new Promise((resolve, reject) => {
            Gio.DBusProxy.new(Gio.DBus.session, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, null,
                this.busName, MPRIS_PATH, iface, this._cancellable, (_o, res) => {
                    try {
                        resolve(Gio.DBusProxy.new_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _prop(name) {
        return unpack(this._proxy?.get_cached_property(name));
    }

    _rebuild() {
        const meta = this._prop('Metadata') ?? {};
        const status = this._prop('PlaybackStatus');
        const title = meta['xesam:title'];
        if (!title) {
            this.snapshot = null;
            this.emit('changed');
            return;
        }
        let artist = meta['xesam:artist'];
        if (Array.isArray(artist))
            artist = artist.join(', ');
        const length = Number(meta['mpris:length'] ?? 0) / 1e6;
        const shuffle = this._prop('Shuffle');
        const loop = this._prop('LoopStatus');
        const trackId = meta['mpris:trackid'] ?? null;
        this.snapshot = {
            track: {
                id: `${trackId ?? ''}|${title}|${artist ?? ''}|${meta['xesam:album'] ?? ''}`,
                trackId,
                title,
                artist: artist ?? '',
                album: meta['xesam:album'] ?? '',
                artUrl: meta['mpris:artUrl'] ?? null,
                url: meta['xesam:url'] ?? null,
                duration: length > 0 ? length : 0,
            },
            isPlaying: status === 'Playing',
            isShuffling: typeof shuffle === 'boolean' ? shuffle : null,
            repeatMode: typeof loop === 'string' ? {None: 'off', Playlist: 'all', Track: 'one'}[loop] ?? 'off' : null,
            rate: Number(this._prop('Rate') ?? 1) || 1,
            canSeek: this._prop('CanSeek') !== false,
        };
        this.emit('changed');
    }

    _setPosition(seconds) {
        this._position = seconds;
        this._positionTime = nowSeconds();
    }

    refreshPosition() {
        if (!this._proxy)
            return;
        Gio.DBus.session.call(this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']), null,
            Gio.DBusCallFlags.NONE, 1000, this._cancellable, (conn, res) => {
                try {
                    const [value] = unpack(conn.call_finish(res));
                    this._setPosition(Number(value) / 1e6);
                    this.emit('changed');
                } catch (_e) {
                    // Some players don't report a position; that's fine.
                }
            });
    }

    elapsed() {
        const snap = this.snapshot;
        if (!snap)
            return 0;
        let position = this._position;
        if (snap.isPlaying)
            position += (nowSeconds() - this._positionTime) * snap.rate;
        if (snap.track.duration > 0)
            position = Math.min(position, snap.track.duration);
        return Math.max(0, position);
    }

    _call(method, args = null) {
        this._proxy?.call(method, args, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _set(name, variant) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, name, variant]), null,
            Gio.DBusCallFlags.NONE, -1, null, null);
    }

    playPause() { this._call('PlayPause'); }
    next() { this._call('Next'); }
    previous() { this._call('Previous'); }

    seek(seconds) {
        const snap = this.snapshot;
        if (!snap)
            return;
        const us = Math.round(seconds * 1e6);
        if (snap.track.trackId && snap.track.trackId.startsWith('/'))
            this._call('SetPosition', new GLib.Variant('(ox)', [snap.track.trackId, us]));
        else
            this._call('Seek', new GLib.Variant('(x)', [Math.round(us - this.elapsed() * 1e6)]));
        this._setPosition(seconds);
        this.emit('changed');
    }

    toggleShuffle() {
        if (this.snapshot?.isShuffling === null)
            return;
        this._set('Shuffle', new GLib.Variant('b', !this.snapshot.isShuffling));
    }

    cycleRepeat() {
        const next = {off: 'Playlist', all: 'Track', one: 'None'}[this.snapshot?.repeatMode];
        if (next)
            this._set('LoopStatus', new GLib.Variant('s', next));
    }

    raise() {
        this._root?.call('Raise', null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy) {
            this._proxy.disconnect(this._propsId);
            this._proxy.disconnect(this._signalId);
        }
        this.disconnectAll();
    }
}

export class NowPlaying extends EventEmitter {
    constructor() {
        super();
        this.players = new Map();
        this.activePlayer = null;
        this.artworkPath = null;
        this.accentColor = NowPlaying.defaultAccent;
        this._lastSeen = new Map();
        this._lastActivity = new Map();
        this._artworkKey = null;
        this._startTime = nowSeconds();
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 10});
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'liland', 'art']);
        GLib.mkdir_with_parents(this._cacheDir, 0o700);

        this._ownerId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {
                    console.warn(`Liland: ListNames failed: ${e.message}`);
                }
            });
    }

    static get defaultAccent() {
        return [0.12, 0.84, 0.38];
    }

    get track() { return this.activePlayer?.snapshot?.track ?? null; }
    get isPlaying() { return this.activePlayer?.snapshot?.isPlaying ?? false; }
    get isShuffling() { return this.activePlayer?.snapshot?.isShuffling ?? null; }
    get repeatMode() { return this.activePlayer?.snapshot?.repeatMode ?? null; }
    elapsed() { return this.activePlayer?.elapsed() ?? 0; }

    playPause() { this.activePlayer?.playPause(); }
    next() { this.activePlayer?.next(); }
    previous() { this.activePlayer?.previous(); }
    seek(s) { this.activePlayer?.seek(s); }
    toggleShuffle() { this.activePlayer?.toggleShuffle(); }
    cycleRepeat() { this.activePlayer?.cycleRepeat(); }
    refresh() { this.activePlayer?.refreshPosition(); }

    _addPlayer(name) {
        if (this.players.has(name))
            return;
        const player = new Player(name);
        player.connect('changed', () => this._update());
        this.players.set(name, player);
    }

    _removePlayer(name) {
        const player = this.players.get(name);
        if (!player)
            return;
        player.destroy();
        this.players.delete(name);
        this._lastSeen.delete(name);
        this._update();
    }

    _mostRecent(candidates) {
        let best = null;
        let bestTime = -Infinity;
        for (const p of candidates) {
            const t = this._lastActivity.get(p.id) ?? -Infinity;
            if (best === null || t > bestTime) {
                best = p;
                bestTime = t;
            }
        }
        return best;
    }

    _update() {
        const now = nowSeconds();
        for (const p of this.players.values()) {
            const seen = `${p.snapshot?.track.id ?? ''}|${p.snapshot?.isPlaying ?? false}`;
            if (p.snapshot?.isPlaying && seen !== this._lastSeen.get(p.id))
                this._lastActivity.set(p.id, now);
            this._lastSeen.set(p.id, seen);
        }
        const available = [...this.players.values()].filter(p => p.snapshot);
        this.activePlayer = this._mostRecent(available.filter(p => p.snapshot.isPlaying)) ??
            this._mostRecent(available);

        const snap = this.activePlayer?.snapshot;
        const key = snap ? `${this.activePlayer.id}|${snap.track.id}` : null;
        if (key !== this._artworkKey) {
            const isSongChange = this._artworkKey !== null || now - this._startTime > 3;
            this._artworkKey = key;
            this._loadArtwork(key, isSongChange && key !== null);
        } else if (snap && !this.artworkPath && snap.track.artUrl && !this._loadingArtwork) {
            // Some players publish the cover a moment after the title.
            this._loadArtwork(key, false);
        }
        this.emit('changed');
    }

    async _loadArtwork(key, announce) {
        this.artworkPath = null;
        this.accentColor = NowPlaying.defaultAccent;
        const url = this.activePlayer?.snapshot?.track.artUrl;
        let path = null;
        this._loadingArtwork = Boolean(url);
        if (url) {
            try {
                path = await this._fetchArtwork(url);
            } catch (e) {
                console.debug(`Liland: artwork failed: ${e.message}`);
            }
        }
        this._loadingArtwork = false;
        if (this._artworkKey !== key)
            return;
        this.artworkPath = path;
        this.accentColor = (path && accentFor(path)) ?? NowPlaying.defaultAccent;
        this.emit('changed');
        if (announce)
            this.emit('track-changed');
    }

    _fetchArtwork(url) {
        if (url.startsWith('file://')) {
            const path = Gio.File.new_for_uri(url).get_path();
            return Promise.resolve(GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null);
        }
        if (url.startsWith('/'))
            return Promise.resolve(url);
        if (!/^https?:\/\//.test(url))
            return Promise.resolve(null);
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const path = GLib.build_filenamev([this._cacheDir, hash]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return Promise.resolve(path);
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    if (message.get_status() !== Soup.Status.OK)
                        throw new Error(`HTTP ${message.get_status()}`);
                    GLib.file_set_contents(path, bytes.get_data());
                    this._pruneCache();
                    resolve(path);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _pruneCache() {
        // Keep only the 60 most recent covers.
        try {
            const dir = Gio.File.new_for_path(this._cacheDir);
            const en = dir.enumerate_children('standard::name,time::modified', 0, null);
            const files = [];
            let info;
            while ((info = en.next_file(null)))
                files.push([info.get_modification_date_time()?.to_unix() ?? 0, info.get_name()]);
            files.sort((a, b) => b[0] - a[0]);
            for (const [, name] of files.slice(60))
                dir.get_child(name).delete(null);
        } catch (_e) {}
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        for (const p of this.players.values())
            p.destroy();
        this.players.clear();
        this.disconnectAll();
    }
}

// Port of Liland's ArtworkColor: a vivid accent color taken from the cover.
function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
        if (h < 0) h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

function accentFor(path) {
    let pixbuf;
    try {
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, false);
    } catch (_e) {
        return null;
    }
    const n = pixbuf.get_n_channels(), stride = pixbuf.get_rowstride();
    const pixels = pixbuf.get_pixels();
    const samples = [];
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const o = y * stride + x * n;
            const rgb = [pixels[o] / 255, pixels[o + 1] / 255, pixels[o + 2] / 255];
            const [, s, v] = rgbToHsv(...rgb);
            if (v <= 0.2)
                continue;
            samples.push([s * 0.7 + v * 0.3, rgb]);
        }
    }
    if (!samples.length)
        return null;
    samples.sort((a, b) => b[0] - a[0]);
    const vivid = samples.slice(0, Math.max(1, Math.floor(samples.length / 4)));
    const avg = [0, 1, 2].map(i => vivid.reduce((acc, [, c]) => acc + c[i], 0) / vivid.length);
    const [h, s, v] = rgbToHsv(...avg);
    if (s <= 0.12)
        return [0.88, 0.88, 0.88];
    return hsvToRgb(h, Math.min(Math.max(s, 0.4), 0.9), Math.max(v, 0.8));
}
