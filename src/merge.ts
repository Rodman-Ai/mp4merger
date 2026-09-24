import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type QualityLevel,
  type Target,
  type VideoCodec,
} from 'mediabunny';

export interface ClipInfo {
  file: File;
  input: Input;
  video: InputVideoTrack;
  audio: InputAudioTrack | null;
  /** Earliest timestamp across the clip's tracks, in seconds. */
  start: number;
  /** Clip length measured from `start`, in seconds. */
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** Average video bitrate over the whole track, in bits per second. */
  bitrate: number;
  codec: string;
  canDecode: boolean;
  /** Whether the GPU has a decoder for this clip's exact codec profile and size. */
  hwDecode: boolean;
}

export async function probeClip(file: File): Promise<ClipInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) {
    input.dispose();
    throw new Error(`${file.name} has no video track`);
  }
  const audio = await input.getPrimaryAudioTrack();
  const tracks = audio ? [video, audio] : [video];
  const [start, end, stats, canDecode, hwDecode] = await Promise.all([
    input.getFirstTimestamp(tracks),
    input.computeDuration(tracks),
    // Full scan: MP4 sample tables make this cheap, and it gives the true average bitrate, not just the intro's.
    video.computePacketStats(),
    video.canDecode(),
    canDecodeInHardware(video),
  ]);
  return {
    file,
    input,
    video,
    audio,
    start,
    duration: end - start,
    width: video.displayWidth,
    height: video.displayHeight,
    fps: stats.averagePacketRate,
    bitrate: stats.averageBitrate,
    codec: video.codec ?? 'unknown',
    canDecode,
    hwDecode,
  };
}

async function canDecodeInHardware(video: InputVideoTrack): Promise<boolean> {
  const config = await video.getDecoderConfig();
  if (!config || typeof VideoDecoder === 'undefined') return false;
  try {
    const res = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' });
    return !!res.supported;
  } catch {
    return false;
  }
}

export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;

export interface MergeOptions {
  width: number;
  height: number;
  frameRate: number;
  codec: VideoCodec;
  quality: QualityLevel | number;
  /** 'require' makes the browser use GPU encode/decode or fail, never silently fall back to software. */
  acceleration: 'require' | 'auto';
  signal: AbortSignal;
  onProgress: (p: MergeProgress) => void;
}

export interface MergeProgress {
  /** Seconds of output timeline processed so far. */
  done: number;
  total: number;
  clipIndex: number;
  /** Seconds processed within the current clip. */
  clipDone: number;
  framesEncoded: number;
}

/**
 * Quality presets always resolve to a target bitrate. Mediabunny would otherwise try constant-quantizer mode first,
 * which GPU encoders in Chrome/Edge often don't offer, so the browser quietly switches to a (very slow) software
 * encoder.
 */
export function makeQuality(quality: QualityLevel | number): Quality {
  return typeof quality === 'number'
    ? new Quality({ bitrate: quality })
    : new Quality({ quality, preferBitrate: true });
}

export type OutputSink =
  | { kind: 'file'; writable: FileSystemWritableFileStream }
  | { kind: 'memory' };

export async function pickAudioCodec(): Promise<AudioCodec | null> {
  return getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: AUDIO_CHANNELS,
    sampleRate: AUDIO_SAMPLE_RATE,
  });
}

export interface EncoderSupport {
  codec: VideoCodec;
  hardware: boolean;
  software: boolean;
}

/** Probes each codec with the exact settings the merge will use, once requiring the GPU and once allowing anything. */
export async function probeEncoders(
  width: number,
  height: number,
  frameRate: number,
  quality: QualityLevel | number,
): Promise<EncoderSupport[]> {
  const candidates: VideoCodec[] = ['avc', 'hevc', 'av1', 'vp9'];
  const q = makeQuality(quality);
  const probe = (codec: VideoCodec, hardwareAcceleration: 'prefer-hardware' | 'no-preference') =>
    canEncodeVideo(codec, { width, height, frameRate, quality: q, hardwareAcceleration }).catch(() => false);
  const results = await Promise.all(
    candidates.map(async (codec) => {
      const [hardware, any] = await Promise.all([probe(codec, 'prefer-hardware'), probe(codec, 'no-preference')]);
      return { codec, hardware, software: any };
    }),
  );
  return results.filter((r) => r.hardware || r.software);
}

/**
 * Concatenates the clips into one MP4. Every frame is resized (letterboxed if the aspect ratio differs) to the
 * target size, the frame stream is normalized to a constant frame rate (duplicating or dropping frames as
 * needed), and audio is resampled to 48 kHz stereo. Clips without audio get silence so A/V stays in sync.
 *
 * Returns the finished file as a Blob when writing to memory, or null when streaming to a file on disk.
 */
export async function mergeClips(clips: ClipInfo[], sink: OutputSink, opts: MergeOptions): Promise<Blob | null> {
  const { frameRate, signal } = opts;
  const total = clips.reduce((sum, c) => sum + c.duration, 0);
  const hasAudio = clips.some((c) => c.audio);
  const audioCodec = hasAudio ? await pickAudioCodec() : null;
  if (hasAudio && !audioCodec) throw new Error('This browser cannot encode AAC or Opus audio');

  const target: Target =
    sink.kind === 'file' ? new StreamTarget(sink.writable, { chunked: true }) : new BufferTarget();
  const output = new Output({
    // Streaming to disk puts the moov box at the end, which keeps memory flat for huge outputs.
    format: new Mp4OutputFormat({ fastStart: sink.kind === 'file' ? false : 'in-memory' }),
    target,
  });

  let framesEncoded = 0;
  const videoSource = new VideoSampleSource({
    codec: opts.codec,
    quality: makeQuality(opts.quality),
    keyFrameInterval: 2,
    hardwareAcceleration: opts.acceleration === 'require' ? 'prefer-hardware' : 'no-preference',
    transform: { frameRate },
    onEncodedPacket: () => {
      framesEncoded++;
    },
  });
  output.addVideoTrack(videoSource, { frameRate });

  let audioSource: AudioSampleSource | null = null;
  if (audioCodec) {
    audioSource = new AudioSampleSource({
      codec: audioCodec,
      quality: new Quality({ bitrate: 192_000 }),
    });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  try {
    let offset = 0;
    for (const [clipIndex, clip] of clips.entries()) {
      const clipOffset = offset;
      const report = (t: number) =>
        opts.onProgress({ done: clipOffset + t, total, clipIndex, clipDone: t, framesEncoded });
      report(0);
      const tasks: Promise<void>[] = [pumpVideo(clip, clipOffset, videoSource, opts, report)];
      if (audioSource) {
        tasks.push(
          clip.audio
            ? pumpAudio(clip, clip.audio, clipOffset, audioSource, signal)
            : pumpSilence(clipOffset, clip.duration, audioSource, signal),
        );
      }
      await Promise.all(tasks);
      offset += clip.duration;
    }
    signal.throwIfAborted();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    if (sink.kind === 'file') await sink.writable.abort().catch(() => {});
    throw err;
  }

  opts.onProgress({
    done: total,
    total,
    clipIndex: clips.length - 1,
    clipDone: clips[clips.length - 1]?.duration ?? 0,
    framesEncoded,
  });
  if (target instanceof BufferTarget) {
    return new Blob([target.buffer!], { type: 'video/mp4' });
  }
  return null;
}

async function pumpVideo(
  clip: ClipInfo,
  offset: number,
  source: VideoSampleSource,
  opts: MergeOptions,
  onTime: (t: number) => void,
) {
  const sink = new VideoSampleSink(clip.video, {
    hardwareAcceleration: opts.acceleration === 'require' && clip.hwDecode ? 'prefer-hardware' : 'no-preference',
  });
  for await (const sample of sink.samples()) {
    try {
      opts.signal.throwIfAborted();
      const rel = sample.timestamp - clip.start;
      if (rel < 0 || rel >= clip.duration) continue;
      let frame = sample;
      if (sample.displayWidth !== opts.width || sample.displayHeight !== opts.height || sample.rotation !== 0) {
        frame = await sample.transform({ width: opts.width, height: opts.height, fit: 'contain' });
      }
      try {
        frame.setTimestamp(offset + rel);
        await source.add(frame);
      } finally {
        if (frame !== sample) frame.close();
      }
      onTime(rel);
    } finally {
      sample.close();
    }
  }
}

async function pumpAudio(
  clip: ClipInfo,
  track: InputAudioTrack,
  offset: number,
  source: AudioSampleSource,
  signal: AbortSignal,
) {
  // The encoder needs one constant format, so every clip is converted to 48 kHz stereo here, and the clip's audio
  // is laid out back to back from its first sample and padded or cut to exactly the clip's duration so later clips
  // stay in sync with the video.
  const totalFrames = Math.round(clip.duration * AUDIO_SAMPLE_RATE);
  let written = 0;
  let resampler: Resampler | null = null;
  const sink = new AudioSampleSink(track);

  const emit = async (planes: Float32Array[]) => {
    const frames = Math.min(planes[0].length, totalFrames - written);
    if (frames <= 0) return;
    const data = new Float32Array(frames * AUDIO_CHANNELS);
    for (let ch = 0; ch < AUDIO_CHANNELS; ch++) data.set(planes[ch].subarray(0, frames), ch * frames);
    const out = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: AUDIO_CHANNELS,
      sampleRate: AUDIO_SAMPLE_RATE,
      timestamp: offset + written / AUDIO_SAMPLE_RATE,
    });
    written += frames;
    try {
      await source.add(out);
    } finally {
      out.close();
    }
  };

  for await (const sample of sink.samples()) {
    try {
      signal.throwIfAborted();
      if (written >= totalFrames) break;
      if (!resampler) {
        resampler = new Resampler(sample.sampleRate);
        // Leading gap between the clip start and its first audio sample becomes silence.
        const lead = Math.round(Math.max(0, sample.timestamp - clip.start) * AUDIO_SAMPLE_RATE);
        if (lead > 0) await emit(silence(Math.min(lead, totalFrames)));
      }
      await emit(resampler.process(toStereoPlanes(sample)));
    } finally {
      sample.close();
    }
  }
  if (written < totalFrames) {
    await pumpSilence(offset + written / AUDIO_SAMPLE_RATE, (totalFrames - written) / AUDIO_SAMPLE_RATE, source, signal);
  }
}

function silence(frames: number): Float32Array[] {
  return Array.from({ length: AUDIO_CHANNELS }, () => new Float32Array(frames));
}

/** Extracts the sample as two float planes, duplicating mono and dropping channels beyond the front pair. */
function toStereoPlanes(sample: AudioSample): Float32Array[] {
  const n = sample.numberOfFrames;
  const read = (plane: number) => {
    const buf = new Float32Array(n);
    sample.copyTo(buf, { planeIndex: plane, format: 'f32-planar' });
    return buf;
  };
  const left = read(0);
  const right = sample.numberOfChannels > 1 ? read(1) : left.slice();
  return [left, right];
}

/** Streaming linear-interpolation resampler to AUDIO_SAMPLE_RATE. Passes audio through untouched at 48 kHz. */
class Resampler {
  private step: number;
  private pos = 0;
  private carry: Float32Array[] = [];

  constructor(srcRate: number) {
    this.step = srcRate / AUDIO_SAMPLE_RATE;
  }

  process(input: Float32Array[]): Float32Array[] {
    if (this.step === 1) return input;
    const buf = input.map((plane, ch) => {
      const prev = this.carry[ch];
      if (!prev?.length) return plane;
      const joined = new Float32Array(prev.length + plane.length);
      joined.set(prev);
      joined.set(plane, prev.length);
      return joined;
    });
    const len = buf[0].length;
    const count = Math.max(0, Math.ceil((len - 1 - this.pos) / this.step));
    const out = buf.map(() => new Float32Array(count));
    let p = this.pos;
    for (let k = 0; k < count; k++, p += this.step) {
      const i = Math.floor(p);
      const f = p - i;
      for (let ch = 0; ch < buf.length; ch++) out[ch][k] = buf[ch][i] * (1 - f) + buf[ch][i + 1] * f;
    }
    const keep = Math.floor(p);
    this.carry = buf.map((plane) => plane.slice(keep));
    this.pos = p - keep;
    return out;
  }
}

async function pumpSilence(offset: number, duration: number, source: AudioSampleSource, signal: AbortSignal) {
  const chunkFrames = AUDIO_SAMPLE_RATE / 2;
  const totalFrames = Math.round(duration * AUDIO_SAMPLE_RATE);
  for (let done = 0; done < totalFrames; done += chunkFrames) {
    signal.throwIfAborted();
    const frames = Math.min(chunkFrames, totalFrames - done);
    const sample = new AudioSample({
      data: new Float32Array(frames * AUDIO_CHANNELS),
      format: 'f32-planar',
      numberOfChannels: AUDIO_CHANNELS,
      sampleRate: AUDIO_SAMPLE_RATE,
      timestamp: offset + done / AUDIO_SAMPLE_RATE,
    });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  }
}
