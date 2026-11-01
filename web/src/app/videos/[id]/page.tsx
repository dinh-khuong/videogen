import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { VideoDetailView } from "@/components/video-detail";

async function Loader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VideoDetailView id={id} />;
}

export default function VideoPage({ params }: PageProps<"/videos/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Loader params={params} />
    </Suspense>
  );
}
