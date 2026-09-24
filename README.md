# MP4 Merger

A browser app that joins video clips into a single MP4 at a fixed resolution and frame rate. Built for merging
3440×1440 recordings with mixed frame rates into one 3440×1440 @ 60 fps file, but any size works.

Everything runs locally in the browser via [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
(hardware-accelerated decode and encode) and [Mediabunny](https://mediabunny.dev). Files are never uploaded.

## Features

- Drop in MP4 / MOV / MKV / WebM clips, reorder by drag, arrows, or natural name sort.
- Output resolution: 3440×1440 (default), match first clip, common presets, or custom. Clips with a different size or
  aspect ratio are scaled to fit and letterboxed.
- Constant output frame rate (60 fps default; also 30 / 120 / 144). Frames are duplicated or dropped against a fixed
  timeline, so 24, 30, 59.94, 144 fps and variable-frame-rate sources all line up.
- H.264, HEVC, AV1 or VP9, whichever the browser can encode at the chosen size. Quality presets or a fixed bitrate.
- GPU check: each codec is probed for a hardware encoder and each clip for a hardware decoder, using the browser's
  own capability check. "GPU only" mode (the default when available) makes the browser use the GPU or fail, instead
  of silently falling back to a slow CPU encoder. If anything would run on the CPU you're asked to confirm first.
- Live progress: overall bar, per-clip bars, encode fps, speed vs. real time, and time remaining (also in the tab title).
- Audio is resampled to 48 kHz stereo (AAC, or Opus when AAC encoding isn't available). Clips without audio get
  silence so sync holds across the whole file.
- In Chrome and Edge the output streams straight to a file on disk, so multi-GB results don't need to fit in memory.
  Other browsers build the file in memory and offer a download.

Chrome or Edge on desktop is recommended: they have H.264/HEVC hardware encoders and the File System Access API.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # type-check and build to dist/
```

## Deployment

`.github/workflows/deploy.yml` builds on every push and PR, and deploys `main` to GitHub Pages.

One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
