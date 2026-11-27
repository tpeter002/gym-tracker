import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';
import { DIVISIONS, rankTitle } from '../lib/ranks';
import type { Rank, RankUp, Tier } from '../lib/ranks';

// The emblem of each tier, drawn here rather than shipped as image files: a
// weight plate for Iron, shields that gain a chevron and a star, a winged
// hexagon, a cut gem, and a crown. The pips underneath count the step.

interface Emblem {
  /** Top, middle and bottom of the fill, the outline, and the colour of what is drawn on top. */
  colors: [light: string, mid: string, dark: string, edge: string, ink: string];
  /** The emblem's silhouette, in a 64 × 64 box with room for the pips below. */
  outline: string;
  /** What sits on the silhouette. `ink` is its colour. */
  detail: (ink: string, edge: string) => ReactNode;
}

const SHIELD = 'M32 4 53 11v18c0 13-9 21-21 25-12-4-21-12-21-25V11Z';
const INNER_SHIELD = 'M32 9.5 48 15v14c0 10-7 16.5-16 19.8-9-3.3-16-9.8-16-19.8V15Z';
const HEXAGON = 'M32 4 52.8 16v24L32 52 11.2 40V16Z';
const STAR = 'M32 17.5 35.4 25.3 43.9 26.1 37.5 31.7 39.4 40 32 35.7 24.6 40 26.5 31.7 20.1 26.1 28.6 25.3Z';

const EMBLEMS: Record<Tier, Emblem> = {
  iron: {
    colors: ['#aab2bc', '#7b8591', '#525b66', '#3d444d', '#2f353c'],
    outline: 'M32 5a24 24 0 1 1-.01 0Z',
    detail: (ink, edge) => (
      <>
        <circle cx="32" cy="29" r="16.5" fill="none" stroke={edge} strokeWidth="2" opacity="0.45" />
        <circle cx="32" cy="29" r="5.5" fill={ink} />
        {[0, 120, 240].map((turn) => (
          <rect key={turn} x="29.5" y="9.5" width="5" height="5.5" rx="2.5" fill={ink} opacity="0.55" transform={`rotate(${turn} 32 29)`} />
        ))}
      </>
    ),
  },
  bronze: {
    colors: ['#eab083', '#c27a3f', '#8a4f22', '#653713', '#5a2f0e'],
    outline: SHIELD,
    detail: (ink) => (
      <>
        <path d={INNER_SHIELD} fill="none" stroke={ink} strokeWidth="1.8" opacity="0.5" />
        <path d="M22 26.5h20v5.5H22Z" fill={ink} opacity="0.85" />
      </>
    ),
  },
  silver: {
    colors: ['#f6f8fa', '#bcc5ce', '#7f8a95', '#5c6670', '#4b545d'],
    outline: SHIELD,
    detail: (ink) => (
      <>
        <path d={INNER_SHIELD} fill="none" stroke={ink} strokeWidth="1.8" opacity="0.4" />
        <path d="M21 21.5 32 30l11-8.5v6.5L32 36.5 21 28Z" fill={ink} opacity="0.85" />
        <path d="M21 30.5 32 39l11-8.5v6.5L32 45.5 21 37Z" fill={ink} opacity="0.55" />
      </>
    ),
  },
  gold: {
    colors: ['#fff0a8', '#f4b92a', '#b97a05', '#8a5a00', '#7a4c00'],
    outline: SHIELD,
    detail: (ink) => (
      <>
        <path d={INNER_SHIELD} fill="none" stroke={ink} strokeWidth="1.8" opacity="0.4" />
        <path d={STAR} fill={ink} opacity="0.9" />
      </>
    ),
  },
  platinum: {
    colors: ['#f0fffc', '#93dccf', '#3f978c', '#2a6f67', '#1f5a53'],
    outline: `${HEXAGON}M11.2 19 2 13l3 12.5-4 1.5 10.2 10ZM52.8 19 62 13l-3 12.5 4 1.5-10.2 10Z`,
    detail: (ink) => (
      <>
        <path d="M32 9.5 48 18.8v18.4L32 46.5 16 37.2V18.8Z" fill="none" stroke={ink} strokeWidth="1.8" opacity="0.4" />
        <path d={STAR} fill={ink} opacity="0.9" transform="translate(0 -1)" />
      </>
    ),
  },
  diamond: {
    colors: ['#dff6ff', '#5fbdf7', '#1f73c9', '#16508f', '#0f3f73'],
    outline: 'M20 6h24l12 15L32 54 8 21Z',
    detail: (ink) => (
      <>
        <path d="M8 21h48M20 6l6 15 6 33M44 6l-6 15-6 33M32 6l-6 15M32 6l6 15" fill="none" stroke={ink} strokeWidth="1.6" strokeLinejoin="round" opacity="0.55" />
        <path d="M20 6h12l-6 15H8Z" fill="#ffffff" opacity="0.35" />
        <path d="M38 21h18L32 54Z" fill={ink} opacity="0.18" />
      </>
    ),
  },
  legend: {
    colors: ['#ffd9f6', '#d455dd', '#7a1fa8', '#521277', '#fff2b0'],
    outline: 'M9 46 5 15l14 12L32 5l13 22 14-12-4 31ZM11 49h42v5H11Z',
    detail: (ink) => (
      <>
        <circle cx="5" cy="14.5" r="3.2" fill={ink} />
        <circle cx="59" cy="14.5" r="3.2" fill={ink} />
        <circle cx="32" cy="5.5" r="3.6" fill={ink} />
        <path d="M32 24.5 34.5 30.2 40.7 30.8 36 34.9 37.4 41 32 37.8 26.6 41 28 34.9 23.3 30.8 29.5 30.2Z" fill={ink} />
        <path d="M11 49h42v5H11Z" fill={ink} opacity="0.55" />
      </>
    ),
  },
};

interface BadgeProps {
  rank: Pick<Rank, 'tier' | 'division'>;
  /** Width in pixels; the height follows. */
  size?: number;
  /** Plays the pop and the sweep of light once. */
  celebrate?: boolean;
  /** Purely decorative next to text that already names the rank. */
  decorative?: boolean;
}

export function RankBadge({ rank, size = 40, celebrate, decorative }: BadgeProps) {
  const id = useId();
  const { colors: [light, mid, dark, edge, ink], outline, detail } = EMBLEMS[rank.tier];
  return (
    <svg
      className={celebrate ? 'rank-badge celebrate' : 'rank-badge'}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : rankTitle(rank)}
      aria-hidden={decorative || undefined}
      data-tier={rank.tier}
    >
      <defs>
        <linearGradient id={`${id}fill`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="0.5" stopColor={mid} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
        <clipPath id={`${id}clip`}>
          <path d={outline} />
        </clipPath>
      </defs>
      <path d={outline} fill={`url(#${id}fill)`} stroke={edge} strokeWidth="1.5" strokeLinejoin="round" />
      {detail(ink, edge)}
      <g clipPath={`url(#${id}clip)`}>
        <rect className="rank-shine" x="-26" y="-4" width="14" height="72" fill="#ffffff" opacity="0" />
      </g>
      {Array.from({ length: DIVISIONS }, (_, index) => (
        <circle
          key={index}
          className={index < rank.division ? 'rank-pip on' : 'rank-pip'}
          cx={32 + (index - (DIVISIONS - 1) / 2) * 8.5}
          cy="60.2"
          r="2.6"
          fill={index < rank.division ? mid : 'none'}
          stroke={index < rank.division ? edge : 'currentColor'}
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}

/** How far along the current step is. The text beside it says the same in words. */
export function RankProgress({ rank }: { rank: Pick<Rank, 'tier' | 'progress'> }) {
  return (
    <span className="rank-bar" data-tier={rank.tier} aria-hidden>
      <span style={{ width: `${Math.round(rank.progress * 100)}%` }} />
    </span>
  );
}

/** Where the sparks fly to, in pixels from the emblem's middle. */
const SPARKS = [[-44, -22], [-28, -42], [0, -50], [28, -42], [44, -22], [-50, 6], [50, 6], [-36, 30], [36, 30]];
// Just past the moment .rank-up has slid away in styles.css (4.1s, then 0.35s); change the two together.
const SHOWN_FOR = 4500; // milliseconds

/** The moment a lift climbs a step: slides in over the workout, celebrates, and leaves by itself. */
export function RankUpToast({ up, onDone }: { up: RankUp; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, SHOWN_FOR);
    return () => clearTimeout(timer);
  }, [up, onDone]);

  return (
    <div className="rank-up" role="status" data-tier={up.to.tier}>
      {/* A tap sends it away early; as a button, so can the keyboard. */}
      <button onClick={onDone}>
        <span className="rank-up-emblem">
          {SPARKS.map(([x, y], index) => (
            <i key={index} style={{ '--dx': `${x}px`, '--dy': `${y}px`, animationDelay: `${180 + index * 35}ms` } as React.CSSProperties} />
          ))}
          <RankBadge rank={up.to} size={72} celebrate decorative />
        </span>
        <span className="rank-up-text">
          <span className="rank-up-kicker">{up.from ? 'Rank up' : 'First rank'}</span>
          <strong>{rankTitle(up.to)}</strong>
          <span className="rank-up-lift">{up.exercise.name}</span>
        </span>
      </button>
    </div>
  );
}
