import { generate as DefaultImage } from "@fumadocs/base-ui/og";
import { readTagline } from "@/lib/package-meta";
import { SITE_NAME } from "@/lib/site-identity";
import { ImageResponse } from "next/og";

export const revalidate = false;

/**
 * Homepage Open Graph image. The description is the repository positioning line.
 */
export function GET() {
  return new ImageResponse(
    <DefaultImage title={SITE_NAME} description={readTagline()} site={SITE_NAME} />,
    {
      width: 1200,
      height: 630,
    },
  );
}
