import { NextResponse } from "next/server";

import { db } from "../../../src/db";

export const runtime = "nodejs";

export async function GET() {
  const rows = await db.example_notes.find({
    orderBy: { id: "asc" },
    limit: 50,
  });
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const title =
    body !== null && typeof body === "object" && "title" in body
      ? (body as { title: unknown }).title
      : undefined;
  if (typeof title !== "string" || title.length === 0) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const row = await db.example_notes.insert({ title });
  return NextResponse.json(row, { status: 201 });
}
