export default function ErrorCard({ msg, detail, onRetry }: { msg: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-line bg-surface p-8 text-center">
      <p className="font-bold">{msg}</p>
      {detail && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{detail}</p>}
      {onRetry && (
        <button onClick={onRetry} className="mt-4 h-10 rounded-full bg-foreground px-5 text-sm font-semibold text-surface hover:bg-accent-ink">
          Try again
        </button>
      )}
    </div>
  );
}
