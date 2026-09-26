import { memo, useEffect, useRef } from 'react';
import { classNames } from '~/utils/classNames';
import type { PreviewInfo } from '~/lib/stores/previews';

interface PortDropdownProps {
  activePreviewIndex: number;
  setActivePreviewIndex: (index: number) => void;
  isDropdownOpen: boolean;
  setIsDropdownOpen: (value: boolean) => void;
  setHasSelectedPreview: (value: boolean) => void;
  previews: PreviewInfo[];
}

/**
 * Port switcher for the preview address bar.
 *
 * - **One (or zero) port → renders NOTHING** (no plug icon, no number): there's
 *   nothing to switch between, so the control is pure noise. The plug only ever
 *   appears when the project actually serves more than one port.
 * - **Multiple ports → a plug button that expands an INLINE port picker** (not a
 *   floating popup): clicking the plug reveals every port as a chip right in the
 *   address bar; selecting one navigates the preview to it and collapses again.
 */
export const PortDropdown = memo(
  ({
    activePreviewIndex,
    setActivePreviewIndex,
    isDropdownOpen,
    setIsDropdownOpen,
    setHasSelectedPreview,
    previews,
  }: PortDropdownProps) => {
    const dropdownRef = useRef<HTMLDivElement>(null);

    // sort previews, preserving original index
    const sortedPreviews = previews
      .map((previewInfo, index) => ({ ...previewInfo, index }))
      .sort((a, b) => a.port - b.port);

    // close the inline picker if the user clicks outside it
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
          setIsDropdownOpen(false);
        }
      };

      if (isDropdownOpen) {
        window.addEventListener('mousedown', handleClickOutside);
      } else {
        window.removeEventListener('mousedown', handleClickOutside);
      }

      return () => {
        window.removeEventListener('mousedown', handleClickOutside);
      };
    }, [isDropdownOpen]);

    /*
     * Only one port available → nothing to choose. Hide the control entirely
     * (no plug, no number) so the address bar starts clean with just the URL.
     */
    if (previews.length <= 1) {
      return null;
    }

    const activePreview =
      activePreviewIndex >= 0 && activePreviewIndex < previews.length ? previews[activePreviewIndex] : undefined;

    return (
      <div className="ps-port relative z-port-dropdown flex items-center" ref={dropdownRef}>
        <button
          type="button"
          className="ps-port-plug flex items-center gap-1.5 rounded-full px-2 py-1"
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          aria-expanded={isDropdownOpen}
          aria-label="Switch preview port"
          title="Switch preview port"
        >
          <span className="i-ph:plug text-base" aria-hidden="true"></span>
          {activePreview && !isDropdownOpen ? (
            <span className="text-xs font-medium">{activePreview.port}</span>
          ) : null}
        </button>

        {isDropdownOpen && (
          <div className="ps-port-inline flex items-center gap-1 pl-1" role="listbox" aria-label="Preview ports">
            {sortedPreviews.map((preview) => {
              const active = activePreviewIndex === preview.index;
              return (
                <button
                  key={preview.port}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={classNames('ps-port-chip', { 'is-active': active })}
                  onClick={() => {
                    setActivePreviewIndex(preview.index);
                    setIsDropdownOpen(false);
                    setHasSelectedPreview(true);
                  }}
                >
                  {preview.port}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
