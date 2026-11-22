// SPDX-License-Identifier: LicenseRef-Proprietary
// Copyright (C) 2026 cristiulian
// The share page's keys, live: cmcore.wasm (the FM-1's synth) in an AudioWorklet, played as the FM-1's audio plays it.
// The page posts { type: "load", wasm } (cmcore.wasm's bytes) once, then { type: "sound", rec } (a record's bytes),
// { type: "note", note, vel } (vel 0: let go), { type: "macro", k, v } (0..1), { type: "alloff" }; what comes before
// the engine is up waits. It answers { type: "ready" } when a sound is loaded, { type: "error", message } when not.
// Each render quantum asks the synth for its frames at 44.1 kHz (the FM-1's rate; read across, linearly, when the
// browser runs audio at another), at the level the emulator plays at (its MASTER as it starts, app_render's gain).
const FS = 44100;
const LEVEL = (2800 / 4096) * 8300000 / 8388608;
const CAP = 8192;                                   // the synth's frames read ahead (a quantum's at 8 kHz fits)

class CmLive extends AudioWorkletProcessor {
  constructor() {
    super();
    this.x = null;
    this.loaded = false;
    this.waiting = [];
    this.fl = new Float32Array(CAP);
    this.fr = new Float32Array(CAP);
    this.rd = 0;                                    // the first frame not yet read past
    this.have = 0;                                  // frames from rd
    this.ph = 0;                                    // where the next sample falls after rd (frames)
    this.ratio = FS / sampleRate;
    this.port.onmessage = (e) => this.message(e.data);
  }

  async message(m) {
    if (m.type === "load") {
      try {
        const { instance } = await WebAssembly.instantiate(m.wasm, { env: { emscripten_notify_memory_growth() {} } });
        this.x = instance.exports;
        if (this.x._initialize) this.x._initialize();
        this.x.cm_init();
      } catch (err) {
        this.port.postMessage({ type: "error", message: String(err && err.message || err) });
        return;
      }
      const w = this.waiting;
      this.waiting = [];
      for (const q of w) this.message(q);
      return;
    }
    if (!this.x) {
      this.waiting.push(m);
      return;
    }
    const x = this.x;
    if (m.type === "sound") {
      const rec = new Uint8Array(m.rec);
      new Uint8Array(x.memory.buffer, x.cm_in(), rec.length).set(rec);
      this.loaded = x.cm_live_load(rec.length) >= 0;
      this.port.postMessage(this.loaded ? { type: "ready" } : { type: "error", message: "the sound would not load" });
    } else if (!this.loaded) {
      return;
    } else if (m.type === "note") {
      x.cm_live_note(m.note >>> 0, m.vel >>> 0);
    } else if (m.type === "macro") {
      x.cm_live_macro(m.k >>> 0, +m.v);
    } else if (m.type === "alloff") {
      x.cm_live_all_off();
    }
  }

  process(inputs, outputs) {
    const out = outputs[0], n = out[0].length, x = this.x;
    if (!x || !this.loaded) return true;            // (silence)
    const need = Math.ceil(this.ph + n * this.ratio) + 1;
    if (this.have < need) {                         // the synth's next frames, after those still to read
      this.fl.copyWithin(0, this.rd, this.rd + this.have);
      this.fr.copyWithin(0, this.rd, this.rd + this.have);
      this.rd = 0;
      const m = need - this.have;
      x.cm_live_render(m);
      this.fl.set(new Float32Array(x.memory.buffer, x.cm_l(), m), this.have);
      this.fr.set(new Float32Array(x.memory.buffer, x.cm_r(), m), this.have);
      this.have += m;
    }
    const l = out[0], r = out[1] || out[0], fl = this.fl, fr = this.fr;
    let ph = this.ph;
    for (let i = 0; i < n; i++, ph += this.ratio) {
      const k = ph | 0, j = this.rd + k, f = ph - k;
      l[i] = (fl[j] + (fl[j + 1] - fl[j]) * f) * LEVEL;
      if (r !== l) r[i] = (fr[j] + (fr[j + 1] - fr[j]) * f) * LEVEL;
    }
    const k = ph | 0;
    this.rd += k;
    this.have -= k;
    this.ph = ph - k;
    return true;
  }
}

registerProcessor("cm-live", CmLive);
