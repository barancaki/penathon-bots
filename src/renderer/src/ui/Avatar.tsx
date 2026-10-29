import { useId } from 'react';
import type { AvatarDetail, AvatarEyes, AvatarShape, AvatarSpec } from '../../../shared/avatars';
import type { BotStatus } from './state';

const bodies: Record<AvatarShape, string> = {
  circle: 'M20 2a18 18 0 1 1 0 36 18 18 0 0 1 0-36Z',
  square:
    'M13.5 2.5h13a11 11 0 0 1 11 11v13a11 11 0 0 1-11 11h-13a11 11 0 0 1-11-11v-13a11 11 0 0 1 11-11Z',
  hexagon:
    'M20 1.8c1 0 2 .26 2.9.78l11.6 6.7a5.8 5.8 0 0 1 2.9 5.02v11.4a5.8 5.8 0 0 1-2.9 5.02l-11.6 6.7a5.8 5.8 0 0 1-5.8 0L5.5 30.72a5.8 5.8 0 0 1-2.9-5.02V14.3a5.8 5.8 0 0 1 2.9-5.02l11.6-6.7c.9-.52 1.9-.78 2.9-.78Z',
  blob: 'M20.4 2.4c9 0 16.9 5.6 16.9 15.9 0 10.9-7.5 19.3-17.8 19.3C9.4 37.6 2.7 29.7 2.7 20 2.7 9.5 10.9 2.4 20.4 2.4Z',
  ghost:
    'M20 2.5c9.1 0 16.5 7.2 16.5 16.2V35c0 1.6-1.8 2.4-3 1.4l-2.6-2.1a2 2 0 0 0-2.5 0l-2.4 2a2 2 0 0 1-2.6 0l-2.1-1.8a2 2 0 0 0-2.6 0l-2.1 1.8a2 2 0 0 1-2.6 0l-2.4-2a2 2 0 0 0-2.5 0l-2.6 2.1c-1.2 1-3 .2-3-1.4V18.7C3.5 9.7 10.9 2.5 20 2.5Z',
  pebble:
    'M20 3.2c3.2 0 5.6 1.9 7.4 4.9l8 13.6c3.6 6.1.6 15-8.3 15H12.9c-8.9 0-11.9-8.9-8.3-15l8-13.6c1.8-3 4.2-4.9 7.4-4.9Z',
};

/** Where the eyes sit on each body, so faces look centred on narrow tops. */
const eyeLine: Record<AvatarShape, number> = {
  circle: 19.5,
  square: 19.5,
  hexagon: 19.5,
  blob: 19.5,
  ghost: 18,
  pebble: 23,
};

const topDetails: AvatarDetail[] = ['antenna', 'sprout', 'ears', 'halo'];

function Eyes({ kind, y, color }: { kind: AvatarEyes; y: number; color: string }) {
  const arc = (cx: number) => `M${cx - 3} ${y + 1.4}q3-3.8 6 0`;
  switch (kind) {
    case 'dots':
      return (
        <>
          <ellipse cx="14.5" cy={y} rx="2.6" ry="3.1" />
          <ellipse cx="25.5" cy={y} rx="2.6" ry="3.1" />
        </>
      );
    case 'big':
      return (
        <>
          <ellipse cx="14" cy={y} rx="3.5" ry="4.1" />
          <ellipse cx="26" cy={y} rx="3.5" ry="4.1" />
          <circle cx="15.2" cy={y - 1.4} r="1.15" fill={color} />
          <circle cx="27.2" cy={y - 1.4} r="1.15" fill={color} />
        </>
      );
    case 'happy':
      return (
        <g fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round">
          <path d={arc(14.5)} />
          <path d={arc(25.5)} />
        </g>
      );
    case 'wink':
      return (
        <>
          <ellipse cx="14.5" cy={y} rx="2.6" ry="3.1" />
          <path d={arc(25.5)} fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" />
        </>
      );
    case 'lines':
      return (
        <>
          <rect x="11.5" y={y - 1.3} width="6" height="2.6" rx="1.3" />
          <rect x="22.5" y={y - 1.3} width="6" height="2.6" rx="1.3" />
        </>
      );
    case 'cyclops':
      return (
        <>
          <ellipse cx="20" cy={y} rx="4.3" ry="4.8" />
          <circle cx="21.6" cy={y - 1.7} r="1.4" fill={color} />
        </>
      );
    case 'none':
      return <rect x="12" y={y - 1.3} width="16" height="2.6" rx="1.3" opacity="0.9" />;
  }
}

function Detail({ kind, color, y }: { kind: AvatarDetail; color: string; y: number }) {
  switch (kind) {
    case 'antenna':
      return (
        <g>
          <path d="M20 4V-1.6" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="20" cy="-3.4" r="2.6" fill={color} />
          <circle cx="19.2" cy="-4.2" r="0.8" fill="white" opacity="0.55" />
        </g>
      );
    case 'sprout':
      return (
        <g fill={color}>
          <path d="M20 4.5V-.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
          <path d="M20-.5c-.6-3.6-3.9-5.4-7.4-4.8.9 3.4 4 5.2 7.4 4.8Z" />
          <path d="M20 .4c.5-2.8 3.1-4.2 5.8-3.7-.7 2.6-3.1 4-5.8 3.7Z" />
        </g>
      );
    case 'ears':
      return (
        <g fill={color} stroke={color} strokeWidth="2.4" strokeLinejoin="round">
          <path d="M6.6 11.5 8 -.6l8.6 5.8Z" />
          <path d="M33.4 11.5 32 -.6l-8.6 5.8Z" />
        </g>
      );
    case 'halo':
      return (
        <ellipse cx="20" cy="-2.6" rx="8.6" ry="2.4" fill="none" stroke={color} strokeWidth="2.2" />
      );
    case 'blush':
      return (
        <g fill="white" opacity="0.32">
          <ellipse cx="10.4" cy={y + 5.4} rx="2.7" ry="1.6" />
          <ellipse cx="29.6" cy={y + 5.4} rx="2.7" ry="1.6" />
        </g>
      );
    case 'none':
      return null;
  }
}

/**
 * Bot face. One colour body, white features. State is shown by motion (blink,
 * glance, bob, squint) instead of separate status badges; the hover title
 * carries the words. Top details (antenna, ears…) shrink the body slightly so
 * the whole figure stays inside its square.
 */
export function Avatar({
  avatar,
  size = 32,
  state = 'idle',
  label,
}: {
  avatar: AvatarSpec;
  size?: number;
  state?: BotStatus;
  label?: string;
}) {
  const clip = useId();
  const { shape, color, eyes } = avatar;
  const detail = avatar.detail ?? 'none';
  const y = eyeLine[shape] ?? 19.5;
  const top = topDetails.includes(detail);
  return (
    <svg
      className="avatar"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label && <title>{label}</title>}
      <defs>
        <clipPath id={clip}>
          <path d={bodies[shape] ?? bodies.circle} />
        </clipPath>
      </defs>
      <g className="body">
        <g transform={top ? 'translate(3.2 4.6) scale(0.84)' : undefined}>
          {top && <Detail kind={detail} color={color} y={y} />}
          <path d={bodies[shape] ?? bodies.circle} fill={color} />
          <ellipse
            cx="13"
            cy="6"
            rx="15"
            ry="8"
            fill="white"
            opacity="0.13"
            clipPath={`url(#${clip})`}
          />
          {!top && <Detail kind={detail} color={color} y={y} />}
          <g className="eyes" fill="white">
            <Eyes kind={eyes} y={y} color={color} />
          </g>
        </g>
      </g>
    </svg>
  );
}
