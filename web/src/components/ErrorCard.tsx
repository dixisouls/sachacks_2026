export default function ErrorCard({ msg, detail, onRetry }: { msg: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-[28px] bg-surface p-8 text-center shadow-soft">
      <p className="font-bold">{msg}</p>
      {detail && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{detail}</p>}
      {onRetry && (
        <button onClick={onRetry} className="mt-4 h-10 rounded-full bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-ink">
          Try again
        </button>
      )}
    </div>
  );
}
