import type { Metadata } from "next";
import { Suspense } from "react";
import { ImagesLibrary } from "@/components/images-library";
import { Loading } from "@/components/ui";

export const metadata: Metadata = { title: "Thư viện ảnh" };

export default function ImagesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ImagesLibrary />
    </Suspense>
  );
}
