const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let ad;
try { ad = require('naudiodon'); } catch (e) { ad = null; console.warn('naudiodon not available — native audio disabled:', e.message); }

let ffmpegPath;
try { ffmpegPath = require('ffmpeg-static'); if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked'); } catch (e) { ffmpegPath = null; console.warn('ffmpeg-static not available:', e.message); }

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// ============================================================
// BIQUAD (RBJ Audio EQ Cookbook) — one filter, one channel. Mirrors the
// exact formulas AURA's own Web Audio BiquadFilterNode uses internally for
// 'peaking' / 'lowshelf' / 'highshelf', with S (shelf slope) fixed at 1 to
// match the Web Audio default, so the native path shapes tone the same way
// the browser path does — not just "an EQ that exists", the SAME curve.
// Keeps its own x1/x2/y1/y2 history across calls, since audio arrives in
// small chunks; a filter that forgot its history at every chunk boundary
// would click on every single write.
// ============================================================
class Biquad {
  constructor(){ this.b0=1; this.b1=0; this.b2=0; this.a1=0; this.a2=0; this.x1=0; this.x2=0; this.y1=0; this.y2=0; }
  _norm(b0,b1,b2,a0,a1,a2){ this.b0=b0/a0; this.b1=b1/a0; this.b2=b2/a0; this.a1=a1/a0; this.a2=a2/a0; }
  setBypass(){ this.b0=1; this.b1=0; this.b2=0; this.a1=0; this.a2=0; }
  setPeaking(freq, Q, gainDb, sampleRate){
    const A = Math.pow(10, gainDb/40);
    const w0 = 2*Math.PI*freq/sampleRate;
    const alpha = Math.sin(w0)/(2*Math.max(Q,0.0001));
    const cosw0 = Math.cos(w0);
    this._norm(1+alpha*A, -2*cosw0, 1-alpha*A, 1+alpha/A, -2*cosw0, 1-alpha/A);
  }
  setLowShelf(freq, gainDb, sampleRate){
    const A = Math.pow(10, gainDb/40);
    const w0 = 2*Math.PI*freq/sampleRate;
    const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
    const alpha = sinw0/2*Math.sqrt((A+1/A)*(1/1-1)+2); // S=1
    const twoSqrtAAlpha = 2*Math.sqrt(A)*alpha;
    this._norm(
      A*((A+1)-(A-1)*cosw0+twoSqrtAAlpha), 2*A*((A-1)-(A+1)*cosw0), A*((A+1)-(A-1)*cosw0-twoSqrtAAlpha),
      (A+1)+(A-1)*cosw0+twoSqrtAAlpha, -2*((A-1)+(A+1)*cosw0), (A+1)+(A-1)*cosw0-twoSqrtAAlpha
    );
  }
  setHighShelf(freq, gainDb, sampleRate){
    const A = Math.pow(10, gainDb/40);
    const w0 = 2*Math.PI*freq/sampleRate;
    const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
    const alpha = sinw0/2*Math.sqrt((A+1/A)*(1/1-1)+2); // S=1
    const twoSqrtAAlpha = 2*Math.sqrt(A)*alpha;
    this._norm(
      A*((A+1)+(A-1)*cosw0+twoSqrtAAlpha), -2*A*((A-1)+(A+1)*cosw0), A*((A+1)+(A-1)*cosw0-twoSqrtAAlpha),
      (A+1)-(A-1)*cosw0+twoSqrtAAlpha, 2*((A-1)-(A+1)*cosw0), (A+1)-(A-1)*cosw0-twoSqrtAAlpha
    );
  }
  process(x){
    const y = this.b0*x + this.b1*this.x1 + this.b2*this.x2 - this.a1*this.y1 - this.a2*this.y2;
    this.x2=this.x1; this.x1=x; this.y2=this.y1; this.y1=y;
    return y;
  }
}

// ============================================================
// NATIVE EQ/TONE CHAIN — runs entirely in Node, sample-by-sample, on the
// mixed PCM before it's written to the device. Mirrors AURA's Web Audio
// signal order: graphic EQ (12/32/64 band) -> preamp -> bass -> treble ->
// vocal -> presence -> air -> balance. Anything AURA sends 0dB/0 for is
// skipped as a bypass (setBypass), so a flat EQ costs almost nothing.
//
// HONEST ABOUT WHAT THIS IS NOT: this is the graphic EQ + Tone Control
// stack only. PureCore, distortion, delay/echo, convolution reverb,
// mid-side widener, 8D auto-pan, the dynamics compressor and the
// brickwall limiter all still live only in the Web Audio graph — porting
// a full real-time convolution reverb and compressor to native PCM is a
// much bigger job than this pass, and AURA already knows how to fall
// back to Web Audio (crossfade does exactly that). Because the safety
// limiter isn't ported yet, this chain hard-clamps to [-1,1] as a last
// line of defense — less musical than a real lookahead limiter, but it
// stops digital clipping from a heavy EQ boost.
// ============================================================
class NativeEQChain {
  constructor(){
    this.sampleRate = 44100;
    this.enabled = true;
    this.graphicBands = [];
    this.tone = { preamp:0, balance:0, bass:0, treble:0, vocal:0, presence:0, air:0 };
    this.toneFilters = {
      bass:     { l:new Biquad(), r:new Biquad() },
      treble:   { l:new Biquad(), r:new Biquad() },
      vocal:    { l:new Biquad(), r:new Biquad() },
      presence: { l:new Biquad(), r:new Biquad() },
      air:      { l:new Biquad(), r:new Biquad() }
    };
    this._rebuildTone();
  }
  setSampleRate(sr){
    if (sr && sr !== this.sampleRate){ this.sampleRate = sr; this._rebuildGraphic(); this._rebuildTone(); }
  }
  setGraphicEQ(freqs, gains, enabled){
    this.enabled = !!enabled;
    freqs = Array.isArray(freqs) ? freqs : [];
    this.graphicBands = freqs.map((freq,i) => ({
      freq, Q: 1.3,
      gain: this.enabled ? (Number(gains && gains[i]) || 0) : 0,
      type: i===0 ? 'lowshelf' : (i===freqs.length-1 ? 'highshelf' : 'peaking'),
      l: new Biquad(), r: new Biquad()
    }));
    this._rebuildGraphic();
  }
  setTone(t){ this.tone = Object.assign({}, this.tone, t||{}); this._rebuildTone(); }
  _configure(biquad, type, freq, Q, gainDb){
    if (!gainDb){ biquad.setBypass(); return; }
    if (type === 'lowshelf') biquad.setLowShelf(freq, gainDb, this.sampleRate);
    else if (type === 'highshelf') biquad.setHighShelf(freq, gainDb, this.sampleRate);
    else biquad.setPeaking(freq, Q || 1.3, gainDb, this.sampleRate);
  }
  _rebuildGraphic(){
    this.graphicBands.forEach(b => {
      this._configure(b.l, b.type, b.freq, b.Q, b.gain);
      this._configure(b.r, b.type, b.freq, b.Q, b.gain);
    });
  }
  _rebuildTone(){
    const cfg = [
      ['bass','lowshelf',150,undefined],
      ['treble','highshelf',6500,undefined],
      ['vocal','peaking',2500,1.1],
      ['presence','peaking',5000,1.0],
      ['air','highshelf',13000,undefined]
    ];
    cfg.forEach(([key,type,freq,Q]) => {
      const gain = this.tone[key] || 0;
      const f = this.toneFilters[key];
      this._configure(f.l, type, freq, Q, gain);
      this._configure(f.r, type, freq, Q, gain);
    });
  }
  // Processes one stereo frame, returns [l, r].
  processFrame(l, r){
    if (this.enabled){
      for (const b of this.graphicBands){ l = b.l.process(l); r = b.r.process(r); }
    }
    const preampGain = Math.pow(10, (this.tone.preamp||0)/20);
    l *= preampGain; r *= preampGain;
    l = this.toneFilters.bass.l.process(l);     r = this.toneFilters.bass.r.process(r);
    l = this.toneFilters.treble.l.process(l);   r = this.toneFilters.treble.r.process(r);
    l = this.toneFilters.vocal.l.process(l);    r = this.toneFilters.vocal.r.process(r);
    l = this.toneFilters.presence.l.process(l); r = this.toneFilters.presence.r.process(r);
    l = this.toneFilters.air.l.process(l);      r = this.toneFilters.air.r.process(r);
    // Balance: equal-power stereo pan, same algorithm the Web Audio spec
    // defines for StereoPannerNode on a stereo input.
    const pan = Math.max(-1, Math.min(1, (this.tone.balance||0)/100));
    if (pan !== 0){
      const x = pan <= 0 ? pan + 1 : pan;
      const gl = Math.cos(x*Math.PI/2), gr = Math.sin(x*Math.PI/2);
      if (pan <= 0) { const outL = l + r*gl, outR = r*gr; l = outL; r = outR; }
      else          { const outL = l*gl, outR = r + l*gr; l = outL; r = outR; }
    }
    return [l, r];
  }
}

// ============================================================
// NativeAudioPlayer — decodes whole tracks to PCM via ffmpeg, then feeds a
// naudiodon (PortAudio/WASAPI) output stream in small chunks, mixing up to
// two "decks" (A/B) so a real crossfade can happen entirely in the native
// path instead of forcing a fallback to Web Audio the way v1 did.
//
// FORMAT/FIDELITY: a fresh, non-crossfaded track is probed (via a quick
// ffmpeg -t 0.05 pass) for its OWN sample rate and bit depth, and decoded
// to match — this is the actual "bit-perfect" part; v1 silently forced
// everything to 44100/16-bit regardless of source, which was quietly
// downsampling every 48kHz/24-bit FLAC in the library. If the output
// device rejects that format, this falls back to 44100/16-bit and tells
// the renderer so (`usedFallbackRate`), rather than pretending it worked.
// A track that crossfades IN, though, is decoded to match whatever format
// the stream is already open at — two different sample rates can't be
// summed sample-for-sample without resampling one of them first, so a
// crossfaded track trades a little of that per-track fidelity for being
// mixable at all. Same trade-off any real crossfading player makes.
//
// KNOWN LIMITS (still true, see README):
//  - No native PureCore/distortion/delay/reverb/mid-side/8D/compressor —
//    EQ + Tone Control only (see NativeEQChain above).
//  - No real lookahead limiter — hard-clamped instead.
//  - Whole-track decode into memory; fine for songs, not hour-long mixes.
//  - True ASIO exclusive mode isn't included (Steinberg's SDK is
//    proprietary and can't be bundled). This is WASAPI — native and
//    low-latency, not full ASIO.
//  - Seeking mid-crossfade only moves the currently-primary deck; the
//    outgoing deck's fade continues on its own schedule. Edge case, not
//    expected to come up in normal use (nobody scrubs during a crossfade).
// ============================================================
class NativeAudioPlayer {
  constructor(){
    this.io = null;
    this.sampleRate = 44100;
    this.bitDepth = 16;
    this.channels = 2;
    this.decks = { A: this._freshDeck(), B: this._freshDeck() };
    this.activeDeckId = 'A';
    this.playing = false;
    this.masterVolume = 1;
    this.chunkMs = 40; // was effectively ~100ms in v1; smaller chunks = lower added latency
    this.onEnd = null;
    this.eq = new NativeEQChain();
    this._pumping = false;
    this._pumpTimer = null;
    this._posInterval = null;
  }
  _freshDeck(){ return { pcm:null, cursor:0, gain:1, targetGain:1, gainStep:0, ended:false }; }
  bytesPerSample(){ return this.bitDepth === 24 ? 3 : 2; }
  bytesPerFrame(){ return this.bytesPerSample() * this.channels; }

  _probeFormat(tmpPath){
    return new Promise((resolve) => {
      if (!ffmpegPath) return resolve({ sampleRate: 44100, bitDepth: 16 });
      let stderr = '';
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
      let ff;
      try { ff = spawn(ffmpegPath, ['-y', '-t', '0.05', '-i', tmpPath, '-f', 'null', '-']); }
      catch (e) { return finish({ sampleRate: 44100, bitDepth: 16 }); }
      ff.stderr.on('data', d => { stderr += d.toString(); });
      ff.on('close', () => {
        const rateMatch = stderr.match(/Audio:[^\n]*?(\d+)\s*Hz/);
        const depthMatch = stderr.match(/Audio:[^\n]*?,\s*(u8|s16p?|s24p?|s32p?|flt(?:p)?|dbl(?:p)?)\b/);
        let sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 44100;
        if (!(sampleRate > 0 && sampleRate <= 384000)) sampleRate = 44100;
        let bitDepth = 16;
        if (depthMatch && /^(s24|s32|flt|dbl)/.test(depthMatch[1])) bitDepth = 24;
        finish({ sampleRate, bitDepth });
      });
      ff.on('error', () => finish({ sampleRate: 44100, bitDepth: 16 }));
    });
  }

  async _decodeToPCM(nodeBuffer, forceRate, forceDepth){
    if (!ffmpegPath) throw new Error('ffmpeg-static missing — run npm install');
    const tmp = path.join(os.tmpdir(), `aura_native_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmp, nodeBuffer);
    try {
      let targetRate = forceRate, targetDepth = forceDepth;
      if (!targetRate || !targetDepth){
        const probe = await this._probeFormat(tmp);
        targetRate = targetRate || probe.sampleRate;
        targetDepth = targetDepth || probe.bitDepth;
      }
      const fmt = targetDepth === 24 ? 's24le' : 's16le';
      const codec = targetDepth === 24 ? 'pcm_s24le' : 'pcm_s16le';
      const pcm = await new Promise((resolve, reject) => {
        const chunks = [];
        const ff = spawn(ffmpegPath, ['-y', '-i', tmp, '-f', fmt, '-acodec', codec, '-ar', String(targetRate), '-ac', '2', 'pipe:1']);
        ff.stdout.on('data', d => chunks.push(d));
        ff.stderr.on('data', () => {});
        ff.on('error', reject);
        ff.on('close', code => {
          if (code !== 0 && chunks.length === 0) return reject(new Error('ffmpeg decode failed (exit ' + code + ')'));
          resolve(Buffer.concat(chunks));
        });
      });
      const bytesPerFrame = (targetDepth === 24 ? 3 : 2) * 2;
      return { pcm, sampleRate: targetRate, bitDepth: targetDepth, durationSec: pcm.length / (targetRate * bytesPerFrame) };
    } finally {
      fs.unlink(tmp, () => {});
    }
  }

  _reopen(sampleRate, bitDepth){
    if (!ad) throw new Error('naudiodon not available (native module not compiled)');
    if (this.io) { try { this.io.quit(); } catch (e) {} this.io = null; }
    // Throw instead of silently downgrading: the PCM buffer being fed in was
    // already decoded at `bitDepth` bytes/sample. If this quietly opened the
    // device at 16-bit while the caller keeps writing 24-bit-encoded PCM,
    // every sample boundary would be misread — that's noise, not a graceful
    // degrade. Throwing here lets playTrack()'s existing catch block do the
    // correct thing: re-decode AND reopen at a matching 44100/16 together.
    if (bitDepth === 24 && !ad.SampleFormat24Bit) {
      throw new Error('24-bit output not supported by this naudiodon build');
    }
    const wantFmt = bitDepth === 24 ? ad.SampleFormat24Bit : ad.SampleFormat16Bit;
    this.io = new ad.AudioIO({
      outOptions: {
        channelCount: this.channels,
        sampleFormat: wantFmt,
        sampleRate: sampleRate,
        deviceId: -1,
        closeOnError: true
      }
    });
    this.io.start();
    this.sampleRate = sampleRate;
    this.bitDepth = bitDepth;
  }

  stopDeck(id){ this.decks[id] = this._freshDeck(); }

  async playTrack(nodeBuffer, opts){
    opts = opts || {};
    const crossfadeSec = opts.crossfadeSec > 0 ? opts.crossfadeSec : 0;
    const outgoingId = this.activeDeckId;
    const canMix = crossfadeSec > 0 && this.io && this.playing && this.decks[outgoingId].pcm && !this.decks[outgoingId].ended;

    if (!canMix) {
      const { pcm, sampleRate, bitDepth, durationSec } = await this._decodeToPCM(nodeBuffer, null, null);
      this.stopDeck('A'); this.stopDeck('B');
      const deck = this.decks.A;
      deck.pcm = pcm; deck.cursor = 0; deck.gain = 1; deck.targetGain = 1; deck.gainStep = 0; deck.ended = false;
      this.activeDeckId = 'A';
      let usedFallbackRate = false;
      try {
        this._reopen(sampleRate, bitDepth);
      } catch (e) {
        console.warn('Native output failed at', sampleRate, bitDepth + '-bit, falling back to 44100/16-bit:', e.message);
        usedFallbackRate = true;
        const fb = await this._decodeToPCM(nodeBuffer, 44100, 16);
        deck.pcm = fb.pcm;
        this._reopen(44100, 16);
      }
      this.eq.setSampleRate(this.sampleRate);
      this.playing = true;
      this._startPump();
      return { durationSec, sampleRate: this.sampleRate, bitDepth: this.bitDepth, usedFallbackRate, crossfading: false };
    } else {
      const incomingId = outgoingId === 'A' ? 'B' : 'A';
      const { pcm, durationSec } = await this._decodeToPCM(nodeBuffer, this.sampleRate, this.bitDepth);
      const inDeck = this.decks[incomingId];
      inDeck.pcm = pcm; inDeck.cursor = 0; inDeck.gain = 0; inDeck.targetGain = 1;
      inDeck.gainStep = 1 / Math.max(0.05, crossfadeSec) / this.sampleRate;
      inDeck.ended = false;
      const outDeck = this.decks[outgoingId];
      outDeck.targetGain = 0;
      outDeck.gainStep = -outDeck.gain / Math.max(0.05, crossfadeSec) / this.sampleRate;
      this.activeDeckId = incomingId; // flips immediately, same as AURA's own Web Audio crossfade flips `usingA` right away
      return { durationSec, sampleRate: this.sampleRate, bitDepth: this.bitDepth, usedFallbackRate: false, crossfading: true };
    }
  }

  _renderChunk(){
    const bytesPerSample = this.bytesPerSample();
    const bytesPerFrame = bytesPerSample * this.channels;
    const chunkFrames = Math.max(1, Math.round(this.sampleRate * (this.chunkMs/1000)));
    const scale = this.bitDepth === 24 ? 8388608 : 32768;
    const outBuf = Buffer.alloc(chunkFrames * bytesPerFrame);
    let framesWritten = 0;
    let deckEndedNatural = false;

    for (let i=0; i<chunkFrames; i++){
      let mixL = 0, mixR = 0, anyActive = false;
      for (const id of ['A','B']){
        const d = this.decks[id];
        if (!d.pcm) continue;
        if (d.cursor + bytesPerFrame > d.pcm.length){
          if (!d.ended){
            d.ended = true;
            if (id === this.activeDeckId && d.targetGain > 0) deckEndedNatural = true;
            if (id !== this.activeDeckId) d.pcm = null; // stale fade-out deck ran dry before its gain ramp finished — free it now rather than waiting on an exact gain match
          }
          continue;
        }
        anyActive = true;
        const l = d.pcm.readIntLE(d.cursor, bytesPerSample) / scale;
        const r = d.pcm.readIntLE(d.cursor + bytesPerSample, bytesPerSample) / scale;
        if (d.gain !== d.targetGain){
          d.gain += d.gainStep;
          if ((d.gainStep > 0 && d.gain >= d.targetGain) || (d.gainStep < 0 && d.gain <= d.targetGain)){
            d.gain = d.targetGain;
            if (d.gain === 0) d.pcm = null; // faded fully out — release it (not a natural end, so no onEnd)
            else if (d.gain === 1 && id !== this.activeDeckId) this.activeDeckId = id; // faded fully in — promote
          }
        }
        mixL += l * d.gain; mixR += r * d.gain;
        d.cursor += bytesPerFrame;
      }
      if (!anyActive) break;
      let [pl, pr] = this.eq.processFrame(mixL, mixR);
      pl *= this.masterVolume; pr *= this.masterVolume;
      pl = Math.max(-1, Math.min(1, pl));
      pr = Math.max(-1, Math.min(1, pr));
      // scale-1/-scale, not scale/-scale: a clamped peak sitting at exactly
      // ±1.0 rounds to exactly ±scale, which is one past the signed range
      // Buffer.writeIntLE accepts — it throws a RangeError there, dropping
      // that whole chunk. The hard-clamp two lines up makes hitting exactly
      // 1.0 routine (any EQ boost that clips lands right on the ceiling), so
      // this isn't a hypothetical edge case — it happens on ordinary loud
      // masters.
      const maxSample = scale - 1, minSample = -scale;
      let sl = Math.round(pl*scale); if (sl > maxSample) sl = maxSample; else if (sl < minSample) sl = minSample;
      let sr = Math.round(pr*scale); if (sr > maxSample) sr = maxSample; else if (sr < minSample) sr = minSample;
      outBuf.writeIntLE(sl, framesWritten*bytesPerFrame, bytesPerSample);
      outBuf.writeIntLE(sr, framesWritten*bytesPerFrame + bytesPerSample, bytesPerSample);
      framesWritten++;
    }
    const buf = framesWritten === chunkFrames ? outBuf : outBuf.subarray(0, framesWritten*bytesPerFrame);
    return { buf, framesWritten, deckEndedNatural };
  }

  _startPump(){
    if (!this._pumping){
      this._pumping = true;
      this._pumpTick();
    }
    if (!this._posInterval){
      this._posInterval = setInterval(() => {
        if (mainWindow && this.playing) {
          try { mainWindow.webContents.send('native-audio:position', this.getPosition()); } catch (e) {}
        }
      }, 200);
    }
  }

  _pumpTick(){
    if (!this._pumping) return;
    if (!this.playing || !this.io){
      this._pumpTimer = setTimeout(() => this._pumpTick(), this.chunkMs);
      return;
    }
    let result;
    try { result = this._renderChunk(); }
    catch (e) { console.error('native pump error:', e); this._pumpTimer = setTimeout(() => this._pumpTick(), this.chunkMs); return; }
    const { buf, framesWritten, deckEndedNatural } = result;
    if (framesWritten > 0){
      let ok = true;
      try { ok = this.io.write(buf); } catch (e) { console.error('native write error:', e); }
      if (ok === false) this.io.once('drain', () => this._pumpTick());
      else this._pumpTimer = setTimeout(() => this._pumpTick(), this.chunkMs);
    } else {
      this._pumpTimer = setTimeout(() => this._pumpTick(), this.chunkMs);
    }
    if (deckEndedNatural){
      this.playing = false;
      if (this.onEnd) this.onEnd();
    }
  }

  pause(){ this.playing = false; }
  resume(){ if (this.decks[this.activeDeckId].pcm) this.playing = true; }
  stop(){
    this.playing = false;
    this._pumping = false;
    if (this._pumpTimer) clearTimeout(this._pumpTimer);
    if (this._posInterval) { clearInterval(this._posInterval); this._posInterval = null; }
    this.stopDeck('A'); this.stopDeck('B');
    this.activeDeckId = 'A';
    if (this.io) { try { this.io.quit(); } catch (e) {} this.io = null; }
  }
  seek(sec){
    const d = this.decks[this.activeDeckId];
    if (!d.pcm) return;
    const frame = Math.max(0, Math.floor(sec * this.sampleRate)) * this.bytesPerFrame();
    d.cursor = Math.max(0, Math.min(d.pcm.length, frame));
    d.ended = false;
  }
  setVolume(v){ this.masterVolume = Math.max(0, Math.min(1, v)); }
  getPosition(){
    const d = this.decks[this.activeDeckId];
    if (!d.pcm && !d.cursor) return 0;
    return d.cursor / (this.sampleRate * this.bytesPerFrame());
  }
  setEQ(payload){ this.eq.setGraphicEQ(payload && payload.freqs, payload && payload.gains, payload && payload.enabled); }
  setTone(payload){ this.eq.setTone(payload); }
}

const player = new NativeAudioPlayer();
player.onEnd = () => { if (mainWindow) mainWindow.webContents.send('native-audio:ended'); };

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('native-audio:list-devices', () => {
  if (!ad) return [];
  try { return ad.getDevices().filter(d => d.maxOutputChannels > 0); }
  catch (e) { return []; }
});

ipcMain.handle('native-audio:play-track', async (evt, arrayBuffer, opts) => {
  try {
    const info = await player.playTrack(Buffer.from(arrayBuffer), opts || {});
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('native-audio:pause', () => { try { player.pause(); } catch (e) {} return true; });
ipcMain.handle('native-audio:resume', () => { try { player.resume(); } catch (e) {} return true; });
ipcMain.handle('native-audio:stop', () => { try { player.stop(); } catch (e) {} return true; });
ipcMain.handle('native-audio:seek', (evt, sec) => { try { player.seek(sec); } catch (e) {} return true; });
ipcMain.handle('native-audio:set-volume', (evt, vol) => { try { player.setVolume(vol); } catch (e) {} return true; });
ipcMain.handle('native-audio:get-position', () => { try { return player.getPosition(); } catch (e) { return 0; } });
ipcMain.handle('native-audio:set-eq', (evt, payload) => { try { player.setEQ(payload); return true; } catch (e) { return false; } });
ipcMain.handle('native-audio:set-tone', (evt, payload) => { try { player.setTone(payload); return true; } catch (e) { return false; } });
