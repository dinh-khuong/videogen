import type { Metadata } from "next";
import { Suspense } from "react";
import { AssetsLibrary } from "@/components/assets-library";
import { Loading } from "@/components/ui";

export const metadata: Metadata = { title: "Assets" };

export default function AssetsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AssetsLibrary />
    </Suspense>
  );
}
