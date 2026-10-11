import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown rendered for reading (react-markdown never renders raw HTML: a pasted `<script>` stays text). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="ws-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(text)}</ReactMarkdown>
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
