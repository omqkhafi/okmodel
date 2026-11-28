/**
 * Handbook heading. A feature or engine attribute renders the support chip
 * beside the title, outside the anchor, so the chip is not a link.
 */

import { SupportChip } from "@/components/support-chip";
import { chipForAttributes } from "@/lib/feature-heading";
import { Heading } from "@fumadocs/base-ui/components/heading";
import type { ComponentProps, ReactNode } from "react";

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * MDX heading for one level.
 *
 * Without a known attribute this is the Fumadocs heading. With one, the
 * chip sits next to the anchor.
 *
 * @param as - Heading tag
 */
export function featureHeading(as: HeadingTag) {
  return function DocsHeading({
    feature,
    engines,
    children,
    ...props
  }: ComponentProps<HeadingTag> & {
    readonly feature?: string;
    readonly engines?: string;
    readonly children?: ReactNode;
  }): ReactNode {
    const chip = chipForAttributes({ feature, engines });
    if (chip === undefined) {
      return (
        <Heading as={as} {...props}>
          {children}
        </Heading>
      );
    }
    const id = typeof props.id === "string" ? props.id : undefined;
    const Tag = as;
    const className = ["scroll-m-28", props.className].filter(Boolean).join(" ");
    return (
      <div className="flex flex-row flex-wrap items-center gap-2">
        <Tag {...props} className={className}>
          {id === undefined ? children : <a href={`#${id}`}>{children}</a>}
        </Tag>
        <SupportChip rule={chip} />
      </div>
    );
  };
}
