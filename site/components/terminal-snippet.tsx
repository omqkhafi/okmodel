"use client";

import { CheckIcon, ClipboardIcon, TerminalIcon } from "@/components/chrome/icons";
import { cn } from "@/lib/cn";
import {
  INSTALL_DRIVERS,
  installCommand,
  isInstallDriver,
  isPackageManager,
  PACKAGE_MANAGERS,
  type InstallDriverId,
  type PackageCommands,
  type PackageManager,
} from "@/lib/package-managers";
import { useEffect, useState } from "react";

const STORAGE_KEY = "okmodel-package-manager";
const CHANGE_EVENT = "okmodel-package-manager";
const DRIVER_KEY = "okmodel-install-driver";

/**
 * Install or `bunx` fence as a terminal: manager tabs, a copy button, and a
 * prompt mark that is not part of the copied command. An install fence also
 * gets a driver tab, which swaps the package on that command.
 *
 * @param commands - The same script for npm, yarn, pnpm, and bun
 * @param driver - Driver the fence named, when the fence is `bun add okmodel`
 */
export function TerminalSnippet({
  commands,
  driver,
}: {
  commands: PackageCommands;
  driver?: InstallDriverId;
}) {
  const [manager, setManager] = usePackageManager();
  const [selectedDriver, setDriver] = useInstallDriver(driver);
  const [copied, setCopied] = useState(false);
  const script = driver === undefined ? commands[manager] : installCommand(selectedDriver, manager);
  const lines = script.split("\n");

  return (
    <div className="my-4 flex flex-col overflow-clip rounded-3xl border border-fd-border not-prose">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-fd-border bg-fd-card pr-2 pl-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fd-muted-foreground">
            <TerminalIcon className="size-3.5" />
            Terminal
          </span>
          <div role="tablist" aria-label="Package manager" className="flex items-center gap-0.5">
            {PACKAGE_MANAGERS.map((name) => {
              const selected = name === manager;
              return (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => {
                  setManager(name);
                  setCopied(false);
                }}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs",
                    selected
                      ? "bg-fd-foreground/10 font-medium text-fd-foreground"
                      : "text-fd-muted-foreground hover:text-fd-foreground",
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(script).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fd-muted-foreground hover:text-fd-foreground"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <ClipboardIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {driver === undefined ? null : (
        <div
          role="tablist"
          aria-label="Postgres driver"
          className="flex flex-wrap items-center gap-0.5 border-b border-fd-border bg-fd-card px-3 py-1.5"
        >
          {INSTALL_DRIVERS.map((item) => {
            const selected = item.id === selectedDriver;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  setDriver(item.id);
                  setCopied(false);
                }}
                className={cn(
                  "rounded-md px-2 py-1 text-xs",
                  selected
                    ? "bg-fd-foreground/10 font-medium text-fd-foreground"
                    : "text-fd-muted-foreground hover:text-fd-foreground",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="overflow-x-auto bg-fd-background px-4 py-4 font-mono text-xs leading-relaxed">
        {lines.map((line, index) => (
          <div key={`${String(index)}-${line}`} className="flex whitespace-nowrap">
            <span className="mr-3 select-none text-fd-muted-foreground" aria-hidden>
              -
            </span>
            <code className="text-fd-foreground">{line}</code>
          </div>
        ))}
      </div>
      {driver === undefined ? null : (
        <p className="border-t border-fd-border px-4 py-3 text-sm text-fd-muted-foreground">
          {INSTALL_DRIVERS.find((item) => item.id === selectedDriver)?.note}
        </p>
      )}
    </div>
  );
}

/**
 * The selected manager, shared by every snippet on the page. The first paint
 * is bun, which is the command the handbook writes.
 */
function usePackageManager(): [PackageManager, (next: PackageManager) => void] {
  const [manager, setManager] = useState<PackageManager>("bun");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isPackageManager(stored)) setManager(stored);

    const onChange = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (typeof detail === "string" && isPackageManager(detail)) setManager(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const select = (next: PackageManager) => {
    setManager(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  };

  return [manager, select];
}

/**
 * Driver tab for an install fence. The first paint is the package written in
 * the fence. A later choice is remembered for the next install snippet.
 *
 * @param initial - Driver named by the fence
 */
function useInstallDriver(initial: InstallDriverId | undefined): [InstallDriverId, (next: InstallDriverId) => void] {
  const [driver, setDriver] = useState<InstallDriverId>(initial ?? "postgresjs");

  useEffect(() => {
    if (initial === undefined) return;
    const stored = window.localStorage.getItem(DRIVER_KEY);
    if (isInstallDriver(stored)) setDriver(stored);
  }, [initial]);

  const select = (next: InstallDriverId) => {
    setDriver(next);
    window.localStorage.setItem(DRIVER_KEY, next);
  };

  return [driver, select];
}
