import { useCallback, useRef } from 'react';
// Single source of truth for the id slug rules lives in the pure, React-free
// id-field-view module (so it unit-tests under node --test). Re-exported here
// for the existing import sites (e.g. Agents.jsx imports `sanitizeId`).
import { deriveIdFromName, sanitizeId } from '../components/id-field-view.js';

export { deriveIdFromName, sanitizeId };

/**
 * useAutoDerivedId — keeps an ID field in sync with a display-name field
 * until the user manually edits the ID, then stops overwriting it.
 *
 * Designed to plug into existing form-state objects:
 *
 *   const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } =
 *     useAutoDerivedId({
 *       initiallyAuto: !isEdit,
 *       setName: v => update('displayName', v),
 *       setId:   v => update('id', v),
 *     });
 *
 *   <input value={form.displayName} onChange={e => handleNameChange(e.target.value)} />
 *   <input value={form.id}          onChange={e => handleIdChange(e.target.value)} />
 *
 * The hook owns no state of its own — the consumer keeps its existing state
 * shape. `initiallyAuto` defaults to `true`; pass `false` for edit dialogs
 * (where the ID is fixed) or when the form already has a user-supplied ID.
 */
export default function useAutoDerivedId({
  setName,
  setId,
  initiallyAuto = true,
  getName,
} = {}) {
  const autoDerived = useRef(initiallyAuto);

  const handleNameChange = useCallback((value) => {
    if (setName) setName(value);
    if (autoDerived.current && setId) {
      setId(deriveIdFromName(value));
    }
  }, [setName, setId]);

  const handleIdChange = useCallback((value) => {
    autoDerived.current = false;
    if (setId) setId(sanitizeId(value));
  }, [setId]);

  const resetAutoDerive = useCallback(() => {
    autoDerived.current = true;
    if (setId && getName) setId(deriveIdFromName(getName()));
  }, [setId, getName]);

  return {
    handleNameChange,
    handleIdChange,
    resetAutoDerive,
    isAutoDerived: () => autoDerived.current,
  };
}
