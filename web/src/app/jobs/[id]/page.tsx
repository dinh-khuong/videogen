import { Suspense } from "react";
import { JobDetailView } from "@/components/jobs";
import { Loading } from "@/components/ui";

async function Loader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobDetailView id={id} />;
}

export default function JobPage({ params }: PageProps<"/jobs/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Loader params={params} />
    </Suspense>
  );
}
