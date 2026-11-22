// Runs levels.py (only while music is playing and the option is on) and
// forwards the 6 band levels it prints.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const STOP_GRACE_MS = 2000;

export class LiveLevels extends EventEmitter {
    constructor(dir, settings) {
        super();
        this._script = GLib.build_filenamev([dir, 'levels.py']);
        this._settings = settings;
        this._playing = false;
        this._proc = null;
        this._settingsId = settings.connect('changed::equalizer-follows-music', () => this._apply());
    }

    follow(isPlaying) {
        this._playing = isPlaying;
        this._apply();
    }

    _apply() {
        const want = this._playing && this._settings.get_boolean('equalizer-follows-music');
        if (want) {
            if (this._stopId) {
                GLib.source_remove(this._stopId);
                this._stopId = 0;
            }
            this._start();
        } else if (this._proc && !this._stopId) {
            // Keep it briefly so pause/skip doesn't restart the helper.
            const grace = this._settings.get_boolean('equalizer-follows-music') ? STOP_GRACE_MS : 0;
            this._stopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, grace, () => {
                this._stopId = 0;
                this._stop();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _start() {
        if (this._proc)
            return;
        try {
            this._proc = Gio.Subprocess.new(['python3', '-I', this._script],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Liland: could not start levels helper: ${e.message}`);
            this._proc = null;
            return;
        }
        const proc = this._proc;
        this._cancellable = new Gio.Cancellable();
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const read = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                let line;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch (_e) {
                    line = null;
                }
                if (line === null) {
                    if (this._proc === proc)
                        this._stop();
                    return;
                }
                const values = line.split(' ').map(Number);
                if (values.length === 6)
                    this.emit('levels', values);
                read();
            });
        };
        read();
    }

    _stop() {
        if (!this._proc)
            return;
        this._cancellable?.cancel();
        try {
            this._proc.get_stdin_pipe()?.close(null);
        } catch (_e) {}
        this._proc.force_exit();
        this._proc = null;
        this.emit('stopped');
    }

    destroy() {
        if (this._stopId)
            GLib.source_remove(this._stopId);
        this._stopId = 0;
        this._settings.disconnect(this._settingsId);
        this._stop();
        this.disconnectAll();
    }
}
