import Logo from "./Logo";

export default function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex max-w-[1280px] flex-col items-center gap-3 px-4 py-10 text-center sm:px-8">
        <Logo size={22} />
        <p className="max-w-[620px] text-[13px] leading-relaxed text-muted">
          RepurposeKG generates research hypotheses for experts. It is not medical advice and must not be used to make
          treatment decisions. Scores rank candidates within a list; they are not probabilities.
        </p>
      </div>
    </footer>
  );
}
