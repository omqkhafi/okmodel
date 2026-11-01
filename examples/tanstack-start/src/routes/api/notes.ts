import { createFileRoute } from "@tanstack/react-router";

import { db } from "../../db";

export const Route = createFileRoute("/api/notes")({
  server: {
    handlers: {
      GET: async () => {
        const rows = await db.example_notes.find({
          orderBy: { id: "asc" },
          limit: 50,
        });
        return Response.json(rows);
      },
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "body must be JSON" }, { status: 400 });
        }
        const title =
          body !== null && typeof body === "object" && "title" in body
            ? (body as { title: unknown }).title
            : undefined;
        if (typeof title !== "string" || title.length === 0) {
          return Response.json({ error: "title is required" }, { status: 400 });
        }
        const row = await db.example_notes.insert({ title });
        return Response.json(row, { status: 201 });
      },
    },
  },
});
