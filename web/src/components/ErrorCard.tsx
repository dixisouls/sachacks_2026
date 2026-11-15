export default function ErrorCard({ msg, detail, onRetry }: { msg: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-[28px] bg-surface p-8 text-center shadow-soft">
      <p className="font-bold">{msg}</p>
      {detail && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{detail}</p>}
      {onRetry && (
        <button onClick={onRetry} className="mt-4 min-h-11 rounded-full bg-foreground px-5 text-sm font-bold text-background">
          Retry
        </button>
      )}
    </div>
  );
}
