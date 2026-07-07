import React from 'react';

export default function AccentureLogo({ size = 24, style, ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16.1 17"
      width={size}
      height={size}
      fill="currentColor"
      role="img"
      aria-label="Accenture"
      style={style}
      {...rest}
    >
      <polygon points="0,4.9 0,0 16.1,6.5 16.1,10.5 0,17 0,12 9.4,8.5" />
    </svg>
  );
}
