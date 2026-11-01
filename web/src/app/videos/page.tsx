import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { VideosLibrary } from "@/components/videos-library";

export const metadata: Metadata = { title: "Thư viện video" };

export default function VideosPage() {
  return (
    <Suspense fallback={<Loading />}>
      <VideosLibrary />
    </Suspense>
  );
}
