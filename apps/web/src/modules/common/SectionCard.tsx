import type { ReactNode } from "react";
import { Button, Dropdown } from "antd";
import { ChevronDown } from "lucide-react";
import "./section-card.css";

/**
 * One section of a side tab (plan 2026-10-29 P3): its own box, the title and how many on the left, one main action on
 * the right, a one-line hint, then the list. Every section of the Sources, Documents and Style tabs is one, so they
 * read the same and never run into each other.
 */
export function SectionCard({ icon, title, count, action, hint, footer, children, className, label }: {
  icon?: ReactNode;
  title: ReactNode;
  count?: number | null;
  /** The main action (one button or an `AddMenu`), at the right of the title. */
  action?: ReactNode;
  hint?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** The section's accessible name when the title is not plain text. */
  label?: string;
}) {
  return (
    <section className={`ws-sec${className ? ` ${className}` : ""}`} aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      <div className="ws-sec__head">
        {icon ? <span className="ws-sec__icon" aria-hidden>{icon}</span> : null}
        <h4 className="ws-sec__title">{title}</h4>
        {count ? <span className="ws-sec__count">{count}</span> : null}
        <span className="ws-sec__grow" />
        {action}
      </div>
      {hint ? <p className="ws-sec__hint">{hint}</p> : null}
      {children !== undefined && children !== null && children !== false ? <div className="ws-sec__body">{children}</div> : null}
      {footer ? <div className="ws-sec__foot">{footer}</div> : null}
    </section>
  );
}

export interface AddMenuItem { key: string; icon?: ReactNode; label: ReactNode; hint?: ReactNode; disabled?: boolean; onClick: () => void }

/** "Add … ▾": the ways to add to a section (pick on ag-go, upload from the computer, from my library). */
export function AddMenu({ label, icon, items, primary, loading, ariaLabel }: {
  label: ReactNode; icon?: ReactNode; items: AddMenuItem[]; primary?: boolean; loading?: boolean; ariaLabel?: string;
}) {
  return (
    <Dropdown trigger={["click"]} placement="bottomRight" menu={{
      items: items.map((i) => ({
        key: i.key, icon: i.icon, disabled: i.disabled ?? false,
        label: <span className="ws-sec__menuitem"><span>{i.label}</span>{i.hint ? <small>{i.hint}</small> : null}</span>,
      })),
      onClick: ({ key }) => items.find((i) => i.key === key)?.onClick(),
    }}>
      <Button size="small" type={primary ? "primary" : "default"} icon={icon} loading={loading ?? false} aria-label={ariaLabel}>
        {label}<ChevronDown size={13} aria-hidden />
      </Button>
    </Dropdown>
  );
}
