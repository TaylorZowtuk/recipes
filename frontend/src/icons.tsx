import type { ReactNode } from "react";

// 2.25px rounded line icons, drawn on a 24px grid for the repo.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const RecipesIcon = () => (
  <Icon>
    <path d="M3.5 12h17a8.5 8.5 0 0 1-17 0Z" />
    <path d="M9 3.5c-1 1.25 1 2.25 0 4.5M15 3.5c-1 1.25 1 2.25 0 4.5" />
  </Icon>
);

export const WeekIcon = () => (
  <Icon>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Icon>
);

export const FridgeIcon = () => (
  <Icon>
    <rect x="5.5" y="2.5" width="13" height="19" rx="3" />
    <path d="M5.5 10h13M9 6v1M9 13v3" />
  </Icon>
);

export const SitesIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M3.25 12h17.5M12 3.25c2.5 2.5 3.5 5.5 3.5 8.75s-1 6.25-3.5 8.75c-2.5-2.5-3.5-5.5-3.5-8.75s1-6.25 3.5-8.75Z" />
  </Icon>
);

export const AccountIcon = () => (
  <Icon>
    <circle cx="12" cy="8.5" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Icon>
);
