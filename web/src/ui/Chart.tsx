import { useEffect, useRef, useState } from 'react';
import { fmtDate, fmtNumber, fmtShortDate } from '../lib/units';

export interface ChartPoint {
  time: number;
  value: number;
  /** Said after the value wherever it is read off: "× 8" for a top set's reps. */
  note?: string;
}

const HEIGHT = 180;
const MARGIN = { top: 12, right: 14, bottom: 24, left: 40 };
/** Above this many points the dots would merge into a thick line. */
const MAX_DOTS = 40;

/** Round axis values covering min…max, about `count` steps apart. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const rough = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step);
  return Array.from({ length: last - first + 1 }, (_, index) => Number(((first + index) * step).toFixed(6)));
}

interface Props {
  /** Oldest first. */
  points: ChartPoint[];
  /** What the line shows, for screen readers: "Body weight". */
  label: string;
  unit: string;
}

/**
 * One series over time. Pointing anywhere (or the arrow keys) reads off the
 * nearest point; every value is also in the list below the chart.
 */
export function LineChart({ points, label, unit }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(frame.current!);
    return () => observer.disconnect();
  }, []);

  const ticks = niceTicks(Math.min(...points.map((point) => point.value)), Math.max(...points.map((point) => point.value)));
  const [low, high] = [ticks[0], ticks[ticks.length - 1]];
  const [start, end] = [points[0].time, points[points.length - 1].time];
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (time: number) => MARGIN.left + (end === start ? plotWidth / 2 : ((time - start) / (end - start)) * plotWidth);
  const y = (value: number) => MARGIN.top + (1 - (value - low) / (high - low)) * plotHeight;
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join('');

  const nearest = (clientX: number) => {
    const offset = clientX - frame.current!.getBoundingClientRect().left;
    let best = 0;
    points.forEach((point, index) => {
      if (Math.abs(x(point.time) - offset) < Math.abs(x(points[best].time) - offset)) best = index;
    });
    return best;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    setActive((current) => Math.min(points.length - 1, Math.max(0, (current ?? points.length - 1) + step)));
  };

  const shown = active !== null && active < points.length ? points[active] : null;
  const first = points[0];
  const last = points[points.length - 1];
  const reading = (point: ChartPoint) => `${fmtNumber(point.value, 1)} ${unit}${point.note ? ` ${point.note}` : ''}`;

  return (
    <div
      ref={frame}
      className="chart"
      tabIndex={0}
      role="group"
      aria-roledescription="chart"
      aria-label={`${label}: ${reading(first)} on ${fmtDate(first.time)} to ${reading(last)} on ${fmtDate(last.time)}. Arrow keys step through the points.`}
      onPointerMove={(event) => setActive(nearest(event.clientX))}
      onPointerDown={(event) => setActive(nearest(event.clientX))}
      onPointerLeave={(event) => event.pointerType === 'mouse' && setActive(null)}
      onFocus={() => setActive((current) => current ?? points.length - 1)}
      onBlur={() => setActive(null)}
      onKeyDown={onKeyDown}
    >
      <svg width={width} height={HEIGHT} aria-hidden>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} />
            <text className="tick" x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="central">
              {fmtNumber(tick, 1)}
            </text>
          </g>
        ))}
        <text className="tick" x={MARGIN.left} y={HEIGHT - 4}>{fmtShortDate(start)}</text>
        {end !== start && (
          <text className="tick" x={width - MARGIN.right} y={HEIGHT - 4} textAnchor="end">{fmtShortDate(end)}</text>
        )}
        {shown && <line className="crosshair" x1={x(shown.time)} x2={x(shown.time)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} />}
        <path className="line" d={path} />
        {points.length <= MAX_DOTS && points.map((point, index) => (
          <circle key={index} className="dot" cx={x(point.time)} cy={y(point.value)} r={4} />
        ))}
        {shown && <circle className="dot" cx={x(shown.time)} cy={y(shown.value)} r={5} />}
      </svg>
      <div aria-live="polite">
        {shown && (
          <div
            className="chart-tip"
            style={x(shown.time) > width / 2 ? { right: width - x(shown.time) + 10 } : { left: x(shown.time) + 10 }}
          >
            <strong>{reading(shown)}</strong>
            <span className="secondary">{fmtDate(shown.time)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
