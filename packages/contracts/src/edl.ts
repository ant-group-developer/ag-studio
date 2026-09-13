import { z } from "zod";
import { idSchema } from "./ids.js";
import { schemaVersion } from "./common.js";

export const edlEntrySchema = z.object({
  source_id: idSchema("source_item"),
  in: z.number().min(0),
  out: z.number().positive(),
  order: z.number().int().min(0),
  overlay: z.enum(["avatar"]).nullable().default(null),
  note: z.string().default(""),
}).strict().refine((e) => e.in < e.out, { message: "in must be less than out" });

/** Contract between the edit-plan gate and the cut/assemble scripts (spec §3). */
export const EdlSchema = z.object({
  schema_version: schemaVersion("edl"),
  entries: z.array(edlEntrySchema).min(1),
}).strict().superRefine((edl, ctx) => {
  const orders = edl.entries.map((e) => e.order);
  if (new Set(orders).size !== orders.length) ctx.addIssue({ code: "custom", message: "duplicate order" });
});
export type Edl = z.infer<typeof EdlSchema>;
export type EdlEntry = z.infer<typeof edlEntrySchema>;
