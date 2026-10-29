import { z } from 'zod';

/**
 * Avatar library: shape × eyes × detail × color. Every combination is a
 * one-colour body with white features, so any pick reads as part of one family.
 * Geometry lives in the renderer (ui/Avatar.tsx); this file only owns the ids,
 * the palette and how a fresh bot gets a look.
 */

export const avatarShapes = ['circle', 'square', 'hexagon', 'blob', 'ghost', 'pebble'] as const;
export const avatarEyes = ['dots', 'big', 'happy', 'wink', 'lines', 'cyclops', 'none'] as const;
export const avatarDetails = ['none', 'antenna', 'sprout', 'ears', 'blush', 'halo'] as const;

/** Saturated mid-tones: white features stay legible on all of them in both themes. */
export const avatarPalette = [
  '#6E6AF0', // iris
  '#3E9BE8', // sky
  '#1FA9B8', // lagoon
  '#2FB38A', // mint
  '#7DB33A', // moss
  '#E8A23B', // honey
  '#EF7B45', // tangerine
  '#E8596B', // coral
  '#E0609E', // bubblegum
  '#C26BE0', // orchid
  '#8F7BE8', // lilac
  '#7A8699', // slate
] as const;

export type AvatarShape = (typeof avatarShapes)[number];
export type AvatarEyes = (typeof avatarEyes)[number];
export type AvatarDetail = (typeof avatarDetails)[number];

export const avatarSchema = z
  .object({
    shape: z.enum(avatarShapes).default('circle'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#808080'),
    eyes: z.enum(avatarEyes).default('dots'),
    detail: z.enum(avatarDetails).default('none'),
  })
  .strict();
export type AvatarSpec = z.infer<typeof avatarSchema>;

export const defaultAvatar: AvatarSpec = {
  shape: 'circle',
  color: '#808080',
  eyes: 'dots',
  detail: 'none',
};

/** Chief's fixed default look; new bots avoid it. */
export const chiefAvatar: AvatarSpec = {
  shape: 'hexagon',
  color: '#6E6AF0',
  eyes: 'dots',
  detail: 'none',
};

function leastUsed<T extends string>(options: readonly T[], used: T[], rand: () => number): T {
  const counts = new Map<T, number>(options.map((o) => [o, 0]));
  for (const u of used) if (counts.has(u)) counts.set(u, (counts.get(u) ?? 0) + 1);
  const min = Math.min(...counts.values());
  const pool = options.filter((o) => counts.get(o) === min);
  return pool[Math.floor(rand() * pool.length) % pool.length]!;
}

/**
 * A look for a new bot that stands apart from the existing team: colour and
 * shape come from the least-used options, eyes and detail are free. Never
 * returns an exact copy of an existing avatar.
 */
export function randomAvatar(existing: AvatarSpec[], rand: () => number = Math.random): AvatarSpec {
  const color = leastUsed(
    avatarPalette.map((c) => c.toUpperCase()),
    existing.map((a) => a.color.toUpperCase()),
    rand,
  );
  const shape = leastUsed(
    avatarShapes,
    existing.map((a) => a.shape),
    rand,
  );
  const same = (a: AvatarSpec, b: AvatarSpec) =>
    a.shape === b.shape &&
    a.color.toUpperCase() === b.color.toUpperCase() &&
    a.eyes === b.eyes &&
    a.detail === b.detail;
  for (let i = 0; i < 24; i++) {
    const pick: AvatarSpec = {
      shape,
      color,
      eyes: avatarEyes[Math.floor(rand() * avatarEyes.length) % avatarEyes.length]!,
      detail: avatarDetails[Math.floor(rand() * avatarDetails.length) % avatarDetails.length]!,
    };
    if (!existing.some((e) => same(e, pick))) return pick;
  }
  return { shape, color, eyes: 'dots', detail: 'none' };
}
