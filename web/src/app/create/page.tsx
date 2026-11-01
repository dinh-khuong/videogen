import type { Metadata } from "next";
import { Suspense } from "react";
import { CreateVideoForm } from "@/components/create-form";
import { Loading } from "@/components/ui";

export const metadata: Metadata = { title: "Tạo video" };

export default function CreatePage() {
  return (
    <Suspense fallback={<Loading />}>
      <CreateVideoForm />
    </Suspense>
  );
}
