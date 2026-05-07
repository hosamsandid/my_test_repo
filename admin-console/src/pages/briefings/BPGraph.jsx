import React, { useRef, useEffect } from 'react';
import { initBPGraph } from './bp-graph';

export function BPGraph({ orchestratorId, workspacePath }) {
  const viewportRef = useRef(null);

  useEffect(() => {
    if (!viewportRef.current || !workspacePath) return;
    const cleanup = initBPGraph(viewportRef.current, {
      apiBase:   '/api/bp-explorer',
      workspace: workspacePath,
    });
    return cleanup;
  }, [orchestratorId, workspacePath]);

  return (
    <div
      ref={viewportRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
