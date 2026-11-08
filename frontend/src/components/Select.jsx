import { Children, useEffect, useId, useRef, useState } from "react";

/**
 * A dropdown whose menu matches the app; the native picker can't be styled.
 * Takes <option> children like <select>. The menu is a popover, so it sits in
 * the top layer (never clipped by the filters panel) and the browser handles
 * click-outside and Escape, returning focus to the button.
 */
export function Select({ label, hideLabel, value, onChange, disabled, children }) {
  const id = useId();
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const typed = useRef({ text: "", at: 0 });
  const options = Children.toArray(children).map((o) => ({ value: String(o.props.value), label: String(o.props.children) }));
  const selected = Math.max(0, options.findIndex((o) => o.value === String(value)));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);

  // Place the menu under the button (above it if there's no room) before it shows.
  useEffect(() => {
    const list = listRef.current;
    const onBeforeToggle = (e) => {
      if (e.newState !== "open") return;
      const r = btnRef.current.getBoundingClientRect();
      const up = window.innerHeight - r.bottom < Math.min(320, options.length * 40 + 12) + 8 && r.top > window.innerHeight - r.bottom;
      const right = r.left + Math.max(r.width, 224) > window.innerWidth - 8;
      Object.assign(list.style, {
        top: up ? "auto" : `${r.bottom + 4}px`,
        bottom: up ? `${window.innerHeight - r.top + 4}px` : "auto",
        left: right ? "auto" : `${r.left}px`,
        right: right ? `${window.innerWidth - r.right}px` : "auto",
        minWidth: `${r.width}px`,
      });
      list.style.setProperty("--origin", `${up ? "bottom" : "top"} ${right ? "right" : "left"}`);
      setActive(selected);
    };
    const onToggle = (e) => {
      setOpen(e.newState === "open");
      if (e.newState === "open") list.focus();
    };
    list.addEventListener("beforetoggle", onBeforeToggle);
    list.addEventListener("toggle", onToggle);
    return () => {
      list.removeEventListener("beforetoggle", onBeforeToggle);
      list.removeEventListener("toggle", onToggle);
    };
  }, [selected, options.length]);

  // The menu is fixed in place, so close it rather than let the page scroll away from it.
  useEffect(() => {
    if (!open) return;
    const hide = () => listRef.current.hidePopover();
    const onScroll = (e) => !listRef.current.contains(e.target) && hide();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, id]);

  const pick = (i) => {
    onChange(options[i].value);
    listRef.current.hidePopover?.();
  };

  const onListKeyDown = (e) => {
    const last = options.length - 1;
    const move = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: last, PageDown: active + 8, PageUp: active - 8 }[e.key];
    if (move != null) {
      e.preventDefault();
      setActive(Math.min(last, Math.max(0, move)));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") {
      listRef.current.hidePopover?.();
    } else if (e.key.length === 1) {
      // Type-ahead, as in a native select: "to" jumps to Toyota.
      const t = typed.current;
      t.text = (Date.now() - t.at < 600 ? t.text : "") + e.key.toLowerCase();
      t.at = Date.now();
      const i = options.findIndex((o) => o.label.toLowerCase().startsWith(t.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div className="field">
      <span id={`${id}-label`} className={hideLabel ? "sr-only" : undefined}>{label}</span>
      <button
        ref={btnRef}
        type="button"
        className="select-btn"
        popoverTarget={`${id}-list`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            listRef.current.showPopover?.();
          }
        }}
      >
        <span id={`${id}-value`}>{options[selected]?.label}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <ul
        ref={listRef}
        id={`${id}-list`}
        popover="auto"
        role="listbox"
        tabIndex={-1}
        className="menu"
        aria-labelledby={`${id}-label`}
        aria-activedescendant={`${id}-${active}`}
        onKeyDown={onListKeyDown}
      >
        {options.map((o, i) => (
          <li
            key={o.value}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === selected}
            className={i === active ? "active" : undefined}
            onMouseMove={() => setActive(i)}
            onClick={() => pick(i)}
          >
            {o.label}
            {i === selected && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5 10 17.5 19 7" />
              </svg>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
