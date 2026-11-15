import Link from "next/link";
import Blobs from "@/components/Blobs";
import DiseaseSearch from "@/components/DiseaseSearch";
import Footer from "@/components/Footer";
import { DEMO_DISEASES } from "@/lib/config";

export default function TryIt() {
  return (
    <div className="relative isolate flex min-h-[calc(100dvh-84px)] flex-col overflow-hidden">
      <Blobs variant="mint" />
      <section className="mx-auto w-full max-w-[860px] flex-1 px-4 pt-16 sm:px-8 sm:pt-28">
        <p className="text-[15px] font-semibold text-accent-ink">Step 1 of 2</p>
        <h1 className="mt-4 text-[clamp(40px,6vw,72px)] font-extrabold leading-[1] tracking-[-0.045em]">Which disease?</h1>
        <p className="mt-5 max-w-[560px] text-lg text-muted">
          Type a name or a synonym. Diseases with only a few known genes are marked, because their rankings are weaker.
        </p>
        <div className="mt-10">
          <DiseaseSearch autoFocus />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-2 text-[15px] font-semibold">
          <span className="mr-1 text-muted">Or start with</span>
          {DEMO_DISEASES.map((d) => (
            <Link
              key={d.disease_id}
              href={`/d/${d.disease_id}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-surface/70 px-4 transition-colors hover:bg-surface"
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
