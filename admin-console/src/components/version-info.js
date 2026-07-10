// Build-time git version label for the footer (#483). VITE_GIT_COMMIT /
// VITE_GIT_DIRTY are embedded at build time (see admin-console/Dockerfile);
// there is no runtime lookup.
export function formatVersionLabel(commit, dirty) {
  if (!commit || commit === 'unknown') return 'unknown';
  return dirty === 'dirty' ? `${commit}-dirty` : commit;
}
