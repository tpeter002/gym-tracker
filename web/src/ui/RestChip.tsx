import { Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { extendRest, fmtRest, rest, REST_OVER_SHOWN_MS, restLeft, skipRest } from '../lib/rest';
import { useSignal } from '../lib/signal';
import type { Settings } from '../lib/types';
import { Menu } from './overlays';

/**
 * The rest between sets, counting down in the workout's header. A tap offers
 * more time or none; when it is over it says so for a moment and goes away.
 */
export function RestChip({ settings }: { settings: Settings }) {
  const current = useSignal(rest);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!current) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [current]);

  const left = current ? restLeft(current, now) : 0;
  const isOver = current !== null && left === 0;

  useEffect(() => {
    if (!isOver) return;
    // Where the browser has it (not on an iPhone): a buzz for a phone lying on the floor.
    try {
      navigator.vibrate?.([200, 100, 200]);
    } catch {
      // not allowed here; the screen still says it
    }
    const timer = setTimeout(skipRest, REST_OVER_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [isOver]);

  if (!current) return null;
  return (
    <Menu
      className={isOver ? 'rest-chip over' : 'rest-chip'}
      label={isOver ? 'Rest over' : `Rest: ${fmtRest(left)} left`}
      items={[
        { label: 'Add 30 Seconds', run: () => extendRest(settings) },
        { label: isOver ? 'Dismiss' : 'Skip Rest', run: skipRest },
      ]}
    >
      <Timer size={16} aria-hidden />
      <span role="timer">{isOver ? 'Rest over' : fmtRest(left)}</span>
    </Menu>
  );
}
