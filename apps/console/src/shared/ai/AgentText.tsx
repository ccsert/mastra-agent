import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent-written summaries share the message renderer's HTML and remote-image policy. */
export function AgentText({
  text,
  className = "",
  plainLocalLinks = false,
}: {
  text: string;
  className?: string;
  plainLocalLinks?: boolean;
}) {
  return (
    <div className={`aui-md ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) =>
            plainLocalLinks && !/^(?:https?:|mailto:)/i.test(href ?? "") ? (
              <span>{children}</span>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {text.trim()}
      </Markdown>
    </div>
  );
}
