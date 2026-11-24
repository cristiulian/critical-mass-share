// SPDX-License-Identifier: LicenseRef-Proprietary
// Copyright (C) 2026 cristiulian
// Critical Mass in the browser (and Node): the engine (cmcore.wasm: the patch core, the synth, the analysis), patch
// files, packs and codes (as tools/patch/cmpatch.py writes them) and the FM-1's SysEx protocol (as
// tools/patch/cmsysex.py and app/critmass.c speak it). docs/PATCH-EXCHANGE.md describes the formats.
//
//   const cm = await CM.load();                 // the engine (CMCORE_WASM if cmcore_wasm.js was loaded, else fetch)
//   cm.presets(); cm.preset(i); cm.unpack(rec); cm.pack(lines, baseRec); cm.render(rec, note, vel, hold, len)
//   cm.share(rec), cm.unshare(text)             // a sound as a QR code's text (the FM-1's SHARE: docs/SHARE.md)
//   cm.target(l, r, rate, note); cm.compare(rec)  // a recording, then sounds played as it was and measured against it
//   CM.fromRecord(cm, rec), CM.recordOf(cm, patch), CM.codeOf(rec), CM.fromCode(cm, code or share link), CM.makePack(...)
//   CM.sx.*: frames, parse, writePlan; new CM.Device(midiIn, midiOut): hello, list, read, write, audition ...
(function (G) {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ------------------------------------------------------------------------------------------------ bytes ---
  function b64enc(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64dec(s) {
    const b = atob(s.replace(/\s+/g, '')), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  const hex = u8 => Array.from(u8, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = s => new Uint8Array((s.match(/../g) || []).map(h => parseInt(h, 16)));

  function lines2obj(text) {
    const o = {};
    for (const line of text.split('\n')) {
      if (!line || line[0] === '#') continue;
      const i = line.indexOf('=');
      if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return o;
  }
  const obj2lines = o => Object.entries(o).map(([k, v]) => k + '=' + v + '\n').join('');

  // ----------------------------------------------------------------------------------------------- engine ---
  async function load(src) {
    let bytes;
    if (src instanceof Uint8Array) bytes = src;
    else if (!src && G.CMCORE_WASM) bytes = b64dec(G.CMCORE_WASM);
    else bytes = new Uint8Array(await (await fetch(src || 'cmcore.wasm')).arrayBuffer());
    const { instance } = await WebAssembly.instantiate(bytes, { env: { emscripten_notify_memory_growth() {} } });
    const x = instance.exports;
    if (x._initialize) x._initialize();
    x.cm_init();
    return new Engine(x);
  }

  class Engine {
    constructor(x) {
      this.x = x;
      this.inMax = x.cm_in_max();
      this.rate = x.cm_rate();
      this.maxFrames = x.cm_max_frames();
      this._keys = null;
    }
    get mem() { return new Uint8Array(this.x.memory.buffer); }
    f32(ptr, n) { return new Float32Array(this.x.memory.buffer, ptr, n); }
    text(n) {                                    // what the last call wrote; a refusal thrown
      const p = this.x.cm_out(), m = this.mem;
      if (n >= 0) return dec.decode(m.subarray(p, p + n));
      let e = p;
      while (m[e]) e++;
      throw new Error(dec.decode(m.subarray(p, e)) || 'refused');
    }
    put(bytes, at = 0) {
      if (at + bytes.length > this.inMax) throw new Error('too long');
      this.mem.set(bytes, this.x.cm_in() + at);
    }
    sound(n) {                                   // "record=HEX" and its lines -> {record, lines, params}
      const t = this.text(n), i = t.indexOf('\n');
      return { record: unhex(t.slice(7, i)), lines: t.slice(i + 1), params: lines2obj(t.slice(i + 1)) };
    }
    keys() {                                     // [{key, id, kind, min, max, init, choices, page}]
      if (!this._keys) {
        this._keys = this.text(this.x.cm_keys()).split('\n').filter(l => l && l[0] !== '#').map(l => {
          const f = l.split('\t');
          return { key: f[0], id: +f[1], kind: f[2], min: +f[3], max: +f[4], init: f[5],
                   choices: f[6] ? f[6].split('|') : [], page: f[7] };
        });
      }
      return this._keys;
    }
    presets() { return this.text(this.x.cm_presets()).split('\n').filter(Boolean); }
    preset(i) { return this.sound(this.x.cm_preset(i)); }
    unpack(rec) { this.put(rec); return this.sound(this.x.cm_unpack(rec.length)); }
    pack(lines, base) {                          // key=value text (an object too) on base (a record; none: INIT)
      const b = base || new Uint8Array(0);
      const t = enc.encode((typeof lines === 'string' ? lines : obj2lines(lines)) + '\0');
      this.put(b);
      this.put(t, b.length);
      return this.sound(this.x.cm_pack(b.length));
    }
    show(rec) { this.put(rec); return lines2obj(this.text(this.x.cm_show(rec.length))); }
    unshare(text) {                              // a QR code's shared text (after the link's #) -> the sound
      this.put(enc.encode(text.trim().toUpperCase() + '\0'));
      return this.sound(this.x.cm_unshare());
    }
    share(rec) { this.put(rec); return this.text(this.x.cm_share(rec.length)); }
    cost(rec) {
      this.put(rec);
      const c = lines2obj(this.text(this.x.cm_cost(rec.length)));
      for (const k of ['voices', 'allowed', 'core1', 'core2', 'limit', 'target']) c[k] = +c[k];
      c.lost = c.allowed < c.voices;
      c.tight = Math.max(c.core1, c.core2) > c.target;
      return c;
    }
    render(rec, note = 57, vel = 100, hold = 1.5, len = 3) {   // {l, r} (copies), at cm.rate
      this.put(rec);
      const n = this.x.cm_render(rec.length, note, vel, hold, len);
      if (n < 0) this.text(n);
      return { l: this.f32(this.x.cm_l(), n).slice(), r: this.f32(this.x.cm_r(), n).slice() };
    }
    target(l, r, rate, note = -1) {              // the recording (at most cm.maxFrames): its analysis
      const n = Math.min(l.length, this.maxFrames);
      this.f32(this.x.cm_tl(), n).set(l.subarray(0, n));
      this.f32(this.x.cm_tr(), n).set((r || l).subarray(0, n));
      const t = this.text(this.x.cm_target(n, rate, note));
      return { text: t, ...features(t) };
    }
    compare(rec, vel = 100) {                    // played as the recording was, measured: {distance, hints, l, r ..}
      this.put(rec);
      const t = this.text(this.x.cm_compare(rec.length, vel)), o = lines2obj(t), n = +o.frames;
      const hints = t.split('\n').filter(l => l.startsWith('hint=')).map(l => l.slice(5));
      return { text: t, played: +o.played_note, distance: +o.distance, spec_db: +o.spec_db, env_db: +o.env_db,
               harm_db: +o.harm_db, bright_oct: +o.bright_oct, cents: +o.cents, hints,
               l: this.f32(this.x.cm_l(), n).slice(), r: this.f32(this.x.cm_r(), n).slice() };
    }
    got() { const t = this.text(this.x.cm_got()); return { text: t, ...features(t) }; }
    spec(which) {                                // a spectrogram: {frames, bands, at(j, k) dB}
      const bands = this.x.cm_spec_bands(), frames = this.x.cm_spec_frames(which);
      const d = this.f32(this.x.cm_spec(which), frames * bands).slice();
      return { frames, bands, data: d, at: (j, k) => d[j * bands + k] };
    }
  }

  function features(t) {
    const o = lines2obj(t), f = {};
    for (const [k, v] of Object.entries(o)) f[k] = v.includes(',') ? v.split(',').map(Number) : isNaN(+v) ? v : +v;
    return f;
  }

  // ------------------------------------------------------------------------------- patch files and codes ---
  const PATCH = 'critical-mass-patch', PACK = 'critical-mass-pack';

  function typed(cm, params) {
    const kind = {};
    for (const k of cm.keys()) kind[k.key] = k.kind;
    for (let m = 1; m <= 8; m++) kind['macro.m' + m] = 'number';
    const o = {};
    for (const [k, v] of Object.entries(params)) {
      if (kind[k] === 'number' && v !== '' && !isNaN(+v)) o[k] = +v;
      else o[k] = v;
    }
    return o;
  }

  function fromRecord(cm, rec, about) {          // a patch file's object, the record as cmtool writes it
    const s = cm.unpack(rec), p = s.params;
    return { format: PATCH, version: 1, name: p.name || '', category: p.category || '',
             tags: (p.tags || '').split(',').filter(Boolean), record_version: s.record[4],
             record: b64enc(s.record), params: typed(cm, p), about: about || {} };
  }

  function recordOf(cm, patch) {                 // its record: its own, or made from its params on its base
    if (!patch || patch.format !== PATCH) throw new Error('not a Critical Mass patch');
    if (patch.version > 1) throw new Error('a newer patch format (version ' + patch.version + ')');
    if (patch.record) {
      const rec = b64dec(patch.record);
      cm.unpack(rec);                            // (refused as the FM-1 would refuse it)
      return rec;
    }
    return cm.pack(patch.params || {}, patch.base ? b64dec(patch.base) : null).record;
  }

  const codeOf = rec => 'CM1:' + b64enc(rec).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const shareOf = code => {                      // a shared sound's text (a QR code's link, or what follows its #)
    const s = code.trim(), t = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
    return !s.startsWith('CM1:') && /^[0-9A-Za-z$*+./:-]+$/.test(t) ? t : null;
  };
  function fromCode(cm, code) {                  // a patch code (CM1:...) or a shared sound (a QR code's link)
    const sh = shareOf(code);
    if (sh) return fromRecord(cm, cm.unshare(sh).record, { from: 'a shared sound (QR code)' });
    const m = /^\s*CM1:([A-Za-z0-9_-]+)\s*$/.exec(code);
    if (!m) throw new Error('not a patch code (CM1:...) or a shared sound');
    let s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return fromRecord(cm, b64dec(s));
  }

  const makePack = (patches, name = '', author = '', description = '') =>
    ({ format: PACK, version: 1, name, author, description, patches });

  function patchesIn(cm, text) {                 // a patch file, a pack, or patch codes (a line each): its patches
    const t = text.trim();
    if (t.startsWith('CM1:') || shareOf(t.split(/\s+/)[0])) {
      return t.split(/\s+/).filter(Boolean).map(c => fromCode(cm, c));
    }
    const o = JSON.parse(t);
    if (o.format === PACK) return o.patches.map(p => { recordOf(cm, p); return p; });
    if (o.format === PATCH) { recordOf(cm, o); return [o]; }
    throw new Error('not a Critical Mass patch or pack');
  }

  const fileName = (name, ext) => ((name || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
                                   || 'sound') + ext;

  // ----------------------------------------------------------------------------------------------- SysEx ---
  const sx = (() => {
    const ID = [0x7D, 0x43, 0x4D], PROTO = 1;
    const C = { HELLO: 0x10, HELLO_R: 0x11, LIST: 0x12, LIST_R: 0x13, READ: 0x14, RECORD: 0x15, BEGIN: 0x16,
                DATA: 0x17, END: 0x18, DELETE: 0x19, SELECT: 0x1A, ACK: 0x7E, NAK: 0x7F };
    const NAME = Object.fromEntries(Object.entries(C).map(([k, v]) => [v, k]));
    const NAKS = { 1: 'FRAME', 2: 'SLOT', 3: 'SIZE', 4: 'STATE', 5: 'OFFSET', 6: 'CRC', 7: 'RECORD', 8: 'FLASH',
                   9: 'BUSY', 10: 'EMPTY', 11: 'FULL' };
    const AUDITION = 127, PART = 280, SLOTS = 64;   // (firmware before the packed bank: 32, as HELLO says)
    const TABLE = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    function crc32(b) {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function pack7(b) {
      const o = [];
      for (let i = 0; i < b.length; i += 7) {
        const g = b.subarray(i, i + 7);
        let hi = 0;
        g.forEach((x, k) => { hi |= ((x >> 7) & 1) << k; });
        o.push(hi, ...Array.from(g, x => x & 0x7F));
      }
      return o;
    }
    function unpack7(b) {
      const o = [];
      for (let i = 0; i < b.length;) {
        const hi = b[i], g = b.slice(i + 1, i + 8);
        g.forEach((x, k) => o.push(x | (((hi >> k) & 1) << 7)));
        i += 1 + g.length;
      }
      return new Uint8Array(o);
    }
    const n7 = (v, n) => Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (7 * i)) & 0x7F);
    const frame = (cmd, data = []) => new Uint8Array([0xF0, ...ID, PROTO, cmd, ...data, 0xF7]);
    const ack = (cmd, a = 0, b = 0, c = 0) => frame(C.ACK, [cmd, a & 0x7F, b & 0x7F, c & 0x7F]);
    const nak = (cmd, code) => frame(C.NAK, [cmd, code]);

    function parse(f) {
      if (f.length < 7 || f[0] !== 0xF0 || f[f.length - 1] !== 0xF7 || f[1] !== ID[0] || f[2] !== ID[1] ||
          f[3] !== ID[2]) return null;
      const cmd = f[5], d = f.slice(6, -1), r = { cmd: NAME[cmd] || cmd, proto: f[4] };
      if (cmd === C.HELLO_R) {
        Object.assign(r, { proto: d[0], slots: d[1], recordMax: d[2] | d[3] << 7, recordVersion: d[4],
                           name: dec.decode(d.slice(5)) });
      } else if (cmd === C.LIST_R) {
        r.slots = [];
        for (let s = 0; s < d[1]; s++) {
          r.slots.push({ slot: d[0] + s + 1, used: !!d[2 + 16 * s],
                         name: dec.decode(d.slice(3 + 16 * s, 2 + 16 * s + 16)).trimEnd() });
        }
      } else if (cmd === C.RECORD) {
        Object.assign(r, { slot: d[0] + 1, part: d[1], parts: d[2], len: d[3] | d[4] << 7,
                           crc: [0, 1, 2, 3, 4].reduce((c, i) => c + d[5 + i] * 2 ** (7 * i), 0) >>> 0,
                           data: unpack7(d.slice(10)) });
      } else if (cmd === C.ACK) {
        Object.assign(r, { of: NAME[d[0]] || d[0], a: d[1], b: d[2], c: d[3] });
      } else if (cmd === C.NAK) {
        Object.assign(r, { of: NAME[d[0]] || d[0], code: d[1], why: NAKS[d[1]] || String(d[1]) });
      }
      return r;
    }

    function writePlan(record, slot) {           // [[frame, the answer it waits for]]; slot 1..64 or 'try'
      const s = slot === 'try' ? AUDITION : slot - 1;
      if (!(s === AUDITION || (s >= 0 && s < SLOTS))) throw new Error('slot ' + slot + ': 1..' + SLOTS);
      const crc = crc32(record);
      const plan = [[frame(C.BEGIN, [s, ...n7(record.length, 2), ...n7(crc, 5)]), ack(C.BEGIN, s)]];
      for (let at = 0; at < record.length; at += PART) {
        const part = record.subarray(at, at + PART), got = at + part.length;
        plan.push([frame(C.DATA, [...n7(at, 2), ...pack7(part)]), ack(C.DATA, got, got >> 7)]);
      }
      plan.push([frame(C.END), ack(C.END, s)]);
      return plan;
    }

    function joinRecord(parts) {
      parts = parts.slice().sort((a, b) => a.part - b.part);
      if (!parts.length || parts.length !== parts[0].parts) throw new Error('parts missing');
      const rec = new Uint8Array(parts.reduce((n, p) => n + p.data.length, 0));
      let o = 0;
      for (const p of parts) { rec.set(p.data, o); o += p.data.length; }
      if (rec.length !== parts[0].len || crc32(rec) !== parts[0].crc) throw new Error('the record does not check');
      return rec;
    }

    return { C, NAKS, AUDITION, PART, SLOTS, crc32, pack7, unpack7, frame, ack, nak, parse, writePlan, joinRecord,
             hello: () => frame(C.HELLO), list: () => frame(C.LIST), read: s => frame(C.READ, [s - 1]),
             del: s => frame(C.DELETE, [s - 1]), select: s => frame(C.SELECT, [s - 1]) };
  })();

  // an FM-1 over Web MIDI (or anything with send(frame) and frames arriving at take(frame))
  class Device {
    constructor(input, output) {
      this.out = output;
      this.queue = [];
      this.waiting = null;
      if (input) input.onmidimessage = e => { if (e.data[0] === 0xF0) this.take(e.data); };
    }
    take(f) {
      const r = sx.parse(f);
      if (!r) return;
      if (this.waiting) { const w = this.waiting; this.waiting = null; w(r); } else this.queue.push(r);
    }
    next(ms = 3000) {
      if (this.queue.length) return Promise.resolve(this.queue.shift());
      return new Promise((ok, no) => {
        const t = setTimeout(() => { this.waiting = null; no(new Error('the FM-1 did not answer')); }, ms);
        this.waiting = r => { clearTimeout(t); ok(r); };
      });
    }
    async ask(f, ms) { this.queue = []; this.out.send(f); return this.next(ms); }
    async hello() {
      const r = await this.ask(sx.hello(), 1500);
      if (r.cmd !== 'HELLO_R') throw new Error('not a Critical Mass FM-1 (' + (r.why || r.cmd) + ')');
      return r;
    }
    async list(slots) {                          // answers of 16 until the slots HELLO said (32 or 64)
      this.queue = [];
      this.out.send(sx.list());
      const all = [];
      while (all.length < (slots || sx.SLOTS)) {
        const a = await this.next();
        if (a.cmd !== 'LIST_R') throw new Error('no list');
        all.push(...a.slots);
      }
      return all;
    }
    async read(slot) {
      this.queue = [];
      this.out.send(sx.read(slot));
      const parts = [];
      for (;;) {
        const r = await this.next();
        if (r.cmd === 'NAK') throw new Error('U' + String(slot).padStart(2, '0') + ': ' + r.why);
        parts.push(r);
        if (parts.length === r.parts) return sx.joinRecord(parts);
      }
    }
    async write(record, slot, progress) {        // slot 1..64, or 'try': played, not saved
      const plan = sx.writePlan(record, slot);
      for (let i = 0; i < plan.length; i++) {
        const [f, want] = plan[i];
        const r = await this.ask(f, i === plan.length - 1 ? 5000 : 2000);
        if (r.cmd !== 'ACK' || sx.ack(want[6], r.a, r.b, r.c).join() !== want.join()) {
          throw new Error(r.why === 'FULL' ? 'no room left in the FM-1\'s bank (empty a slot, or try a smaller sound)'
                                           : (r.why || 'unexpected answer') + ' at ' + (sx.parse(f).cmd));
        }
        if (progress) progress((i + 1) / plan.length);
      }
    }
    async select(slot) { const r = await this.ask(sx.select(slot)); if (r.cmd !== 'ACK') throw new Error(r.why); }
    async del(slot) { const r = await this.ask(sx.del(slot), 5000); if (r.cmd !== 'ACK') throw new Error(r.why); }
  }

  G.CM = { load, Engine, b64enc, b64dec, hex, unhex, lines2obj, obj2lines, PATCH, PACK, fromRecord, recordOf, codeOf,
           fromCode, makePack, patchesIn, fileName, sx, Device };
})(typeof globalThis !== 'undefined' ? globalThis : this);
