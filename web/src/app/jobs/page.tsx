import type { Metadata } from "next";
import { JobsList } from "@/components/jobs";

export const metadata: Metadata = { title: "Hàng đợi" };

export default function JobsPage() {
  return <JobsList />;
}
