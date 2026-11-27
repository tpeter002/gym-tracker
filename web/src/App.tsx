import { Dumbbell, History as HistoryIcon, List, Scale, Settings as SettingsIcon, SquarePlay, Trophy } from 'lucide-react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { beginWorkout, startConflict } from './lib/actions';
import { sendWaiting } from './lib/exports';
import { analyzePending, takeSharedLink } from './lib/identify';
import { collectShared, ensureShareCode } from './lib/inbox';
import { navigate, useRoute } from './lib/router';
import { useSignal } from './lib/signal';
import { storageStatus, update, useAppState } from './lib/store';
import type { AppState } from './lib/types';
import { activeWorkout, deleteWorkout } from './lib/workouts';
import { ActiveWorkout } from './screens/ActiveWorkout';
import { Body } from './screens/Body';
import { ExerciseDetail, Exercises } from './screens/Exercises';
import { History, WorkoutDetail } from './screens/History';
import { Home } from './screens/Home';
import { Ranks } from './screens/Ranks';
import { Settings } from './screens/settings/Settings';
import { StrongImportPage } from './screens/settings/StrongImport';
import { VideoDetail, Videos } from './screens/Videos';
import { Link, Redirect } from './ui/layout';
import { ConfirmDialog } from './ui/overlays';
import { ResumeCard } from './ui/parts';

const TABS = [
  { to: '/', label: 'Workout', icon: Dumbbell, sections: ['', 'workout'] },
  { to: '/history', label: 'History', icon: HistoryIcon, sections: ['history'] },
  { to: '/exercises', label: 'Exercises', icon: List, sections: ['exercises'] },
  { to: '/ranks', label: 'Ranks', icon: Trophy, sections: ['ranks'] },
  { to: '/body', label: 'Body', icon: Scale, sections: ['body'] },
  // On a phone these two are reached from the Workout tab instead.
  { to: '/videos', label: 'Saved Videos', icon: SquarePlay, sections: ['videos'], wideOnly: true },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, sections: ['settings'], wideOnly: true },
];

function screenFor(route: string[], state: AppState): ReactNode {
  const [section = '', id] = route;
  switch (section) {
    case '':
      return <Home state={state} />;
    case 'workout': {
      const workout = activeWorkout(state);
      return workout ? <ActiveWorkout state={state} workout={workout} /> : <Redirect to="/" />;
    }
    case 'history': {
      if (!id) return <History state={state} />;
      const workout = state.workouts.find((candidate) => candidate.id === id && candidate.endedAt !== null);
      if (!workout) return <Redirect to="/history" />;
      // key: the editor remembers how the workout was when it opened; another workout is another edit.
      if (route[2] === 'edit') return <ActiveWorkout key={workout.id} state={state} workout={workout} editing />;
      return <WorkoutDetail state={state} workout={workout} />;
    }
    case 'exercises': {
      if (!id) return <Exercises state={state} />;
      const exercise = state.exercises.find((candidate) => candidate.id === id);
      return exercise ? <ExerciseDetail state={state} exercise={exercise} /> : <Redirect to="/exercises" />;
    }
    case 'ranks':
      return <Ranks state={state} />;
    case 'body':
      return <Body state={state} />;
    case 'videos': {
      if (!id) return <Videos state={state} />;
      const video = state.videos.find((candidate) => candidate.id === id);
      return video ? <VideoDetail state={state} video={video} /> : <Redirect to="/videos" />;
    }
    case 'settings':
      return id === 'import' ? <StrongImportPage state={state} /> : <Settings state={state} />;
    default:
      return <Redirect to="/" />;
  }
}

export function App() {
  const route = useRoute();
  const state = useAppState();
  const storage = useSignal(storageStatus);
  const conflict = useSignal(startConflict);
  const section = route[0] ?? '';
  const active = activeWorkout(state);
  // The Workout tab shows the running workout as a card of its own.
  const showResumeBar = active !== undefined && section !== '' && section !== 'workout';

  useEffect(() => {
    update(ensureShareCode);
    const shared = takeSharedLink();
    if (shared) navigate(`/videos/${shared}`);
    // Videos saved, and workouts finished, while the analyzer was out of reach get their turn whenever the app comes to the front.
    const sweep = () => {
      if (document.visibilityState !== 'visible') return;
      // Links shared from other apps first, so they are identified in the same pass.
      void collectShared().then(analyzePending);
      void sendWaiting();
    };
    sweep();
    document.addEventListener('visibilitychange', sweep);
    return () => document.removeEventListener('visibilitychange', sweep);
  }, []);

  const isLogging = section === 'workout' || (section === 'history' && route[2] === 'edit');
  const frame = ['app', isLogging && 'no-tabs', showResumeBar && 'has-resume-bar'].filter(Boolean).join(' ');

  return (
    <div className={frame}>
      <nav className="nav" aria-label="Main">
        <div className="nav-title">Gym Tracker</div>
        {TABS.map((tab, index) => (
          <Link
            key={tab.to}
            to={tab.to}
            current={tab.sections.includes(section)}
            className={[
              tab.wideOnly && 'wide-only',
              tab.wideOnly && !TABS[index - 1].wideOnly && 'nav-gap',
              // Without their own tab on a phone, these two light up the one they are reached from.
              tab.to === '/' && ['videos', 'settings'].includes(section) && 'parent-tab',
            ].filter(Boolean).join(' ') || undefined}
          >
            <tab.icon size={24} aria-hidden />
            {tab.label}
          </Link>
        ))}
      </nav>

      <main className="main">
        {storage === 'unavailable' && (
          <p className="banner" role="alert">
            This browser window doesn't allow websites to store data (a private window?), so nothing you log here will be kept.
          </p>
        )}
        {storage === 'unreadable' && (
          <p className="banner" role="alert">
            What this browser has stored for the app couldn't be read, so it started empty and will save nothing this time. Reload to try again; what is stored has not been touched.
          </p>
        )}
        {storage === 'failed' && (
          <p className="banner" role="alert">
            The last change couldn't be saved — the browser's storage may be full. Download a backup from Settings before closing this tab.
          </p>
        )}
        {screenFor(route, state)}
      </main>

      {showResumeBar && <ResumeCard workout={active} compact />}

      {conflict && (
        <ConfirmDialog
          title="You already have a workout in progress"
          actions={[
            { label: 'Resume Current Workout', run: () => navigate('/workout') },
            {
              label: 'Discard It and Start New',
              destructive: true,
              run: () => {
                if (active) update((draft) => deleteWorkout(draft, active.id));
                beginWorkout(conflict);
              },
            },
          ]}
          onClose={() => startConflict.set(null)}
        />
      )}
    </div>
  );
}
