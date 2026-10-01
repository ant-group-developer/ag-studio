import { describe, it, expect } from 'vitest';
import { parseStoredYoutubeKit, readStoredYoutubeKit } from '../src/studio.js';

const kit = (hashtags: string[]) => ({
  schema_version: 'studio.youtube-kit/v1',
  titles: ['Tiêu đề 1', 'Tiêu đề 2', 'Tiêu đề 3'],
  description: 'Mô tả tập phim.',
  tags: ['phở'],
  hashtags,
  thumbnails: [1, 2, 3].map((i) => ({ asset_id: `a-${i}`, text: `Chữ ${i}` })),
  playlist: '',
});

describe('readStoredYoutubeKit', () => {
  it('returns a valid kit as is', () => {
    expect(readStoredYoutubeKit(kit(['#Phở_Hà_Nội']))?.hashtags).toEqual(['#Phở_Hà_Nội']);
  });

  it('cleans hashtags stored before the letters/digits/_ rule instead of failing the episode', () => {
    const read = readStoredYoutubeKit(kit(['#Phở-Hà-Nội', '#(Tập1)', '#', '#Phở-Hà-Nội']));
    expect(read?.hashtags).toEqual(['#PhởHàNội', '#Tập1']);
  });

  it('leaves out a kit that is still invalid; parseStoredYoutubeKit throws for it', () => {
    expect(readStoredYoutubeKit({ ...kit([]), titles: ['một'] })).toBeNull();
    expect(() => parseStoredYoutubeKit({ ...kit([]), titles: ['một'] })).toThrow();
    expect(parseStoredYoutubeKit(kit(['#Phở-Hà-Nội'])).hashtags).toEqual(['#PhởHàNội']);
  });
});
