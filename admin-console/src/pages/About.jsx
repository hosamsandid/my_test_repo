import React from 'react';
import AccentureLogo from '../components/AccentureLogo';
import { formatVersionLabel } from '../components/version-info';
import { decodeContributors } from '../components/contributors';

const VERSION_LABEL = formatVersionLabel(
  import.meta.env.VITE_GIT_COMMIT,
  import.meta.env.VITE_GIT_DIRTY,
);

// Contributors extracted from git history at build time (#1742). Empty when the
// build had no git metadata available — the section then hides itself (AC6).
const CONTRIBUTORS = decodeContributors(import.meta.env.VITE_CONTRIBUTORS);

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
        <AccentureLogo size={40} style={{ color: 'var(--eb-accent-primary)', marginBottom: 'var(--eb-space-3)' }} />
        <div style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-primary)',
          fontWeight: 'var(--eb-font-medium)',
        }}>
          © 2026 Accenture. All rights reserved.
        </div>
      </div>

      <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--eb-border-default)' }} />

      {/* Contributors — extracted live from git history at build time (#1742).
          Hidden entirely when the build had no git metadata (AC6). */}
      {CONTRIBUTORS.length > 0 && (
        <>
          <div style={{ textAlign: 'center', width: '100%' }}>
            <div style={{
              fontSize: 'var(--eb-text-md)',
              color: 'var(--eb-text-primary)',
              fontWeight: 'var(--eb-font-medium)',
              marginBottom: 'var(--eb-space-3)',
            }}>
              Contributors
            </div>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: 'var(--eb-space-2) var(--eb-space-3)',
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-secondary)',
              lineHeight: 1.6,
            }}>
              {CONTRIBUTORS.map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
          </div>

          <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--eb-border-default)' }} />
        </>
      )}

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
          {' · '}License:{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            CC-BY-4.0
          </a>
          {' · '}Copyright NVIDIA Corporation.
        </div>
        <div style={{ marginTop: 'var(--eb-space-2)' }}>
          ONNX conversion:{' '}
          <a href="https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            istupakov/parakeet-tdt-0.6b-v3-onnx
          </a>
          {' · '}License:{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            CC-BY-4.0
          </a>
        </div>
        <div style={{ marginTop: 'var(--eb-space-2)' }}>
          Inference:{' '}
          <a href="https://github.com/istupakov/onnx-asr" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            onnx-asr
          </a>
          {' · '}License:{' '}
          <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            MIT
          </a>
        </div>
        <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          No retraining or fine-tuning performed.
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
