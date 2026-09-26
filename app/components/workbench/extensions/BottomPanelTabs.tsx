/**
 * @file Bottom-panel tab router for the bolt.diy editor.
 *
 * @remarks
 * Icon-only tab strip with hover/focus tooltips. Shows the Terminal(s) only —
 * the "Problems" and "Logs" extension tabs (and their machinery) were removed.
 *
 * @example
 * <BottomPanelTabs />
 */
import { useStore } from '@nanostores/react';
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Panel, type ImperativePanelHandle } from 'react-resizable-panels';
import { shortcutEventEmitter } from '~/lib/hooks';
import { themeStore } from '~/lib/stores/theme';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';
import { createScopedLogger } from '~/utils/logger';
import { Terminal, type TerminalRef } from '~/components/workbench/terminal/Terminal';
import { TerminalManager } from '~/components/workbench/terminal/TerminalManager';
import * as Tooltip from '@radix-ui/react-tooltip';

const logger = createScopedLogger('BottomPanelTabs');

const MAX_TERMINALS = 3;
export const DEFAULT_BOTTOM_PANEL_SIZE = 30;

type ActiveTab = { kind: 'terminal'; index: number };

export const BottomPanelTabs = memo(() => {
  const showTerminal = useStore(workbenchStore.showTerminal);
  const theme = useStore(themeStore);

  const terminalRefs = useRef<Map<number, TerminalRef>>(new Map());
  const panelRef = useRef<ImperativePanelHandle>(null);
  const panelToggledByShortcut = useRef(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>({ kind: 'terminal', index: 0 });
  const [terminalCount, setTerminalCount] = useState(0);

  const addTerminal = useCallback(() => {
    if (terminalCount < MAX_TERMINALS) {
      setTerminalCount((c) => c + 1);
      setActiveTab({ kind: 'terminal', index: terminalCount });
    }
  }, [terminalCount]);

  const closeTerminal = useCallback((index: number) => {
    if (index === 0) {
      return;
    } // can't close Bolt terminal

    const ref = terminalRefs.current.get(index);

    if (ref?.getTerminal) {
      const terminal = ref.getTerminal();

      if (terminal) {
        workbenchStore.detachTerminal(terminal);
      }
    }

    terminalRefs.current.delete(index);
    setTerminalCount((c) => c - 1);
    setActiveTab((prev) => {
      if (prev.kind !== 'terminal') {
        return prev;
      }

      if (prev.index === index) {
        return { kind: 'terminal', index: Math.max(0, index - 1) };
      }

      if (prev.index > index) {
        return { kind: 'terminal', index: prev.index - 1 };
      }

      return prev;
    });
  }, []);

  // Cleanup detached terminals on unmount.
  useEffect(() => {
    return () => {
      terminalRefs.current.forEach((ref, index) => {
        if (index > 0 && ref?.getTerminal) {
          const terminal = ref.getTerminal();

          if (terminal) {
            workbenchStore.detachTerminal(terminal);
          }
        }
      });
    };
  }, []);

  /*
   * Bottom panel collapse/expand mirrors workbenchStore.showTerminal. Defers
   * by one animation frame to avoid the lazy-mount race that produced the
   * historical "Panel size not found for panel :rq:" error.
   */
  useEffect(() => {
    let rafId = 0;
    rafId = requestAnimationFrame(() => {
      const panel = panelRef.current;

      if (!panel) {
        return;
      }

      try {
        const collapsed = panel.isCollapsed();

        if (!showTerminal && !collapsed) {
          panel.collapse();
        } else if (showTerminal && collapsed) {
          panel.resize(DEFAULT_BOTTOM_PANEL_SIZE);
        }
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          logger.warn('BottomPanelTabs: imperative call skipped (panel not registered yet)', err);
        }
      }
      panelToggledByShortcut.current = false;
    });

    return () => cancelAnimationFrame(rafId);
  }, [showTerminal]);

  useEffect(() => {
    const offShortcut = shortcutEventEmitter.on('toggleTerminal', () => {
      panelToggledByShortcut.current = true;
    });
    const offTheme = themeStore.subscribe(() => {
      terminalRefs.current.forEach((ref) => ref?.reloadStyles());
    });

    return () => {
      offShortcut();
      offTheme();
    };
  }, []);

  const isTerminalTab = activeTab.kind === 'terminal';

  return (
    <Panel
      id="bottom-panel"
      order={2}
      ref={panelRef}
      defaultSize={showTerminal ? DEFAULT_BOTTOM_PANEL_SIZE : 0}
      minSize={10}
      collapsible
      onExpand={() => {
        if (!panelToggledByShortcut.current) {
          workbenchStore.toggleTerminal(true);
        }
      }}
      onCollapse={() => {
        if (!panelToggledByShortcut.current) {
          workbenchStore.toggleTerminal(false);
        }
      }}
    >
      <div className="h-full bg-bolt-elements-terminals-background flex flex-col">
        {/* Tab strip — icon-only with hover/focus tooltips */}
        <div className="flex items-center bg-bolt-elements-background-depth-2 border-y border-bolt-elements-borderColor gap-0.5 min-h-[34px] px-2 overflow-x-auto">
          {/* Terminal tabs — icon + count badge */}
          {Array.from({ length: terminalCount + 1 }, (_, index) => {
            const active = isTerminalTab && (activeTab as { index: number }).index === index;
            const label = index === 0 ? 'Terminal' : `Terminal ${index}`;

            return (
              <Tooltip.Root key={`term-${index}`} delayDuration={400}>
                <Tooltip.Trigger asChild>
                  <button
                    type="button"
                    onClick={() => setActiveTab({ kind: 'terminal', index })}
                    aria-label={label}
                    className={classNames(
                      'flex items-center cursor-pointer gap-1 px-2 py-1 h-7 whitespace-nowrap rounded-md transition-colors',
                      active
                        ? 'bg-bolt-elements-terminals-buttonBackground text-bolt-elements-textPrimary'
                        : 'bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
                    )}
                  >
                    <div className="i-ph:terminal-window-duotone text-base" />

                    {/*
                      Close control INSIDE the tab button — must NOT be a nested <button>
                      (invalid HTML: the browser restructures it and the masked `i-ph:x` icon
                      rendered as a solid white square, Brian 2026-08-21). A keyboard-operable
                      <span> is valid inside a button, and an inline SVG draws the ✕ with zero
                      mask/CSP/data-URL dependency.
                    */}
                    {index > 0 ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className="inline-flex items-center cursor-pointer text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                        aria-label={`Close ${label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTerminal(index);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            closeTerminal(index);
                          }
                        }}
                      >
                        <svg viewBox="0 0 256 256" className="w-3 h-3" fill="currentColor" aria-hidden="true">
                          <path d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128L50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z" />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    side="top"
                    align="center"
                    className="z-50 px-2 py-1 text-xs rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary border border-bolt-elements-borderColor shadow-lg"
                    sideOffset={4}
                  >
                    {label}
                    <Tooltip.Arrow className="fill-bolt-elements-borderColor" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            );
          })}

          {terminalCount < MAX_TERMINALS ? (
            <Tooltip.Root delayDuration={400}>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={addTerminal}
                  aria-label="New terminal"
                  className="flex items-center justify-center w-6 h-6 rounded-md bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors"
                >
                  <div className="i-ph:plus text-sm" />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="top"
                  align="center"
                  className="z-50 px-2 py-1 text-xs rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary border border-bolt-elements-borderColor shadow-lg"
                  sideOffset={4}
                >
                  New terminal
                  <Tooltip.Arrow className="fill-bolt-elements-borderColor" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ) : null}

          {/* Close panel button */}
          <Tooltip.Root delayDuration={400}>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                className="ml-auto flex items-center justify-center w-6 h-6 rounded-md bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors"
                aria-label="Close panel"
                onClick={() => workbenchStore.toggleTerminal(false)}
              >
                <div className="i-ph:caret-down text-sm" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="top"
                align="center"
                className="z-50 px-2 py-1 text-xs rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary border border-bolt-elements-borderColor shadow-lg"
                sideOffset={4}
              >
                Close panel
                <Tooltip.Arrow className="fill-bolt-elements-borderColor" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </div>

        {/* Tab bodies */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* All terminals render together so their xterm refs stay alive
              across tab switches; only the active one is visible. */}
          <div className={classNames('h-full', { hidden: !isTerminalTab })}>
            {Array.from({ length: terminalCount + 1 }, (_, index) => {
              const active = isTerminalTab && (activeTab as { index: number }).index === index;
              const isBolt = index === 0;

              return (
                <React.Fragment key={`terminal-body-${index}`}>
                  <Terminal
                    id={`terminal_${index}`}
                    className={classNames(
                      'h-full overflow-hidden',
                      isBolt ? 'modern-scrollbar-invert' : 'modern-scrollbar',
                      { hidden: !active },
                    )}
                    ref={(ref) => {
                      if (ref) {
                        terminalRefs.current.set(index, ref);
                      }
                    }}
                    onTerminalReady={(terminal) => {
                      if (isBolt) {
                        workbenchStore.attachBoltTerminal(terminal);
                      } else {
                        workbenchStore.attachTerminal(terminal);
                      }
                    }}
                    onTerminalResize={(cols, rows) => workbenchStore.onTerminalResize(cols, rows)}
                    theme={theme}
                  />
                  {active ? (
                    <TerminalManager
                      terminal={terminalRefs.current.get(index)?.getTerminal() || null}
                      isActive={active}
                    />
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </Panel>
  );
});

BottomPanelTabs.displayName = 'BottomPanelTabs';
