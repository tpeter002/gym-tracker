import { CirclePlus, ClipboardPaste, Hand, Play, Plus, Sparkles, SquarePlay, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { byName } from '../lib/exercises';
import { addVideoLink, analysisErrors, analyzerOnline, analyzeVideo, analyzing, checkAnalyzer } from '../lib/inbox';
import { goBack, navigate } from '../lib/router';
import { update, useSignal } from '../lib/store';
import type { AppState, SavedVideo } from '../lib/types';
import { fmtCount, fmtDate } from '../lib/units';
import {
  adoptSuggestion, deleteVideo, exercisesFrom, linkExerciseById, pendingSuggestions, resolvedName,
  unlinkExercise, videoSource, videoTitle, webLink,
} from '../lib/videos';
import { Spinner } from '../ui/controls';
import { EmptyState, Link, Page, Section } from '../ui/layout';
import { ConfirmDialog, Sheet } from '../ui/overlays';
import { ExerciseLabel, Thumbnail } from '../ui/parts';
import { ExercisePicker } from './ExercisePicker';

/** Clips saved from Instagram / TikTok / YouTube, waiting to be turned into exercises. */
export function Videos({ state }: { state: AppState }) {
  const [showAdd, setShowAdd] = useState(false);
  const busy = useSignal(analyzing);
  const videos = useMemo(() => [...state.videos].sort((a, b) => b.addedAt - a.addedAt), [state.videos]);

  const status = (video: SavedVideo) => {
    const added = exercisesFrom(state, video.id).length;
    if (added > 0) return `${fmtCount(added, 'exercise')} added`;
    if (busy.has(video.id)) return 'Identifying exercises…';
    const found = video.suggestions.length;
    if (found > 0) return `${fmtCount(found, 'exercise')} found — review`;
    return video.analyzedAt === null ? 'Not identified yet' : 'No exercises found';
  };

  return (
    <Page
      title="Saved Videos"
      back="/"
      trailing={
        <button className="bar-button" aria-label="Add link" onClick={() => setShowAdd(true)}>
          <Plus size={24} aria-hidden />
        </button>
      }
    >
      {videos.length === 0 && (
        <EmptyState icon={<SquarePlay size={48} aria-hidden />} title="No Saved Videos">
          <p>In Instagram, TikTok or YouTube tap Share → Copy Link, then paste the link here.</p>
          <button className="btn btn-primary btn-inline" onClick={() => setShowAdd(true)}>Add Link</button>
        </EmptyState>
      )}
      {videos.length > 0 && (
        <Section>
          {videos.map((video) => (
            <Link key={video.id} to={`/videos/${video.id}`} className="row">
              <Thumbnail video={video} />
              <span className="grow">
                <span className="small" style={{ fontWeight: 500 }}>{videoTitle(video)}</span>
                <span className="sub">{videoSource(video.url)} · {fmtDate(video.addedAt)}</span>
                <span className={exercisesFrom(state, video.id).length > 0 ? 'sub status row-icon' : 'sub status'}>
                  {status(video)}
                </span>
              </span>
            </Link>
          ))}
        </Section>
      )}
      {showAdd && <AddVideoLink onClose={() => setShowAdd(false)} />}
    </Page>
  );
}

function AddVideoLink({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState('');
  const [isInvalid, setInvalid] = useState(false);
  // Reading the clipboard is only offered to pages on https (or on this computer).
  const canPaste = typeof navigator.clipboard?.readText === 'function';

  const save = () => {
    const id = addVideoLink(link);
    if (!id) return setInvalid(true);
    onClose();
    navigate(`/videos/${id}`);
  };

  return (
    <Sheet
      title="Add Video Link"
      onClose={onClose}
      trailing={<button className="bar-button strong" disabled={link.trim() === ''} onClick={save}>Save</button>}
    >
      <Section
        footer={isInvalid
          ? <span className="error-text">That doesn't contain a link.</span>
          : 'Reels, Shorts and TikToks all work. Text around the link is fine — “Check this out! https://…” works too.'}
      >
        <div className="row">
          <textarea
            className="field"
            aria-label="Video link"
            placeholder="https://…"
            rows={2}
            autoCapitalize="none"
            spellCheck={false}
            data-autofocus
            value={link}
            onChange={(event) => {
              setLink(event.target.value);
              setInvalid(false);
            }}
          />
        </div>
        {canPaste && (
          <button
            className="row accent"
            onClick={() => navigator.clipboard.readText().then((text) => text && setLink(text), () => undefined)}
          >
            <ClipboardPaste size={20} aria-hidden />
            Paste from Clipboard
          </button>
        )}
      </Section>
    </Sheet>
  );
}

/** One saved clip: watch it, let the analyzer name its exercises, and put them on the to-try list. */
export function VideoDetail({ state, video }: { state: AppState; video: SavedVideo }) {
  const [showPicker, setShowPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isAnalyzing = useSignal(analyzing).has(video.id);
  const error = useSignal(analysisErrors).get(video.id);
  const online = useSignal(analyzerOnline);

  useEffect(() => {
    if (analyzerOnline.get() === null) void checkAnalyzer();
  }, []);

  const onList = exercisesFrom(state, video.id).sort(byName);
  const pending = pendingSuggestions(state, video);
  const link = webLink(video.url);

  let note: React.ReactNode = null;
  if (error) note = <span className="error-text">{error}</span>;
  else if (isAnalyzing) note = 'Downloading and watching the video. This can take up to a minute.';
  else if (online === false) {
    note = 'Automatic identification needs the analyzer running on your Mac — open this app from its address, or set the address in Settings.';
  } else if (video.analyzedAt !== null && pending.length === 0 && onList.length === 0) {
    note = "The analyzer didn't recognise any exercises in this video.";
  }

  return (
    <Page
      title="Saved Video"
      back="/videos"
      trailing={
        <button className="bar-button" aria-label="Delete video" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={22} aria-hidden />
        </button>
      }
    >
      <Section>
        <div className="video-head">
          <Thumbnail video={video} large />
          <h2>{videoTitle(video)}</h2>
          {video.caption && <p className="small secondary clamp">{video.caption}</p>}
        </div>
        {link && (
          <a className="row accent" href={link} target="_blank" rel="noreferrer">
            <Play size={20} aria-hidden />
            Open in {videoSource(video.url)}
          </a>
        )}
      </Section>

      {onList.length > 0 && (
        <Section title="On your list">
          {onList.map((exercise) => (
            <div key={exercise.id} className="row split">
              <Link to={`/exercises/${exercise.id}`} className="row-main">
                <ExerciseLabel exercise={exercise} />
              </Link>
              <button
                className="bar-button small"
                aria-label={`Remove ${exercise.name}`}
                onClick={() => update((draft) => unlinkExercise(draft, exercise.id, video.id))}
              >
                Remove
              </button>
            </div>
          ))}
        </Section>
      )}

      {pending.length > 0 && (
        <Section title="Found in this video" footer="Identified by AI from the video — check the names before you rely on them.">
          {pending.map((suggestion) => (
            <div key={suggestion.name} className="row split">
              <div className="row-main">
                <span className="grow">
                  {resolvedName(suggestion)}
                  {suggestion.notes && <span className="sub">{suggestion.notes}</span>}
                  {suggestion.setsReps && <span className="sub status row-icon">{suggestion.setsReps}</span>}
                </span>
              </div>
              <button
                className="icon-button"
                aria-label={`Add ${resolvedName(suggestion)}`}
                onClick={() => update((draft) => adoptSuggestion(draft, suggestion, video.id))}
              >
                <CirclePlus size={26} aria-hidden />
              </button>
            </div>
          ))}
          <button
            className="row accent centered"
            onClick={() => update((draft) => pending.forEach((suggestion) => adoptSuggestion(draft, suggestion, video.id)))}
          >
            Add All {pending.length}
          </button>
        </Section>
      )}

      <Section footer={note}>
        <button className="row accent" disabled={isAnalyzing} onClick={() => void analyzeVideo(video.id)}>
          <Sparkles size={20} aria-hidden />
          <span className="grow">{video.analyzedAt === null ? 'Identify Exercises' : 'Identify Again'}</span>
          {isAnalyzing && <Spinner />}
        </button>
        <button className="row accent" onClick={() => setShowPicker(true)}>
          <Hand size={20} aria-hidden />
          Add Exercise Manually
        </button>
      </Section>

      {showPicker && (
        <ExercisePicker
          state={state}
          onClose={() => setShowPicker(false)}
          onAdd={(ids) => update((draft) => ids.forEach((id) => linkExerciseById(draft, id, video.id)))}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this video?"
          message={onList.length > 0 ? 'The exercises added from it stay on your list.' : undefined}
          actions={[{
            label: 'Delete Video',
            destructive: true,
            run: () => {
              update((draft) => deleteVideo(draft, video.id));
              goBack('/videos');
            },
          }]}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </Page>
  );
}
