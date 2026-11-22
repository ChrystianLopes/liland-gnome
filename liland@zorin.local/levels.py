#!/usr/bin/env python3
"""Liland levels helper: listens to the default output (monitor) and prints
6 equalizer levels (0..1) per line on stdout, ~60 times per second.
It only measures the sound in the moment; nothing is recorded or saved.
Port of Liland's SpectrumAnalyzer (adaptive range + attack + spring)."""
import math
import sys
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gst, GLib

BANDS = [(40, 100), (100, 200), (200, 560), (560, 1700), (1700, 5000), (5000, 12000)]
AVERAGING_TIMES = [0.045, 0.03, 0.015, 0.015, 0.015, 0.015]
FALL_PER_SECOND = 60.0
SILENCE = -80.0
MEMORY_SECONDS, MEMORY_STEP = 3.0, 0.05
MEMORY_LENGTH = int(round(MEMORY_SECONDS / MEMORY_STEP))
QUIET_P, LOUD_P = 0.1, 0.9
MIN_SPAN, MAX_SPAN = 12.0, 40.0
SPRING_RESPONSE = 0.065
ATTACK_WEIGHTS = [0.8, 0.8, 0.3, 0.3, 0, 0]
ATTACK_AVERAGING, ATTACK_RANGE, ATTACK_FALL = 0.15, 8.0, 3.0
RATE = 48000
FFT_BANDS = 1024
INTERVAL_NS = 16_000_000  # 16 ms


def db(power):
    return 10 * math.log10(power + 1e-12)


class Analyzer:
    def __init__(self):
        n = len(BANDS)
        self.powers = [0.0] * n
        self.mix_power = 0.0
        self.held = [-math.inf] * n
        self.memory = [[] for _ in range(n)]
        self.memory_index = 0
        self.since_memory = math.inf
        self.quiet = [0.0] * n
        self.loud = [0.0] * n
        self.recent = [math.nan] * n
        self.attack = [0.0] * n
        self.smoothed = [0.0] * n
        self.velocity = [0.0] * n
        width = (RATE / 2) / FFT_BANDS
        self.bins = [[i for i in range(FFT_BANDS) if lo <= (i + 0.5) * width < hi] for lo, hi in BANDS]

    def feed(self, magnitudes, seconds):
        lin = [10 ** (m / 10) for m in magnitudes]
        mix = sum(lin)
        self.mix_power += (mix - self.mix_power) * (1 - math.exp(-seconds / 0.05))
        for b, idx in enumerate(self.bins):
            p = sum(lin[i] for i in idx)
            a = 1 - math.exp(-seconds / max(AVERAGING_TIMES[b] * 4, seconds))
            self.powers[b] += (p - self.powers[b]) * a
        self.update(seconds)
        return [min(max(v, 0.0), 1.0) for v in self.smoothed]

    def update(self, seconds):
        silent = db(self.mix_power) < SILENCE
        step = 1 - math.exp(-seconds / ATTACK_AVERAGING)
        for b in range(len(BANDS)):
            now = db(self.powers[b])
            if math.isnan(self.recent[b]):
                self.recent[b] = now
            jump = min(max((now - self.recent[b]) / ATTACK_RANGE, 0), 1)
            self.recent[b] += (now - self.recent[b]) * step
            self.attack[b] = 0 if silent else max(jump, self.attack[b] - ATTACK_FALL * seconds)
        levels = []
        for b in range(len(BANDS)):
            self.held[b] = max(db(self.powers[b]), self.held[b] - FALL_PER_SECOND * seconds)
            levels.append(self.held[b])
        self.since_memory += seconds
        if not silent and self.since_memory >= MEMORY_STEP:
            self.since_memory = 0
            self.remember(levels)
        omega = 2 * math.pi / SPRING_RESPONSE
        decay = math.exp(-omega * seconds)
        for b, d in enumerate(levels):
            span = min(max(self.loud[b] - self.quiet[b], MIN_SPAN), MAX_SPAN)
            empty = self.loud[b] - span
            plain = 0 if silent or not self.memory[b] else min(max((d - empty) / span, 0), 1)
            w = ATTACK_WEIGHTS[b]
            target = w * self.attack[b] + (1 - w) * plain
            offset = self.smoothed[b] - target
            push = self.velocity[b] + omega * offset
            new_offset = (offset + push * seconds) * decay
            self.velocity[b] = (self.velocity[b] - omega * push * seconds) * decay
            self.smoothed[b] = target + new_offset

    def remember(self, levels):
        for b, d in enumerate(levels):
            if len(self.memory[b]) < MEMORY_LENGTH:
                self.memory[b].append(d)
            else:
                self.memory[b][self.memory_index] = d
            s = sorted(self.memory[b])
            last = len(s) - 1
            self.quiet[b] = s[int(round(last * QUIET_P))]
            self.loud[b] = s[int(round(last * LOUD_P))]
        self.memory_index = (self.memory_index + 1) % MEMORY_LENGTH


def main():
    Gst.init(None)
    pipeline = Gst.parse_launch(
        'pulsesrc name=src device=@DEFAULT_MONITOR@ client-name=Liland ! '
        f'audioconvert ! audioresample ! audio/x-raw,rate={RATE},channels=1 ! '
        f'spectrum bands={FFT_BANDS} threshold=-120 interval={INTERVAL_NS} post-messages=true ! '
        'fakesink sync=false')
    src = pipeline.get_by_name('src')
    # Tag the stream as a level meter so GNOME doesn't show the microphone
    # privacy indicator for it (it's the output monitor, not the mic).
    props = Gst.Structure.new_from_string(
        'props,application.id=org.gnome.VolumeControl,media.role=Music,application.name=Liland')
    src.set_property('stream-properties', props)
    src.set_property('buffer-time', 20000)
    src.set_property('latency-time', 10000)

    analyzer = Analyzer()
    loop = GLib.MainLoop()
    last = [None]

    def on_message(_bus, msg):
        if msg.type == Gst.MessageType.ELEMENT:
            s = msg.get_structure()
            if s and s.get_name() == 'spectrum':
                ts = s.get_value('endtime')
                seconds = INTERVAL_NS / 1e9 if last[0] is None else max((ts - last[0]) / 1e9, 0.001)
                last[0] = ts
                ok, arr = s.get_list('magnitude')
                if not ok:
                    return
                mags = [arr.get_nth(i) for i in range(arr.n_values)]
                levels = analyzer.feed(mags, seconds)
                try:
                    sys.stdout.write(' '.join(f'{v:.3f}' for v in levels) + '\n')
                    sys.stdout.flush()
                except BrokenPipeError:
                    loop.quit()
        elif msg.type in (Gst.MessageType.ERROR, Gst.MessageType.EOS):
            loop.quit()

    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect('message', on_message)
    # Quit when the parent closes stdin.
    GLib.io_add_watch(GLib.IOChannel.unix_new(0), GLib.PRIORITY_DEFAULT,
                      GLib.IOCondition.HUP | GLib.IOCondition.IN | GLib.IOCondition.ERR,
                      lambda *_: (loop.quit(), False)[1])
    pipeline.set_state(Gst.State.PLAYING)
    try:
        loop.run()
    finally:
        pipeline.set_state(Gst.State.NULL)


if __name__ == '__main__':
    main()
