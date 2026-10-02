/**
 * Thumbnails of an episode over a real studio.db with an in-memory bucket and a drawing fake: the list and the pick
 * only for someone whose footage scope covers the production, words drawn on the clean frame under a suggestion,
 * uploads checked, the person's pictures deletable and the render's not, the pick kept in the dataset, and 503
 * when the box has no ffmpeg.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ForbiddenException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { insertThumbnail, listHumanEdits, MemoryBucket, type ThumbnailRenderer } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import type { FootageAccessService } from './footage-access.service';
import { ThumbnailsController } from './thumbnails.controller';
import { ThumbnailWorkService } from './thumbnail-work.service';

const PROD = '55555555-5555-4555-8555-555555555555';
const EP = 'ep-1';
const req = (userId = 'auth0|editor') => ({ authContext: { userId, isAdmin: false } }) as unknown as Request;
const style = { position: 'bottom', size: 'l', text_color: '#FFFFFF', outline_color: '#000000', box_color: null, uppercase: true } as const;

/** Draws by appending the lines to the picture, so a test can see what went on which picture. */
function fakeRenderer(): ThumbnailRenderer {
  return {
    async extractFrame(_v, t, out) { writeFileSync(out, `frame@${t}`); },
    async compose(base, out, p) { writeFileSync(out, Buffer.concat([readFileSync(base), Buffer.from(`+${p.lines.join('|')}`)])); },
    async normalize(input, out) { copyFileSync(input, out); },
  };
}

describe('ThumbnailsController (real studio.db)', () => {
  let s: RealStudio;
  let bucket: MemoryBucket;
  let covered: boolean;
  let ctl: ThumbnailsController;
  let frameId: string;
  let suggestionId: string;

  function controller(renderer: ThumbnailRenderer | null) {
    const engine = Object.assign(s.engine, { bucket, thumbnails: renderer, browserUrlTtl: 60 });
    const access = { coversProduction: async () => covered } as unknown as FootageAccessService;
    return new ThumbnailsController(engine as unknown as EngineService, access, new ThumbnailWorkService());
  }

  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, aspect)
              VALUES (?, 'team-1', 'Phở', 'draft', ?, ?, 'auth0|owner', '16:9')`, [PROD, now, now]);
    s.db.run(`INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at)
              VALUES (?, ?, 1, 'Phở sáng Hà Nội', '', ?, ?)`, [EP, PROD, now, now]);
    bucket = new MemoryBucket();
    covered = true;
    const frameKey = `productions/${PROD}/episodes/${EP}/thumbnails/run-1/frame-001.jpg`;
    const sugKey = `productions/${PROD}/episodes/${EP}/thumbnails/run-1/suggestion-1.jpg`;
    await bucket.put(frameKey, Buffer.from('clean-frame'));
    await bucket.put(sugKey, Buffer.from('clean-frame+OLD WORDS'));
    const common = { episode_id: EP, source_run_id: 'run-1', parent_id: null, t_s: 3, asset_id: 'asset-1', width: 1280, height: 720, size_bytes: 11, created_by: 'system' };
    frameId = insertThumbnail(s.engine.db, { ...common, kind: 'frame', base_key: frameKey, image_key: frameKey, text: null, style: null }).id;
    suggestionId = insertThumbnail(s.engine.db, { ...common, kind: 'suggestion', base_key: frameKey, image_key: sugKey, text: 'Old words', style }).id;
    ctl = controller(fakeRenderer());
  });
  afterEach(() => s.close());

  it('lists the pictures with view and download URLs, the first suggestion as the pick; nothing without the footage scope', async () => {
    const list = await ctl.get(PROD, EP, req());
    expect(list.items.map((t) => [t.kind, t.deletable, t.drawable])).toEqual([['frame', false, true], ['suggestion', false, true]]);
    expect(list.selectedId).toBe(suggestionId);
    expect(list.items[0]!.downloadUrl).toMatch(/\?download=pho-sang-ha-noi-frame-.{8}\.jpg$/);
    covered = false;
    expect(await ctl.get(PROD, EP, req())).toMatchObject({ items: [], footageHidden: true });
    await expect(ctl.select(PROD, EP, { thumbnailId: frameId }, req())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.get(PROD, 'nope', req())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('draws the words on the clean frame under a suggestion, previews them, and keeps the pick in the dataset', async () => {
    const preview = await ctl.preview(PROD, EP, { baseId: suggestionId, text: 'Phở 6 giờ sáng', style }, req());
    expect(Buffer.from(preview.dataUrl.split(',')[1]!, 'base64').toString()).toBe('clean-frame+PHỞ 6 GIỜ SÁNG');
    const drawn = await ctl.compose(PROD, EP, { baseId: suggestionId, text: 'Phở 6 giờ sáng', style }, req());
    expect(drawn).toMatchObject({ kind: 'composed', parentId: suggestionId, text: 'Phở 6 giờ sáng', deletable: true, createdBy: 'auth0|editor' });
    const picked = await ctl.select(PROD, EP, { thumbnailId: drawn.id }, req());
    expect(picked.selectedId).toBe(drawn.id);
    const edits = listHumanEdits(s.engine.db, { productionId: PROD, page: 1, pageSize: 20 }).items;
    expect(edits.map((e) => e.kind)).toEqual(['thumbnail']);
    expect(JSON.parse(edits[0]!.after!)).toMatchObject({ kind: 'composed', text: 'Phở 6 giờ sáng' });
    await expect(ctl.compose(PROD, EP, { baseId: suggestionId, text: '   ', style }, req())).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(ctl.select(PROD, EP, { thumbnailId: 'nope' }, req())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('takes a JPEG/PNG/WebP upload, deletes what a person made only, and answers 503 without ffmpeg', async () => {
    const up = await ctl.upload(PROD, EP, { buffer: Buffer.from('png'), mimetype: 'image/png', size: 3 }, req());
    expect(up).toMatchObject({ kind: 'upload', deletable: true, drawable: true });
    await expect(ctl.upload(PROD, EP, { buffer: Buffer.from('gif'), mimetype: 'image/gif', size: 3 }, req())).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(ctl.upload(PROD, EP, undefined, req())).rejects.toBeInstanceOf(UnprocessableEntityException);
    await ctl.select(PROD, EP, { thumbnailId: up.id }, req());
    const after = await ctl.remove(PROD, EP, up.id, req());
    expect(after.items.map((t) => t.id)).not.toContain(up.id);
    expect(after.selectedId).toBe(suggestionId);
    await expect(ctl.remove(PROD, EP, frameId, req())).rejects.toBeInstanceOf(UnprocessableEntityException);

    const noFfmpeg = controller(null);
    expect((await noFfmpeg.get(PROD, EP, req())).canDraw).toBe(false);
    await expect(noFfmpeg.compose(PROD, EP, { baseId: frameId, text: 'Chữ', style }, req())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
