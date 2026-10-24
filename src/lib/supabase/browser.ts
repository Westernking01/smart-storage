"use client";
import { createBrowserClient } from "@supabase/ssr";
/** Public configuration is supplied only by an enabled, validated server boundary. */
export function browserSupabase(config: { url: string; key: string }) {
  return createBrowserClient(config.url, config.key);
}
