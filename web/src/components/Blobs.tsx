/** Soft organic background shapes. Purely decorative. */
export default function Blobs({ variant = "mint" }: { variant?: "mint" | "lilac" | "both" }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {(variant === "mint" || variant === "both") && (
        <svg className="float-slow absolute -right-40 -top-40 w-[760px] max-w-none" viewBox="0 0 640 600">
          <path
            d="M220 20 C 420 100 640 120 620 340 C 600 540 380 600 250 540 C 100 470 40 330 40 210 C 40 90 120 -20 220 20 Z"
            fill="var(--mint)"
          />
        </svg>
      )}
      {(variant === "lilac" || variant === "both") && (
        <svg className="float-slow absolute -right-24 -top-32 w-[520px] max-w-none [animation-delay:-3s]" viewBox="0 0 500 420">
          <path d="M120 0 C 320 40 500 80 480 250 C 460 400 280 420 180 360 C 80 300 0 200 20 110 C 30 40 60 -10 120 0 Z" fill="var(--lilac)" />
        </svg>
      )}
      {(variant === "mint" || variant === "both") && (
        <svg className="float-slow absolute -bottom-48 -left-40 w-[560px] max-w-none [animation-delay:-5s]" viewBox="0 0 560 420">
          <path d="M80 60 C 240 -20 460 20 520 160 C 580 300 440 420 260 410 C 80 400 -40 300 -20 200 C -10 130 20 90 80 60 Z" fill="var(--peach)" />
        </svg>
      )}
    </div>
  );
}
