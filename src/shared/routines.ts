import { z } from 'zod';
import { translate } from './i18n';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * When a routine runs, in the computer's local time. Routines run only while
 * the app is open; a run missed while closed is not replayed.
 * - `daily`: every day at `time`.
 * - `weekly`: on `days` (0 = Sunday … 6 = Saturday) at `time`.
 * - `interval`: every `everyMinutes` (≥ 15) between optional `from`/`to` hours.
 *   Windows start at `from` (default midnight), exclude `to`, and may cross midnight.
 */
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: hhmm }).strict(),
  z
    .object({
      kind: z.literal('weekly'),
      time: hhmm,
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      everyMinutes: z
        .number()
        .int()
        .min(15)
        .max(24 * 60),
      from: hhmm.optional(),
      to: hhmm.optional(),
    })
    .strict(),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

/** Named after the work it does ("Morning mail summary"), never after a role. */
export const routineSchema = z
  .object({
    id: slug,
    name: z.string().trim().min(1).max(100),
    schedule: scheduleSchema,
    /** What the bot is asked to do on every run. */
    prompt: z.string().trim().min(1).max(20_000),
    enabled: z.boolean().default(true),
    /** Optional per-routine model override, e.g. `haiku` for cheap housekeeping. */
    model: z.string().trim().max(200).optional(),
    /** Built-in routines (the Chief's knowledge-folder update) can be paused but not deleted. */
    system: z.boolean().default(false),
  })
  .strict();
export type Routine = z.infer<typeof routineSchema>;

export const reportProcessingKey = 'routines.reportProcessing';

/** Localize only the built-in default; names edited in bot Markdown stay intact. */
export function routineName(routine: Routine, botId: string): string {
  return botId === 'chief' &&
    routine.system &&
    routine.id === 'vault-update' &&
    [
      'Vault güncelleme',
      translate('en', reportProcessingKey),
      translate('tr', reportProcessingKey),
    ].includes(routine.name)
    ? reportProcessingKey
    : routine.name;
}

export function routinePrompt(routine: Routine, botId: string): string {
  return botId === 'chief' &&
    routine.system &&
    routine.id === 'vault-update' &&
    [translate('en', 'routines.reportPrompt'), translate('tr', 'routines.reportPrompt')].includes(
      routine.prompt,
    )
    ? 'routines.reportPrompt'
    : routine.prompt;
}

export const routineDraftSchema = routineSchema
  .omit({ id: true, system: true })
  .extend({ id: slug.optional() })
  .strict();
export type RoutineDraft = z.infer<typeof routineDraftSchema>;
export const routinePatchSchema = routineDraftSchema
  .omit({ id: true })
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .strict();

export type RoutineRun = {
  id: string;
  routineId: string;
  botId: string;
  /** The conversation the run happened in; the UI links to it. */
  conversationId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: 'running' | 'done' | 'error' | 'skipped' | 'cancelled';
  /** First lines of the final answer, or why it was skipped/failed. */
  summary?: string;
};

/** Per-routine view for the panel: definition + next due time + last run. */
export type RoutineState = {
  routine: Routine;
  botId: string;
  nextRunAt?: string;
  lastRun?: RoutineRun;
};

/**
 * A bot's work report to the Chief. Created automatically at the end of a run
 * that changed something, or explicitly with `report_to_chief`. The Chief's
 * knowledge-folder routine processes pending reports.
 */
export type WorkReport = {
  id: string;
  botId: string;
  conversationId: string;
  runId?: string;
  createdAt: string;
  summary: string;
  decisions: string[];
  files: string[];
  open: string[];
  source: 'auto' | 'bot';
  processedAt?: string;
  /** Where the Chief wrote it, e.g. `daily/2026-10-29.md`. */
  processedInto?: string;
};
