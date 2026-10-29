import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/**
 * Three access levels, shown as Reader / Writer / Full access:
 * - `read`: reads files, changes nothing.
 * - `write` (default): edits inside the folders; deleting files asks the user first.
 * - `full`: no limits inside the folders, deletes without asking.
 */
export const accessLevelSchema = z.enum(['read', 'write', 'full']);
export type AccessLevel = z.infer<typeof accessLevelSchema>;
export const accessRank: Record<AccessLevel, number> = { read: 0, write: 1, full: 2 };

/** A project is one or more folders under one name, e.g. "Acme" = several repos. */
export const projectSchema = z
  .object({
    id: slug,
    name: z.string().trim().min(1).max(100),
    folders: z.array(z.string().min(1)).min(1).max(50),
    /** One line for the roster and the Chief's team summary. */
    description: z.string().trim().max(300).default(''),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

export const projectDraftSchema = projectSchema
  .omit({ id: true })
  .extend({ id: slug.optional(), description: z.string().trim().max(300).optional() })
  .strict();
export type ProjectDraft = z.infer<typeof projectDraftSchema>;

/** A bot's access to one project. */
export const projectGrantSchema = z
  .object({ project: slug, level: accessLevelSchema.default('write') })
  .strict();
export type ProjectGrant = z.infer<typeof projectGrantSchema>;
