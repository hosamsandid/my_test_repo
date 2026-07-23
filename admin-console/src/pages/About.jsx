import React from 'react';
import AccentureLogo from '../components/AccentureLogo';
import { formatVersionLabel } from '../components/version-info';

const VERSION_LABEL = formatVersionLabel(
  import.meta.env.VITE_GIT_COMMIT,
  import.meta.env.VITE_GIT_DIRTY,
);

export default function About() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: 'var(--eb-space-8) var(--eb-space-6)',
      maxWidth: 600,
      margin: '0 auto',
      gap: 'var(--eb-space-6)',
    }}>
      {/* Accenture copyright */}
      <div style={{ textAlign: 'center' }}>
        <AccentureLogo size={40} style={{ color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-3)' }} />
        <div style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-primary)',
          fontWeight: 'var(--eb-font-medium)',
        }}>
          © 2026 Accenture. All rights reserved.
        </div>
      </div>

      <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--eb-border-default)' }} />

      {/* Parakeet attribution (CC-BY-4.0 required) */}
      <div style={{ textAlign: 'center', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.7 }}>
        <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-2)' }}>
          Speech-to-text powered by NVIDIA Parakeet TDT 0.6B v3
        </div>
        <div>
          Model:{' '}
          <a href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            nvidia/parakeet-tdt-0.6b-v3
          </a>
        </div>
        <div>
          License:{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            CC-BY-4.0
          </a>
        </div>
        <div>Copyright NVIDIA Corporation.</div>
        <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Model converted to ONNX (int8) format for CPU inference via sherpa-onnx; no retraining or fine-tuning performed.
        </div>
      </div>

      <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--eb-border-default)' }} />

      {/* Version */}
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        v{VERSION_LABEL}
      </div>
    </div>
  );
}
