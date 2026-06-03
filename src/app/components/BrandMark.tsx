type BrandMarkProps = {
  size?: number;
  className?: string;
};

export function BrandMark({ size = 28, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="4" y="4" width="56" height="56" rx="18" fill="url(#brand-bg)" />
      <path
        d="M34.331 12.4L19.954 32.796C19.548 33.372 19.96 34.168 20.666 34.168H29.161L27.78 51.017C27.702 51.968 28.941 52.377 29.44 51.565L43.694 28.375C44.056 27.786 43.632 27.032 42.941 27.032H35.13L36.113 13.011C36.182 12.03 34.896 11.598 34.331 12.4Z"
        stroke="white"
        strokeWidth="2.8"
        fill="white"
      />
      <defs>
        <linearGradient id="brand-bg" x1="12" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6EA0FF" />
          <stop offset="0.55" stopColor="#5D7BFF" />
          <stop offset="1" stopColor="#4B57E5" />
        </linearGradient>
      </defs>
    </svg>
  );
}
