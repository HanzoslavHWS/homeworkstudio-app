"use client"

/*
 * Shared work blocks of the Generator_ABF UI (SHAD-01), built only from the shadcn/ui primitives in
 * this folder: page header, action bar, filter panel, bulk-action bar, empty / loading / error
 * states, status badge, labelled field, section card and a confirmation dialog. Screens compose
 * these instead of inventing their own buttons, bars and notices.
 */

import * as React from "react"
import { cn } from "cn"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

/** Page title, optional eyebrow / description / count line and the page's actions on the right. */
function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  eyebrow?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div data-slot="page-header" className={cn("mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-xs font-bold tracking-[0.18em] text-muted-foreground uppercase">{eyebrow}</p>}
        <h1 className="text-2xl leading-tight font-bold tracking-tight text-foreground sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <ActionBar>{actions}</ActionBar>}
    </div>
  )
}

/** A row of actions: primary last (rightmost), wraps on narrow screens. */
function ActionBar({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="action-bar" className={cn("flex flex-wrap items-center gap-2", className)} {...props} />
}

/** Bordered panel for search and filters; `more` is rendered below the main row when given. */
function FilterPanel({ className, children, more, ...props }: React.ComponentProps<"div"> & { more?: React.ReactNode }) {
  return (
    <div data-slot="filter-panel" role="search" className={cn("@container mb-4 grid gap-3 rounded-xl border bg-card p-4", className)} {...props}>
      {/* Laid out by the panel's own width (container query), so it fits beside the sidebar at any window size. */}
      <div className="grid items-end gap-3 @xl:grid-cols-2 @5xl:grid-cols-[minmax(220px,2fr)_repeat(3,minmax(150px,1fr))_auto]">{children}</div>
      {more}
    </div>
  )
}

/**
 * Label + control + hint / error, linked for assistive technology: the control must carry the
 * same `id`; hint and error ids are returned by `fieldDescriptionIds(id)` for aria-describedby.
 */
function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string
  label: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div data-slot="field" className={cn("grid min-w-0 gap-1.5", className)}>
      <Label htmlFor={id} className="text-[13px] font-semibold text-muted-foreground">{label}</Label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  )
}

function fieldDescriptionIds(id: string, { hint, error }: { hint?: unknown; error?: unknown }): string | undefined {
  const ids = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean)
  return ids.length ? ids.join(" ") : undefined
}

/** Shown only while something is selected: count, scope, the actions and "Zrušit výběr". */
function BulkActionBar({
  summary,
  detail,
  message,
  onClear,
  clearDisabled,
  children,
  className,
}: {
  summary: React.ReactNode
  detail?: React.ReactNode
  message?: React.ReactNode
  onClear: () => void
  clearDisabled?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="bulk-action-bar"
      role="region"
      aria-label="Hromadné akce"
      className={cn("sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-info/30 bg-info-soft px-4 py-3 shadow-sm", className)}
    >
      <strong className="text-sm">{summary}</strong>
      {detail && <span className="text-sm text-muted-foreground">{detail}</span>}
      <ActionBar className="ml-auto">
        {children}
        <Button type="button" variant="ghost" onClick={onClear} disabled={clearDisabled}>Zrušit výběr</Button>
      </ActionBar>
      {message && <p role="status" className="w-full text-sm text-info">{message}</p>}
    </div>
  )
}

function EmptyState({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div data-slot="empty-state" className={cn("grid justify-items-center gap-2 rounded-xl border border-dashed bg-card px-6 py-10 text-center", className)}>
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  )
}

function LoadingState({ label = "Načítám…", rows = 3, className }: { label?: string; rows?: number; className?: string }) {
  return (
    <div data-slot="loading-state" role="status" aria-live="polite" className={cn("grid gap-2", className)}>
      <span className="text-sm text-muted-foreground">{label}</span>
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}
    </div>
  )
}

type NoticeTone = "error" | "info" | "success" | "warning"

const NOTICE_TONES: Record<NoticeTone, string> = {
  error: "border-destructive/30 bg-[color-mix(in_oklch,var(--ui-destructive)_6%,white)]",
  info: "border-info/30 bg-info-soft text-info",
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-warning/30 bg-warning-soft text-warning",
}

/** Error, warning, success or info message. Errors are announced (role="alert"), others politely. */
function Notice({ tone = "info", title, children, className }: { tone?: NoticeTone; title?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      role={tone === "error" ? "alert" : "status"}
      className={cn("mb-3 border", NOTICE_TONES[tone], className)}
    >
      {title && <AlertTitle>{title}</AlertTitle>}
      {children && <AlertDescription className={cn(tone !== "error" && "text-current")}>{children}</AlertDescription>}
    </Alert>
  )
}

type StatusTone = "success" | "warning" | "neutral" | "muted" | "danger" | "info"

const STATUS_TONES: Record<StatusTone, string> = {
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-warning/30 bg-warning-soft text-warning",
  neutral: "border-border bg-secondary text-secondary-foreground",
  muted: "border-border bg-muted text-muted-foreground",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info-soft text-info",
}

/** Status never by colour alone: a symbol (hidden from screen readers) plus the status text. */
function StatusBadge({ tone = "neutral", symbol, children, className }: { tone?: StatusTone; symbol?: string; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1 font-semibold", STATUS_TONES[tone], className)}>
      {symbol && <span aria-hidden="true">{symbol}</span>}
      {children}
    </Badge>
  )
}

/** A titled block of a page (card detail section, form group). */
function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section data-slot="section-card" className={cn("rounded-xl border bg-card p-4 sm:p-5", className)} {...props}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <ActionBar>{actions}</ActionBar>}
        </div>
      )}
      {children}
    </section>
  )
}

export type ConfirmChoice = Readonly<{ label: string; value: string; destructive?: boolean }>

/**
 * Confirmation dialog (replaces window.confirm). One or more choices; the cancel button always
 * closes without acting. Focus starts on Cancel, Escape cancels.
 */
function ConfirmDialog({
  open,
  title,
  description,
  choices,
  cancelLabel = "Zrušit",
  onChoose,
  onCancel,
  children,
}: {
  open: boolean
  title: React.ReactNode
  description?: React.ReactNode
  choices: readonly ConfirmChoice[]
  cancelLabel?: string
  onChoose: (value: string) => void
  onCancel: () => void
  children?: React.ReactNode
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{cancelLabel}</AlertDialogCancel>
          {choices.map((choice) => (
            <AlertDialogAction key={choice.value} variant={choice.destructive ? "destructive" : "default"} onClick={() => onChoose(choice.value)}>
              {choice.label}
            </AlertDialogAction>
          ))}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export {
  ActionBar,
  BulkActionBar,
  ConfirmDialog,
  EmptyState,
  Field,
  FilterPanel,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  fieldDescriptionIds,
}
