import { Fragment, type ReactNode } from "react";

/** `**bold**` inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>);
}

/**
 * A guide section's body as the locale writes it: paragraphs split by a blank line, "- " lines as a list, "1. " lines
 * as a numbered list, a list right under a paragraph line belonging to the same block.
 */
export function GuideText({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, b) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const out: ReactNode[] = [];
        let list: { ordered: boolean; items: string[] } | null = null;
        const flush = () => {
          if (!list) return;
          const items = list.items.map((x, i) => <li key={i}>{inline(x)}</li>);
          out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
          list = null;
        };
        for (const line of lines) {
          const bullet = /^- (.*)$/.exec(line);
          const numbered = /^\d+\. (.*)$/.exec(line);
          const item = bullet ?? numbered;
          if (item) {
            const ordered = !!numbered;
            if (list && list.ordered !== ordered) flush();
            list ??= { ordered, items: [] };
            list.items.push(item[1]!);
          } else {
            flush();
            out.push(<p key={out.length}>{inline(line)}</p>);
          }
        }
        flush();
        return <Fragment key={b}>{out}</Fragment>;
      })}
    </>
  );
}
