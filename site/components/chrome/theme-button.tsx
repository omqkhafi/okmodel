"use client";

import { cn } from "@/lib/cn";
import { useTheme } from "@fumadocs/base-ui/provider/base";
import { Moon, Sun } from "lucide-react";

/**
 * Light/dark toggle. Reads the `dark` class on the document so it does not
 * wait for the theme provider to resolve.
 *
 * @param className - Layout classes for the button
 */
export function ThemeButton({ className }: { className?: string }) {
  const { setTheme } = useTheme();
  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => {
        const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
        setTheme(next);
      }}
      className={cn(className)}
    >
      <Sun className="hidden size-4 dark:block" aria-hidden />
      <Moon className="size-4 dark:hidden" aria-hidden />
    </button>
  );
}
