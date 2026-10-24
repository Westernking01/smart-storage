import { AuthPage } from "@/components/auth-page";
export const dynamic = "force-dynamic";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthPage
      mode="login"
      next={params.next}
      confirmationFailed={params.error === "confirmation"}
    />
  );
}
