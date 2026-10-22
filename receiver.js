// Move IT Custom Web Receiver.
// Receives phone-rendered H.264 (Annex B) over the Cast custom namespace and shows it.
// Decoders: WebCodecs when available (lowest latency); otherwise Media Source Extensions with one
// fragmented-MP4 segment per frame, played at the live edge. Milestone 0 candidate transport.
'use strict';

const NAMESPACE = 'urn:x-cast:com.moveit.stream';
const canvas = document.getElementById('screen');
const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');

const diagEl = document.getElementById('diag');
const diag = { version: 'v4', messages: 0, last: '-', error: '' };
function showDiag() {
  if (diagEl) diagEl.textContent = `receiver ${diag.version} · webcodecs ${hasWebCodecs} · mse ${hasMSE} · msgs ${diag.messages} · last ${diag.last}${diag.error ? ' · ' + diag.error : ''}`;
}
window.onerror = (msg, src, line, col) => {
  diag.error = 'ERROR ' + msg + ' @' + line + ':' + col;
  showDiag();
  send({ t: 'error', reason: 'script', detail: diag.error });
};

const context = cast.framework.CastReceiverContext.getInstance();
const hasWebCodecs = typeof window.VideoDecoder === 'function';
const hasMSE = typeof window.MediaSource === 'function';

let sender = null;
let decoder = null;            // WebCodecsDecoder | MseDecoder
let config = null;             // { codec, w, h, fps }
const partial = new Map();     // frame id -> { n, k, parts[], received }
const stats = { dropped: 0, decodeMs: [], window: [] };

function send(message) {
  if (sender) context.sendCustomMessage(NAMESPACE, sender, message);
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'block' : 'none';
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function frameShown(id, startedAt) {
  stats.window.push(performance.now());
  if (startedAt !== undefined) {
    stats.decodeMs.push(performance.now() - startedAt);
    if (stats.decodeMs.length > 60) stats.decodeMs.shift();
  }
  send({ t: 'ack', id });
}

function requestKeyframe() {
  send({ t: 'needkey' });
}

// ---------------------------------------------------------------- WebCodecs

class WebCodecsDecoder {
  constructor(cfg) {
    this.name = 'webcodecs';
    this.ctx = canvas.getContext('2d');
    canvas.width = cfg.w;
    canvas.height = cfg.h;
    canvas.style.display = 'block';
    video.style.display = 'none';
    this.started = new Map();
    this.needKey = true;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        const id = frame.timestamp;
        frame.close();
        frameShown(id, this.started.get(id));
        this.started.delete(id);
      },
      error: (e) => {
        setStatus('Decoder error: ' + e.message);
        this.needKey = true;
        requestKeyframe();
      },
    });
    // No description → Annex B input.
    this.decoder.configure({ codec: cfg.codec, codedWidth: cfg.w, codedHeight: cfg.h, optimizeForLatency: true });
  }

  push(id, isKey, bytes) {
    if (this.decoder.state !== 'configured') return;
    if (this.needKey && !isKey) { stats.dropped++; return; }
    if (this.decoder.decodeQueueSize > 4) { stats.dropped++; this.needKey = true; requestKeyframe(); return; }
    this.needKey = false;
    this.started.set(id, performance.now());
    this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: id, data: bytes }));
  }

  get queue() { return this.decoder.decodeQueueSize; }
  close() { if (this.decoder.state !== 'closed') this.decoder.close(); }
}

// ---------------------------------------------------------------- MSE (fragmented MP4)

/** Splits Annex B into NAL units (without start codes). */
function splitAnnexB(bytes) {
  const units = [];
  let i = 0, start = -1;
  while (i + 3 <= bytes.length) {
    const sc3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    const sc4 = !sc3 && i + 4 <= bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) units.push(bytes.subarray(start, i));
      i += sc3 ? 3 : 4;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < bytes.length) units.push(bytes.subarray(start));
  return units;
}

const Mp4 = {
  box(type, ...payloads) {
    const size = 8 + payloads.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let offset = 8;
    for (const p of payloads) { out.set(p, offset); offset += p.length; }
    return out;
  },
  u8: (...v) => new Uint8Array(v),
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; },
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; },
  u64(v) { const b = new Uint8Array(8); const d = new DataView(b.buffer); d.setUint32(0, Math.floor(v / 2 ** 32)); d.setUint32(4, v >>> 0); return b; },
  zeros: (n) => new Uint8Array(n),
  str(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
  matrix() { const m = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]; return Mp4.concat(...m.map((v) => Mp4.u32(v))); },
  concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  },

  init(sps, pps, width, height, timescale) {
    const { box, u8, u16, u32, zeros, str, matrix, concat } = Mp4;
    const avcC = box('avcC', u8(1, sps[1], sps[2], sps[3], 0xff, 0xe1), u16(sps.length), sps, u8(1), u16(pps.length), pps);
    const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000),
      u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), avcC);
    const stbl = box('stbl',
      box('stsd', u32(0), u32(1), avc1),
      box('stts', u32(0), u32(0)), box('stsc', u32(0), u32(0)), box('stsz', u32(0), u32(0), u32(0)), box('stco', u32(0), u32(0)));
    const minf = box('minf',
      box('vmhd', u32(1), zeros(8)),
      box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1)))),
      stbl);
    const mdia = box('mdia',
      box('mdhd', u32(0), u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0)),
      box('hdlr', u32(0), u32(0), str('vide'), zeros(12), str('MoveIT\0')),
      minf);
    const trak = box('trak',
      box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix(),
        u32(width << 16), u32(height << 16)),
      mdia);
    const moov = box('moov',
      box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(0), u32(0x00010000), u16(0x0100), zeros(10), matrix(), zeros(24), u32(2)),
      trak,
      box('mvex', box('trex', u32(0), u32(1), u32(1), u32(0), u32(0), u32(0))));
    return concat(box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('avc1'), str('mp41')), moov);
  },

  segment(sequence, decodeTime, duration, isKey, sample) {
    const { box, u32, u64 } = Mp4;
    const flags = isKey ? 0x02000000 : 0x01010000;
    const build = (dataOffset) => box('moof',
      box('mfhd', u32(0), u32(sequence)),
      box('traf',
        box('tfhd', u32(0x020000), u32(1)),
        box('tfdt', u32(0x01000000), u64(decodeTime)),
        box('trun', u32(0x000701), u32(1), u32(dataOffset), u32(duration), u32(sample.length), u32(flags))));
    const moofSize = build(0).length;
    return Mp4.concat(build(moofSize + 8), box('mdat', sample));
  },
};

class MseDecoder {
  constructor(cfg) {
    this.name = 'mse';
    this.cfg = cfg;
    this.mime = `video/mp4; codecs="${cfg.codec}"`;
    this.timescale = 90000;
    this.duration = Math.round(this.timescale / (cfg.fps || 30));
    this.sequence = 1;
    this.sampleIndex = 0;
    this.queue = [];
    this.pending = new Map();      // sample index -> { id, appendedAt }
    this.initialized = false;
    this.needKey = true;
    this.sb = null;
    canvas.style.display = 'none';
    video.style.display = 'block';
    this.ms = new MediaSource();
    video.src = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => {
      if (!MediaSource.isTypeSupported(this.mime)) {
        setStatus('This TV cannot play ' + this.mime);
        send({ t: 'error', reason: 'mse-codec-unsupported', mime: this.mime });
        return;
      }
      this.sb = this.ms.addSourceBuffer(this.mime);
      this.sb.mode = 'segments';
      this.sb.addEventListener('updateend', () => this.onUpdateEnd());
      this.pump();
    });
    this.hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    if (this.hasFrameCallback) video.requestVideoFrameCallback((now, meta) => this.onFrame(now, meta));
  }

  push(id, isKey, bytes) {
    let sps = null, pps = null;
    const parts = [];
    for (const nal of splitAnnexB(bytes)) {
      const type = nal[0] & 0x1f;
      if (type === 7) sps = nal;
      else if (type === 8) pps = nal;
      else if (type !== 9) parts.push(Mp4.u32(nal.length), nal);   // skip access unit delimiters
    }
    if (!this.initialized) {
      if (!isKey || !sps || !pps) { stats.dropped++; return; }
      this.queue.push({ data: Mp4.init(sps, pps, this.cfg.w, this.cfg.h, this.timescale) });
      this.initialized = true;
    }
    if (this.needKey && !isKey) { stats.dropped++; return; }
    if (this.queue.length > 6) {
      // Falling behind: drop and resync on the next keyframe.
      this.queue = this.queue.filter((q) => !q.index && q.index !== 0);
      stats.dropped++;
      this.needKey = true;
      requestKeyframe();
      return;
    }
    this.needKey = false;
    const index = this.sampleIndex++;
    const sample = Mp4.concat(...parts);
    this.queue.push({ index, id, data: Mp4.segment(this.sequence++, index * this.duration, this.duration, isKey, sample) });
    this.pump();
  }

  pump() {
    if (!this.sb || this.sb.updating || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (next.index !== undefined) this.pending.set(next.index, { id: next.id, appendedAt: performance.now() });
    try {
      this.sb.appendBuffer(next.data);
    } catch (e) {
      setStatus('Append failed: ' + e.message);
      this.needKey = true;
      requestKeyframe();
    }
  }

  onUpdateEnd() {
    const buffered = video.buffered;
    if (buffered.length) {
      const end = buffered.end(buffered.length - 1);
      // Stay at the live edge: never let playback lag the newest frame by more than ~3 frames.
      if (end - video.currentTime > 0.12) video.currentTime = Math.max(buffered.start(buffered.length - 1), end - 0.04);
      if (video.paused) video.play().catch(() => {});
      // Trim old media so memory does not grow.
      if (video.currentTime - buffered.start(0) > 10 && !this.sb.updating) {
        this.sb.remove(buffered.start(0), video.currentTime - 5);
        return;
      }
    }
    if (!this.hasFrameCallback) {
      // No per-frame presentation callback: acknowledge on append instead.
      for (const [index, p] of this.pending) { frameShown(p.id, p.appendedAt); this.pending.delete(index); }
    }
    setStatus('');
    this.pump();
  }

  onFrame(now, meta) {
    const index = Math.round(meta.mediaTime * this.timescale / this.duration);
    for (const [i, p] of this.pending) {
      if (i > index) continue;
      if (i === index) frameShown(p.id, p.appendedAt); else stats.dropped++;
      this.pending.delete(i);
    }
    video.requestVideoFrameCallback((n, m) => this.onFrame(n, m));
  }

  get queueSize() { return this.queue.length; }
  close() {
    try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch (e) { /* ignore */ }
    video.removeAttribute('src');
    video.load();
  }
}

// ---------------------------------------------------------------- stream handling

function configure(cfg) {
  if (decoder) decoder.close();
  config = cfg;
  if (hasWebCodecs) decoder = new WebCodecsDecoder(cfg);
  else if (hasMSE) decoder = new MseDecoder(cfg);
  else {
    decoder = null;
    setStatus('This TV can decode neither WebCodecs nor MSE video.');
    send({ t: 'error', reason: 'no-decoder' });
    return;
  }
  setStatus('Waiting for video…');
}

function onFrameChunk(m) {
  let entry = partial.get(m.id);
  if (!entry) {
    entry = { n: m.n, k: m.k === 1, parts: new Array(m.n), received: 0 };
    partial.set(m.id, entry);
  }
  if (entry.parts[m.i] === undefined) {
    entry.parts[m.i] = m.d;
    entry.received++;
  }
  if (entry.received < entry.n) return;
  partial.delete(m.id);
  for (const id of partial.keys()) if (id < m.id) { partial.delete(id); stats.dropped++; }
  const bytes = base64ToBytes(entry.parts.join(''));
  if (!decoder && entry.k) {
    // No "cfg" received (e.g. after a reconnect): derive the codec from the keyframe's SPS.
    const sps = splitAnnexB(bytes).find((nal) => (nal[0] & 0x1f) === 7);
    if (sps) {
      const hex = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
      configure({ codec: 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]), w: 1280, h: 720, fps: 30 });
    }
  }
  if (decoder) decoder.push(m.id, entry.k, bytes);
  else {
    stats.dropped++;
    const now = performance.now();
    if (!diag.lastKeyRequest || now - diag.lastKeyRequest > 1000) { diag.lastKeyRequest = now; requestKeyframe(); }
  }
}

context.addCustomMessageListener(NAMESPACE, (event) => {
  sender = event.senderId;
  const m = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  diag.messages++;
  diag.last = m.t;
  if (m.t !== 'f' || diag.messages % 30 === 0) showDiag();
  switch (m.t) {
    case 'hello':
      send({
        t: 'hello', webcodecs: hasWebCodecs, mse: hasMSE,
        decoder: hasWebCodecs ? 'webcodecs' : hasMSE ? 'mse' : 'none',
        ua: navigator.userAgent, w: window.innerWidth, h: window.innerHeight,
      });
      setStatus(hasWebCodecs || hasMSE ? 'Connected — waiting for video…' : 'Connected, but this TV has no usable video decoder.');
      break;
    case 'cfg':
      if (!config || m.codec !== config.codec || m.w !== config.w || m.h !== config.h) configure(m);
      break;
    case 'f':
      onFrameChunk(m);
      break;
    case 'ping':
      send({ t: 'pong', s: m.s });
      break;
    case 'stop':
      setStatus('Stream stopped on the phone.');
      break;
    case 'debug':
      statsEl.style.display = m.on ? 'block' : 'none';
      break;
  }
});

setInterval(() => {
  const now = performance.now();
  stats.window = stats.window.filter((t) => t > now - 1000);
  const sorted = [...stats.decodeMs].sort((a, b) => a - b);
  const decodeMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const queue = decoder ? (decoder.name === 'mse' ? decoder.queueSize : decoder.queue) : 0;
  const message = { t: 'rstats', fps: stats.window.length, decodeMs, dropped: stats.dropped, queue, decoder: decoder ? decoder.name : 'none' };
  send(message);
  statsEl.textContent = `${message.decoder}  fps ${message.fps}  decode ${decodeMs.toFixed(1)} ms  dropped ${stats.dropped}  queue ${queue}`;
}, 1000);

const options = new cast.framework.CastReceiverOptions();
options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
options.disableIdleTimeout = true; // no media is "playing" via CAF, so keep the receiver alive while connected
options.skipPlayersLoad = true;    // we do not use the CAF media player
context.start(options);
showDiag();
