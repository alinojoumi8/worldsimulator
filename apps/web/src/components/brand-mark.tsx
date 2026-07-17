import { useState } from "react";

export function BrandMark({ compact = false }: { readonly compact?: boolean }) {
  const [imageAvailable, setImageAvailable] = useState(true);
  return (
    <span className={compact ? "brand-mark brand-mark--compact" : "brand-mark"} aria-hidden="true">
      <svg className="brand-mark__fallback" viewBox="0 0 64 64" role="presentation">
        <path d="M13 17C24 6 39 8 48 18c8 9 6 23-2 31" />
        <path d="M51 15c-7 8-10 19-16 31-2 4-5 7-9 6-7-1-11-12-13-26" />
        <path d="M18 13c2 13 7 29 14 36" />
      </svg>
      {imageAvailable ? (
        <img
          className="brand-mark__image"
          src="/brand/worldtangle-mark.svg"
          alt=""
          onError={() => setImageAvailable(false)}
        />
      ) : null}
    </span>
  );
}
