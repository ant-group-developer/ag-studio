import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown as a team wrote it. react-markdown never renders raw HTML, so a pasted `<script>` stays text. */
export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
