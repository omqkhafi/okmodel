import Link from "next/link";

/**
 * HTML 404. The same destinations are in the markdown 404 body.
 */
export function NotFoundView() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-3xl tracking-tight">Not found</h1>
      <p className="mt-4 text-fd-muted-foreground">No page matched this path.</p>
      <ul className="mt-8 flex flex-col gap-2 text-sm">
        <li>
          <Link href="/docs" className="underline-offset-4 hover:underline">
            Documentation
          </Link>
        </li>
        <li>
          <Link href="/llms.txt" className="underline-offset-4 hover:underline">
            llms.txt
          </Link>
        </li>
        <li>
          <Link href="/sitemap.xml" className="underline-offset-4 hover:underline">
            sitemap.xml
          </Link>
        </li>
      </ul>
    </main>
  );
}
