import { Suspense } from "react";
import { ContactDetailView } from "@/components/crm";
import { Loading } from "@/components/ui";

async function Loader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactDetailView id={id} />;
}

export default function ContactPage({ params }: PageProps<"/crm/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Loader params={params} />
    </Suspense>
  );
}
