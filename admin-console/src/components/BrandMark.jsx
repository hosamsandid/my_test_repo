import React from 'react';

/**
 * The Agent Studio mark: a terminal prompt ready for the next job.
 * Same artwork as the browser favicon (admin-console/public/favicon.svg) — keep the two in sync.
 */
export default function BrandMark({ size = 28, style, ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label="Agent Studio"
      style={style}
      {...rest}
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#A100FF" />
      <path
        d="M8.5 11 L14.2 16 L8.5 21"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="17" y="18" width="7.5" height="3.2" rx="1.6" fill="#FFFFFF" />
    </svg>
  );
}
