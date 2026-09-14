/**
 * Peek (spec §4, Plane): any object opens as an overlay from any context with "Open full". On a phone
 * it is a bottom sheet.
 */
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog } from "../components/overlays.tsx";
import { buttonVariants } from "../components/primitives.tsx";
import { t } from "../i18n/index.ts";
import { useIsMobile } from "./shell.tsx";

export function Peek(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The stable URL of the object (spec §4: every object has one). */
  fullHref?: string;
  onOpenFull?: () => void;
  identifier?: string;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const openFull = props.fullHref ? (
    <a
      href={props.fullHref}
      onClick={props.onOpenFull}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      <ExternalLink className="size-3.5" aria-hidden="true" />
      {t("ui.openFull")}
    </a>
  ) : props.onOpenFull ? (
    <button
      type="button"
      onClick={props.onOpenFull}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      <ExternalLink className="size-3.5" aria-hidden="true" />
      {t("ui.openFull")}
    </button>
  ) : null;
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.identifier ? `${props.identifier} · ${props.title}` : props.title}
      placement={mobile ? "bottom" : "right"}
      actions={openFull}
    >
      {props.children}
    </Dialog>
  );
}
