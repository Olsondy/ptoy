/** Scenes the agent publishes on `ptoy.video`. Speeds are the usecup filenames. */
export const VIDEO_SCENES = ['common', 'takecup', 'slow', 'mid', 'fast'] as const;
export type VideoScene = (typeof VIDEO_SCENES)[number];

const FILES: Record<VideoScene, readonly string[]> = {
  common: ['commonchat/common1.mp4', 'commonchat/common2.mp4', 'commonchat/common3.mp4'],
  // takecup.mp4 plays once; the three showcup clips then rotate.
  takecup: ['takecup/takecup.mp4', 'takecup/showcup1.mp4', 'takecup/showcup2.mp4', 'takecup/showcup3.mp4'],
  slow: ['usecup/slow1.mp4', 'usecup/slow2.mp4', 'usecup/slow3.mp4'],
  mid: ['usecup/mid1.mp4', 'usecup/mid2.mp4'],
  fast: ['usecup/fast1.mp4', 'usecup/fast2.mp4'],
};

export function parseVideoScene(value: string | undefined): VideoScene {
  return (VIDEO_SCENES as readonly string[]).includes(value ?? '') ? (value as VideoScene) : 'common';
}

export function videoPlaylist(scene: VideoScene): readonly string[] {
  return FILES[scene].map((file) => `/chatvideo/${file}`);
}

/** Loops while the character is not speaking. */
export const SILENT_LOOP = '/chatvideo/masked-silent-gaze-3x4.mp4';

/**
 * Ordinary chat uses the silent gaze while the character is quiet, and commonchat while speaking.
 * Once the cup is out (takecup / a use speed), that playlist stays up even between sentences.
 */
export function playbackClips(scene: VideoScene, speaking: boolean): readonly string[] {
  if (scene !== 'common') return videoPlaylist(scene);
  return speaking ? videoPlaylist('common') : [SILENT_LOOP];
}

/** Every clip, once. The page downloads these before playback so later switches stay local. */
export function allVideoSources(): readonly string[] {
  const seen = new Set<string>([SILENT_LOOP]);
  const sources = [SILENT_LOOP];
  for (const scene of VIDEO_SCENES) {
    for (const url of videoPlaylist(scene)) {
      if (seen.has(url)) continue;
      seen.add(url);
      sources.push(url);
    }
  }
  return sources;
}

/** Index of the clip after `index` ends. takecup's first file plays once; the rest loop. */
export function nextClip(scene: VideoScene, index: number, length: number): number {
  if (length <= 1) return 0;
  const loopStart = scene === 'takecup' ? 1 : 0;
  const next = index + 1;
  return next >= length ? loopStart : Math.max(next, loopStart);
}
