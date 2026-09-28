import { useState, useEffect } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';
import { Checkbox } from '~/components/ui/Checkbox';
import { toast } from '~/components/ui/use-toast';

interface LockedItem {
  path: string;
  type: 'file' | 'folder';
}

export function LockManager() {
  const [lockedItems, setLockedItems] = useState<LockedItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'files' | 'folders'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Load locked items
  useEffect(() => {
    const loadLockedItems = () => {
      // We don't need to filter by chat ID here as we want to show all locked files
      const items: LockedItem[] = [];

      // Get all files and folders from the workbench store
      const allFiles = workbenchStore.files.get();

      // Check each file/folder for locks
      Object.entries(allFiles).forEach(([path, item]) => {
        if (!item) {
          return;
        }

        if (item.type === 'file' && item.isLocked) {
          items.push({
            path,
            type: 'file',
          });
        } else if (item.type === 'folder' && item.isLocked) {
          items.push({
            path,
            type: 'folder',
          });
        }
      });

      setLockedItems(items);
    };

    loadLockedItems();

    // Set up an interval to refresh the list periodically
    const intervalId = setInterval(loadLockedItems, 5000);

    return () => clearInterval(intervalId);
  }, []);

  // Filter and sort the locked items
  const filteredAndSortedItems = lockedItems
    .filter((item) => {
      // Apply type filter
      if (filter === 'files' && item.type !== 'file') {
        return false;
      }

      if (filter === 'folders' && item.type !== 'folder') {
        return false;
      }

      // Apply search filter
      if (searchTerm && !item.path.toLowerCase().includes(searchTerm.toLowerCase())) {
        return false;
      }

      return true;
    })
    .sort((a, b) => {
      return a.path.localeCompare(b.path);
    });

  // Handle selecting/deselecting a single item
  const handleSelectItem = (path: string) => {
    const newSelectedItems = new Set(selectedItems);

    if (newSelectedItems.has(path)) {
      newSelectedItems.delete(path);
    } else {
      newSelectedItems.add(path);
    }

    setSelectedItems(newSelectedItems);
  };

  // Handle selecting/deselecting all visible items
  const handleSelectAll = (checked: boolean | 'indeterminate') => {
    if (checked === true) {
      // Select all filtered items
      const allVisiblePaths = new Set(filteredAndSortedItems.map((item) => item.path));
      setSelectedItems(allVisiblePaths);
    } else {
      // Deselect all (clear selection)
      setSelectedItems(new Set());
    }
  };

  // Handle unlocking selected items
  const handleUnlockSelected = () => {
    if (selectedItems.size === 0) {
      toast.error('No items selected to unlock.');
      return;
    }

    let unlockedCount = 0;
    selectedItems.forEach((path) => {
      const item = lockedItems.find((i) => i.path === path);

      if (item) {
        if (item.type === 'file') {
          workbenchStore.unlockFile(path);
        } else {
          workbenchStore.unlockFolder(path);
        }

        unlockedCount++;
      }
    });

    if (unlockedCount > 0) {
      toast.success(`Unlocked ${unlockedCount} selected item(s).`);
      setSelectedItems(new Set()); // Clear selection after unlocking
    }
  };

  // Determine the state of the "Select All" checkbox
  const isAllSelected = filteredAndSortedItems.length > 0 && selectedItems.size === filteredAndSortedItems.length;
  const isSomeSelected = selectedItems.size > 0 && selectedItems.size < filteredAndSortedItems.length;
  const selectAllCheckedState: boolean | 'indeterminate' = isAllSelected
    ? true
    : isSomeSelected
      ? 'indeterminate'
      : false;

  return (
    // `[color-scheme:dark]` keeps the native <select> popup + its <option> list dark, never white.
    <div className="flex flex-col h-full overflow-hidden bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary [color-scheme:dark]">
      {/* Controls */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-bolt-elements-borderColor">
        {/* Search Input */}
        <div className="relative flex-1 group">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary group-focus-within:text-bolt-elements-item-contentAccent transition-colors i-ph:magnifying-glass text-xs pointer-events-none" />
          <input
            type="text"
            placeholder="Search…"
            className="w-full text-xs pl-6 pr-2 py-0.5 h-6 bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary rounded border border-bolt-elements-borderColor transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ minWidth: 0 }}
          />
        </div>
        {/* Filter Select — appearance-none + cyan SVG chevron so no OS-gray arrow leaks. */}
        <select
          className={classNames(
            'text-xs h-6 appearance-none pl-2 pr-6 py-0.5 bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary rounded border border-bolt-elements-borderColor cursor-pointer transition-colors',
            'hover:border-bolt-elements-item-contentAccent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
            "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%2300e5ff%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22/%3E%3C/svg%3E')]",
            'bg-[length:12px] bg-[right_0.45rem_center] bg-no-repeat',
            '[&>option]:bg-bolt-elements-background-depth-2 [&>option]:text-bolt-elements-textPrimary',
          )}
          value={filter}
          onChange={(e) => setFilter(e.target.value as any)}
          aria-label="Filter locked items by type"
        >
          <option value="all">All</option>
          <option value="files">Files</option>
          <option value="folders">Folders</option>
        </select>
      </div>

      {/* Header Row with Select All */}
      <div className="flex items-center justify-between px-2 py-1 text-xs text-bolt-elements-textSecondary">
        <div>
          <Checkbox
            checked={selectAllCheckedState}
            onCheckedChange={handleSelectAll}
            className="w-3 h-3 rounded border-bolt-elements-borderColor mr-2"
            aria-label="Select all items"
            disabled={filteredAndSortedItems.length === 0} // Disable if no items to select
          />
          <span>All</span>
        </div>
        {selectedItems.size > 0 && (
          <button
            className="ml-auto px-2 py-0.5 rounded bg-bolt-elements-button-secondary-background hover:bg-bolt-elements-button-secondary-backgroundHover text-bolt-elements-button-secondary-text text-xs flex items-center gap-1"
            onClick={handleUnlockSelected}
            title="Unlock all selected items"
          >
            Unlock all
          </button>
        )}
        <div></div>
      </div>

      {/* List of locked items */}
      <div className="flex-1 overflow-auto modern-scrollbar px-1 py-1">
        {filteredAndSortedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-bolt-elements-textTertiary text-xs gap-2">
            <span className="i-ph:lock-open-duotone text-lg opacity-50" />
            <span>No locked items found</span>
          </div>
        ) : (
          <ul className="space-y-1">
            {filteredAndSortedItems.map((item) => (
              <li
                key={item.path}
                className={classNames(
                  'text-bolt-elements-textTertiary flex items-center gap-2 px-2 py-1 rounded hover:bg-bolt-elements-background-depth-2 transition-colors group',
                  selectedItems.has(item.path) ? 'bg-bolt-elements-background-depth-2' : '',
                )}
              >
                <Checkbox
                  checked={selectedItems.has(item.path)}
                  onCheckedChange={() => handleSelectItem(item.path)}
                  className="w-3 h-3 rounded border-bolt-elements-borderColor"
                  aria-labelledby={`item-label-${item.path}`} // For accessibility
                />
                <span
                  className={classNames(
                    'shrink-0 text-bolt-elements-textTertiary text-xs',
                    item.type === 'file' ? 'i-ph:file-text-duotone' : 'i-ph:folder-duotone',
                  )}
                />
                <span id={`item-label-${item.path}`} className="truncate flex-1 text-xs" title={item.path}>
                  {item.path.replace('/home/project/', '')}
                </span>
                {/* ... rest of the item details and buttons ... */}
                <span
                  className={classNames(
                    'inline-flex items-center px-1 rounded-sm text-xs',
                    'bg-red-500/10 text-red-500',
                  )}
                ></span>
                <button
                  className="flex items-center px-1 py-0.5 text-xs rounded bg-transparent hover:bg-bolt-elements-background-depth-3"
                  onClick={() => {
                    if (item.type === 'file') {
                      workbenchStore.unlockFile(item.path);
                    } else {
                      workbenchStore.unlockFolder(item.path);
                    }

                    toast.success(`${item.path.replace('/home/project/', '')} unlocked`);
                  }}
                  title="Unlock"
                >
                  <span className="i-ph:lock-open text-xs" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 py-1 border-t border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-xs text-bolt-elements-textTertiary flex justify-between items-center">
        <div>
          {filteredAndSortedItems.length} item(s) • {selectedItems.size} selected
        </div>
      </div>
    </div>
  );
}
