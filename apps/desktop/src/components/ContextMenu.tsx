import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Dropdown, dropdownVariants } from "@heroui/react";

/** One entry of the context menu: something to do, or a submenu of entries.
 * Every entry has an icon — it is required here so none can be forgotten. */
export type ContextMenuItem =
  | { label: string; icon: ReactNode; disabled?: boolean; onAction: () => void }
  | { label: string; icon: ReactNode; disabled?: boolean; items: ContextMenuItem[] };

type PointerPlace = { clientX: number; clientY: number; shiftKey: boolean; preventDefault: () => void };
type Open = (event: PointerPlace, items: ContextMenuItem[]) => void;

const ContextMenuContext = createContext<Open>(() => {});

/** Opens the app's one context menu at the pointer: `open(event, items)` from
 * any `onContextMenu`. */
export const useContextMenu = () => useContext(ContextMenuContext);

// Passed explicitly: the menu hangs off a bare anchor, not a `<Dropdown>` root,
// and without that root HeroUI's overlay parts get no classes (see
// `DROPDOWN_SLOTS` in `AmpConfigureView.tsx`).
const SLOTS = dropdownVariants();

/** The app's single right-click menu. Mounted once around everything; a view
 * says what the menu holds when it opens it, the instance and its look are
 * shared. It also turns the webview's own menu (Reload, Inspect…) off — kept
 * in text fields, where copy and paste live, and behind Shift for developing. */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      if (e.shiftKey || (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]"))) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);

  const open = useCallback<Open>((event, items) => {
    if (event.shiftKey) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  // `Dropdown.Menu` is a RAC collection: entries have to be its direct
  // children, so this returns elements and never wraps them in a component.
  const entries = (items: ContextMenuItem[]): ReactNode =>
    items.map((item) =>
      "items" in item ? (
        <Dropdown.SubmenuTrigger key={item.label}>
          <Dropdown.Item id={item.label} isDisabled={item.disabled}>
            {item.icon}
            {item.label}
            <Dropdown.SubmenuIndicator />
          </Dropdown.Item>
          <Dropdown.Popover className={SLOTS.popover()}>
            <Dropdown.Menu className={SLOTS.menu()}>{entries(item.items)}</Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.SubmenuTrigger>
      ) : (
        <Dropdown.Item
          key={item.label}
          id={item.label}
          isDisabled={item.disabled}
          onAction={() => {
            setMenu(null);
            item.onAction();
          }}
        >
          {item.icon}
          {item.label}
        </Dropdown.Item>
      ),
    );

  return (
    <ContextMenuContext.Provider value={open}>
      {children}
      <div ref={anchor} style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0, width: 1, height: 1, pointerEvents: "none" }} />
      <Dropdown.Popover
        className={`${SLOTS.popover()} min-w-[180px]`}
        triggerRef={anchor}
        isOpen={menu !== null}
        onOpenChange={(isOpen) => !isOpen && setMenu(null)}
        placement="bottom start"
      >
        <Dropdown.Menu className={SLOTS.menu()}>{menu && entries(menu.items)}</Dropdown.Menu>
      </Dropdown.Popover>
    </ContextMenuContext.Provider>
  );
}
