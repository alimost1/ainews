/** Frame-based edit decisions. Narration and picture edits use independent timelines. */
export interface GalleryAsset { photo: string; video?: string; blur?: string; presenter?: boolean }
export interface GalleryShot extends GalleryAsset { from: number; duration: number; index: number }
export function planGallery(assets: GalleryAsset[], totalFrames: number, fps = 30): GalleryShot[] {
  if (!assets.length) throw new Error('Select at least one property photo');
  if (!Number.isInteger(totalFrames) || totalFrames <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid gallery timeline');
  const count = Math.min(totalFrames, Math.max(assets.length, Math.ceil(totalFrames / (fps * 4))));
  const overlap = Math.round(fps * 0.4);
  return Array.from({ length: count }, (_, index) => {
    const from = Math.floor(index * totalFrames / count);
    const next = Math.floor((index + 1) * totalFrames / count);
    return { ...assets[index % assets.length], index, from, duration: Math.min(totalFrames - from, next - from + overlap) };
  });
}
export function frameTimeline(durations: number[], fps: number) {
  let from = 0;
  return durations.map(seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid narration duration');
    const duration = Math.ceil(seconds * fps);
    const segment = { from, duration };
    from += duration;
    return segment;
  });
}
