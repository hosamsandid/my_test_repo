import React from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Server } from 'lucide-react';

const CATALOGS = [
  {
    id: 'sdlc',
    path: '/patterns/sdlc',
    Icon: GitBranch,
    title: 'SDLC Catalog',
    description:
      'End-to-end view of the trigger- and label-driven Software Development Lifecycle workflow. Shows how each agent role fits into the automated CI/CD pipeline.',
    accent: 'var(--eb-color-blue-500, #3b82f6)',
    accentDim: 'oklch(0.45 0.18 250 / 0.12)',
  },
  {
    id: 'mainframe',
    path: '/patterns/mainframe',
    Icon: Server,
    title: 'Mainframe Modernization Catalog',
    description:
      'Pattern catalog covering COBOL, JCL, DB2, IMS, and related mainframe modernization strategies — re-engineering, strangler-fig, microservice extraction, and more.',
    accent: 'var(--eb-color-violet-500, #8b5cf6)',
    accentDim: 'oklch(0.45 0.2 290 / 0.12)',
  },
];

export default function PatternsCatalog() {
  const navigate = useNavigate();

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>Patterns Catalog</h1>
        <p style={subtitleStyle}>
          Browse the available pattern catalogs for this agent studio.
        </p>
      </div>

      <div style={gridStyle}>
        {CATALOGS.map(({ id, path, Icon, title, description, accent, accentDim }) => (
          <button
            key={id}
            onClick={() => navigate(path)}
            style={cardStyle}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = accent;
              e.currentTarget.style.background = accentDim;
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = 'var(--eb-shadow-lg)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--eb-border-default)';
              e.currentTarget.style.background = 'var(--eb-bg-surface)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--eb-shadow-sm)';
            }}
          >
            <div style={{ ...iconWrapStyle, background: accentDim, color: accent }}>
              <Icon size={32} strokeWidth={1.5} />
            </div>
            <h2 style={cardTitleStyle}>{title}</h2>
            <p style={cardDescStyle}>{description}</p>
            <span style={{ ...viewLinkStyle, color: accent }}>View catalog →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const pageStyle = {
  padding: 'var(--eb-space-8)',
  maxWidth: 960,
  margin: '0 auto',
};

const headerStyle = {
  marginBottom: 'var(--eb-space-8)',
};

const titleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-2xl)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const subtitleStyle = {
  marginTop: 'var(--eb-space-2)',
  fontSize: 'var(--eb-text-base)',
  color: 'var(--eb-text-secondary)',
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
  gap: 'var(--eb-space-6)',
};

const cardStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 'var(--eb-space-4)',
  padding: 'var(--eb-space-8)',
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-xl)',
  boxShadow: 'var(--eb-shadow-sm)',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  transition: 'border-color 0.15s, background 0.15s, transform 0.15s, box-shadow 0.15s',
};

const iconWrapStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 64,
  height: 64,
  borderRadius: 'var(--eb-radius-lg)',
};

const cardTitleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-xl)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const cardDescStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.6,
  flex: 1,
};

const viewLinkStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  marginTop: 'var(--eb-space-2)',
};
