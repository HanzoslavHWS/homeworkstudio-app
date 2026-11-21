"use client";

import { useEffect, useState } from "react";
import { parseRichText, renderableUrl, SEE_DEFAULT_LINK_LABEL, type SeeLink } from "../../domain/seeContent";

/**
 * Picture stored in HWS SEE (annotation / information panel). The URL is requested through the same
 * authorized file endpoint as models and documents (PIN grant, publication state, re-keying), right
 * before it is shown — short-lived URLs are never cached in the page.
 */
export function SeeImage({ fileId, resolve, alt, className }: Readonly<{ fileId: string; resolve: (fileId: string) => Promise<string>; alt: string; className?: string }>) {
  const [state, setState] = useState<{ fileId: string; url?: string; failed?: boolean }>({ fileId });
  useEffect(() => {
    let cancelled = false;
    setState({ fileId });
    resolve(fileId).then(
      (url) => !cancelled && setState({ fileId, url }),
      () => !cancelled && setState({ fileId, failed: true }),
    );
    return () => { cancelled = true; };
    // resolve identity may change every render; the picture depends on the file only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);
  if (state.failed) return <div className={`seeImage seeImageFailed ${className ?? ""}`}>Obrázek se nepodařilo načíst.</div>;
  if (!state.url) return <div className={`seeImage seeImageLoading ${className ?? ""}`} aria-busy="true" />;
  return (
    <div className={`seeImage ${className ?? ""}`}>
      <img src={state.url} alt={alt} loading="lazy" decoding="async" onError={() => setState({ fileId, failed: true })} />
    </div>
  );
}

/** HTML-free formatted text: paragraphs, line breaks, bullet lists and **bold** (domain/seeContent.ts). */
export function SeeRichText({ text, className }: Readonly<{ text: string; className?: string }>) {
  const blocks = parseRichText(text);
  if (!blocks.length) return null;
  return (
    <div className={`seeRichText ${className ?? ""}`}>
      {blocks.map((block, blockIndex) => block.type === "list" ? (
        <ul key={blockIndex}>
          {block.items.map((item, itemIndex) => <li key={itemIndex}>{item.map((span, spanIndex) => (span.bold ? <strong key={spanIndex}>{span.text}</strong> : <span key={spanIndex}>{span.text}</span>))}</li>)}
        </ul>
      ) : (
        <p key={blockIndex}>
          {block.lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 && <br />}
              {line.map((span, spanIndex) => (span.bold ? <strong key={spanIndex}>{span.text}</strong> : <span key={spanIndex}>{span.text}</span>))}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/** External link button — only safe absolute URLs, always a new tab without opener/referrer. */
export function SeeExternalLink({ link, className }: Readonly<{ link: SeeLink; className?: string }>) {
  const href = renderableUrl(link.url);
  if (!href) return null;
  return (
    <a className={`seeExternalLink ${className ?? ""}`} href={href} target="_blank" rel="noopener noreferrer">
      {link.label || SEE_DEFAULT_LINK_LABEL}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}
