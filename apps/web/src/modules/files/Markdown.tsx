import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useInRouterContext } from "react-router-dom";

/** A link inside Studio's web: a path of this site (`/p/<id>/v/<id>?tab=preview`), never `//host`, `/\host` or a scheme. */
export function isInternalHref(href: string | undefined): href is string {
  return !!href && href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\");
}

/** A link of the text: one inside Studio goes through the router (no page reload, the chat stays), others open apart. */
function MdLink({ href, children, node: _node, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const inRouter = useInRouterContext();
  if (isInternalHref(href) && inRouter) return <Link to={href} {...rest}>{children}</Link>;
  if (isInternalHref(href)) return <a href={href} {...rest}>{children}</a>;
  return <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>;
}

/** Markdown rendered for reading (react-markdown never renders raw HTML: a pasted `<script>` stays text). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="ws-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>{stripFrontmatter(text)}</ReactMarkdown>
    </div>
  );
}

/** The body of a markdown file without its leading `---` YAML block (shown apart by the file view). */
export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** The leading `---` YAML block of a markdown file, as written (null when there is none). */
export function frontmatterOf(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1]! : null;
}
