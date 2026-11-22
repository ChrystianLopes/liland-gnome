// Clipboard history in the island (instead of the clipboard-indicator
// extension), in the island's design.
//
// - Copies are seen through the display's selection ('owner-changed' for the
//   CLIPBOARD selection) and read with St.Clipboard: text and images. Nothing
//   is kept while private mode is on, when the focused window belongs to an
//   excluded app (password managers...), or when the copy is our own.
// - The history (texts, image files, favorites) lives in
//   ~/.cache/liland/clipboard, readable only by the user (0700 / 0600).
// - Picking an entry puts it back on the clipboard and pastes it into the
//   focused app (Shift+Insert, Ctrl+Shift+Insert in terminals).
// - The history of clipboard-indicator is imported once.
// - It's a button of the top bar (so in the island's tray), whose menu the
//   island shows inside itself; Super+V opens it, Ctrl+F8 toggles private
//   mode. While clipboard-indicator is enabled, all of this stays off.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {_} from './i18n.js';

const LEGACY_UUID = 'clipboard-indicator@tudmotu.com';
const HISTORY_SIZE = 50;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const SAVE_DELAY = 400;
const PASTE_DELAY = 120;
const CLEAR_CONFIRM_MS = 3000;
const TEXT_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ExtensionState = {ENABLED: 1};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function checksum(bytes) {
    return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
}

// Writes a file readable only by the user, atomically.
function writePrivate(path, data) {
    Gio.File.new_for_path(path).replace_contents(data, null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function readBytes(path) {
    const [, contents] = Gio.File.new_for_path(path).load_contents(null);
    return contents;
}

function fileSize(path) {
    try {
        return Gio.File.new_for_path(path).query_info('standard::size', 0, null).get_size();
    } catch (_e) {
        return -1;
    }
}

// One line to show for a text entry.
function preview(text) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function relativeTime(seconds) {
    const ago = Math.max(0, GLib.get_real_time() / 1e6 - seconds);
    if (ago < 60)
        return _('now');
    if (ago < 3600)
        return _('%d min ago').replace('%d', Math.floor(ago / 60));
    if (ago < 86400)
        return _('%d h ago').replace('%d', Math.floor(ago / 3600));
    return GLib.DateTime.new_from_unix_local(Math.floor(seconds)).format('%d/%m');
}

// ---------- the history, on disk ----------

class ClipboardStore {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this.dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'liland', 'clipboard']);
        GLib.mkdir_with_parents(this.dir, 0o700);
        Gio.File.new_for_path(this.dir).set_attribute_uint32('unix::mode', 0o700,
            Gio.FileQueryInfoFlags.NONE, null);
        this._path = GLib.build_filenamev([this.dir, 'history.json']);
        this.entries = [];
        this._saveId = 0;
        this._load();
    }

    _imagePath(name) {
        return GLib.build_filenamev([this.dir, name]);
    }

    _load() {
        let list = [];
        try {
            list = JSON.parse(decoder.decode(readBytes(this._path)));
        } catch (_e) {
            return;
        }
        if (!Array.isArray(list))
            return;
        this.entries = list.filter(e =>
            e && typeof e.hash === 'string' && typeof e.time === 'number' &&
            ((e.kind === 'text' && typeof e.text === 'string') ||
             (e.kind === 'image' && typeof e.file === 'string' && /^[0-9a-f]{64}$/.test(e.file) &&
              GLib.file_test(this._imagePath(e.file), GLib.FileTest.EXISTS))))
            .map(e => ({...e, favorite: Boolean(e.favorite)}));
    }

    _save() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
            this._saveId = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    flush() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        try {
            writePrivate(this._path, encoder.encode(JSON.stringify(this.entries)));
        } catch (e) {
            console.warn(`Liland: could not save the clipboard history: ${e.message}`);
        }
    }

    _changed() {
        this._save();
        this._onChanged();
    }

    get(id) {
        return this.entries.find(e => e.hash === id) ?? null;
    }

    // Newest first. An entry already there moves to the top.
    addText(text, mimetype, {time = null, favorite = false, notify = true} = {}) {
        if (!text.trim())
            return;
        text = text.slice(0, MAX_TEXT_CHARS);
        const hash = checksum(encoder.encode(text));
        this._insert({kind: 'text', text, mimetype, hash, favorite, time: time ?? GLib.get_real_time() / 1e6}, notify);
    }

    addImage(bytes, mimetype, {time = null, favorite = false, notify = true} = {}) {
        const size = bytes.get_size?.() ?? bytes.length;
        if (!size || size > MAX_IMAGE_BYTES)
            return;
        const data = bytes.toArray?.() ?? bytes;
        const hash = checksum(data);
        if (!this.get(hash)) {
            try {
                writePrivate(this._imagePath(hash), data);
            } catch (e) {
                console.warn(`Liland: could not save a clipboard image: ${e.message}`);
                return;
            }
        }
        this._insert({kind: 'image', file: hash, mimetype, hash, favorite, time: time ?? GLib.get_real_time() / 1e6}, notify);
    }

    _insert(entry, notify) {
        const existing = this.get(entry.hash);
        if (existing) {
            entry.favorite ||= existing.favorite;
            this.entries = this.entries.filter(e => e !== existing);
        }
        this.entries.unshift(entry);
        this._trim();
        if (notify)
            this._changed();
    }

    // Favorites never fall out of the history.
    _trim() {
        let kept = 0;
        const removed = [];
        this.entries = this.entries.filter(e => {
            if (e.favorite)
                return true;
            kept++;
            if (kept <= HISTORY_SIZE)
                return true;
            removed.push(e);
            return false;
        });
        removed.forEach(e => this._deleteFile(e));
    }

    _deleteFile(entry) {
        if (entry.kind !== 'image' || this.entries.some(e => e.file === entry.file))
            return;
        try {
            Gio.File.new_for_path(this._imagePath(entry.file)).delete(null);
        } catch (_e) {}
    }

    moveToTop(id) {
        const entry = this.get(id);
        if (!entry)
            return;
        this.entries = [entry, ...this.entries.filter(e => e !== entry)];
        entry.time = GLib.get_real_time() / 1e6;
        this._changed();
    }

    toggleFavorite(id) {
        const entry = this.get(id);
        if (!entry)
            return;
        entry.favorite = !entry.favorite;
        this._trim();
        this._changed();
    }

    remove(id) {
        const entry = this.get(id);
        if (!entry)
            return;
        this.entries = this.entries.filter(e => e !== entry);
        this._deleteFile(entry);
        this._changed();
    }

    // Favorites stay.
    clear() {
        const removed = this.entries.filter(e => !e.favorite);
        this.entries = this.entries.filter(e => e.favorite);
        removed.forEach(e => this._deleteFile(e));
        this._changed();
    }

    imagePath(entry) {
        return this._imagePath(entry.file);
    }

    // clipboard-indicator's history: ~/.cache/<its uuid>/registry.txt, a JSON
    // list (oldest first) of {contents, mimetype, favorite}; images are files
    // in that folder, named in `contents`. Only files inside it are read.
    importLegacy() {
        const legacyDir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), LEGACY_UUID]));
        let list;
        try {
            list = JSON.parse(decoder.decode(readBytes(legacyDir.get_child('registry.txt').get_path())));
        } catch (_e) {
            return 0;
        }
        if (!Array.isArray(list))
            return 0;
        let count = 0;
        const now = GLib.get_real_time() / 1e6;
        list.forEach((item, index) => {
            if (!item || typeof item.mimetype !== 'string' || typeof item.contents !== 'string')
                return;
            // Oldest first: give them increasing times, a second apart.
            const options = {favorite: Boolean(item.favorite), notify: false, time: now - (list.length - index)};
            if (IMAGE_TYPES.includes(item.mimetype) || item.mimetype.startsWith('image/')) {
                const file = Gio.File.new_for_path(item.contents);
                const parent = file.get_parent();
                if (!parent?.equal(legacyDir))
                    return;
                const size = fileSize(file.get_path());
                if (size <= 0 || size > MAX_IMAGE_BYTES)
                    return;
                try {
                    this.addImage(readBytes(file.get_path()), item.mimetype, options);
                    count++;
                } catch (_e) {}
            } else {
                this.addText(item.contents, item.mimetype, options);
                count++;
            }
        });
        this._changed();
        return count;
    }

    destroy() {
        this.flush();
    }
}

// ---------- the view (the menu's content) ----------

class ClipboardView {
    constructor(service) {
        this._service = service;
        this._selected = 0;
        this._clearArmedId = 0;

        this.actor = new St.BoxLayout({style_class: 'liland-clip', vertical: true});

        const header = new St.BoxLayout({style_class: 'liland-clip-header'});
        header.add_child(new St.Label({text: _('Clipboard'), style_class: 'liland-clip-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._privateButton = this._headerButton('view-reveal-symbolic', _('Private Mode'), () => service.togglePrivate());
        this._clearButton = this._headerButton('user-trash-symbolic', _('Clear History'), () => this._clear());
        header.add_child(this._privateButton);
        header.add_child(this._clearButton);
        this.actor.add_child(header);

        this.entry = new St.Entry({
            style_class: 'liland-clip-search',
            hint_text: _('Search'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'liland-clip-search-icon'}),
        });
        this.entry.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this.refresh();
        });
        this.entry.clutter_text.connect('key-press-event', (_a, event) => this._key(event));
        this.actor.add_child(this.entry);

        this._status = new St.Label({style_class: 'liland-clip-status', x_align: Clutter.ActorAlign.CENTER});
        this._status.clutter_text.line_wrap = true;
        this.actor.add_child(this._status);

        this._list = new St.BoxLayout({vertical: true, style_class: 'liland-clip-list'});
        this._scroll = new St.ScrollView({
            style_class: 'liland-clip-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._scroll.set_child(this._list);
        this.actor.add_child(this._scroll);
    }

    _headerButton(iconName, label, fn) {
        const button = new St.Button({
            style_class: 'liland-clip-header-button',
            can_focus: true,
            accessible_name: label,
            child: new St.Icon({icon_name: iconName, icon_size: 15}),
        });
        button.connect('clicked', fn);
        return button;
    }

    get _visible() {
        const query = this.entry.get_text().trim().toLowerCase();
        const all = this._service.store.entries;
        const matches = query
            ? all.filter(e => e.kind === 'text' && e.text.toLowerCase().includes(query))
            : all;
        // Favorites first, then the rest, each newest first.
        return [...matches.filter(e => e.favorite), ...matches.filter(e => !e.favorite)];
    }

    reset() {
        this.entry.set_text('');
        this._selected = 0;
        this._disarmClear();
        this.refresh();
    }

    refresh() {
        const service = this._service;
        this._privateButton.child.icon_name = service.isPrivate ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
        this._privateButton.style_class = `liland-clip-header-button${service.isPrivate ? ' liland-clip-header-button-on' : ''}`;

        this._list.destroy_all_children();
        this._rows = [];
        const entries = this._visible;
        this._selected = Math.min(this._selected, Math.max(0, entries.length - 1));
        let section = null;
        entries.forEach((entry, index) => {
            const name = entry.favorite ? _('Favorites') : _('Recent');
            if (name !== section) {
                section = name;
                this._list.add_child(new St.Label({text: name, style_class: 'liland-clip-section'}));
            }
            const row = this._row(entry, index);
            this._rows.push(row);
            this._list.add_child(row);
        });
        this._syncSelection();

        let status = '';
        if (service.isPrivate)
            status = _('Private mode: copies aren’t being kept.');
        else if (!this._service.store.entries.length)
            status = _('Nothing copied yet.');
        else if (!entries.length)
            status = _('Nothing found.');
        this._status.text = status;
        this._status.visible = status !== '';
        this._scroll.visible = entries.length > 0;
    }

    _row(entry, index) {
        const box = new St.BoxLayout({style_class: 'liland-clip-row-box', x_expand: true});
        if (entry.kind === 'image') {
            const uri = Gio.File.new_for_path(this._service.store.imagePath(entry)).get_uri();
            box.add_child(new St.Bin({
                style_class: 'liland-clip-thumb',
                style: `background-image: url("${uri}"); background-size: cover;`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const text = new St.Label({
            text: entry.kind === 'image' ? _('Image') : preview(entry.text),
            style_class: 'liland-clip-text',
        });
        text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const meta = entry.kind === 'image'
            ? relativeTime(entry.time)
            : `${relativeTime(entry.time)} · ${_('%d characters').replace('%d', entry.text.length)}`;
        texts.add_child(text);
        texts.add_child(new St.Label({text: meta, style_class: 'liland-clip-meta'}));
        box.add_child(texts);

        const actions = new St.BoxLayout({style_class: 'liland-clip-actions', y_align: Clutter.ActorAlign.CENTER});
        const pin = this._rowButton(entry.favorite ? 'starred-symbolic' : 'non-starred-symbolic',
            entry.favorite ? _('Unpin') : _('Pin'), () => this._service.store.toggleFavorite(entry.hash));
        const del = this._rowButton('edit-delete-symbolic', _('Delete'), () => this._service.store.remove(entry.hash));
        actions.add_child(pin);
        actions.add_child(del);
        box.add_child(actions);

        const row = new St.Button({
            style_class: `liland-clip-row${entry.favorite ? ' liland-clip-row-favorite' : ''}`,
            can_focus: false,
            x_expand: true,
            child: box,
            track_hover: true,
        });
        row._entry = entry;
        row._actions = actions;
        row.connect('clicked', () => this._service.pick(entry.hash));
        row.connect('notify::hover', () => {
            if (row.hover) {
                this._selected = index;
                this._syncSelection();
            }
        });
        return row;
    }

    _rowButton(iconName, label, fn) {
        const button = new St.Button({
            style_class: 'liland-clip-row-button',
            can_focus: false,
            accessible_name: label,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
        });
        button.connect('clicked', () => {
            fn();
            return Clutter.EVENT_STOP;
        });
        return button;
    }

    _syncSelection() {
        (this._rows ?? []).forEach((row, i) => {
            const selected = i === this._selected;
            if (selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
            row._actions.opacity = selected ? 255 : 0;
        });
        const row = this._rows?.[this._selected];
        if (row)
            this._scrollTo(row);
    }

    _scrollTo(row) {
        const adjustment = this._scroll.vadjustment;
        const box = row.get_allocation_box();
        if (box.y1 < adjustment.value)
            adjustment.value = box.y1;
        else if (box.y2 > adjustment.value + adjustment.page_size)
            adjustment.value = box.y2 - adjustment.page_size;
    }

    _key(event) {
        const key = event.get_key_symbol();
        const rows = this._rows ?? [];
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            if (rows.length) {
                const step = key === Clutter.KEY_Down ? 1 : -1;
                this._selected = (this._selected + step + rows.length) % rows.length;
                this._syncSelection();
            }
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            const entry = rows[this._selected]?._entry;
            if (entry)
                this._service.pick(entry.hash);
            return Clutter.EVENT_STOP;
        }
        // Delete removes the selected entry (when the search is empty, so it
        // still edits the search otherwise).
        if (key === Clutter.KEY_Delete && !this.entry.get_text()) {
            const entry = rows[this._selected]?._entry;
            if (entry)
                this._service.store.remove(entry.hash);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // First click arms, second one (within a few seconds) clears.
    _clear() {
        if (this._clearArmedId) {
            this._disarmClear();
            this._service.store.clear();
            return;
        }
        this._clearButton.add_style_pseudo_class('armed');
        this._clearButton.accessible_name = _('Click again to clear');
        this._clearArmedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLEAR_CONFIRM_MS, () => {
            this._clearArmedId = 0;
            this._disarmClear();
            return GLib.SOURCE_REMOVE;
        });
    }

    _disarmClear() {
        if (this._clearArmedId)
            GLib.source_remove(this._clearArmedId);
        this._clearArmedId = 0;
        this._clearButton.remove_style_pseudo_class('armed');
        this._clearButton.accessible_name = _('Clear History');
    }

    destroy() {
        this._disarmClear();
        this.actor.destroy();
    }
}

// ---------- the service ----------

export class ClipboardService {
    constructor(settings) {
        this._settings = settings;
        this._active = false;
        this._settingsIds = [
            settings.connect('changed::clipboard-in-island', () => this._sync()),
            settings.connect('changed::clipboard-private', () => this._view?.refresh()),
        ];
        this._extensionsId = Main.extensionManager.connect('extension-state-changed', (_m, extension) => {
            if (extension.uuid === LEGACY_UUID)
                this._sync();
        });
        this._sync();
    }

    // clipboard-indicator still on: leave everything to it.
    get _legacyEnabled() {
        return Main.extensionManager.lookup(LEGACY_UUID)?.state === ExtensionState.ENABLED;
    }

    get isPrivate() {
        return this._settings.get_boolean('clipboard-private');
    }

    togglePrivate() {
        this._settings.set_boolean('clipboard-private', !this.isPrivate);
    }

    _sync() {
        const want = this._settings.get_boolean('clipboard-in-island') && !this._legacyEnabled;
        if (want && !this._active)
            this._start();
        else if (!want && this._active)
            this._stop();
    }

    _start() {
        this._active = true;
        this.store = new ClipboardStore(() => this._view?.refresh());
        if (!this._settings.get_boolean('clipboard-imported')) {
            this.store.importLegacy();
            this._importLegacyExcludedApps();
            this._settings.set_boolean('clipboard-imported', true);
        }

        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onCopy();
        });

        this._keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        // The button (in the island's tray) and its menu.
        this._button = new PanelMenu.Button(0.5, _('Clipboard'));
        this._button.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'}));
        this._view = new ClipboardView(this);
        this._button.menu.box.add_child(this._view.actor);
        this._button.menu.box.add_style_class_name('liland-clip-menu');
        this._menuId = this._button.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._view.reset();
            // Typing goes to the search right away.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._button?.menu.isOpen)
                    global.stage.set_key_focus(this._view.entry);
                return GLib.SOURCE_REMOVE;
            });
        });
        Main.panel.addToStatusArea('lilandClipboard', this._button, 0, 'right');

        for (const [key, fn] of [['clipboard-toggle', () => this.toggle()],
            ['clipboard-private-toggle', () => this.togglePrivate()]]) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, fn);
        }
    }

    _stop() {
        this._active = false;
        Main.wm.removeKeybinding('clipboard-toggle');
        Main.wm.removeKeybinding('clipboard-private-toggle');
        for (const name of ['_pasteId', '_ignoreId']) {
            if (this[name])
                GLib.source_remove(this[name]);
            this[name] = 0;
        }
        this._selection.disconnect(this._ownerId);
        this._button.menu.disconnect(this._menuId);
        this._view.destroy();
        this._view = null;
        this._button.destroy();
        this._button = null;
        this._keyboard.run_dispose();
        this._keyboard = null;
        this.store.destroy();
        this.store = null;
    }

    // Super+V: like the top bar's own shortcuts (the island opens on its
    // tray first when it replaces the top bar).
    toggle() {
        if (!this._button)
            return;
        if (this._button.menu.isOpen)
            this._button.menu.close();
        else
            Main.panel._toggleMenu(this._button);
    }

    _excluded() {
        const wmClass = global.display.focus_window?.get_wm_class() ?? '';
        const apps = this._settings.get_strv('clipboard-excluded-apps');
        return Boolean(wmClass) && apps.some(app => app.toLowerCase() === wmClass.toLowerCase());
    }

    _onCopy() {
        if (this._ignoreNext || this.isPrivate || this._excluded())
            return;
        const types = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        const image = IMAGE_TYPES.find(t => types.includes(t));
        const text = TEXT_TYPES.find(t => types.includes(t));
        const type = image ?? text;
        if (!type)
            return;
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD, type, (_c, bytes) => {
            if (!this.store || !bytes || bytes.get_size() === 0)
                return;
            if (image)
                this.store.addImage(bytes, type);
            else
                this.store.addText(decoder.decode(bytes.toArray()), 'text/plain;charset=utf-8');
        });
    }

    // Puts an entry back on the clipboard and pastes it into the app.
    pick(id) {
        const entry = this.store?.get(id);
        if (!entry)
            return;
        let bytes;
        try {
            bytes = entry.kind === 'image'
                ? new GLib.Bytes(readBytes(this.store.imagePath(entry)))
                : new GLib.Bytes(encoder.encode(entry.text));
        } catch (_e) {
            return;
        }
        // Our own copy: don't record it again (it just moves to the top).
        this._ignoreNext = true;
        if (this._ignoreId)
            GLib.source_remove(this._ignoreId);
        this._ignoreId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._ignoreId = 0;
            this._ignoreNext = false;
            return GLib.SOURCE_REMOVE;
        });
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD,
            entry.kind === 'image' ? entry.mimetype : 'text/plain;charset=utf-8', bytes);
        this.store.moveToTop(id);
        this._button.menu.close();

        // Paste once the app has the focus back.
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY, () => {
            this._pasteId = 0;
            this._paste();
            return GLib.SOURCE_REMOVE;
        });
    }

    _paste() {
        if (!this._keyboard)
            return;
        const terminal = Main.inputMethod.content_purpose === Clutter.InputContentPurpose.TERMINAL;
        const keys = terminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_Insert]
            : [Clutter.KEY_Shift_L, Clutter.KEY_Insert];
        const time = GLib.get_monotonic_time();
        for (const key of keys)
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of [...keys].reverse())
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }

    // clipboard-indicator's own list of excluded apps, if it has one.
    _importLegacyExcludedApps() {
        const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
            .map(d => GLib.build_filenamev([d, 'gnome-shell', 'extensions', LEGACY_UUID, 'schemas']));
        for (const dir of dirs) {
            if (!GLib.file_test(dir, GLib.FileTest.IS_DIR))
                continue;
            try {
                const source = Gio.SettingsSchemaSource.new_from_directory(dir,
                    Gio.SettingsSchemaSource.get_default(), false);
                const schema = source.lookup('org.gnome.shell.extensions.clipboard-indicator', false);
                if (!schema?.has_key('excluded-apps'))
                    continue;
                const legacy = new Gio.Settings({settings_schema: schema});
                const apps = new Set([...this._settings.get_strv('clipboard-excluded-apps'),
                    ...legacy.get_strv('excluded-apps')]);
                this._settings.set_strv('clipboard-excluded-apps', [...apps]);
                return;
            } catch (_e) {}
        }
    }

    destroy() {
        if (this._active)
            this._stop();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        Main.extensionManager.disconnect(this._extensionsId);
    }
}
