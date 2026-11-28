import type { ReactNode } from 'react';
import type { BodyPart, Tier } from '../lib/ranks';

// The body from the front and from the back, each ranked part filled with the
// colour of its tier. A drawing of blocks, not of anatomy: enough to see at a
// glance which parts are ahead and which have nothing logged.

/** One figure is this wide; the two stand side by side. */
const WIDTH = 110;
const HEIGHT = 233;

/** A shape on the figure's left side, at `dx` from its middle line. `both` draws it and its mirror image. */
function both(render: (side: 1 | -1) => ReactNode): ReactNode {
  return <>{render(-1)}{render(1)}</>;
}

/** Head, arms, legs and trunk: what the muscles sit on. */
function Frame({ cx }: { cx: number }) {
  return (
    <g className="body-frame">
      <circle cx={cx} cy={14} r={11} />
      <rect x={cx - 4.5} y={23} width={9} height={11} rx={3} />
      <path d={`M${cx - 17} 36Q${cx} 30 ${cx + 17} 36L${cx + 13.5} 98Q${cx} 106 ${cx - 13.5} 98Z`} />
      {both((side) => (
        <g key={side}>
          <line x1={cx + side * 24} y1={43} x2={cx + side * 33} y2={116} strokeWidth={13} />
          <line x1={cx + side * 10.5} y1={104} x2={cx + side * 11} y2={206} strokeWidth={17} />
          <ellipse cx={cx + side * 12} cy={214} rx={8} ry={4.5} />
        </g>
      ))}
    </g>
  );
}

interface Props {
  /** The tier each part is filled with; a part left out, or null, is drawn as not ranked. */
  tiers: Partial<Record<BodyPart, Tier | null>>;
}

export function BodyMap({ tiers }: Props) {
  const front = WIDTH / 2;
  const back = WIDTH + WIDTH / 2;
  // data-tier gives the part its colour (see styles.css); without one it is drawn as not ranked.
  const part = (name: BodyPart) => ({ 'data-part': name, 'data-tier': tiers[name] ?? undefined });

  return (
    <svg className="body-map" viewBox={`0 0 ${WIDTH * 2} ${HEIGHT}`} aria-hidden>
      <Frame cx={front} />
      <g className="body-parts">
        {both((side) => (
          <g key={side}>
            <ellipse {...part('shoulders')} cx={front + side * 24} cy={43} rx={8.5} ry={8} />
            <rect {...part('chest')} x={front + (side === 1 ? 1 : -15)} y={37} width={14} height={20} rx={6} />
            <ellipse {...part('biceps')} cx={front + side * 27.5} cy={65} rx={6} ry={12.5} />
            <ellipse {...part('forearms')} cx={front + side * 31} cy={95} rx={5} ry={14.5} />
            <ellipse {...part('quads')} cx={front + side * 10.5} cy={132} rx={8} ry={25} />
          </g>
        ))}
        <rect {...part('core')} x={front - 11} y={59} width={22} height={35} rx={7} />
      </g>

      <Frame cx={back} />
      <g className="body-parts">
        <path {...part('back')} d={`M${back - 15} 38Q${back} 33 ${back + 15} 38L${back + 11} 88Q${back} 93 ${back - 11} 88Z`} />
        {both((side) => (
          <g key={side}>
            <ellipse {...part('shoulders')} cx={back + side * 24} cy={43} rx={8.5} ry={8} />
            <ellipse {...part('triceps')} cx={back + side * 27.5} cy={65} rx={6} ry={12.5} />
            <ellipse {...part('forearms')} cx={back + side * 31} cy={95} rx={5} ry={14.5} />
            <ellipse {...part('glutes')} cx={back + side * 8.5} cy={102} rx={8} ry={8.5} />
            <ellipse {...part('hamstrings')} cx={back + side * 10.5} cy={136} rx={8} ry={21} />
            <ellipse {...part('calves')} cx={back + side * 11} cy={182} rx={6.5} ry={19} />
          </g>
        ))}
      </g>

      <text x={front} y={HEIGHT - 2}>Front</text>
      <text x={back} y={HEIGHT - 2}>Back</text>
    </svg>
  );
}
