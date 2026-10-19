/**
 * The plain test diagnostic client (unstyled HTML + vanilla JS, no frontend
 * framework, no product UI).
 *
 * This is TEST TOOLING, not a v1 contract route: it exists so a driver
 * (agent-browser or a human) can exercise the capture/mic/PCM/playback/
 * interruption/fresh-reconnect paths against a local Ranger API. It holds no
 * secrets: the caller pastes their own bearer credential into the page (kept
 * in page memory only, never logged or persisted), and every provider
 * interaction still flows through Ranger.
 *
 * Honesty rules enforced by the page itself:
 * - every diagnostic outcome carries a stable code and a `synthetic` flag;
 * - fake/automation device streams are labeled synthetic:true;
 * - the page states explicitly that the physical-device path is NOT TESTED
 *   on this host (no physical microphone/display hardware exists here).
 */

export const DIAGNOSTIC_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ranger media diagnostic (test tooling)</title>
</head>
<body style="max-width: 60em; font-family: monospace; margin: 2em auto;">
<h1>Ranger media diagnostic (plain test tooling)</h1>
<p>
  Unstyled diagnostic for the voice relay, latest-frame capture and on-demand
  inspection. No framework, no product UI, no provider calls from the browser:
  Ranger opens the provider connection with its server-side key.
</p>
<p id="physical-device-note">
  <strong>Honesty labels:</strong> this host has <strong>no physical
  microphone or capture display</strong>. Any device stream obtained here is
  synthetic (fake device) or an error path. Physical-device paths are
  <strong>NOT TESTED</strong> on this host. Synthetic evidence is labeled
  <code>synthetic:true</code> and is never reported as human permission
  testing.
</p>

<h2>1. Identity and project</h2>
<p>
  <label>Bearer credential: <input id="token" type="password" size="40" autocomplete="off"></label>
  <label>projectId: <input id="projectId" size="40"></label>
  <label>conversationId: <input id="conversationId" size="40"></label>
</p>
<p>
  <button id="btnCreateConversation">create conversation</button>
</p>

<h2>2. Voice relay</h2>
<p>
  <button id="btnStartVoice">start voice session</button>
  <button id="btnOpenRelay">open relay (fresh ticket)</button>
  <button id="btnSendPcm">send synthetic PCM tone</button>
  <button id="btnSendText">send text turn</button>
  <button id="btnInterrupt">interrupt voice response</button>
  <button id="btnEndVoice">end voice session</button>
  <button id="btnFreshReconnect">fresh reconnect (new session + ticket)</button>
  <button id="btnGetVoice">read session/usage</button>
</p>
<p>Synthetic PCM: 0.25s of a 440 Hz sine, 16-bit LE 24 kHz mono, sent as
input_audio_buffer.append frames through the relay. The browser never touches
a provider URL.</p>

<h2>3. Microphone diagnostics (device enumeration)</h2>
<p>
  <button id="btnMic">run getUserMedia diagnostic</button>
</p>

<h2>4. Capture and inspection</h2>
<p>
  <button id="btnStartCapture">start capture session</button>
  <button id="btnDisplay">getDisplayMedia diagnostic</button>
  <button id="btnIngest">ingest synthetic canvas frame</button>
  <button id="btnInspect">request inspection</button>
  <button id="btnEndCapture">end capture (clears latest frame)</button>
  <button id="btnLateIngest">post-end upload (must be rejected)</button>
</p>

<h2>5. Diagnostic log</h2>
<pre id="log" style="white-space: pre-wrap; border: 1px solid #999; padding: 1em;"></pre>

<script>
'use strict';
var state = { voiceSessionId: null, captureSessionId: null, relay: null, relayOpen: false };
var logEl = document.getElementById('log');
function log(entry) {
  entry.ts = new Date().toISOString();
  logEl.textContent += JSON.stringify(entry) + '\\n';
}
function diag(code, detail, synthetic) {
  log({ kind: 'diagnostic', code: code, detail: detail, synthetic: synthetic === true });
  return { code: code, detail: detail, synthetic: synthetic === true };
}
function token() { return document.getElementById('token').value.trim(); }
function projectId() { return document.getElementById('projectId').value.trim(); }
function conversationId() { return document.getElementById('conversationId').value.trim(); }
function headers(extra) {
  var h = extra || {};
  h['authorization'] = 'Bearer ' + token();
  return h;
}
async function api(method, path, body) {
  var res = await fetch(path, {
    method: method,
    headers: headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'omit'
  });
  var json = await res.json();
  if (!res.ok) {
    log({ kind: 'api-error', path: path, status: res.status, code: json.error && json.error.code, requestId: json.requestId });
    throw new Error(json.error && json.error.code);
  }
  return json;
}
async function newTicket(purpose) {
  var out = await api('POST', '/v1/auth/connection-tickets', { projectId: projectId(), purpose: purpose, origin: location.origin });
  return out.ticket;
}
function closeRelay() {
  if (state.relay) { try { state.relay.close(); } catch (e) {} }
  state.relay = null; state.relayOpen = false;
}

document.getElementById('btnCreateConversation').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/conversations', { title: 'media diagnostic' });
    document.getElementById('conversationId').value = out.conversation.conversationId;
    log({ kind: 'conversation', conversationId: out.conversation.conversationId });
  } catch (e) {}
};

// ---- voice ----
document.getElementById('btnStartVoice').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/voice/sessions', { conversationId: conversationId() });
    state.voiceSessionId = out.session.sessionId;
    log({ kind: 'voice-session', sessionId: out.session.sessionId, model: out.session.model, expiresAt: out.session.expiresAt });
  } catch (e) {}
};
async function openRelayForCurrentSession() {
  closeRelay();
  var ticket = await newTicket('voice-relay');
  var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
    '/v1/projects/' + encodeURIComponent(projectId()) + '/voice/sessions/' + encodeURIComponent(state.voiceSessionId) +
    '/relay?ticket=' + encodeURIComponent(ticket);
  var ws = new WebSocket(url);
  state.relay = ws;
  ws.onopen = function () { state.relayOpen = true; diag('relay_open', 'relay WebSocket open (server dials the provider)', false); };
  ws.onmessage = function (event) {
    var frame;
    try { frame = JSON.parse(event.data); } catch (e) { frame = { type: 'unparsed' }; }
    if (frame.type === 'response.cancelled') diag('voice_response_flushed', 'interrupted: flush local playback buffer now', false);
    log({ kind: 'relay-frame', type: frame.type });
  };
  ws.onclose = function (event) {
    state.relayOpen = false;
    log({ kind: 'relay-close', code: event.code, reason: event.reason || '(none)' });
    if (event.code === 4409 || event.code === 4408 || event.code === 4503) {
      diag('voice_session_ended', 'session is terminal: use a FRESH session and a FRESH ticket to reconnect', false);
    }
  };
  ws.onerror = function () { log({ kind: 'relay-error' }); };
}
document.getElementById('btnOpenRelay').onclick = async function () {
  try { await openRelayForCurrentSession(); } catch (e) {}
};
function synthPcmChunks() {
  // 0.25s 440 Hz sine at 24 kHz, 16-bit LE mono, in 25 x 10ms chunks.
  var sampleRate = 24000, seconds = 0.25, chunk = 240;
  var total = Math.floor(sampleRate * seconds);
  var chunks = [];
  for (var start = 0; start < total; start += chunk) {
    var n = Math.min(chunk, total - start);
    var buf = new ArrayBuffer(n * 2);
    var view = new DataView(buf);
    for (var i = 0; i < n; i++) {
      var s = Math.round(Math.sin(2 * Math.PI * 440 * ((start + i) / sampleRate)) * 8000);
      view.setInt16(i * 2, s, true);
    }
    var bin = '';
    var bytes = new Uint8Array(buf);
    for (var b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
    chunks.push(btoa(bin));
  }
  return chunks;
}
document.getElementById('btnSendPcm').onclick = function () {
  if (!state.relayOpen) { diag('relay_not_open', 'open the relay first', false); return; }
  var chunks = synthPcmChunks();
  for (var i = 0; i < chunks.length; i++) {
    state.relay.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunks[i] }));
  }
  log({ kind: 'synthetic-pcm', frames: chunks.length, sampleRate: 24000, synthetic: true,
        note: 'synthetic tone, no physical microphone involved' });
};
document.getElementById('btnSendText').onclick = function () {
  if (!state.relayOpen) { diag('relay_not_open', 'open the relay first', false); return; }
  state.relay.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say: relay check ok.' }] }
  }));
  state.relay.send(JSON.stringify({ type: 'response.create' }));
  log({ kind: 'text-turn-sent', synthetic: true });
};
document.getElementById('btnInterrupt').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/voice/sessions/' + encodeURIComponent(state.voiceSessionId) + '/response/cancel');
    log({ kind: 'interrupt-requested', out: out });
  } catch (e) {}
};
document.getElementById('btnEndVoice').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/voice/sessions/' + encodeURIComponent(state.voiceSessionId) + '/end');
    closeRelay();
    log({ kind: 'voice-session-ended', sessionId: out.session.sessionId, state: out.session.state });
  } catch (e) {}
};
document.getElementById('btnFreshReconnect').onclick = async function () {
  try {
    // A reconnect ALWAYS creates a fresh session with a fresh ticket; no
    // provider state is reconstructed and no past tool call is replayed.
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/voice/sessions', { conversationId: conversationId() });
    state.voiceSessionId = out.session.sessionId;
    log({ kind: 'voice-session', sessionId: out.session.sessionId, fresh: true });
    await openRelayForCurrentSession();
  } catch (e) {}
};
document.getElementById('btnGetVoice').onclick = async function () {
  try {
    var out = await api('GET', '/v1/projects/' + encodeURIComponent(projectId()) + '/voice/sessions/' + encodeURIComponent(state.voiceSessionId));
    log({ kind: 'voice-usage', usage: out.usage, state: out.session.state });
  } catch (e) {}
};

// ---- microphone diagnostics (synthetic-labeled) ----
document.getElementById('btnMic').onclick = async function () {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    diag('unsupported_api', 'getUserMedia is not available in this browser', true);
    return;
  }
  // A pending prompt must never be a silent no-op: some environments (for
  // example a headless display-picker) never settle the promise.
  diag('device_prompt_pending', 'getUserMedia requested: waiting for grant, denial or device error (outcome logged when it settles)', true);
  var stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') diag('denied', 'permission denied by the browser', true);
    else if (err && err.name === 'NotFoundError') diag('no_device', 'no audio input device present (headless/no hardware)', true);
    else diag('runtime_error', String(err && err.name), true);
    return;
  }
  var devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {}
  var labels = devices.filter(function (d) { return d.kind === 'audioinput'; }).map(function (d) { return d.label; });
  var fake = labels.some(function (l) { return /fake/i.test(l); });
  stream.getTracks().forEach(function (t) { t.stop(); });
  diag('granted', 'audio capture granted; device labels: ' + JSON.stringify(labels), true);
  log({ kind: 'device-labels', synthetic: true, note: 'no physical microphone exists on this host; any granted stream is synthetic', fakeDevice: fake });
};

// ---- capture and inspection ----
document.getElementById('btnStartCapture').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/capture/sessions', {});
    state.captureSessionId = out.session.sessionId;
    log({ kind: 'capture-session', sessionId: out.session.sessionId, generation: out.session.generation });
  } catch (e) {}
};
document.getElementById('btnDisplay').onclick = async function () {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    diag('unsupported_api', 'getDisplayMedia is not available in this browser', true);
    return;
  }
  // A pending display-picker must never be a silent no-op: headless or
  // unattended environments may never settle the promise.
  diag('device_prompt_pending', 'getDisplayMedia requested: waiting for surface selection, denial or error (outcome logged when it settles)', true);
  var stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') diag('denied', 'screen sharing denied or unavailable', true);
    else if (err && err.name === 'NotFoundError') diag('no_device', 'no display surface available', true);
    else diag('runtime_error', String(err && err.name), true);
    return;
  }
  stream.getTracks().forEach(function (t) { t.stop(); });
  diag('granted', 'display media granted', true);
};
document.getElementById('btnIngest').onclick = async function () {
  try {
    // Synthetic evidence: a drawn canvas frame (never a physical display).
    var canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 200;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = '#ffffff'; ctx.font = '16px monospace';
    ctx.fillText('ranger diagnostic frame ' + Date.now(), 10, 100);
    var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    var buf = await blob.arrayBuffer();
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/capture/sessions/' + encodeURIComponent(state.captureSessionId) + '/frames', {
      frameId: 'diag-' + Date.now(),
      imageBase64: btoa(bin),
      captureTimestamp: new Date().toISOString(),
      declaredWidth: 1,
      declaredHeight: 1
    });
    log({ kind: 'frame-ingested', frame: out.frame, synthetic: true,
          note: 'synthetic canvas frame; client-declared dimensions are ignored by the server' });
  } catch (e) {}
};
document.getElementById('btnInspect').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/capture/sessions/' + encodeURIComponent(state.captureSessionId) + '/inspection', {});
    log({ kind: 'inspection', inspection: out.inspection });
  } catch (e) {}
};
document.getElementById('btnEndCapture').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/capture/sessions/' + encodeURIComponent(state.captureSessionId) + '/end');
    log({ kind: 'capture-session-ended', session: out.session });
  } catch (e) {}
};
document.getElementById('btnLateIngest').onclick = async function () {
  try {
    var out = await api('POST', '/v1/projects/' + encodeURIComponent(projectId()) + '/capture/sessions/' + encodeURIComponent(state.captureSessionId) + '/frames', {
      frameId: 'late-' + Date.now(),
      imageBase64: 'iVBORw0KGgo=',
      captureTimestamp: new Date().toISOString()
    });
    log({ kind: 'unexpected-accepted', out: out });
  } catch (e) {
    // expected: the ended capture must reject the late upload
  }
};
diag('diagnostic_loaded', 'physical device paths are NOT TESTED on this host; browser automation runs are synthetic:true', true);
</script>
</body>
</html>`;
