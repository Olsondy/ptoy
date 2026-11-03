import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allVideoSources, nextClip, parseVideoScene, playbackClips, videoPlaylist } from '../src/video/playlist.ts';

describe('video playlist', () => {
  it('falls back to common for an unknown scene', () => {
    assert.equal(parseVideoScene(undefined), 'common');
    assert.equal(parseVideoScene('showcup'), 'common');
  });

  it('lists every clip once so they can all be stored locally', () => {
    const sources = allVideoSources();
    assert.equal(new Set(sources).size, sources.length);
    assert.equal(sources.length, 15);
    assert.equal(sources[0], '/chatvideo/masked-silent-gaze-3x4.mp4');
    assert.ok(sources.includes('/chatvideo/commonchat/common1.mp4'));
    assert.ok(sources.includes('/chatvideo/usecup/fast2.mp4'));
  });

  it('loops the silent gaze until the character speaks, then uses commonchat', () => {
    assert.deepEqual(playbackClips('common', false), ['/chatvideo/masked-silent-gaze-3x4.mp4']);
    assert.deepEqual(playbackClips('common', true), videoPlaylist('common'));
    assert.deepEqual(playbackClips('takecup', false), videoPlaylist('takecup'));
    assert.deepEqual(playbackClips('takecup', true), videoPlaylist('takecup'));
    assert.deepEqual(playbackClips('slow', false), videoPlaylist('slow'));
  });

  it('lists takecup first, then the three show clips', () => {
    assert.deepEqual(videoPlaylist('takecup'), [
      '/chatvideo/takecup/takecup.mp4',
      '/chatvideo/takecup/showcup1.mp4',
      '/chatvideo/takecup/showcup2.mp4',
      '/chatvideo/takecup/showcup3.mp4',
    ]);
  });

  it('plays takecup once and then rotates the show clips', () => {
    assert.equal(nextClip('takecup', 0, 4), 1);
    assert.equal(nextClip('takecup', 1, 4), 2);
    assert.equal(nextClip('takecup', 3, 4), 1);
  });

  it('rotates a speed folder from the start', () => {
    assert.equal(nextClip('slow', 0, 3), 1);
    assert.equal(nextClip('slow', 2, 3), 0);
    assert.equal(nextClip('fast', 1, 2), 0);
  });
});
