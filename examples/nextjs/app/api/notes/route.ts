import { NextResponse } from "next/server";

import { db } from "../../../src/db";

export const runtime = "nodejs";

export async function GET() {
  const rows = await db.example_notes.find({ limit: 50 });
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  const title = typeof body.title === "string" ? body.title : "untitled";
  const row = await db.example_notes.insert({ title });
  return NextResponse.json(row, { status: 201 });
}
