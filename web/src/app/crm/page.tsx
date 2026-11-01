import type { Metadata } from "next";
import { Suspense } from "react";
import { ContactsList } from "@/components/crm";
import { Loading } from "@/components/ui";

export const metadata: Metadata = { title: "Khách hàng" };

export default function CrmPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ContactsList />
    </Suspense>
  );
}
