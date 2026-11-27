import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';
import { goBack, href, navigate, onLinkClick } from '../lib/router';

interface PageProps {
  /** Shown in the header (unless `heading` replaces it) and in the browser tab. */
  title: string;
  heading?: ReactNode;
  /** Big left-aligned title, as on the tabs. */
  large?: boolean;
  /** Where Back leads when this page was opened directly. */
  back?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}

export function Page({ title, heading, large, back, leading, trailing, children }: PageProps) {
  useEffect(() => {
    document.title = `${title} · Gym Tracker`;
  }, [title]);

  return (
    <>
      <header className={large ? 'page-header large' : 'page-header'}>
        {(back || leading) && (
          <div className="leading">
            {leading ?? (
              <button className="bar-button" onClick={() => goBack(back!)}>
                <ChevronLeft size={24} aria-hidden />
                Back
              </button>
            )}
          </div>
        )}
        <h1>{heading ?? title}</h1>
        {trailing && <div className="trailing">{trailing}</div>}
      </header>
      {children}
    </>
  );
}

interface SectionProps {
  title?: ReactNode;
  /** Names a section that has no title, for screen readers. */
  label?: string;
  /** Right-hand side of the header line. */
  aside?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function Section({ title, label, aside, footer, children }: SectionProps) {
  const titleId = useId();
  return (
    <section className="section" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : label}>
      {(title || aside) && (
        <div className="section-header">
          {/* Only the title is the heading: a count or a button beside it is not part of the section's name. */}
          {title && <h2 id={titleId}>{title}</h2>}
          {aside && <span>{aside}</span>}
        </div>
      )}
      <div className="card">{children}</div>
      {footer && <div className="section-footer">{footer}</div>}
    </section>
  );
}

/** A link to another page of the app. */
export function Link({ to, className, children, label, current }: {
  to: string;
  className?: string;
  children: ReactNode;
  label?: string;
  /** Marks the link as the page being shown. */
  current?: boolean;
}) {
  return (
    <a
      href={href(to)}
      className={className}
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      onClick={(event) => onLinkClick(event, to)}
    >
      {children}
    </a>
  );
}

/** A list row that opens another page. */
export function LinkRow({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="row">
      {children}
      <ChevronRight className="chevron" size={20} aria-hidden />
    </Link>
  );
}

/** Label on the left, value on the right. */
export function ValueRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="row">
      <span>{label}</span>
      <span className="row-value">{value}</span>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Sends the visitor on when the page they asked for doesn't exist (any more). */
export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}
