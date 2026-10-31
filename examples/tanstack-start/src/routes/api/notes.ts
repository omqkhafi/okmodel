import { createFileRoute } from "@tanstack/react-router";

import { db } from "../../db";

export const Route = createFileRoute("/api/notes")({
  server: {
    handlers: {
      GET: async () => {
        const rows = await db.example_notes.find({ limit: 50 });
        return Response.json(rows);
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { title?: string };
        const title = typeof body.title === "string" ? body.title : "untitled";
        const row = await db.example_notes.insert({ title });
        return Response.json(row, { status: 201 });
      },
    },
  },
});
