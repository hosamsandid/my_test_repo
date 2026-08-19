// Pure, React-free core for the Helper Chat guided tour (#1737, Phase 2.2).
// Everything that can be decided without the browser lives here so it is
// node:test-covered (admin-console-src CI job) while HelperChatPanel.jsx stays a
// thin renderer over it (per the #651 convention). This module owns: sorting the
// manifest chapters, the localStorage progress shape (parse/serialize/mutate),
// the screenshot URL, and the step-navigation math.

// localStorage key the tour persists its progress under.
export const TOUR_PROGRESS_KEY = 'helper-chat.tour-progress';

// The static endpoint the pre-built manifest is served from (#1737 §5).
export const TOUR_MANIFEST_URL = '/api/helper/tour-manifest';

// Screenshots are served by the static route added in #1736 (§5 there). The
// manifest step carries a repo-relative `screenshotPath` like
// "team-setup/select-process.png"; the route roots that under e2e/artifacts/.
export const TOUR_SCREENSHOT_BASE = '/api/helper/tour-screenshot';

// ── Manifest ────────────────────────────────────────────────────────────────

// Chapters in stable display order. The manifest gives each chapter an `order`
// integer; ties fall back to the original array position so the sort is
// deterministic. Returns a new array — never mutates the manifest.
export function sortChapters(manifest) {
  const chapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
  return chapters
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const oa = Number.isFinite(a.c?.order) ? a.c.order : Number.MAX_SAFE_INTEGER;
      const ob = Number.isFinite(b.c?.order) ? b.c.order : Number.MAX_SAFE_INTEGER;
      return oa === ob ? a.i - b.i : oa - ob;
    })
    .map(({ c }) => c);
}

// Locate a chapter by id in the manifest (unsorted lookup is fine).
export function findChapter(manifest, chapterId) {
  const chapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
  return chapters.find(c => c && c.id === chapterId) || null;
}

// A chapter's steps as a safe array.
export function chapterSteps(chapter) {
  return Array.isArray(chapter?.steps) ? chapter.steps : [];
}

// The full screenshot URL for a step, or '' when the step declares none.
export function screenshotUrl(step) {
  const p = step?.screenshotPath;
  if (typeof p !== 'string' || !p) return '';
  return `${TOUR_SCREENSHOT_BASE}/${p.replace(/^\/+/, '')}`;
}

// ── Progress (localStorage shape) ─────────────────────────────────────────────

// The canonical empty progress object.
export function emptyProgress() {
  return { completedChapters: [], currentChapter: null, currentStep: 0 };
}

// Normalize any parsed/stored value into a well-formed progress object. Tolerant
// of corrupt/partial JSON so a stale key can never crash the panel.
export function normalizeProgress(value) {
  const v = value && typeof value === 'object' ? value : {};
  const completed = Array.isArray(v.completedChapters)
    ? [...new Set(v.completedChapters.filter(x => typeof x === 'string'))]
    : [];
  const currentChapter = typeof v.currentChapter === 'string' && v.currentChapter
    ? v.currentChapter
    : null;
  const step = Number.isFinite(v.currentStep) && v.currentStep >= 0
    ? Math.floor(v.currentStep)
    : 0;
  return { completedChapters: completed, currentChapter, currentStep: currentChapter ? step : 0 };
}

// Parse the raw localStorage string. Never throws.
export function parseProgress(raw) {
  if (typeof raw !== 'string' || !raw) return emptyProgress();
  try {
    return normalizeProgress(JSON.parse(raw));
  } catch {
    return emptyProgress();
  }
}

// Serialize progress back to a string for localStorage.
export function serializeProgress(progress) {
  return JSON.stringify(normalizeProgress(progress));
}

export function isChapterComplete(progress, chapterId) {
  return normalizeProgress(progress).completedChapters.includes(chapterId);
}

// Record where the user currently is (chapter + step) without marking complete.
export function setCurrent(progress, chapterId, step = 0) {
  const p = normalizeProgress(progress);
  return {
    ...p,
    currentChapter: chapterId || null,
    currentStep: chapterId && Number.isFinite(step) && step >= 0 ? Math.floor(step) : 0,
  };
}

// Mark a chapter complete and clear the in-progress pointer (the user is bounced
// back to the chapter list). Idempotent — completing twice adds no duplicate.
export function markChapterComplete(progress, chapterId) {
  const p = normalizeProgress(progress);
  const completedChapters = p.completedChapters.includes(chapterId)
    ? p.completedChapters
    : [...p.completedChapters, chapterId];
  return { completedChapters, currentChapter: null, currentStep: 0 };
}

// Clear the in-progress pointer without touching completion (e.g. "Exit tour").
export function clearCurrent(progress) {
  const p = normalizeProgress(progress);
  return { ...p, currentChapter: null, currentStep: 0 };
}

// Whether a "Resume from where I left off" affordance should show: there is a
// saved current chapter AND it still exists in the manifest with a valid step.
export function resumePoint(progress, manifest) {
  const p = normalizeProgress(progress);
  if (!p.currentChapter) return null;
  const chapter = findChapter(manifest, p.currentChapter);
  if (!chapter) return null;
  const steps = chapterSteps(chapter);
  if (steps.length === 0) return null;
  const step = Math.min(p.currentStep, steps.length - 1);
  return { chapterId: p.currentChapter, step };
}

// Clamp a requested step index into a chapter's valid range.
export function clampStep(chapter, step) {
  const total = chapterSteps(chapter).length;
  if (total === 0) return 0;
  if (!Number.isFinite(step) || step < 0) return 0;
  return Math.min(Math.floor(step), total - 1);
}

// True when `step` is the last step of the chapter (so "Next" becomes "Finish").
export function isLastStep(chapter, step) {
  const total = chapterSteps(chapter).length;
  return total > 0 && step >= total - 1;
}
