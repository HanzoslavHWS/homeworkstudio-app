"use client";

import { useEffect, useState } from "react";
import { embedUrl, parseArticleBody, type InlineNode } from "../../domain/support";
import { attachmentUrl } from "../../lib/support/supportClient";

function Inline({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.type === "strong") return <strong key={index}>{node.text}</strong>;
        if (node.type === "em") return <em key={index}>{node.text}</em>;
        if (node.type === "link") {
          return node.external
            ? <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-info underline underline-offset-4">{node.text}</a>
            : <a key={index} href={node.href} className="font-medium text-info underline underline-offset-4">{node.text}</a>;
        }
        return <span key={index}>{node.text}</span>;
      })}
    </>
  );
}

function StoredMedia({ appKey, attachmentId, kind, label }: { appKey: string; attachmentId: string; kind: "image" | "video"; label: string }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    attachmentUrl(appKey, attachmentId).then((value) => { if (!cancelled) setUrl(value); }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [appKey, attachmentId]);
  if (failed) return <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Příloha není dostupná.</p>;
  if (!url) return <div className="h-40 animate-pulse rounded-lg bg-muted" aria-label="Načítám přílohu" />;
  return kind === "image"
    ? <img src={url} alt={label} className="max-h-[480px] w-auto max-w-full rounded-lg border" loading="lazy" />
    : <video src={url} controls preload="metadata" className="w-full max-w-3xl rounded-lg border" aria-label={label || "Video"} />;
}

/**
 * Article text → React elements (V1-SUPPORT-01). Never dangerouslySetInnerHTML: the author's text is
 * parsed into a fixed set of blocks (headings, paragraphs, lists, links, images, videos). Stored files
 * load through short-lived URLs after the server checked the permission; YouTube / Vimeo play in a
 * sandboxed player whose address the app builds itself.
 */
export function ArticleContent({ appKey, body }: Readonly<{ appKey: string; body: string }>) {
  const blocks = parseArticleBody(body);
  return (
    <div className="grid gap-3 text-[15px] leading-relaxed" data-slot="article-content">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return block.level === 2 ? <h2 key={index} className="mt-2 text-lg font-semibold"><Inline nodes={block.inline} /></h2> : <h3 key={index} className="mt-1 text-base font-semibold"><Inline nodes={block.inline} /></h3>;
          case "paragraph":
            return <p key={index}><Inline nodes={block.inline} /></p>;
          case "list":
            return block.ordered
              ? <ol key={index} className="list-decimal grid gap-1 pl-6">{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline nodes={item} /></li>)}</ol>
              : <ul key={index} className="list-disc grid gap-1 pl-6">{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline nodes={item} /></li>)}</ul>;
          case "image":
            return <figure key={index} className="grid gap-1"><StoredMedia appKey={appKey} attachmentId={block.attachmentId} kind="image" label={block.alt} />{block.alt && <figcaption className="text-xs text-muted-foreground">{block.alt}</figcaption>}</figure>;
          case "video":
            return <figure key={index} className="grid gap-1"><StoredMedia appKey={appKey} attachmentId={block.attachmentId} kind="video" label={block.title} />{block.title && <figcaption className="text-xs text-muted-foreground">{block.title}</figcaption>}</figure>;
          case "embed":
            return (
              <figure key={index} className="grid gap-1">
                <div className="aspect-video w-full max-w-3xl overflow-hidden rounded-lg border bg-black">
                  <iframe src={embedUrl(block.provider, block.videoId)} title={block.title || "Video"} className="size-full" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" loading="lazy" />
                </div>
                {block.title && <figcaption className="text-xs text-muted-foreground">{block.title}</figcaption>}
              </figure>
            );
        }
      })}
    </div>
  );
}
