import React, { useEffect, useRef, useState } from 'react';

const MAX_LINES = 500;

export default function LogStream({ container }) {
  const [lines, setLines] = useState([]);
  const bottomRef = useRef(null);

  useEffect(() => {
    setLines([]);
    const es = new EventSource(`/api/logs/stream?container=${encodeURIComponent(container)}`);
    es.onmessage = (e) => {
      const line = JSON.parse(e.data);
      setLines(prev => [...prev.slice(-MAX_LINES + 1), line]);
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [container]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <pre style={{
      background: 'var(--eb-bg-secondary, var(--eb-bg-elevated))',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-4)',
      overflow: 'auto',
      height: '500px',
      fontSize: 'var(--eb-text-xs)',
      fontFamily: 'JetBrains Mono, monospace',
      color: 'var(--eb-text-primary)',
      margin: 0,
    }}>
      {lines.length === 0 && (
        <span style={{ color: 'var(--eb-text-muted)' }}>Waiting for log output from "{container}"...</span>
      )}
      {lines.map((line, i) => <div key={i}>{line}</div>)}
      <div ref={bottomRef} />
    </pre>
  );
}
