import Link from "next/link";
import DiseaseSearch from "@/components/DiseaseSearch";
import Footer from "@/components/Footer";
import { DEMO_DISEASES } from "@/lib/config";

export default function FindDrugs() {
  return (
    <div className="flex min-h-[calc(100dvh-64px)] flex-col">
      <section className="mx-auto flex w-full max-w-[760px] flex-1 flex-col items-center px-4 pt-20 text-center sm:px-8 sm:pt-32">
        <h1 className="text-[clamp(42px,6.5vw,76px)] font-extrabold leading-[0.95] tracking-[-0.05em]">Which disease?</h1>
        <p className="mt-5 max-w-[520px] text-[17px] leading-relaxed text-muted">
          Type a name or a synonym. Diseases with only a few known genes are flagged, because their rankings are weaker.
        </p>
        <div className="mt-10 w-full">
          <DiseaseSearch autoFocus />
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[14px]">
          <span className="text-muted">Or start with</span>
          {DEMO_DISEASES.map((d) => (
            <Link
              key={d.disease_id}
              href={`/d/${d.disease_id}`}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 font-semibold transition-colors hover:border-disease"
            >
              <span className="h-2 w-2 rounded-full bg-disease" />
              {d.name}
            </Link>
          ))}
        </div>
      </section>
      <Footer />
    </div>
  );
}
