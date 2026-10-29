import type { ReactNode } from 'react';
import {
  avatarDetails,
  avatarEyes,
  avatarPalette,
  avatarShapes,
  randomAvatar,
  type AvatarSpec,
} from '../../../shared/avatars';
import { Avatar } from './Avatar';
import { DiceIcon } from './icons';
import type { T } from './strings';

/**
 * Picker for the avatar library. Every option is previewed on the current
 * face, so the user sees exactly what they get; "Surprise me" re-rolls while
 * staying apart from the rest of the team.
 */
export function AvatarPicker({
  value,
  others,
  t,
  onChange,
}: {
  value: AvatarSpec;
  others: AvatarSpec[];
  t: T;
  onChange(next: AvatarSpec): void;
}) {
  const set = (patch: Partial<AvatarSpec>) => onChange({ ...value, ...patch });
  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  return (
    <div className="avatar-picker">
      <div className="avatar-stage" style={{ ['--bot' as string]: value.color }}>
        <Avatar avatar={value} size={88} state="idle" />
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => onChange(randomAvatar([...others, value]))}
        >
          <DiceIcon size={15} />
          {t('avatar.shuffle')}
        </button>
      </div>
      <div className="avatar-options">
        <Row label={t('avatar.color')}>
          {avatarPalette.map((color) => (
            <button
              key={color}
              type="button"
              className="swatch"
              style={{ background: color }}
              aria-label={color}
              aria-pressed={same(color, value.color)}
              onClick={() => set({ color })}
            />
          ))}
        </Row>
        <Row label={t('avatar.shape')}>
          {avatarShapes.map((shape) => (
            <Choice
              key={shape}
              pressed={value.shape === shape}
              label={t(`avatar.shape.${shape}`)}
              onClick={() => set({ shape })}
            >
              <Avatar avatar={{ ...value, shape, detail: 'none' }} size={30} />
            </Choice>
          ))}
        </Row>
        <Row label={t('avatar.eyes')}>
          {avatarEyes.map((eyes) => (
            <Choice
              key={eyes}
              pressed={value.eyes === eyes}
              label={t(`avatar.eyes.${eyes}`)}
              onClick={() => set({ eyes })}
            >
              <Avatar avatar={{ ...value, eyes, detail: 'none' }} size={30} />
            </Choice>
          ))}
        </Row>
        <Row label={t('avatar.detail')}>
          {avatarDetails.map((detail) => (
            <Choice
              key={detail}
              pressed={value.detail === detail}
              label={t(`avatar.detail.${detail}`)}
              onClick={() => set({ detail })}
            >
              <Avatar avatar={{ ...value, detail }} size={30} />
            </Choice>
          ))}
        </Row>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="avatar-row" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <div className="avatar-choices">{children}</div>
    </div>
  );
}

function Choice({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="avatar-choice"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
