import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeft, ArrowRight, ChevronRight, Check, ExternalLink, ImageOff, RotateCcw,
} from 'lucide-react';
import {
  TOUR_PROGRESS_KEY,
  TOUR_MANIFEST_URL,
  sortChapters,
  findChapter,
  chapterSteps,
  screenshotUrl,
  emptyProgress,
  parseProgress,
  serializeProgress,
  isChapterComplete,
  setCurrent,
  markChapterComplete,
  clearCurrent,
  resumePoint,
  clampStep,
  isLastStep,
} from '../context/tour-view.js';

// Helper Chat guided tour (#1737, Phase 2.2). The tour lives inside the panel
// as a second mode; this component renders the chapter list and the per-chapter
// step carousel. All non-visual logic (sorting, localStorage progress, step
// math) lives in the pure, node:test-covered tour-view.js — this file is the
// thin renderer over it (per the #651 convention). Screenshots are served by
// the static route from #1736; a missing image degrades to a placeholder.

// ── localStorage helpers (browser-only side of tour-view) ────────────────────

function loadProgress() {
  if (typeof window === 'undefined') return emptyProgress();
  try {
    return parseProgress(window.localStorage.getItem(TOUR_PROGRESS_KEY));
  } catch {
    return emptyProgress();
  }
}

function saveProgress(progress) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOUR_PROGRESS_KEY, serializeProgress(progress));
  } catch { /* private-mode / quota — tour still works, just not persisted */ }
}

// ── Small styled bits ────────────────────────────────────────────────────────

const linkBtn = {
  background: 'none',
  border: 'none',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-1)',
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  padding: 'var(--eb-space-1)',
};

function NavButton({ onClick, disabled, children, primary, title }) {
  const idle = primary ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--eb-space-1)',
        background: disabled ? 'var(--eb-bg-hover)' : idle,
        color: disabled
          ? 'var(--eb-text-muted)'
          : (primary ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)'),
        border: primary ? 'none' : '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        fontSize: 'var(--eb-text-sm)',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
      }}
    >
      {children}
    </button>
  );
}

// ── Screenshot with graceful placeholder on load error ───────────────────────

function StepShot({ step, chapterTitle }) {
  const [failed, setFailed] = useState(false);
  const src = screenshotUrl(step);
  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--eb-space-2)',
        minHeight: 160,
        background: 'var(--eb-bg-surface)',
        border: '1px dashed var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        color: 'var(--eb-text-muted)',
        padding: 'var(--eb-space-4)',
        textAlign: 'center',
      }}>
        <ImageOff size={22} />
        <span style={{ fontSize: 'var(--eb-text-sm)' }}>
          {chapterTitle}{step?.id ? ` — ${step.id}` : ''}
        </span>
        <span style={{ fontSize: 'var(--eb-text-xs)' }}>Screenshot not available yet</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={`${chapterTitle} — ${step?.id || 'step'}`}
      onError={() => setFailed(true)}
      style={{
        width: '100%',
        height: 'auto',
        borderRadius: 'var(--eb-radius-md)',
        border: '1px solid var(--eb-border-default)',
        display: 'block',
      }}
    />
  );
}

// ── Chapter list ─────────────────────────────────────────────────────────────

function ChapterList({ chapters, progress, onStart, onResume }) {
  const resume = resumePoint(progress, { chapters });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)', padding: 'var(--eb-space-4)' }}>
      <div>
        <div style={{ fontSize: 'var(--eb-text-base)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>
          Take the Tour
        </div>
        <p style={{ margin: 'var(--eb-space-1) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
          A guided walkthrough of Agent Studio, chapter by chapter.
        </p>
      </div>

      {chapters.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
          No tour chapters are available yet.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          {chapters.map((c, i) => {
            const done = isChapterComplete(progress, c.id);
            return (
              <button
                key={c.id}
                onClick={() => onStart(c.id, 0)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--eb-space-2)',
                  textAlign: 'left',
                  background: 'var(--eb-bg-elevated)',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-md)',
                  color: 'var(--eb-text-primary)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 'var(--eb-text-sm)',
                  padding: 'var(--eb-space-2) var(--eb-space-3)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--eb-bg-elevated)'; }}
              >
                <span style={{
                  flexShrink: 0,
                  width: 20,
                  height: 20,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '50%',
                  background: done ? 'var(--eb-accent-primary)' : 'var(--eb-bg-surface)',
                  color: done ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
                  border: done ? 'none' : '1px solid var(--eb-border-default)',
                  fontSize: 'var(--eb-text-xs)',
                }}>
                  {done ? <Check size={13} /> : i + 1}
                </span>
                <span style={{ flex: 1 }}>{c.title}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' }}>
                  Start <ChevronRight size={14} />
                </span>
              </button>
            );
          })}
        </div>
      )}

      {resume ? (
        <button
          onClick={() => onResume(resume.chapterId, resume.step)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--eb-space-1)',
            background: 'var(--eb-bg-surface)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 'var(--eb-text-sm)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
          }}
        >
          <RotateCcw size={14} /> Resume from where I left off
        </button>
      ) : null}
    </div>
  );
}

// ── Step carousel ────────────────────────────────────────────────────────────

function StepCarousel({ chapter, chapterIndex, chapterCount, step, onStep, onExit, onFinish, onGoToPage }) {
  const steps = chapterSteps(chapter);
  const current = steps[step];
  const last = isLastStep(chapter, step);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={onExit} style={linkBtn} title="Back to chapters">
          <ArrowLeft size={14} /> Back to chapters
        </button>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Chapter {chapterIndex + 1} of {chapterCount}
        </span>
      </div>

      <div style={{ fontSize: 'var(--eb-text-base)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>
        {chapter.title}
      </div>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        Step {step + 1} of {steps.length}
      </div>

      <StepShot step={current} chapterTitle={chapter.title} />

      <p style={{ margin: 0, fontSize: 'var(--eb-text-base)', lineHeight: 1.55, color: 'var(--eb-text-primary)' }}>
        {current?.voiceover || ''}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
        <NavButton onClick={() => onStep(step - 1)} disabled={step <= 0} title="Previous step">
          <ArrowLeft size={14} /> Previous
        </NavButton>
        {last ? (
          <NavButton onClick={onFinish} primary title="Finish this chapter">
            Finish chapter <Check size={14} />
          </NavButton>
        ) : (
          <NavButton onClick={() => onStep(step + 1)} primary title="Next step">
            Next <ArrowRight size={14} />
          </NavButton>
        )}
        {chapter.route ? (
          <NavButton onClick={() => onGoToPage(chapter.route)} title={`Go to ${chapter.route}`}>
            Go to this page <ExternalLink size={14} />
          </NavButton>
        ) : null}
      </div>

      <button onClick={onExit} style={{ ...linkBtn, alignSelf: 'flex-start', color: 'var(--eb-text-muted)' }} title="Exit the tour">
        Exit tour
      </button>
    </div>
  );
}

// ── Top-level tour view ──────────────────────────────────────────────────────

export default function HelperChatTour() {
  const navigate = useNavigate();
  const [manifest, setManifest] = useState(null);
  const [progress, setProgress] = useState(loadProgress);
  // The active chapter id + step, or null chapter for the chapter-list view.
  const [active, setActive] = useState(null); // { chapterId, step } | null

  // Fetch the manifest once when the tour first mounts.
  useEffect(() => {
    let alive = true;
    fetch(TOUR_MANIFEST_URL, { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : { chapters: [] }))
      .then(m => { if (alive) setManifest(m && typeof m === 'object' ? m : { chapters: [] }); })
      .catch(() => { if (alive) setManifest({ chapters: [] }); });
    return () => { alive = false; };
  }, []);

  const chapters = useMemo(() => sortChapters(manifest), [manifest]);

  // Persist progress whenever it changes.
  const firstWrite = useRef(true);
  useEffect(() => {
    if (firstWrite.current) { firstWrite.current = false; return; }
    saveProgress(progress);
  }, [progress]);

  const openChapter = (chapterId, step) => {
    const chapter = findChapter(manifest, chapterId);
    if (!chapter) return;
    const s = clampStep(chapter, step);
    setActive({ chapterId, step: s });
    setProgress(p => setCurrent(p, chapterId, s));
  };

  const goStep = (nextStep) => {
    if (!active) return;
    const chapter = findChapter(manifest, active.chapterId);
    const s = clampStep(chapter, nextStep);
    setActive({ chapterId: active.chapterId, step: s });
    setProgress(p => setCurrent(p, active.chapterId, s));
  };

  const exitToList = () => {
    setActive(null);
    setProgress(p => clearCurrent(p));
  };

  const finishChapter = () => {
    if (!active) return;
    setProgress(p => markChapterComplete(p, active.chapterId));
    setActive(null);
  };

  const goToPage = (route) => {
    // Navigate but keep the panel open — the user follows along on the page.
    if (route) navigate(route);
  };

  if (manifest === null) {
    return (
      <div style={{ padding: 'var(--eb-space-4)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        Loading tour…
      </div>
    );
  }

  if (!active) {
    return (
      <ChapterList
        chapters={chapters}
        progress={progress}
        onStart={openChapter}
        onResume={openChapter}
      />
    );
  }

  const chapter = findChapter(manifest, active.chapterId);
  if (!chapter) {
    // Chapter vanished from the manifest — fall back to the list.
    return (
      <ChapterList chapters={chapters} progress={progress} onStart={openChapter} onResume={openChapter} />
    );
  }
  const chapterIndex = chapters.findIndex(c => c.id === active.chapterId);

  return (
    <StepCarousel
      chapter={chapter}
      chapterIndex={chapterIndex < 0 ? 0 : chapterIndex}
      chapterCount={chapters.length}
      step={active.step}
      onStep={goStep}
      onExit={exitToList}
      onFinish={finishChapter}
      onGoToPage={goToPage}
    />
  );
}
