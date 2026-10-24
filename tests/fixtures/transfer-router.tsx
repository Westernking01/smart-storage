import type { ComponentProps } from "react";
import { useSyncExternalStore } from "react";
export function usePathname() {
  return useSyncExternalStore(
    (changed) => {
      window.addEventListener("popstate", changed);
      return () => window.removeEventListener("popstate", changed);
    },
    () => window.location.pathname,
    () => "/",
  );
}
export function useRouter() {
  return {
    replace: (path: string) => {
      history.replaceState({}, "", path);
      window.dispatchEvent(new Event("popstate"));
    },
    refresh: () =>
      (
        window as unknown as { transferHarness: { refresh(): void } }
      ).transferHarness.refresh(),
  };
}
export default function Link(props: ComponentProps<"a">) {
  return <a {...props} />;
}
