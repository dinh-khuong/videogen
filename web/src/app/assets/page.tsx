import type { Metadata } from "next";
import { Suspense } from "react";
import { AssetsLibrary } from "@/components/asset-drive";
import { Loading } from "@/components/ui";

export const metadata: Metadata = { title: "Assets" };

export default function AssetsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AssetsLibrary />
    </Suspense>
  );
}
