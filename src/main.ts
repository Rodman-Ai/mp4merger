import { CanvasSink, type QualityLevel, type VideoCodec } from 'mediabunny';
import { mergeClips, probeClip, supportedVideoCodecs, type ClipInfo, type OutputSink } from './merge';

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
const progress = $<HTMLProgressElement>('progress');
const stats = $('stats');
const statusBox = $('status');
const result = $('result');
const preview = $<HTMLVideoElement>('preview');
const download = $<HTMLAnchorElement>('download');

const CODEC_LABELS: Record<string, string> = {
  avc: 'H.264 (most compatible)',
  hevc: 'H.265 / HEVC',
  av1: 'AV1',
  vp9: 'VP9',
};

let entries: Entry[] = [];
let nextId = 1;
let running: AbortController | null = null;
let resultUrl: string | null = null;
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

function targetSize(): { width: number; height: number } | null {
  const v = resolutionSel.value;
  if (v === 'source') {
    const first = entries.find((e) => e.info)?.info;
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
        meta.textContent = `${i.width}×${i.height} · ${i.fps.toFixed(2).replace(/\.?0+$/, '')} fps · ${fmtTime(i.duration)} · ${i.codec} · ${fmtBytes(entry.file.size)}${i.audio ? '' : ' · no audio'}`;
        if (!i.canDecode) {
          const w = document.createElement('span');
          w.className = 'warn';
          w.textContent = ` · this browser can't decode ${i.codec}`;
          meta.append(w);
        }
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

  const ready = entries.filter((e) => e.info);
  const total = ready.reduce((s, e) => s + e.info!.duration, 0);
  listHead.hidden = entries.length === 0;
  summary.textContent = `${entries.length} clip${entries.length === 1 ? '' : 's'} · ${fmtTime(total)} total`;
  updateMergeButton();
}

function updateMergeButton() {
  const allReady = entries.length > 0 && entries.every((e) => e.info && e.info.canDecode);
  mergeBtn.disabled = !!running || !allReady || !targetSize() || !codecSel.value;
}

// ---------- settings ----------

async function refreshCodecs() {
  const size = targetSize() ?? { width: 3440, height: 1440 };
  const prev = codecSel.value;
  const codecs = await supportedVideoCodecs(size.width, size.height, Number(fpsSel.value));
  codecSel.replaceChildren(
    ...codecs.map((c) => {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = CODEC_LABELS[c] ?? c;
      return o;
    }),
  );
  if (codecs.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = `No encoder for ${size.width}×${size.height}`;
    codecSel.append(o);
  } else if (codecs.includes(prev as VideoCodec)) {
    codecSel.value = prev;
  }
  updateMergeButton();
}

resolutionSel.addEventListener('change', () => {
  customRes.hidden = resolutionSel.value !== 'custom';
  refreshCodecs();
});
customW.addEventListener('change', refreshCodecs);
customH.addEventListener('change', refreshCodecs);
fpsSel.addEventListener('change', refreshCodecs);
codecSel.addEventListener('change', updateMergeButton);
qualitySel.addEventListener('change', () => {
  customBitrate.hidden = qualitySel.value !== 'custom';
});

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
});

// ---------- merge ----------

mergeBtn.addEventListener('click', async () => {
  const size = targetSize();
  if (!size) return;
  const clips = entries.map((e) => e.info!);
  const frameRate = Number(fpsSel.value);
  const quality: QualityLevel | number =
    qualitySel.value === 'custom' ? Math.round(Number(bitrateInput.value) * 1_000_000) : (qualitySel.value as QualityLevel);

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
  progress.value = 0;
  stats.textContent = 'Starting…';
  render();

  const started = performance.now();
  let lastPaint = 0;
  try {
    const blob = await mergeClips(clips, sink, {
      ...size,
      frameRate,
      codec: codecSel.value as VideoCodec,
      quality,
      signal: running.signal,
      onProgress: (done, total) => {
        const now = performance.now();
        if (now - lastPaint < 200 && done < total) return;
        lastPaint = now;
        const elapsed = (now - started) / 1000;
        const speed = done / elapsed;
        progress.value = total ? done / total : 0;
        stats.textContent =
          `${(progress.value * 100).toFixed(1)}% · ${fmtTime(done)} / ${fmtTime(total)} · ` +
          `${speed.toFixed(2)}× realtime · ${fmtTime(elapsed)} elapsed · ${fmtTime((total - done) / speed)} left`;
      },
    });
    const elapsed = (performance.now() - started) / 1000;
    if (blob) {
      resultUrl = URL.createObjectURL(blob);
      preview.src = resultUrl;
      download.href = resultUrl;
      result.hidden = false;
      showStatus(`Done in ${fmtTime(elapsed)}. Output: ${fmtBytes(blob.size)}.`);
    } else {
      showStatus(`Done in ${fmtTime(elapsed)}. Saved to ${savedName}.`);
    }
  } catch (err) {
    if (running.signal.aborted) {
      showStatus('Cancelled.', true);
    } else {
      console.error(err);
      showStatus(`Merge failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  } finally {
    running = null;
    cancelBtn.hidden = true;
    render();
  }
});

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
