import type { Metadata } from "next";
import { TokenManager } from "@/components/tokens";

export const metadata: Metadata = { title: "Token API" };

export default function TokensPage() {
  return <TokenManager />;
}
