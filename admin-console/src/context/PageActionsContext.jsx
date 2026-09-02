import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

// Holds the DOM node of the header's page-actions slot.
// Shell.jsx provides this; pages call usePageActions() to portal their
// primary action controls into the header without triggering Shell re-renders.
export const PageActionsContext = createContext(null);

// Call in a page component, passing the JSX to render in the header slot.
// Returns a React portal that must be included in the page's returned JSX tree.
// When the page unmounts, the portal unmounts and the slot empties automatically.
// Example:
//   const headerAction = usePageActions(<button onClick={...}>New Item</button>);
//   return <>{headerAction}<div>... page content ...</div></>;
export function usePageActions(content) {
  const slot = useContext(PageActionsContext);
  if (!slot || content == null) return null;
  return createPortal(content, slot);
}
