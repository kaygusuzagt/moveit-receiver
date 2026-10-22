// Move IT Custom Web Receiver.
// Receives phone-rendered H.264 (Annex B) over the Cast custom namespace, decodes it with WebCodecs and draws it.
// Milestone 0 candidate transport — see README "Google Cast streaming".
'use strict';

const NAMESPACE = 'urn:x-cast:com.moveit.stream';
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');

const context = cast.framework.CastReceiverContext.getInstance();
const hasWebCodecs = typeof window.VideoDecoder === 'function';

let decoder = null;
let configuredCodec = null;
let needKeyframe = true;
let sender = null;
const partial = new Map(); // frame id -> { n, parts[], k }

const stats = { decoded: 0, dropped: 0, decodeMs: [], window: [] };
const decodeStart = new Map(); // frame id -> performance.now()

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

function createDecoder(codec, width, height) {
  if (!hasWebCodecs) {
    setStatus('This TV’s browser has no WebCodecs — the phone stream cannot be decoded here.');
    send({ t: 'error', reason: 'webcodecs-unsupported' });
    return;
  }
  if (decoder && decoder.state !== 'closed') decoder.close();
  canvas.width = width;
  canvas.height = height;
  decoder = new VideoDecoder({
    output: (frame) => {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      const id = frame.timestamp; // we pass the frame id as the timestamp
      frame.close();
      const started = decodeStart.get(id);
      if (started !== undefined) {
        stats.decodeMs.push(performance.now() - started);
        if (stats.decodeMs.length > 60) stats.decodeMs.shift();
        decodeStart.delete(id);
      }
      stats.decoded++;
      stats.window.push(performance.now());
      send({ t: 'ack', id });
    },
    error: (e) => {
      setStatus('Decoder error: ' + e.message);
      needKeyframe = true;
      send({ t: 'needkey' });
      createDecoder(codec, width, height);
    },
  });
  // No description → Annex B input. Low-latency hint: render frames as soon as they decode.
  decoder.configure({ codec, codedWidth: width, codedHeight: height, optimizeForLatency: true });
  configuredCodec = codec;
  needKeyframe = true;
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
  // Anything older than this frame and still incomplete is lost.
  for (const id of partial.keys()) if (id < m.id) { partial.delete(id); stats.dropped++; needKeyframe = true; }

  if (!decoder || decoder.state !== 'configured') return;
  if (needKeyframe && !entry.k) { stats.dropped++; return; }
  if (decoder.decodeQueueSize > 4) { stats.dropped++; needKeyframe = true; send({ t: 'needkey' }); return; }
  needKeyframe = false;

  const bytes = base64ToBytes(entry.parts.join(''));
  decodeStart.set(m.id, performance.now());
  decoder.decode(new EncodedVideoChunk({ type: entry.k ? 'key' : 'delta', timestamp: m.id, data: bytes }));
  setStatus('');
}

context.addCustomMessageListener(NAMESPACE, (event) => {
  sender = event.senderId;
  const m = event.data;
  switch (m.t) {
    case 'hello':
      send({ t: 'hello', webcodecs: hasWebCodecs, ua: navigator.userAgent, w: window.innerWidth, h: window.innerHeight });
      setStatus(hasWebCodecs ? 'Connected — waiting for video…' : 'Connected, but WebCodecs is unavailable on this device.');
      break;
    case 'cfg':
      if (m.codec !== configuredCodec || canvas.width !== m.w || canvas.height !== m.h) createDecoder(m.codec, m.w, m.h);
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
  const message = { t: 'rstats', fps: stats.window.length, decodeMs, dropped: stats.dropped, queue: decoder ? decoder.decodeQueueSize : 0 };
  send(message);
  statsEl.textContent = `fps ${message.fps}  decode ${decodeMs.toFixed(1)} ms  dropped ${stats.dropped}  queue ${message.queue}`;
}, 1000);

const options = new cast.framework.CastReceiverOptions();
options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
options.disableIdleTimeout = true; // no media is "playing", so keep the receiver alive while connected
options.skipPlayersLoad = true;    // we do not use the CAF media player
context.start(options);
