"use client";

import { useEffect, useState } from "react";
import { parseTheme, resolveTheme, THEME_KEY } from "@/lib/theme";
import type { ThemePreference } from "@/types/theme";

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>("light");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    let current: ThemePreference = "light";
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(
        current,
        media.matches,
      );
      setPreference(current);
    };
    const read = () => {
      try {
        current = parseTheme(localStorage.getItem(THEME_KEY));
      } catch {
        current = "light";
      }
      apply();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) read();
    };
    const selection = (event: Event) => {
      current = (event as CustomEvent<ThemePreference>).detail;
      apply();
    };
    read();
    media.addEventListener("change", apply);
    window.addEventListener("storage", storage);
    window.addEventListener("smart-storage-theme", selection);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener("storage", storage);
      window.removeEventListener("smart-storage-theme", selection);
    };
  }, []);
  return {
    preference,
    setTheme(next: ThemePreference) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* Selection still works for this visit. */
      }
      window.dispatchEvent(
        new CustomEvent("smart-storage-theme", { detail: next }),
      );
    },
  };
}
