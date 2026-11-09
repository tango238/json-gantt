import type { ReactNode } from "react";

// 16px inline SVG icons, stroke = currentColor (03 section 8.1). No icon library.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconNew = () => (
  <Icon>
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3" />
  </Icon>
);
export const IconOpen = () => (
  <Icon>
    <path d="M2 4.5h4l1.5 1.5H14v7H2z" />
  </Icon>
);
export const IconSave = () => (
  <Icon>
    <path d="M3 2h8l2 2v10H3z" />
    <path d="M5.5 2v3.5h4V2M5.5 14V9.5h5V14" />
  </Icon>
);
export const IconUndo = () => (
  <Icon>
    <path d="M6 3 3 6l3 3" />
    <path d="M3 6h6a4 4 0 0 1 0 8H7" />
  </Icon>
);
export const IconRedo = () => (
  <Icon>
    <path d="m10 3 3 3-3 3" />
    <path d="M13 6H7a4 4 0 0 0 0 8h2" />
  </Icon>
);
export const IconAdd = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
export const IconDelete = () => (
  <Icon>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9M7 7v4M9 7v4" />
  </Icon>
);
export const IconDuplicate = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Icon>
);
export const IconIndent = () => (
  <Icon>
    <path d="M2 3h12M8 6.5h6M8 10h6M2 13.5h12" />
    <path d="m2.5 6.5 2.5 1.75L2.5 10z" />
  </Icon>
);
export const IconOutdent = () => (
  <Icon>
    <path d="M2 3h12M8 6.5h6M8 10h6M2 13.5h12" />
    <path d="M5 6.5 2.5 8.25 5 10z" />
  </Icon>
);
export const IconMoveUp = () => (
  <Icon>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Icon>
);
export const IconMoveDown = () => (
  <Icon>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Icon>
);
export const IconSwap = () => (
  <Icon>
    <path d="M3 5.5h9M9.5 3 12 5.5 9.5 8M13 10.5H4M6.5 8 4 10.5 6.5 13" />
  </Icon>
);
export const IconPdf = () => (
  <Icon>
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3M6 10h4M6 12h2.5" />
  </Icon>
);
export const IconSidePanel = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M10 3v10" />
  </Icon>
);
