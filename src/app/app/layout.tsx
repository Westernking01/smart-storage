import { redirect } from "next/navigation";
import { ownerContext } from "@/lib/backend/operations";
export const dynamic = "force-dynamic";
export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await ownerContext();
  } catch {
    redirect("/login?next=/app");
  }
  return children;
}
