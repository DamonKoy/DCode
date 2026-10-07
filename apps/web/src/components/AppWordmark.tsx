import type { SVGProps } from "react";

/** DCode brand mark: a bold geometric "D" that pairs with "Code" in the sidebar. */
export function AppWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6 3H50C79 3 97 22 97 50C97 78 79 97 50 97H6ZM27 25V75H49C66 75 76 65 76 50C76 35 66 25 49 25Z"
        fill="currentColor"
      />
    </svg>
  );
}
