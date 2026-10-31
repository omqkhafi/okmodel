import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <main>OKModel TanStack Start example. Use /api/notes.</main>;
}
