import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { t } from "../i18n";

const EDGE_DISTANCE_PX = 480;
const PANEL_GAP_PX = 12;

interface ControlVisibility {
  top: boolean;
  bottom: boolean;
}

const hiddenControls: ControlVisibility = { top: false, bottom: false };

export function PageJumpControls({
  interactionPanel = null,
}: {
  interactionPanel?: HTMLElement | null;
}) {
  useTranslation();
  const controls = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(hiddenControls);

  useEffect(() => {
    let pageHeight = document.documentElement.scrollHeight;
    let animationFrame: number | null = null;
    const updateControls = () => {
      const panelTop = interactionPanel?.getBoundingClientRect().top;
      // Allow controls to leave the viewport rather than overlap a tall panel.
      const panelClearance =
        panelTop === undefined ? 0 : Math.max(0, window.innerHeight - panelTop + PANEL_GAP_PX);
      controls.current?.style.setProperty("--panel-clearance", `${panelClearance}px`);
      const viewportBottom = window.scrollY + window.innerHeight;
      const next = {
        top: window.scrollY > EDGE_DISTANCE_PX,
        bottom: pageHeight > window.innerHeight && pageHeight - viewportBottom > EDGE_DISTANCE_PX,
      };
      setVisible((current) =>
        current.top === next.top && current.bottom === next.bottom ? current : next,
      );
    };
    const scheduleControlsUpdate = () => {
      if (typeof window.requestAnimationFrame !== "function") {
        updateControls();
        return;
      }
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        updateControls();
      });
    };
    const updatePageGeometry = () => {
      pageHeight = document.documentElement.scrollHeight;
      scheduleControlsUpdate();
    };

    updateControls();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePageGeometry);
    const onScroll = () => {
      if (resizeObserver === null) pageHeight = document.documentElement.scrollHeight;
      scheduleControlsUpdate();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updatePageGeometry);
    resizeObserver?.observe(document.documentElement);
    if (interactionPanel) resizeObserver?.observe(interactionPanel);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updatePageGeometry);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
    };
  }, [interactionPanel]);

  const scrollTo = (top: number) => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <nav ref={controls} className="page-jump-controls" aria-label={t("pagePosition")}>
      <button
        type="button"
        className={`page-jump-control${visible.top ? " is-visible" : ""}`}
        aria-label={t("backToTop")}
        aria-hidden={!visible.top}
        tabIndex={visible.top ? 0 : -1}
        onClick={() => scrollTo(0)}
      >
        <span aria-hidden="true">↑</span> {t("top")}
      </button>
      <button
        type="button"
        className={`page-jump-control${visible.bottom ? " is-visible" : ""}`}
        aria-label={t("jumpToBottom")}
        aria-hidden={!visible.bottom}
        tabIndex={visible.bottom ? 0 : -1}
        onClick={() => scrollTo(document.documentElement.scrollHeight)}
      >
        <span aria-hidden="true">↓</span> {t("end")}
      </button>
    </nav>
  );
}
