import { CanvasSink, type VideoCodec } from 'mediabunny';
import {
  mergeClips,
  probeClip,
  probeEncoders,
  type ClipInfo,
  type EncoderSupport,
  type MergeProgress,
  type OutputSink,
} from './merge';

type Entry = { id: number; file: File; info?: ClipInfo; thumb?: string; error?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>('file-input');
const drop = $<HTMLLabelElement>('drop');
const list = $<HTMLOListElement>('clips');
const listHead = $('list-head');
const summary = $('summary');
const resolutionSel = $<HTMLSelectElement>('resolution');
const customRes = $('custom-res');
const customW = $<HTMLInputElement>('custom-w');
const customH = $<HTMLInputElement>('custom-h');
const fpsSel = $<HTMLSelectElement>('fps');
const codecSel = $<HTMLSelectElement>('codec');
const qualitySel = $<HTMLSelectElement>('quality');
const customBitrate = $('custom-bitrate');
const bitrateInput = $<HTMLInputElement>('bitrate');
const mergeBtn = $<HTMLButtonElement>('merge');
const cancelBtn = $<HTMLButtonElement>('cancel');
const saveHint = $('save-hint');
const progressWrap = $('progress-wrap');
const pct = $('pct');
const phase = $('phase');
const bar = $('bar');
const barFill = $('bar-fill');
const stats = $('stats');
const accelSel = $<HTMLSelectElement>('accel');
const hwStatus = $('hw-status');
const confirmSw = $('confirm-sw');
const confirmSwText = $('confirm-sw-text');
const statusBox = $('status');
const result = $('result');
const preview = $<HTMLVideoElement>('preview');
const download = $<HTMLAnchorElement>('download');

const CODEC_LABELS: Record<string, string> = {
  avc: 'H.264',
  hevc: 'H.265 / HEVC',
  av1: 'AV1',
  vp9: 'VP9',
};

let entries: Entry[] = [];
let nextId = 1;
let running: AbortController | null = null;
let resultUrl: string | null = null;
let encoders: EncoderSupport[] = [];
let probeSeq = 0;
/** Progress of the clip currently being merged, keyed by entry id (0..1). */
const clipProgress = new Map<number, number>();
let activeClipId: number | null = null;
const baseTitle = document.title;
const canStreamToDisk = 'showSaveFilePicker' in window;

// ---------- helpers ----------

function fmtTime(sec: number): string {
  if (!isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function showStatus(msg: string, isError = false) {
  statusBox.textContent = msg;
  statusBox.classList.toggle('error', isError);
  statusBox.hidden = false;
}

function firstClip(): ClipInfo | undefined {
  return entries[0]?.info;
}

function targetSize(): { width: number; height: number } | null {
  const v = resolutionSel.value;
  if (v === 'source') {
    const first = firstClip();
    return first ? { width: even(first.width), height: even(first.height) } : null;
  }
  if (v === 'custom') {
    const w = even(Number(customW.value));
    const h = even(Number(customH.value));
    return w >= 16 && h >= 16 ? { width: w, height: h } : null;
  }
  const [w, h] = v.split('x').map(Number);
  return { width: w, height: h };
}

function even(n: number) {
  return Math.max(2, Math.round(n / 2) * 2);
}

const NTSC_RATES = [24000 / 1001, 30000 / 1001, 60000 / 1001, 120000 / 1001];
const COMMON_RATES = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];

/**
 * Screen recorders often produce slightly irregular timing, so a "60 fps" capture can measure 59.886. Rates within
 * 0.5% of a common rate are treated as that rate. NTSC rates (59.94 etc.) only match when essentially exact, since
 * real NTSC files measure precisely. Anything else, such as 45 fps, is kept as measured.
 */
function snapFps(fps: number): number {
  const ntsc = NTSC_RATES.find((r) => Math.abs(r - fps) / r < 0.0002);
  if (ntsc) return ntsc;
  const common = COMMON_RATES.find((r) => Math.abs(r - fps) / r < 0.005);
  if (common) return common;
  return Number(fps.toFixed(3));
}

function fmtFps(fps: number): string {
  return String(Number(fps.toFixed(3)));
}

function targetFps(): number | null {
  if (fpsSel.value === 'source') {
    const first = firstClip();
    return first ? snapFps(first.fps) : null;
  }
  return Number(fpsSel.value);
}

/** Bits per pixel per frame for each preset, applied to the output's pixel rate. */
const QUALITY_BPP: Record<string, number> = { 'very-high': 0.15, high: 0.1, medium: 0.06, low: 0.035 };

function fmtMbps(bps: number): string {
  return `${(bps / 1e6).toFixed(bps < 10e6 ? 1 : 0)} Mbps`;
}

function roundBitrate(bps: number): number {
  return Math.max(100_000, Math.round(bps / 100_000) * 100_000);
}

/** The first clip's bitrate, scaled by pixel rate if the output size or frame rate differs from it. */
function sourceBitrate(width: number, height: number, fps: number): number | null {
  const first = firstClip();
  if (!first || !first.bitrate) return null;
  const scale = (width * height * fps) / (first.width * first.height * snapFps(first.fps));
  return roundBitrate(first.bitrate * scale);
}

function outputShape() {
  const size = targetSize() ?? { width: 3440, height: 1440 };
  return { ...size, fps: targetFps() ?? 60 };
}

// ---------- clip list ----------

async function addFiles(files: Iterable<File>) {
  const added: Entry[] = [];
  for (const file of files) {
    const entry: Entry = { id: nextId++, file };
    entries.push(entry);
    added.push(entry);
  }
  render();
  await Promise.all(
    added.map(async (entry) => {
      try {
        entry.info = await probeClip(entry.file);
        const sink = new CanvasSink(entry.info.video, { width: 240, height: 100, fit: 'contain' });
        const frame = await sink.getCanvas(entry.info.start + Math.min(1, entry.info.duration / 2));
        if (frame) entry.thumb = await thumbUrl(frame.canvas);
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
      render();
    }),
  );
  refreshCodecs();
  renderHw();
}

async function thumbUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  return blob ? URL.createObjectURL(blob) : '';
}

function disposeEntry(e: Entry) {
  e.info?.input.dispose();
  if (e.thumb) URL.revokeObjectURL(e.thumb);
}

function removeEntry(id: number) {
  const e = entries.find((x) => x.id === id);
  if (e) disposeEntry(e);
  entries = entries.filter((x) => x.id !== id);
  render();
}

function move(id: number, delta: number) {
  const i = entries.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= entries.length) return;
  [entries[i], entries[j]] = [entries[j], entries[i]];
  render();
}

let dragId: number | null = null;
let lastFirstKey: number | null = null;

function render() {
  list.replaceChildren(
    ...entries.map((entry, idx) => {
      const li = document.createElement('li');
      li.className = 'clip' + (entry.info || entry.error ? '' : ' loading');
      li.draggable = !running;
      li.dataset.id = String(entry.id);

      const index = document.createElement('span');
      index.className = 'index';
      index.textContent = String(idx + 1);

      let thumb: HTMLElement;
      if (entry.thumb) {
        const img = document.createElement('img');
        img.src = entry.thumb;
        img.alt = '';
        thumb = img;
      } else {
        thumb = document.createElement('div');
      }
      thumb.classList.add('thumb');

      const body = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = entry.file.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      if (entry.error) {
        meta.innerHTML = '';
        const w = document.createElement('span');
        w.className = 'warn';
        w.textContent = entry.error;
        meta.append(w);
      } else if (entry.info) {
        const i = entry.info;
        const chips = document.createElement('div');
        chips.className = 'chips';
        for (const text of [`${i.width}×${i.height}`, `${fmtFps(i.fps)} fps`, i.bitrate ? fmtMbps(i.bitrate) : '? Mbps']) {
          const c = document.createElement('span');
          c.className = 'chip';
          c.textContent = text;
          chips.append(c);
        }
        meta.append(chips);
        meta.append(`${fmtTime(i.duration)} · ${i.codec} · ${fmtBytes(entry.file.size)}${i.audio ? '' : ' · no audio'}`);
        const dec = document.createElement('span');
        if (!i.canDecode) {
          dec.className = 'warn';
          dec.textContent = ` · this browser can't decode ${i.codec}`;
        } else if (i.hwDecode) {
          dec.className = 'gpu';
          dec.textContent = ' · GPU decode';
        } else {
          dec.className = 'warn';
          dec.textContent = ' · CPU decode (slow)';
        }
        meta.append(dec);
      } else {
        meta.textContent = 'Reading…';
      }
      body.append(name, meta);

      const ctrl = document.createElement('div');
      ctrl.className = 'ctrl';
      const mk = (label: string, title: string, fn: () => void, disabled = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon';
        b.textContent = label;
        b.title = title;
        b.disabled = disabled || !!running;
        b.onclick = fn;
        return b;
      };
      ctrl.append(
        mk('↑', 'Move up', () => move(entry.id, -1), idx === 0),
        mk('↓', 'Move down', () => move(entry.id, 1), idx === entries.length - 1),
        mk('✕', 'Remove', () => removeEntry(entry.id)),
      );

      li.append(index, thumb, body, ctrl);
      const clipBar = document.createElement('div');
      clipBar.className = 'clip-bar';
      clipBar.style.width = `${(clipProgress.get(entry.id) ?? 0) * 100}%`;
      li.append(clipBar);
      li.classList.toggle('active', activeClipId === entry.id);

      li.addEventListener('dragstart', (ev) => {
        dragId = entry.id;
        li.classList.add('dragging');
        ev.dataTransfer!.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => {
        dragId = null;
        li.classList.remove('dragging');
      });
      li.addEventListener('dragover', (ev) => {
        if (dragId === null || dragId === entry.id) return;
        ev.preventDefault();
        const from = entries.findIndex((x) => x.id === dragId);
        const to = entries.findIndex((x) => x.id === entry.id);
        const [moved] = entries.splice(from, 1);
        entries.splice(to, 0, moved);
        render();
      });
      return li;
    }),
  );

  // Defaults follow the first clip, so re-resolve settings whenever a different clip moves to the top.
  const firstKey = entries[0]?.info ? entries[0].id : null;
  if (firstKey !== lastFirstKey) {
    lastFirstKey = firstKey;
    refreshCodecs();
  }

  const ready = entries.filter((e) => e.info);
  const total = ready.reduce((s, e) => s + e.info!.duration, 0);
  listHead.hidden = entries.length === 0;
  summary.textContent = `${entries.length} clip${entries.length === 1 ? '' : 's'} · ${fmtTime(total)} total`;
  updateMergeButton();
}

function updateMergeButton() {
  const allReady = entries.length > 0 && entries.every((e) => e.info && e.info.canDecode);
  const enc = selectedEncoder();
  const encoderOk = !!enc && (accelSel.value === 'auto' || enc.hardware);
  mergeBtn.disabled = !!running || !allReady || !targetSize() || !targetFps() || !encoderOk;
}

function selectedEncoder(): EncoderSupport | undefined {
  return encoders.find((e) => e.codec === codecSel.value);
}

function currentQuality(): number {
  const { width, height, fps } = outputShape();
  const v = qualitySel.value;
  if (v === 'custom') return Math.max(100_000, Math.round(Number(bitrateInput.value) * 1_000_000));
  if (v === 'source') {
    const b = sourceBitrate(width, height, fps);
    if (b) return b;
  }
  return roundBitrate(width * height * fps * (QUALITY_BPP[v] ?? QUALITY_BPP.high));
}

/** Puts the resolved numbers into the option labels so every choice shows what it means. */
function updateOptionLabels() {
  const first = firstClip();
  const { width, height, fps } = outputShape();
  const set = (sel: HTMLSelectElement, value: string, text: string) => {
    const o = sel.querySelector<HTMLOptionElement>(`option[value="${value}"]`);
    if (o) o.textContent = text;
  };
  set(resolutionSel, 'source', first ? `First clip (${even(first.width)} × ${even(first.height)})` : 'Match first clip');
  if (first) {
    const snapped = snapFps(first.fps);
    const measured = fmtFps(first.fps);
    const note = fmtFps(snapped) !== measured ? ` from ${measured}` : '';
    set(fpsSel, 'source', `First clip (${fmtFps(snapped)} fps${note})`);
  } else {
    set(fpsSel, 'source', 'Match first clip');
  }
  const src = sourceBitrate(width, height, fps);
  const scaled = first && src && Math.abs(src - roundBitrate(first.bitrate)) > 100_000;
  set(
    qualitySel,
    'source',
    src ? `First clip (${fmtMbps(src)}${scaled ? ', scaled' : ''})` : 'Match first clip',
  );
  const names: Record<string, string> = { 'very-high': 'Very high', high: 'High', medium: 'Medium', low: 'Low' };
  for (const [level, bpp] of Object.entries(QUALITY_BPP)) {
    set(qualitySel, level, `${names[level]} (${fmtMbps(roundBitrate(width * height * fps * bpp))})`);
  }
}

/** Shows whether encoding and each clip's decoding will run on the GPU, based on the browser's own capability check. */
function renderHw() {
  const size = targetSize();
  const enc = selectedEncoder();
  const rows: HTMLElement[] = [];
  const row = (ok: boolean, text: string) => {
    const d = document.createElement('div');
    d.className = 'row';
    const icon = document.createElement('span');
    icon.className = ok ? 'ok' : 'bad';
    icon.textContent = ok ? '✓' : '✗';
    const t = document.createElement('span');
    t.textContent = text;
    d.append(icon, t);
    rows.push(d);
  };

  if (size) {
    const out = document.createElement('div');
    out.className = 'output-summary';
    out.textContent = `Output: ${size.width}×${size.height} · ${fmtFps(targetFps() ?? 60)} fps · ${fmtMbps(currentQuality())}`;
    rows.push(out);
  }
  if (enc && size) {
    const what = `${CODEC_LABELS[enc.codec]} at ${size.width}×${size.height} ${fmtFps(targetFps() ?? 60)} fps, ${fmtMbps(currentQuality())}`;
    row(enc.hardware, enc.hardware ? `GPU encoder available for ${what}` : `No GPU encoder for ${what}; encoding would run on the CPU`);
  }
  const clips = entries.filter((e) => e.info?.canDecode);
  if (clips.length) {
    const cpu = clips.filter((e) => !e.info!.hwDecode);
    row(
      cpu.length === 0,
      cpu.length === 0
        ? `GPU decoder available for all ${clips.length} clip${clips.length === 1 ? '' : 's'}`
        : `${cpu.length} of ${clips.length} clips have no GPU decoder and will decode on the CPU`,
    );
  }
  const anyHw = encoders.some((e) => e.hardware);
  if (enc && !enc.hardware) {
    const tip = document.createElement('p');
    tip.className = 'tip';
    tip.textContent = anyHw
      ? `Pick a codec marked GPU for fast encoding.`
      : 'No GPU video encoder is reachable. In Edge, open edge://settings/system and turn on "Use graphics acceleration when available", ' +
        'then check edge://gpu: "Video Encode" should say "Hardware accelerated". Very wide sizes can exceed what some GPUs encode; ' +
        'try H.264 or HEVC at 3440×1440 or lower.';
    rows.push(tip);
  }
  hwStatus.replaceChildren(...rows);
}

// ---------- settings ----------

async function refreshCodecs() {
  const size = targetSize() ?? { width: 3440, height: 1440 };
  const seq = ++probeSeq;
  const prev = codecSel.value;
  updateOptionLabels();
  const found = await probeEncoders(size.width, size.height, targetFps() ?? 60, currentQuality());
  if (seq !== probeSeq) return; // a newer probe superseded this one
  encoders = found;
  codecSel.replaceChildren(
    ...encoders.map((e) => {
      const o = document.createElement('option');
      o.value = e.codec;
      o.textContent = `${CODEC_LABELS[e.codec] ?? e.codec} · ${e.hardware ? 'GPU' : 'CPU only'}`;
      return o;
    }),
  );
  if (encoders.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = `No encoder for ${size.width}×${size.height}`;
    codecSel.append(o);
  } else {
    const keep = encoders.find((e) => e.codec === prev && (e.hardware || !encoders.some((x) => x.hardware)));
    codecSel.value = (keep ?? encoders.find((e) => e.hardware) ?? encoders[0]).codec;
  }
  syncAccel();
}

/** "GPU only" can't work without a GPU encoder, so fall back to auto in that case. */
function syncAccel() {
  const enc = selectedEncoder();
  const requireOpt = accelSel.querySelector<HTMLOptionElement>('option[value="require"]')!;
  requireOpt.disabled = !enc?.hardware;
  if (!enc?.hardware) accelSel.value = 'auto';
  else if (!accelSel.dataset.userSet) accelSel.value = 'require';
  renderHw();
  updateMergeButton();
}

resolutionSel.addEventListener('change', () => {
  customRes.hidden = resolutionSel.value !== 'custom';
  refreshCodecs();
});
customW.addEventListener('change', refreshCodecs);
customH.addEventListener('change', refreshCodecs);
fpsSel.addEventListener('change', refreshCodecs);
codecSel.addEventListener('change', syncAccel);
accelSel.addEventListener('change', () => {
  accelSel.dataset.userSet = '1';
  updateMergeButton();
});
qualitySel.addEventListener('change', () => {
  const custom = qualitySel.value === 'custom';
  if (custom && customBitrate.hidden) {
    // Start the custom field from the matched bitrate so it's an easy tweak.
    const { width, height, fps } = outputShape();
    const b = sourceBitrate(width, height, fps) ?? currentQuality();
    bitrateInput.value = (b / 1e6).toFixed(1).replace(/\.0$/, '');
  }
  customBitrate.hidden = !custom;
  refreshCodecs();
});
bitrateInput.addEventListener('change', refreshCodecs);

// ---------- file input ----------

fileInput.addEventListener('change', () => {
  if (fileInput.files) addFiles(Array.from(fileInput.files));
  fileInput.value = '';
});
drop.addEventListener('dragover', (ev) => {
  if (!ev.dataTransfer?.types.includes('Files')) return;
  ev.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (ev) => {
  ev.preventDefault();
  drop.classList.remove('over');
  const files = Array.from(ev.dataTransfer?.files ?? []).filter(
    (f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|mkv|webm)$/i.test(f.name),
  );
  if (files.length) addFiles(files);
});
// Prevent the browser from navigating to a file dropped outside the drop zone.
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => ev.preventDefault());

$('sort-name').addEventListener('click', () => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => collator.compare(a.file.name, b.file.name));
  render();
});
$('clear').addEventListener('click', () => {
  entries.forEach(disposeEntry);
  entries = [];
  render();
  renderHw();
});

// ---------- merge ----------

mergeBtn.addEventListener('click', () => {
  confirmSw.hidden = true;
  const enc = selectedEncoder();
  const cpuDecode = entries.filter((e) => !e.info?.hwDecode).length;
  const cpuParts: string[] = [];
  if (enc && !enc.hardware) cpuParts.push(`encoding (${CODEC_LABELS[enc.codec]} has no GPU encoder at this size)`);
  if (cpuDecode) cpuParts.push(`decoding for ${cpuDecode} clip${cpuDecode === 1 ? '' : 's'}`);
  if (cpuParts.length) {
    // Ask in-page rather than with confirm(): the save dialog opened next needs a fresh click to be allowed.
    confirmSwText.textContent =
      `Not everything can run on the GPU: ${cpuParts.join(' and ')} will run on the CPU. ` +
      'At 3440×1440 this can be many times slower than real time.';
    confirmSw.hidden = false;
    return;
  }
  startMerge();
});
$('confirm-sw-go').addEventListener('click', () => {
  confirmSw.hidden = true;
  startMerge();
});
$('confirm-sw-cancel').addEventListener('click', () => {
  confirmSw.hidden = true;
});

async function startMerge() {
  const size = targetSize();
  if (!size) return;
  const clips = entries.map((e) => e.info!);
  const ids = entries.map((e) => e.id);
  const frameRate = targetFps();
  if (!frameRate) return;
  const quality = currentQuality();
  const enc = selectedEncoder();
  const acceleration = accelSel.value === 'require' ? 'require' : 'auto';

  // Stream straight to disk when possible so multi-GB outputs don't have to fit in RAM.
  let sink: OutputSink = { kind: 'memory' };
  let savedName = '';
  if (canStreamToDisk) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'merged.mp4',
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      sink = { kind: 'file', writable: await handle.createWritable() };
      savedName = handle.name;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return;
      throw err;
    }
  }

  running = new AbortController();
  statusBox.hidden = true;
  result.hidden = true;
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    preview.removeAttribute('src');
  }
  cancelBtn.hidden = false;
  progressWrap.hidden = false;
  clipProgress.clear();
  activeClipId = null;
  const engine = acceleration === 'require' ? 'GPU' : enc?.hardware ? 'GPU if available' : 'CPU';
  render();

  const started = performance.now();
  let lastPaint = 0;
  let lastFrames = 0;
  let lastFramesAt = started;
  let encodeFps = 0;

  function paintProgress(p: MergeProgress, now = performance.now()) {
    const frac = p.total ? Math.min(1, p.done / p.total) : 0;
    const elapsed = (now - started) / 1000 || 0;
    const speed = elapsed > 0 ? p.done / elapsed : 0;
    const left = speed > 0 ? (p.total - p.done) / speed : Infinity;
    if (now - lastFramesAt >= 1000) {
      const inst = ((p.framesEncoded - lastFrames) * 1000) / (now - lastFramesAt);
      encodeFps = encodeFps ? encodeFps * 0.6 + inst * 0.4 : inst;
      lastFrames = p.framesEncoded;
      lastFramesAt = now;
    }
    const text = `${(frac * 100).toFixed(1)}%`;
    pct.textContent = text;
    barFill.style.width = `${frac * 100}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    document.title = `${text} · ${baseTitle}`;
    const clip = clips[p.clipIndex];
    phase.textContent = clip ? `Clip ${p.clipIndex + 1} of ${clips.length}: ${clip.file.name}` : '';

    // Per-clip bars in the list, updated in place to avoid rebuilding rows several times a second.
    ids.forEach((id, i) => {
      const v = i < p.clipIndex ? 1 : i === p.clipIndex && clip ? Math.min(1, p.clipDone / clip.duration) : 0;
      clipProgress.set(id, v);
    });
    activeClipId = ids[p.clipIndex] ?? null;
    for (const li of list.querySelectorAll<HTMLLIElement>('li.clip')) {
      const id = Number(li.dataset.id);
      li.classList.toggle('active', id === activeClipId);
      const b = li.querySelector<HTMLElement>('.clip-bar');
      if (b) b.style.width = `${(clipProgress.get(id) ?? 0) * 100}%`;
    }

    const cell = (value: string, label: string) => `<div><b>${value}</b><span>${label}</span></div>`;
    stats.innerHTML =
      cell(`${fmtTime(p.done)} / ${fmtTime(p.total)}`, 'processed') +
      cell(encodeFps ? `${encodeFps.toFixed(0)} fps` : '…', `encoding (${engine})`) +
      cell(speed ? `${speed.toFixed(2)}×` : '…', 'real time') +
      cell(fmtTime(elapsed), 'elapsed') +
      cell(isFinite(left) ? fmtTime(left) : '…', 'remaining');
  }

  paintProgress({ done: 0, total: clips.reduce((s, c) => s + c.duration, 0), clipIndex: 0, clipDone: 0, framesEncoded: 0 });

  let final: MergeProgress | null = null;
  try {
    const blob = await mergeClips(clips, sink, {
      ...size,
      frameRate,
      codec: codecSel.value as VideoCodec,
      quality,
      acceleration,
      signal: running.signal,
      onProgress: (p) => {
        final = p;
        const now = performance.now();
        if (now - lastPaint < 250 && p.done < p.total) return;
        lastPaint = now;
        paintProgress(p, now);
      },
    });
    const elapsed = (performance.now() - started) / 1000;
    const frames = (final as MergeProgress | null)?.framesEncoded ?? 0;
    const gpuDecodeAll = clips.every((c) => c.hwDecode);
    const accelNote =
      acceleration === 'require'
        ? `GPU encode confirmed${gpuDecodeAll ? ' and GPU decode confirmed' : '; some clips decoded on the CPU'} (GPU-only mode)`
        : `acceleration: ${engine}`;
    const how = `${frames} frames at ${(frames / elapsed).toFixed(0)} fps average, ${accelNote}`;
    if (blob) {
      resultUrl = URL.createObjectURL(blob);
      preview.src = resultUrl;
      download.href = resultUrl;
      result.hidden = false;
      showStatus(`Done in ${fmtTime(elapsed)}. Output: ${fmtBytes(blob.size)}. ${how}.`);
    } else {
      showStatus(`Done in ${fmtTime(elapsed)}. Saved to ${savedName}. ${how}.`);
    }
    document.title = `Done · ${baseTitle}`;
  } catch (err) {
    document.title = baseTitle;
    if (running.signal.aborted) {
      showStatus('Cancelled.', true);
    } else {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        acceleration === 'require'
          ? ' The GPU refused this job. Try another codec marked GPU, a lower resolution, or switch Acceleration to "Allow CPU fallback".'
          : '';
      showStatus(`Merge failed: ${msg}${hint}`, true);
    }
  } finally {
    running = null;
    activeClipId = null;
    cancelBtn.hidden = true;
    render();
  }
}

cancelBtn.addEventListener('click', () => running?.abort());

window.addEventListener('beforeunload', (ev) => {
  if (running) ev.preventDefault();
});

// ---------- init ----------

if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
  $('unsupported').hidden = false;
}
saveHint.textContent = canStreamToDisk
  ? "You'll pick where to save the file; it is written to disk as it encodes, so output size isn't limited by memory."
  : 'This browser builds the output in memory. For very long merges, use Chrome or Edge, which can stream straight to disk.';
render();
refreshCodecs();
