import { z } from 'zod';
import { avatarSchema, defaultAvatar } from './avatars';
import { projectGrantSchema } from './projects';
import { routineSchema } from './routines';

export const engineSchema = z.enum(['claude', 'codex']);
export type EngineId = z.infer<typeof engineSchema>;
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const sandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

/** How the bot talks. Every field is optional free text or a small enum; empty = engine default. */
export const personaSchema = z
  .object({
    tone: z.string().trim().max(200).default(''),
    address: z.string().trim().max(100).default(''),
    emoji: z.enum(['none', 'some', 'lots']).default('none'),
    length: z.enum(['short', 'medium', 'long']).default('short'),
    notes: z.string().trim().max(2000).default(''),
  })
  .strict();
export type Persona = z.infer<typeof personaSchema>;
export const defaultPersona: Persona = {
  tone: '',
  address: '',
  emoji: 'none',
  length: 'short',
  notes: '',
};

export const botSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    name: z.string().trim().min(1).max(100),
    /** One line shown under the name in the roster and on cards. */
    role: z.string().trim().max(200).default(''),
    avatar: avatarSchema.default(defaultAvatar),
    persona: personaSchema.default(defaultPersona),
    engine: engineSchema,
    model: z.string().trim().max(200).default('default'),
    effort: effortSchema.default('medium'),
    workdir: z.string().min(1),
    writeScope: z.array(z.string().min(1)).default([]),
    readScope: z.array(z.string().min(1)).default([]),
    sandbox: sandboxSchema.default('workspace-write'),
    network: z.boolean().default(false),
    /**
     * MCP servers (claude.ai connectors and user MCPs) this bot may use, by
     * server name. `*` = all. The app's own `team` server is always on.
     * Each engine uses the servers defined in its own configuration.
     */
    connections: z.array(z.string().trim().min(1).max(200)).default([]),
    /**
     * Projects this bot may work in, each with an access level. Effective
     * folders = workdir/readScope/writeScope plus the granted projects' folders.
     */
    projects: z.array(projectGrantSchema).default([]),
    /** Bot that created this one; children appear nested under it. */
    parent: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .nullable()
      .default(null),
    routines: z.array(routineSchema).default([]),
    system: z.boolean().default(false),
    temporary: z.boolean().default(false),
    instructions: z.string().max(200_000),
  })
  .strict();
export type Bot = z.infer<typeof botSchema>;

/** What a bot (or the user, through the editor) proposes for a new bot. */
export const botDraftSchema = botSchema
  .pick({
    name: true,
    role: true,
    avatar: true,
    persona: true,
    engine: true,
    model: true,
    effort: true,
    workdir: true,
    readScope: true,
    writeScope: true,
    sandbox: true,
    network: true,
    connections: true,
    projects: true,
    parent: true,
    temporary: true,
    instructions: true,
  })
  .extend({
    role: botSchema.shape.role.removeDefault().optional(),
    avatar: botSchema.shape.avatar.removeDefault().optional(),
    persona: botSchema.shape.persona.removeDefault().optional(),
    model: botSchema.shape.model.removeDefault().optional(),
    effort: botSchema.shape.effort.removeDefault().optional(),
    workdir: botSchema.shape.workdir.optional(),
    readScope: botSchema.shape.readScope.removeDefault().optional(),
    writeScope: botSchema.shape.writeScope.removeDefault().optional(),
    sandbox: botSchema.shape.sandbox.removeDefault().optional(),
    network: botSchema.shape.network.removeDefault().optional(),
    connections: botSchema.shape.connections.removeDefault().optional(),
    projects: botSchema.shape.projects.removeDefault().optional(),
    parent: botSchema.shape.parent.removeDefault().optional(),
    temporary: botSchema.shape.temporary.removeDefault().optional(),
  })
  .strict();
export type BotDraft = z.infer<typeof botDraftSchema>;

/** Fields a bot may change on itself or a descendant through `update_bot`. */
export const botPatchSchema = botDraftSchema.partial().strict();
export type BotPatch = z.infer<typeof botPatchSchema>;
