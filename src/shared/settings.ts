import { z } from 'zod';
import { projectSchema } from './projects';
export const telegramOptionsSchema = z
  .object({
    enabled: z.boolean().optional(),
    routeTo: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .optional(),
    notifyRoutines: z.boolean().optional(),
  })
  .strict();
export type TelegramOptions = z.infer<typeof telegramOptionsSchema>;
export const telegramSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    routeTo: z.string().default('chief'),
    notifyRoutines: z.boolean().default(true),
    pairedChatId: z.number().int().safe().positive().optional(),
    pairedName: z.string().max(200).optional(),
    conversationId: z.string().optional(),
    hasToken: z.boolean().default(false),
  })
  .strict();
export const authModeSchema = z.enum(['local-cli', 'api-key']);
export const engineSettingsSchema = z
  .object({
    authMode: authModeSchema.default('local-cli'),
    hasApiKey: z.boolean().default(false),
  })
  .strict();
export const notificationsSchema = z
  .object({
    enabled: z.boolean(),
    done: z.boolean(),
    approval: z.boolean(),
    error: z.boolean(),
    routine: z.boolean(),
    rooms: z.boolean(),
  })
  .strict();
export const settingsSchema = z
  .object({
    botsDir: z.string().min(1),
    knowledgeDir: z.string().min(1).optional(),
    language: z.enum(['tr', 'en']).default('tr'),
    theme: z.enum(['system', 'dark', 'light']).default('system'),
    runInBackground: z.boolean().default(true),
    notifications: notificationsSchema.default({
      enabled: true,
      done: true,
      approval: true,
      error: true,
      routine: true,
      rooms: false,
    }),
    /** Named folder groups bots can be given access to. Managed via `api.projects`. */
    projects: z.array(projectSchema).default([]),
    /** Shared by every bot: who the user is and how to address them. */
    profile: z
      .object({
        name: z.string().trim().max(100).default(''),
        address: z.string().trim().max(100).default(''),
      })
      .strict()
      .default({ name: '', address: '' }),
    engines: z.object({ claude: engineSettingsSchema, codex: engineSettingsSchema }).strict(),
    telegram: telegramSettingsSchema.default(() => telegramSettingsSchema.parse({})),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
const authPatch = z
  .object({
    authMode: authModeSchema.optional(),
    apiKey: z.string().min(1).max(8192).nullable().optional(),
  })
  .strict();
export const settingsPatchSchema = settingsSchema
  .omit({ engines: true, projects: true, telegram: true })
  .partial()
  .extend({
    // Zod defaults belong to saved settings, never to omitted patch fields.
    language: settingsSchema.shape.language.removeDefault().optional(),
    theme: settingsSchema.shape.theme.removeDefault().optional(),
    profile: settingsSchema.shape.profile.removeDefault().optional(),
    runInBackground: settingsSchema.shape.runInBackground.removeDefault().optional(),
    knowledgeDir: z.string().min(1).nullable().optional(),
    notifications: notificationsSchema.partial().optional(),
    engines: z
      .object({ claude: authPatch.optional(), codex: authPatch.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
