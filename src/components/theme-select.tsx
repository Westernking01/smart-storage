"use client";

import { useTheme } from "@/hooks/use-theme";
import { parseTheme } from "@/lib/theme";
import { useId } from "react";

export function ThemeSelect() {
  const { preference, setTheme } = useTheme();
  const id = useId();
  return (
    <div className="theme-control">
      <label htmlFor={id}>Theme</label>
      <select
        id={id}
        className="ui-input"
        value={preference}
        onChange={(event) => setTheme(parseTheme(event.target.value))}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </div>
  );
}
