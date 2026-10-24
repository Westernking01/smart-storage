import type { ThemePreference } from "@/types/theme";

export const THEME_KEY = "smart-storage-theme";
export function parseTheme(value: string | null): ThemePreference {
  return value === "dark" || value === "system" ? value : "light";
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean) {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

// Runs before paint; storage can be unavailable in restricted browser contexts.
export const themeBootstrap = `(()=>{let p='light';try{const v=localStorage.getItem('${THEME_KEY}');if(v==='dark'||v==='system')p=v}catch{}document.documentElement.dataset.theme=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p})()`;
