"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, LoadingState, Notice, StatusBadge } from "@/components/ui/workspace";
import { ARTICLE_KIND_LABELS_CS, supportAreaLabel } from "../../domain/support";
import { supportApi } from "../../lib/support/supportClient";
import { ArticleContent } from "./ArticleContent";
import type { ArticleView } from "./SupportCenter";

/**
 * „Nápověda k této stránce“ (V1-SUPPORT-01): a side panel over the current screen with the published
 * articles linked to its area key. Nothing underneath is closed, so an open project stays as it was.
 * With no linked article it offers the support overview and reporting a problem instead.
 */
export function ContextHelpSheet({ open, onOpenChange, appKey, area, onOpenSupport, onReport }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appKey: string;
  area: string;
  onOpenSupport: (route?: string) => void;
  onReport: () => void;
}>) {
  const [articles, setArticles] = useState<ArticleView[] | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setArticles(null);
    setError("");
    setOpenId(null);
    supportApi<{ articles: ArticleView[] }>("articles", { query: { app: appKey, area } }).then(
      (body) => { if (!cancelled) setArticles(body.articles.filter((article) => article.status === "published" && article.areaKeys.includes(area))); },
      (cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Nápovědu se nepodařilo načíst."); },
    );
    return () => { cancelled = true; };
  }, [open, appKey, area]);

  const shown = articles?.find((article) => article.id === openId);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-ui="support" className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:max-w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>Nápověda k této stránce</SheetTitle>
          <SheetDescription>{supportAreaLabel(area)}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          {error && <Notice tone="error">{error}</Notice>}
          {!error && !articles && <LoadingState label="Načítám nápovědu…" />}
          {shown ? (
            <div className="grid gap-3">
              <Button type="button" variant="ghost" className="-ml-2 justify-self-start" onClick={() => setOpenId(null)}>← Zpět na seznam</Button>
              <h3 className="text-xl font-bold tracking-tight">{shown.title}</h3>
              {shown.summary && <p className="text-muted-foreground">{shown.summary}</p>}
              <ArticleContent appKey={appKey} body={shown.body} />
              <Button type="button" variant="outline" className="justify-self-start" onClick={() => onOpenSupport(`navody/${shown.id}`)}>Otevřít v Nápovědě a podpoře (komentáře)</Button>
            </div>
          ) : articles && articles.length > 0 ? (
            <ul className="grid gap-2">
              {articles.map((article) => (
                <li key={article.id}>
                  <button type="button" onClick={() => setOpenId(article.id)} className="grid w-full gap-1 rounded-xl border bg-card p-3 text-left hover:border-foreground/40 focus-visible:ring-3 focus-visible:ring-ring/50">
                    <span><StatusBadge tone="neutral">{ARTICLE_KIND_LABELS_CS[article.kind]}</StatusBadge></span>
                    <strong>{article.title}</strong>
                    {article.summary && <span className="text-sm text-muted-foreground">{article.summary}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : articles ? (
            <EmptyState title="K této stránce zatím není návod" description="Podívejte se do přehledu návodů a FAQ, nebo nám napište, co hledáte." />
          ) : null}
          {!shown && (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenSupport()}>Všechny návody a FAQ</Button>
              <Button type="button" onClick={onReport}>Nahlásit problém nebo dotaz</Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
