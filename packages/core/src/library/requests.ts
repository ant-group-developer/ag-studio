import { existsSync } from "node:fs";
import { ContentRequestSchema, HarnessError, newId, type Clock, type ContentRequest, type StateStore } from "@harness/contracts";
import type { LibraryFs } from "./files.js";
import { requireActiveVoice } from "./voices.js";

/** Common dependencies for every library lifecycle function in requests.ts and review.ts. */
export interface LibraryDeps {
  store: StateStore;
  fs: LibraryFs;
  clock: Clock;
}

function appendNote(notes: string, note: string): string {
  if (!note) return notes;
  return notes ? `${notes}\n${note}` : note;
}

/**
 * Reads a request straight from the kho (not the DB mirror). Only an *absent* file is NOT_FOUND: a file that
 * exists but cannot be read or parsed keeps `readJson`'s own code (`IO_ERROR`, or `CONFIG_INVALID` for a
 * schema mismatch), because a dropped mount or a half-written file is a retryable problem with the kho, not
 * "this request never existed" -- which `library-stage` would turn into a permanent contract failure.
 */
export function readRequest(d: LibraryDeps, requestId: string): ContentRequest {
  const path = d.fs.paths.requestFile(requestId);
  if (!existsSync(path)) {
    throw new HarnessError("NOT_FOUND", `content request not found: ${requestId}`, { request_id: requestId });
  }
  return d.fs.readJson(path, ContentRequestSchema);
}

function saveRequest(d: LibraryDeps, request: ContentRequest): ContentRequest {
  d.fs.writeJsonAtomic(d.fs.paths.requestFile(request.request_id), request);
  d.store.upsertContentRequest(request);
  return request;
}

export function createRequest(d: LibraryDeps, p: {
  requested_by: { portfolio_id: string; channel_id?: string };
  topic: string;
  style_id?: string;
  style_revision?: number;
  target_duration_seconds?: [number, number];
  voice?: "none" | "tts" | "original";
  /** An explicit voice profile for this request, only meaningful when `voice: "tts"`. */
  voice_id?: string;
  /** Fallback voice profile when the caller (e.g. `create-requests`, spec §4.2) has the requesting channel's
   * own configured voice but no per-request override; ignored if `voice_id` is also given. */
  channelVoiceId?: string;
  language?: string;
  due_at?: string;
  notes?: string;
  source_hint?: ContentRequest["source_hint"];
}): ContentRequest {
  const now = d.clock.now();
  const voice = p.voice ?? "none";
  // voice_id is only ever persisted for "tts": requireActiveVoice both validates and resolves it (undefined
  // input included, so "tts" with neither voice_id nor channelVoiceId fails clearly here rather than at
  // `intake` time), and any voice_id passed alongside "none"/"original" is silently dropped.
  const voice_id = voice === "tts" ? requireActiveVoice(d.store, p.voice_id ?? p.channelVoiceId).voice_id : undefined;
  const request: ContentRequest = {
    schema_version: "harness.content-request/v1",
    request_id: newId("content_request"),
    requested_by: p.requested_by,
    topic: p.topic,
    voice,
    language: p.language ?? "vi",
    count: 1, // fixed by contract: one request buys one item (ContentRequestSchema.count)
    status: "open",
    item_ids: [],
    notes: p.notes ?? "",
    created_at: now,
    updated_at: now,
    ...(p.style_id !== undefined ? { style_id: p.style_id } : {}),
    ...(p.style_revision !== undefined ? { style_revision: p.style_revision } : {}),
    ...(p.target_duration_seconds !== undefined ? { target_duration_seconds: p.target_duration_seconds } : {}),
    ...(voice_id !== undefined ? { voice_id } : {}),
    ...(p.due_at !== undefined ? { due_at: p.due_at } : {}),
    ...(p.source_hint !== undefined ? { source_hint: p.source_hint } : {}),
  };
  return saveRequest(d, request);
}

/** open -> claimed. Already claimed by the same run is idempotent (returned unchanged); any other
 * non-open status, or claimed by a different run, is INVALID_TRANSITION. */
export function claimRequest(d: LibraryDeps, p: { request_id: string; run: { project_id: string; run_id: string } }): ContentRequest {
  const request = readRequest(d, p.request_id);
  if (request.status === "claimed") {
    const owner = request.claimed_by_run;
    if (owner && owner.project_id === p.run.project_id && owner.run_id === p.run.run_id) return request;
    throw new HarnessError(
      "INVALID_TRANSITION",
      `content request ${p.request_id} is already claimed by ${owner ? `${owner.project_id}/${owner.run_id}` : "another run"}`,
      { request_id: p.request_id, status: request.status, claimed_by_run: owner },
    );
  }
  if (request.status !== "open") {
    throw new HarnessError("INVALID_TRANSITION", `content request ${p.request_id} is ${request.status}, not open`, { request_id: p.request_id, status: request.status });
  }
  const updated: ContentRequest = { ...request, status: "claimed", claimed_by_run: p.run, updated_at: d.clock.now() };
  return saveRequest(d, updated);
}

/** claimed -> fulfilled once item_ids reaches count, otherwise stays claimed. */
export function fulfillRequest(d: LibraryDeps, p: { request_id: string; item_id: string }): ContentRequest {
  const request = readRequest(d, p.request_id);
  if (request.status !== "claimed") {
    throw new HarnessError("INVALID_TRANSITION", `content request ${p.request_id} is ${request.status}, not claimed`, { request_id: p.request_id, status: request.status });
  }
  const item_ids = request.item_ids.includes(p.item_id) ? request.item_ids : [...request.item_ids, p.item_id];
  const status = item_ids.length >= request.count ? "fulfilled" : "claimed";
  const updated: ContentRequest = { ...request, item_ids, status, updated_at: d.clock.now() };
  return saveRequest(d, updated);
}

/** claimed -> rejected, appending note. */
export function rejectRequest(d: LibraryDeps, p: { request_id: string; note: string }): ContentRequest {
  const request = readRequest(d, p.request_id);
  if (request.status !== "claimed") {
    throw new HarnessError("INVALID_TRANSITION", `content request ${p.request_id} is ${request.status}, not claimed`, { request_id: p.request_id, status: request.status });
  }
  const updated: ContentRequest = { ...request, status: "rejected", notes: appendNote(request.notes, p.note), updated_at: d.clock.now() };
  return saveRequest(d, updated);
}

/** claimed|rejected -> open, clearing claimed_by_run and appending note. */
export function reopenRequest(d: LibraryDeps, p: { request_id: string; note: string }): ContentRequest {
  const request = readRequest(d, p.request_id);
  if (request.status !== "claimed" && request.status !== "rejected") {
    throw new HarnessError("INVALID_TRANSITION", `content request ${p.request_id} is ${request.status}, not claimed or rejected`, { request_id: p.request_id, status: request.status });
  }
  const { claimed_by_run: _claimed_by_run, ...rest } = request;
  const updated: ContentRequest = { ...rest, status: "open", notes: appendNote(request.notes, p.note), updated_at: d.clock.now() };
  return saveRequest(d, updated);
}
