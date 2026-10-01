// Whether leaving the Team Wizard now would silently discard input (#2658).
// The wizard keeps no draft, so a reload or tab close mid-wizard used to return
// to step 1 with nothing selected. TeamSetup.jsx arms a `beforeunload` warning
// while this is true. Pure so it runs under `node --test`.
//
// Anything past the first step, or a process already picked on it, is input
// worth warning about; once the launch has completed there is nothing left to
// lose (the page navigates to the new team itself).
export function wizardHasUnsavedInput({ step, form, launched }) {
  if (launched) return false;
  return step > 0 || !!(form && form.processBundle);
}
