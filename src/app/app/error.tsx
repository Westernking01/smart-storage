"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <h1 className="type-page">Private workspace unavailable</h1>
      <p>
        Account metadata could not be loaded. No transfer success is assumed.
      </p>
      <Button onClick={reset}>Reload workspace</Button>
    </>
  );
}
